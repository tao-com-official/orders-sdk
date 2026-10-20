import { describe, expect, it } from "vitest";

import { feesInCurrency, feesUsd, netAfterFees, type EstimatedFee } from "../src/index.js";

const TAO = "urn:bittensor:testnet:native";
const ALPHA = "urn:bittensor:testnet:alpha:2";
const fee = (feeType: string, own: [string, string], usd: string, userPayable = true, converted?: [string, string]): EstimatedFee => ({
  amount: [
    { value: own[0], currency: own[1] },
    ...(converted ? [{ value: converted[0], currency: converted[1] }] : []),
    { value: usd, currency: "USD" },
  ],
  feeType,
  userPayable,
});

// The fees the service estimated for the 0.001 TAO swap that failed on testnet.
const taoFees = [fee("SUBNET_AMM", ["5000", TAO], "0.002", false), fee("TRANSACTION", ["812723", TAO], "0.325"), fee("PLATFORM", ["3000", TAO], "1.2"), fee("MEV_SHIELD", ["94548", TAO], "0.038")];

describe("fee helpers", () => {
  it("sums only the fees you pay, in one currency", () => {
    expect(feesInCurrency(taoFees, TAO)).toBe(910_271n);
    expect(feesInCurrency(taoFees, ALPHA)).toBe(0n);
    expect(feesInCurrency(undefined, TAO)).toBe(0n);
  });

  it("totals USD across the fees you pay", () => {
    expect(feesUsd(taoFees)).toBeCloseTo(1.563, 3);
    expect(feesUsd(undefined)).toBe(0);
  });

  it("net after fees reproduces what was staked on chain (89,729 rao)", () => {
    expect(netAfterFees("1000000", taoFees, TAO)).toEqual({ fees: 910_271n, net: 89_729n });
    expect(netAfterFees(1_000_000n, taoFees, TAO).net).toBe(89_729n);
  });

  it("a sell from alpha loses only the alpha-denominated fee; the TAO fee is not taken from the alpha", () => {
    const sell = [
      fee("TRANSACTION", ["800000", TAO], "0.3"),
      fee("PLATFORM", ["15000000", ALPHA], "0.1", true, ["30000", TAO]), // a fee in alpha with a TAO conversion in between
    ];
    expect(netAfterFees("5000000000", sell, ALPHA)).toEqual({ fees: 15_000_000n, net: 4_985_000_000n });
    expect(feesInCurrency(sell, TAO)).toBe(800_000n);
    expect(feesUsd(sell)).toBeCloseTo(0.4, 6);
  });
});
