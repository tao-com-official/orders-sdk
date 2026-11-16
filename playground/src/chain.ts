// Read-only chain reads for the playground: the wallet's balance and stake, and a subnet's spot
// price. Same calls as the order-execution e2e suite. Order data still comes only from the SDK.

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
