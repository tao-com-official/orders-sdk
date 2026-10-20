import type { Amount } from "./types.js";

/** 1 TAO in rao. Prices and ratios on the wire are scaled by this. */
export const RAO = 1_000_000_000n;

/** Root (SN0) has no pool: its price is always 1 TAO per alpha. */
export const ROOT_PRICE = RAO;

const BPS = 10_000n;

function big(value: Amount, name: string): bigint {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (!/^[0-9]+$/.test(text)) throw new RangeError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return BigInt(text);
}

function positive(value: Amount, name: string): bigint {
  const n = big(value, name);
  if (n <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return n;
}

function bps(slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be an integer from 0 to 10000, got ${slippageBps}`);
  }
  return BigInt(slippageBps);
}

/**
 * Spot price of a dynamic subnet's alpha in rao of TAO per alpha, scaled by 1e9 (so a 1:1 pool is
 * `1000000000`). Same formula the order service uses. Read `taoIn` (`SubtensorModule.SubnetTAO`)
 * and `alphaIn` (`SubtensorModule.SubnetAlphaIn`) from the chain. Root has no pool: use `ROOT_PRICE`.
 */
export function spotPrice(pool: { taoIn: Amount; alphaIn: Amount }): bigint {
  return (positive(pool.taoIn, "taoIn") * RAO) / positive(pool.alphaIn, "alphaIn");
}

/**
 * `destination.limitPrice` for `tao_to_alpha`: the most you will pay per alpha, the spot price
 * raised by `slippageBps` (100 = 1%). The stake fails on chain if the price moves above it.
 */
export function buyLimitPrice(spot: Amount, slippageBps: number): bigint {
  const numerator = positive(spot, "spot") * (BPS + bps(slippageBps));
  return (numerator + BPS - 1n) / BPS; // round up: never tighter than asked
}

/**
 * `source.limitPrice` for `alpha_to_tao`: the least you will accept per alpha, the spot price
 * lowered by `slippageBps`. The unstake fails on chain if the price falls below it.
 */
export function sellLimitPrice(spot: Amount, slippageBps: number): bigint {
  return (positive(spot, "spot") * (BPS - bps(slippageBps))) / BPS; // round down: never tighter than asked
}

/**
 * `destination.limitPrice` for `alpha_swap` and `alpha_swap_move`: the minimum destination alpha
 * you will take per origin alpha, scaled by 1e9. It is the ratio of the two spot prices
 * (origin / destination) lowered by `slippageBps`; the service's own default is 500 (5%).
 * Use `ROOT_PRICE` for a Root leg. Example: origin priced 0.5, destination 1.0 -> ratio
 * `500000000`, limit `475000000` at 500 bps.
 */
export function swapLimitPrice(prices: { origin: Amount; destination: Amount }, slippageBps: number): bigint {
  const ratio = (positive(prices.origin, "origin") * RAO) / positive(prices.destination, "destination");
  return (ratio * (BPS - bps(slippageBps))) / BPS;
}
