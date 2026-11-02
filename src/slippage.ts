import type { Amount } from "./types.js";

/** 1 TAO in rao. Spot prices are scaled by this. */
export const RAO = 1_000_000_000n;

/** Root (SN0) has no pool: its price is always 1 TAO per alpha. */
export const ROOT_PRICE = RAO;

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

/**
 * Spot price of a dynamic subnet's alpha in rao of TAO per alpha, scaled by 1e9 (so a 1:1 pool is
 * `1000000000`). Same formula the order service uses. Read `taoIn` (`SubtensorModule.SubnetTAO`)
 * and `alphaIn` (`SubtensorModule.SubnetAlphaIn`) from the chain. Root has no pool: use `ROOT_PRICE`.
 */
export function spotPrice(pool: { taoIn: Amount; alphaIn: Amount }): bigint {
  return (positive(pool.taoIn, "taoIn") * RAO) / positive(pool.alphaIn, "alphaIn");
}
