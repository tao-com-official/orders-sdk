import type { Amount, EstimatedFee } from "./types.js";

/** The fee's own amount: the first entry, in the fee's own currency (USD is last, a TAO conversion may sit between). */
function ownAmount(fee: EstimatedFee) {
  return fee.amount[0];
}

/** Sum of the fees you pay (`userPayable`) that are denominated in `currency`. */
export function feesInCurrency(fees: readonly EstimatedFee[] | undefined, currency: string): bigint {
  let total = 0n;
  for (const fee of fees ?? []) {
    const own = ownAmount(fee);
    if (fee.userPayable && own !== undefined && own.currency === currency) total += BigInt(own.value);
  }
  return total;
}

/** Estimated USD total of the fees you pay, across currencies. */
export function feesUsd(fees: readonly EstimatedFee[] | undefined): number {
  let total = 0;
  for (const fee of fees ?? []) {
    const usd = fee.amount.find((entry) => entry.currency === "USD");
    if (fee.userPayable && usd !== undefined) total += Number(usd.value);
  }
  return total;
}

/**
 * What is left of `amount` after the fees denominated in the same currency. The service takes
 * those fees out of the amount you pay: a TAO swap pays its network, platform and shield fees
 * in TAO, so it stakes `net`; a sell from alpha loses only the alpha-denominated platform fee
 * (the TAO network fee is paid from your free balance). The subnet AMM fee is not paid by you.
 */
export function netAfterFees(
  amount: Amount,
  fees: readonly EstimatedFee[] | undefined,
  currency: string,
): { fees: bigint; net: bigint } {
  const paid = feesInCurrency(fees, currency);
  return { fees: paid, net: BigInt(amount) - paid };
}
