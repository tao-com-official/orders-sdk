// Read-only chain reads for the playground: the wallet's balance and stake, and a subnet's spot
// price, and on testnet a pool mover. Same calls as the order-execution e2e suite. Order data
// still comes only from the SDK.

import {
  cryptoWaitReady,
  encodeAddress,
  mnemonicToMiniSecret,
  mnemonicValidate,
  sr25519PairFromSeed,
  sr25519Sign,
} from "@polkadot/util-crypto";
import { getTxCreator } from "polkadot-api/tx-creator";
import { createWsClient } from "polkadot-api/ws";

type ChainApi = {
  query: { System: { Account: { getValue: (address: string) => Promise<{ data: { free: bigint } }> } } };
  apis: {
    StakeInfoRuntimeApi: {
      get_stake_info_for_coldkey: (address: string) => Promise<{ hotkey: string; netuid: number; stake: bigint }[]>;
    };
    SwapRuntimeApi: { current_alpha_price: (netuid: number) => Promise<bigint> };
  };
};

// One connection per RPC for the page's lifetime.
const clients = new Map<string, ChainApi>();
function api(rpc: string): ChainApi {
  let found = clients.get(rpc);
  if (found === undefined) {
    found = createWsClient(rpc, { timeout: 30_000 }).getUnsafeApi() as unknown as ChainApi;
    clients.set(rpc, found);
  }
  return found;
}

export interface Stake {
  hotkey: string;
  netuid: number;
  /** Alpha rao. */
  stake: bigint;
}

/** Free TAO (rao) and every non-zero stake of the coldkey, by netuid. */
export async function walletBalances(rpc: string, address: string): Promise<{ free: bigint; stakes: Stake[] }> {
  const chain = api(rpc);
  const [account, stakes] = await Promise.all([
    chain.query.System.Account.getValue(address),
    chain.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(address),
  ]);
  return {
    free: account.data.free,
    stakes: stakes
      .filter((s) => s.stake > 0n)
      .map(({ hotkey, netuid, stake }) => ({ hotkey, netuid, stake }))
      .sort((a, b) => a.netuid - b.netuid || a.hotkey.localeCompare(b.hotkey)),
  };
}

/** Spot price of the subnet's alpha: TAO per alpha × 1e9, the scale of a limit order's prices. */
export function alphaPrice(rpc: string, netuid: number): Promise<bigint> {
  return api(rpc).apis.SwapRuntimeApi.current_alpha_price(netuid);
}

// ---- pool mover (testnet market maker) -------------------------------------

/** Reserves and fee of the subnet's pool, as the e2e suite reads them. */
async function pool(rpc: string, netuid: number) {
  const chain = api(rpc) as unknown as { query: any; apis: any };
  const [spot, taoIn, alphaIn, feeRate] = await Promise.all([
    chain.apis.SwapRuntimeApi.current_alpha_price(netuid),
    chain.query.SubtensorModule.SubnetTAO.getValue(netuid),
    chain.query.SubtensorModule.SubnetAlphaIn.getValue(netuid),
    chain.query.Swap.FeeRate.getValue(netuid),
  ]);
  return { spot: BigInt(spot), taoIn: Number(taoIn), alphaIn: Number(alphaIn), fee: Number(feeRate) / 65535 };
}

/**
 * Moves the subnet's spot by about `percent` (up: stake TAO, down: unstake alpha) on `hotkey`,
 * signed by `phrase`. On the constant product spot = taoIn / alphaIn, staking x TAO scales the spot
 * by (1 + x/taoIn)² and unstaking y alpha by (alphaIn / (alphaIn + y))²; the pool fee comes off the
 * input first. Waits for the block; returns the spot before and after.
 */
export async function movePrice(
  rpc: string,
  phrase: string,
  hotkey: string,
  netuid: number,
  percent: number,
): Promise<{ before: bigint; after: bigint }> {
  if (!(Number.isFinite(percent) && percent !== 0 && percent > -100)) throw new Error("The move must be a non-zero percent above -100");
  await cryptoWaitReady();
  const pair = sr25519PairFromSeed(mnemonicToMiniSecret(phrase.trim().split(/\s+/).join(" ")));
  const p = await pool(rpc, netuid);
  const factor = 1 + percent / 100;
  const [call, args] =
    factor > 1
      ? ([
          "add_stake",
          { hotkey, netuid, amount_staked: BigInt(Math.ceil((p.taoIn * (Math.sqrt(factor) - 1)) / (1 - p.fee))) },
        ] as const)
      : ([
          "remove_stake",
          { hotkey, netuid, amount_unstaked: BigInt(Math.ceil((p.alphaIn * (1 / Math.sqrt(factor) - 1)) / (1 - p.fee))) },
        ] as const);
  if (call === "remove_stake") {
    // Only alpha this account holds on the hotkey can be sold; the chain answers a bare AmountTooLow.
    const { stakes } = await walletBalances(rpc, encodeAddress(pair.publicKey));
    const held = stakes.find((s) => s.netuid === netuid && s.hotkey === hotkey)?.stake ?? 0n;
    if (held < args.amount_unstaked) {
      throw new Error(
        `Moving down ${(-percent).toFixed(2)}% sells ${Number(args.amount_unstaked) / 1e9} α, but this account holds ` +
          `${Number(held) / 1e9} α on that hotkey. The pool goes down by selling alpha bought earlier: lift it with ↑ first.`,
      );
    }
  }
  const chain = api(rpc) as unknown as { tx: any };
  const result = await chain.tx.SubtensorModule[call](args).createAndSubmit(
    getTxCreator(pair.publicKey, "Sr25519", (bytes: Uint8Array) => sr25519Sign(bytes, pair)),
  );
  if (!result.ok) {
    throw new Error(`${call} failed: ${JSON.stringify(result.dispatchError, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
  }
  return { before: p.spot, after: await alphaPrice(rpc, netuid) };
}

/** SS58 of a mnemonic, to show which account moves the pool. */
export async function addressOf(phrase: string): Promise<string> {
  await cryptoWaitReady();
  if (!mnemonicValidate(phrase.trim().split(/\s+/).join(" "))) throw new Error("Not a valid BIP39 mnemonic");
  return encodeAddress(sr25519PairFromSeed(mnemonicToMiniSecret(phrase.trim().split(/\s+/).join(" "))).publicKey);
}
