import { describe, expect, it } from "vitest";

import { RAO, spotPrice } from "../src/index.js";

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
