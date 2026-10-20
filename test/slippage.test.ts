import { describe, expect, it } from "vitest";

import { buyLimitPrice, RAO, ROOT_PRICE, sellLimitPrice, spotPrice, swapLimitPrice } from "../src/index.js";

describe("spotPrice", () => {
  it("is taoIn * 1e9 / alphaIn, like the service", () => {
    expect(spotPrice({ taoIn: 10n * RAO, alphaIn: 10n * RAO })).toBe(1_000_000_000n); // the local 1:1 pool
    expect(spotPrice({ taoIn: "189774212604", alphaIn: "1000000000000" })).toBe(189_774_212n);
    expect(spotPrice({ taoIn: 5n * RAO, alphaIn: 10n * RAO })).toBe(500_000_000n);
  });

  it("rejects an empty pool and bad input", () => {
    expect(() => spotPrice({ taoIn: 0n, alphaIn: RAO })).toThrow(RangeError);
    expect(() => spotPrice({ taoIn: RAO, alphaIn: "0" })).toThrow(RangeError);
    expect(() => spotPrice({ taoIn: "1.5", alphaIn: RAO })).toThrow(RangeError);
  });
});

describe("buyLimitPrice (tao_to_alpha: most you will pay)", () => {
  it("raises the spot price by the tolerance", () => {
    expect(buyLimitPrice(RAO, 0)).toBe(RAO);
    expect(buyLimitPrice(RAO, 100)).toBe(1_010_000_000n); // +1%
    expect(buyLimitPrice(RAO, 500)).toBe(1_050_000_000n); // +5%
    expect(buyLimitPrice("500000000", 500)).toBe(525_000_000n);
  });

  it("rounds up, never tighter than asked", () => {
    expect(buyLimitPrice(3n, 1)).toBe(4n); // 3.0003 -> 4
    expect(buyLimitPrice(10_001n, 1)).toBe(10_003n); // 10001 * 10001 / 10000 = 10002.0001 -> 10003
  });
});

describe("sellLimitPrice (alpha_to_tao: least you will accept)", () => {
  it("lowers the spot price by the tolerance, rounding down", () => {
    expect(sellLimitPrice(RAO, 0)).toBe(RAO);
    expect(sellLimitPrice(RAO, 100)).toBe(990_000_000n);
    expect(sellLimitPrice(RAO, 500)).toBe(950_000_000n);
    expect(sellLimitPrice(3n, 1)).toBe(2n); // 2.9997 -> 2
  });
});

describe("swapLimitPrice (alpha_swap / alpha_swap_move: min destination alpha per origin alpha)", () => {
  it("matches the service's documented examples at 5%", () => {
    // An alpha subnet priced 500000000 swapped into root: ratio 500000000, limit 475000000.
    expect(swapLimitPrice({ origin: 500_000_000n, destination: ROOT_PRICE }, 500)).toBe(475_000_000n);
    // Root swapped into that subnet: ratio 2000000000, limit 1900000000.
    expect(swapLimitPrice({ origin: ROOT_PRICE, destination: 500_000_000n }, 500)).toBe(1_900_000_000n);
  });

  it("is 1:1 for equal prices, and tighter tolerance gives a higher floor", () => {
    expect(swapLimitPrice({ origin: RAO, destination: RAO }, 0)).toBe(RAO);
    expect(swapLimitPrice({ origin: RAO, destination: RAO }, 100)).toBe(990_000_000n);
    expect(swapLimitPrice({ origin: RAO, destination: RAO }, 50)).toBeGreaterThan(
      swapLimitPrice({ origin: RAO, destination: RAO }, 100),
    );
  });
});

describe("validation", () => {
  it("rejects slippage outside 0..10000 or non-integer", () => {
    for (const bad of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => buyLimitPrice(RAO, bad)).toThrow(RangeError);
      expect(() => sellLimitPrice(RAO, bad)).toThrow(RangeError);
      expect(() => swapLimitPrice({ origin: RAO, destination: RAO }, bad)).toThrow(RangeError);
    }
  });

  it("rejects non-positive prices", () => {
    expect(() => buyLimitPrice(0n, 100)).toThrow(RangeError);
    expect(() => sellLimitPrice("0", 100)).toThrow(RangeError);
    expect(() => swapLimitPrice({ origin: RAO, destination: 0n }, 100)).toThrow(RangeError);
  });

  it("sell at 100% slippage is zero (accept any price)", () => {
    expect(sellLimitPrice(RAO, 10_000)).toBe(0n);
  });
});
