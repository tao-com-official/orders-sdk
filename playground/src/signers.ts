// Wallets for the playground: a seed phrase held in memory, or any Polkadot-compatible browser
// extension (our own injects as `tao-com`). Each becomes the two functions the SDK asks for:
// one signs the login challenge, the other signs order instructions.
//
// ponytail: lives here until the shape is proven in an app, then moves to an SDK subpath.

import type { ChallengeSigner, InstructionSigner, SignatureType } from "@tao.com/orders-sdk";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import {
  blake2AsU8a,
  cryptoWaitReady,
  encodeAddress,
  mnemonicToMiniSecret,
  mnemonicValidate,
  sr25519PairFromSeed,
  sr25519Sign,
} from "@polkadot/util-crypto";
import { getTxCreatorFromPjs, type SignPayload, type SignRaw } from "polkadot-api/pjs-signer";
import { getTxCreator, type TxCreator } from "polkadot-api/tx-creator";
import { createWsClient } from "polkadot-api/ws";
import { of, throwError } from "rxjs";

type TxPayloadV1 = Parameters<TxCreator>[0];
type TxCreatorBindings = Parameters<TxCreator>[2];

export interface Wallet {
  address: string;
  label: string;
  signChallenge: ChallengeSigner;
  signInstruction: InstructionSigner;
}

// ---- chain metadata --------------------------------------------------------

// The service leaves the runtime metadata out of the payload; the signer needs it to lay out the
// extrinsic, so it is read from the chain once per RPC.
const metadataCache = new Map<string, Promise<string>>();

function chainMetadata(rpc: string): Promise<string> {
  let cached = metadataCache.get(rpc);
  if (cached === undefined) {
    cached = (async () => {
      const client = createWsClient(rpc, { timeout: 30_000 });
      try {
        const [head] = await client.getBestBlocks();
        if (head === undefined) throw new Error(`${rpc} returned no best block`);
        return u8aToHex(await client.getMetadata(head.hash));
      } finally {
        client.destroy();
      }
    })();
    cached.catch(() => metadataCache.delete(rpc));
    metadataCache.set(rpc, cached);
  }
  return cached;
}

// The payload already carries every extension (nonce, immortal era, tip), so the creator only
// needs the hasher; it must never reach the chain itself.
const bindings = {
  hasher: (bytes: Uint8Array) => of(blake2AsU8a(bytes)),
  blocks: throwError(() => new Error("the authored payload should not need chain blocks")),
  call: () => throwError(() => new Error("the authored payload should not need runtime calls")),
} as unknown as TxCreatorBindings;

async function signExtrinsic(creator: TxCreator, payload: TxPayloadV1, rpc: string): Promise<string> {
  const metadata = payload.context.metadata ?? (await chainMetadata(rpc));
  return creator({ ...payload, context: { ...payload.context, metadata } }, {} as never, bindings, false);
}

// ---- seed ------------------------------------------------------------------

/** A BIP39 mnemonic, kept only in this closure: never stored, never logged. */
export async function seedWallet(phrase: string, rpc: string): Promise<Wallet> {
  await cryptoWaitReady();
  const words = phrase.trim().split(/\s+/).join(" ");
  if (!mnemonicValidate(words)) throw new Error("Not a valid BIP39 mnemonic");
  const pair = sr25519PairFromSeed(mnemonicToMiniSecret(words));
  const address = encodeAddress(pair.publicKey);
  const creator = getTxCreator(pair.publicKey, "Sr25519", (bytes) => sr25519Sign(bytes, pair));
  return {
    address,
    label: "seed",
    signChallenge: (message) => u8aToHex(sr25519Sign(message, pair)),
    signInstruction: async (instruction) =>
      instruction.type === "RAW"
        ? { type: "sr25519", value: u8aToHex(sr25519Sign(hexToU8a(instruction.payload), pair)) }
        : { type: "sr25519", value: await signExtrinsic(creator, instruction.payload as unknown as TxPayloadV1, rpc) },
  };
}

// ---- browser extensions ----------------------------------------------------

interface InjectedAccount {
  address: string;
  name?: string;
  type?: string;
}

interface Injected {
  accounts: { get: () => Promise<InjectedAccount[]> };
  signer: { signPayload: SignPayload; signRaw: SignRaw };
}

type InjectedWeb3 = Record<string, { enable: (dapp: string) => Promise<Injected> }>;

const injectedWeb3 = () => (window as unknown as { injectedWeb3?: InjectedWeb3 }).injectedWeb3 ?? {};

/** Installed extensions by their `injectedWeb3` key: `tao-com`, `talisman`, `subwallet-js`, `polkadot-js`... */
export function installedExtensions(): string[] {
  return Object.keys(injectedWeb3());
}

export async function extensionAccounts(name: string): Promise<{ accounts: InjectedAccount[]; injected: Injected }> {
  const provider = injectedWeb3()[name];
  if (provider === undefined) throw new Error(`${name} is not installed`);
  const injected = await provider.enable("TAO Orders SDK Playground");
  return { accounts: await injected.accounts.get(), injected };
}

export function extensionWallet(name: string, injected: Injected, account: InjectedAccount, rpc: string): Wallet {
  const { address } = account;
  const type: SignatureType = account.type === "ed25519" ? "ed25519" : "sr25519";
  const creator = getTxCreatorFromPjs(address, injected.signer.signPayload, injected.signer.signRaw, type);
  const signRaw = async (data: Uint8Array) =>
    (await injected.signer.signRaw({ address, data: u8aToHex(data), type: "bytes" })).signature;
  return {
    address,
    label: `${name}${account.name !== undefined ? ` · ${account.name}` : ""}`,
    // The challenge is already `<Bytes>`-wrapped, so the extension signs it as is.
    signChallenge: signRaw,
    signInstruction: async (instruction) =>
      instruction.type === "RAW"
        ? // An extension wraps whatever it signs in `<Bytes>`; the service accepts that form only
          // over the blake2_256 of the order, not over the order itself.
          { type, value: await signRaw(blake2AsU8a(hexToU8a(instruction.payload), 256)) }
        : { type, value: await signExtrinsic(creator, instruction.payload as unknown as TxPayloadV1, rpc) },
  };
}
