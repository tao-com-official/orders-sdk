import { describe, expect, it, vi } from "vitest";

import { OrderServiceClient, UnexpectedResponseError, type InstructionSigner } from "../src/index.js";

const BASE = "https://orders.test";
const SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const NATIVE = "urn:bittensor:testnet:native";
const ALPHA = "urn:bittensor:testnet:alpha:1";

type Call = { url: URL; headers: Headers; body: unknown };

function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    calls.push({
      url: new URL(input.toString()),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return response;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function hal(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/hal+json", ...headers },
  });
}

const raw = (payload: string) => ({ type: "RAW" as const, payload });
const plan = (status: string, links: Record<string, { href: string }>, extra: object = {}) => ({
  _links: { self: { href: `${BASE}/orders/v2/orders/p1` }, ...links },
  type: "tao_to_alpha",
  status,
  source: { currency: NATIVE, amount: "1000" },
  destination: { currency: ALPHA, address: HOTKEY },
  signerAddress: SIGNER,
  createdAt: "2026-11-14T00:00:00Z",
  updatedAt: "2026-11-14T00:00:00Z",
  ...extra,
});
const next = { instruction: { href: `${BASE}/orders/v2/orders/p1/components` } };

describe("limit plans", () => {
  it("authors a linked LIMIT_BUY, then signs entry, stop loss and take profit in turn", async () => {
    const authoredLimit = {
      type: "LIMIT_BUY",
      maxSlippage: 0.05,
      expiresAt: "2026-11-21T00:00:00.000Z",
      limitPrice: { currency: NATIVE, value: "900" },
      triggerPrice: { currency: NATIVE, value: "900" },
      stopLoss: { percentage: 0.1, targetPrice: { currency: NATIVE, value: "810" } },
      takeProfit: { percentage: 0.2, targetPrice: { currency: NATIVE, value: "1080" } },
    };
    const { fetch, calls } = fakeFetch(
      hal(
        200,
        {
          _links: { instruction: { href: `${BASE}/orders/v2/orders` } },
          order: {
            type: "tao_to_alpha",
            source: { currency: NATIVE, amount: "1000" },
            destination: { currency: ALPHA, address: HOTKEY },
            signerAddress: SIGNER,
            limit: authoredLimit,
          },
          instruction: raw("0xentry"),
        },
        { "x-provenance-token": "t-entry" },
      ),
      hal(202, plan("PENDING_SIGNATURES", next, { instruction: raw("0xsl") }), { "x-provenance-token": "t-sl" }),
      hal(202, plan("PENDING_SIGNATURES", next, { instruction: raw("0xtp") }), { "x-provenance-token": "t-tp" }),
      hal(201, plan("OPEN", {})),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const signed: string[] = [];
    const signer: InstructionSigner = (instruction) => {
      signed.push(String(instruction.payload));
      return { type: "sr25519", value: `0x${signed.length}` };
    };
    const progress: number[] = [];

    const order = await client.placeLimitOrder({
      signerAddress: SIGNER,
      source: { currency: NATIVE, amount: 1000n },
      destination: { currency: ALPHA, address: HOTKEY },
      limit: {
        type: "LIMIT_BUY",
        limitPrice: { value: 900n },
        maxSlippage: 0.05,
        expiresAt: new Date("2026-11-21T00:00:00Z"),
        stopLoss: { percentage: 0.1 },
        takeProfit: { percentage: 0.2 },
      },
      signer,
      onComponentSigned: (_, n) => progress.push(n),
    });

    expect(calls[0]?.body).toMatchObject({
      limit: {
        type: "LIMIT_BUY",
        limitPrice: { value: "900" },
        maxSlippage: 0.05,
        expiresAt: "2026-11-21T00:00:00.000Z",
        stopLoss: { percentage: 0.1 },
        takeProfit: { percentage: 0.2 },
      },
    });
    // Register repeats the limit without what the service derived.
    expect((calls[1]?.body as { order: { limit: unknown } }).order.limit).toEqual({
      ...authoredLimit,
      stopLoss: { percentage: 0.1 },
      takeProfit: { percentage: 0.2 },
    });
    expect(calls[1]?.headers.get("x-provenance-token")).toBe("t-entry");
    expect(calls[2]?.url.pathname).toBe("/orders/v2/orders/p1/components");
    expect(calls[2]?.headers.get("x-provenance-token")).toBe("t-sl");
    expect(calls[2]?.body).toEqual({ signedInstruction: { type: "sr25519", value: "0x2" } });
    expect(calls[3]?.headers.get("x-provenance-token")).toBe("t-tp");
    expect(signed).toEqual(["0xentry", "0xsl", "0xtp"]);
    expect(progress).toEqual([1, 2]);
    expect(order.status).toBe("OPEN");
    expect(order.nextSignature).toBeUndefined();
  });

  it("sends a Profit Lock without an amount and registers only its legs", async () => {
    const { fetch, calls } = fakeFetch(
      hal(
        200,
        {
          order: {
            type: "alpha_to_tao",
            source: { currency: ALPHA, address: HOTKEY, amount: "5000" },
            destination: { currency: NATIVE },
            signerAddress: SIGNER,
            limit: {
              type: "PROFIT_LOCK",
              currency: "USD",
              maxSlippage: 0.02,
              expiresAt: "2027-01-01T00:00:00.000Z",
              stopLoss: { percentage: 0.05, targetPrice: { currency: NATIVE, value: "1" } },
            },
          },
          instruction: raw("0xsl"),
        },
        { "x-provenance-token": "t" },
      ),
      hal(201, plan("OPEN", {})),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });

    await client.placeLimitOrder({
      signerAddress: SIGNER,
      source: { currency: ALPHA, address: HOTKEY },
      destination: { currency: NATIVE },
      limit: { type: "PROFIT_LOCK", currency: "USD", stopLoss: { percentage: 0.05 } },
      signer: () => ({ type: "sr25519", value: "0x01" }),
    });

    expect(calls[0]?.body).toMatchObject({
      limit: { type: "PROFIT_LOCK", currency: "USD", stopLoss: { percentage: 0.05 } },
    });
    expect((calls[1]?.body as { order: unknown }).order).toEqual({
      type: "alpha_to_tao",
      source: { currency: ALPHA, address: HOTKEY },
      destination: { currency: NATIVE },
      signerAddress: SIGNER,
      limit: { type: "PROFIT_LOCK", currency: "USD", stopLoss: { percentage: 0.05 } },
    });
  });

  it("sends a USD trigger without limitPrice and maxSlippage", async () => {
    const { fetch, calls } = fakeFetch(hal(200, { order: {}, instruction: raw("0x01") }, { "x-provenance-token": "t" }));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });

    await client.authorOrder({
      signerAddress: SIGNER,
      source: { currency: NATIVE, amount: 1000n },
      destination: { currency: ALPHA, address: HOTKEY },
      limit: { type: "LIMIT_BUY", triggerPrice: { value: 1_250_000_000n, currency: "USD" } },
    });

    expect((calls[0]?.body as { limit: unknown }).limit).toEqual({
      type: "LIMIT_BUY",
      triggerPrice: { value: "1250000000", currency: "USD" },
    });
  });

  it("rejects an amount on a Profit Lock and a missing one on a limit order", async () => {
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: fakeFetch().fetch });
    const legs = { signerAddress: SIGNER, destination: { currency: NATIVE } };
    await expect(
      client.authorOrder({
        ...legs,
        source: { currency: ALPHA, address: HOTKEY, amount: 1n },
        limit: { type: "PROFIT_LOCK" },
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.authorOrder({
        ...legs,
        source: { currency: ALPHA, address: HOTKEY },
        limit: { type: "STOP_LOSS", limitPrice: { value: 1n }, maxSlippage: 0.1 },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("exposes the next step of a pending plan on getOrder", async () => {
    const { fetch } = fakeFetch(
      hal(200, plan("PENDING_SIGNATURES", next, { instruction: raw("0xtp") }), { "x-provenance-token": "t-tp" }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const order = await client.getOrder("p1");
    expect(order.nextSignature).toEqual({
      instruction: raw("0xtp"),
      href: `${BASE}/orders/v2/orders/p1/components`,
      provenanceToken: "t-tp",
    });
  });

  it("reads a pending plan without its token as an order with no next step, not an error", async () => {
    const { fetch } = fakeFetch(hal(200, plan("PENDING_SIGNATURES", next, { instruction: raw("0xtp") })));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const order = await client.getOrder("p1");
    expect(order.status).toBe("PENDING_SIGNATURES");
    expect(order.nextSignature).toBeUndefined();
    expect(order).not.toHaveProperty("instruction");
  });
});

describe("limit wire shapes and plan guards", () => {
  const authored = (limit: object, token = "t") =>
    hal(
      200,
      {
        _links: { instruction: { href: `${BASE}/orders/v2/orders` } },
        order: {
          type: "tao_to_alpha",
          source: { currency: NATIVE, amount: "1000" },
          destination: { currency: ALPHA, address: HOTKEY },
          signerAddress: SIGNER,
          ...(Object.keys(limit).length > 0 ? { limit } : {}),
        },
        instruction: raw("0xentry"),
      },
      { "x-provenance-token": token },
    );
  const buy = {
    signerAddress: SIGNER,
    source: { currency: NATIVE, amount: 1000n },
    destination: { currency: ALPHA, address: HOTKEY },
  };
  const signer: InstructionSigner = () => ({ type: "sr25519", value: "0x01" });

  it("sends a USD MARKET_BUY and registers only its own choices", async () => {
    const { fetch, calls } = fakeFetch(
      authored({
        type: "MARKET_BUY",
        currency: "USD",
        maxSlippage: 0.02,
        expiresAt: "2027-01-01T00:00:00.000Z",
        stopLoss: { percentage: 0.1, targetPrice: { currency: "USD", value: "1" } },
      }),
      hal(201, plan("OPEN", {})),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });

    await client.placeLimitOrder({
      ...buy,
      limit: { type: "MARKET_BUY", currency: "USD", maxSlippage: 0.02, stopLoss: { percentage: 0.1 } },
      signer,
    });

    expect((calls[0]?.body as { limit: unknown }).limit).toEqual({
      type: "MARKET_BUY",
      currency: "USD",
      maxSlippage: 0.02,
      stopLoss: { percentage: 0.1 },
    });
    // The plan's expiry and the derived targetPrice stay out of register.
    expect((calls[1]?.body as { order: { limit: unknown } }).order.limit).toEqual({
      type: "MARKET_BUY",
      currency: "USD",
      maxSlippage: 0.02,
      stopLoss: { percentage: 0.1 },
    });
  });

  it("sends an explicit TAO trigger with notBefore as ISO strings", async () => {
    const { fetch, calls } = fakeFetch(authored({}));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });

    await client.authorOrder({
      ...buy,
      limit: {
        type: "LIMIT_BUY",
        triggerPrice: { value: 950n, currency: NATIVE },
        limitPrice: { value: 900n },
        maxSlippage: 0.01,
        notBefore: new Date("2026-12-01T00:00:00Z"),
      },
    });

    expect((calls[0]?.body as { limit: unknown }).limit).toEqual({
      type: "LIMIT_BUY",
      triggerPrice: { value: "950", currency: NATIVE },
      limitPrice: { value: "900" },
      maxSlippage: 0.01,
      notBefore: "2026-12-01T00:00:00.000Z",
    });
  });

  it("rejects destination.amount on a limit order", async () => {
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: fakeFetch().fetch });
    await expect(
      client.authorOrder({
        ...buy,
        destination: { ...buy.destination, amount: 5n } as never,
        limit: { type: "LIMIT_BUY", limitPrice: { value: 900n }, maxSlippage: 0.01 },
      }),
    ).rejects.toThrow("A limit order takes no destination.amount");
  });

  it("throws UnexpectedResponseError on a 202 without its X-Provenance-Token", async () => {
    const { fetch } = fakeFetch(
      authored({ type: "LIMIT_BUY", stopLoss: { percentage: 0.1 } }),
      hal(202, plan("PENDING_SIGNATURES", next, { instruction: raw("0xsl") })),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(
      client.placeLimitOrder({
        ...buy,
        limit: { type: "LIMIT_BUY", limitPrice: { value: 900n }, maxSlippage: 0.01, stopLoss: { percentage: 0.1 } },
        signer,
      }),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("refuses to sign a plan component that is not a RAW limit order", async () => {
    const extrinsic = { type: "SUBSTRATE_EXTRINSIC", payload: { call: "balances.transfer_all" } };
    const { fetch } = fakeFetch(
      authored({ type: "LIMIT_BUY", stopLoss: { percentage: 0.1 } }),
      hal(202, plan("PENDING_SIGNATURES", next, { instruction: extrinsic }), { "x-provenance-token": "t" }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const sign = vi.fn(signer);
    await expect(
      client.placeLimitOrder({
        ...buy,
        limit: { type: "LIMIT_BUY", limitPrice: { value: 900n }, maxSlippage: 0.01, stopLoss: { percentage: 0.1 } },
        signer: sign,
      }),
    ).rejects.toThrow("must be a RAW limit order");
    expect(sign).toHaveBeenCalledTimes(1); // the entry only
  });

  it("refuses more signatures than the order has exit legs, and any on a market order", async () => {
    const extra = () => hal(202, plan("PENDING_SIGNATURES", next, { instruction: raw("0xmore") }), { "x-provenance-token": "t" });
    const { fetch } = fakeFetch(authored({}), extra());
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const sign = vi.fn(signer);
    await expect(client.placeMarketOrder({ ...buy, signer: sign })).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(sign).toHaveBeenCalledTimes(1);

    const second = fakeFetch(
      authored({ type: "LIMIT_BUY", stopLoss: { percentage: 0.1 } }),
      hal(202, plan("PENDING_SIGNATURES", next, { instruction: raw("0xsl") }), { "x-provenance-token": "t" }),
      extra(),
    );
    const contexts: unknown[] = [];
    const plans = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: second.fetch });
    await expect(
      plans.placeLimitOrder({
        ...buy,
        limit: { type: "LIMIT_BUY", limitPrice: { value: 900n }, maxSlippage: 0.01, stopLoss: { percentage: 0.1 } },
        signer: (instruction, context) => {
          contexts.push(context.component?.signed);
          return signer(instruction, context);
        },
      }),
    ).rejects.toThrow("has 1 exit leg(s) to sign");
    // Entry without a component, then the stop loss as component 1; the third ask is refused unsigned.
    expect(contexts).toEqual([undefined, 1]);
  });
});

describe("listTransactions", () => {
  it("reads the account's activity page and its cursors", async () => {
    const { fetch, calls } = fakeFetch(
      hal(200, {
        _links: {
          self: { href: "x" },
          next: { href: `${BASE}/orders/v2/bittensor/accounts/${SIGNER}/transactions?cursor=n1` },
        },
        _embedded: {
          transactions: [
            {
              _links: { order: { href: `${BASE}/orders/v2/orders/o1` } },
              id: "a1",
              blockNumber: 7,
              type: "tao_to_alpha",
              status: "FILLED",
              signerAddress: SIGNER,
              createdAt: "2026-11-14T00:00:00Z",
            },
          ],
        },
        page: { limit: 20, total: 41 },
      }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });

    const page = await client.listTransactions(SIGNER, { netuid: 1, type: "swaps", limit: 20 });

    expect(calls[0]?.url.pathname).toBe(`/orders/v2/bittensor/accounts/${SIGNER}/transactions`);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ netuid: "1", type: "swaps", limit: "20" });
    expect(page.transactions.map((t) => t.id)).toEqual(["a1"]);
    expect(page.total).toBe(41);
    expect(page.nextCursor).toBe("n1");
    expect(page.prevCursor).toBeUndefined();
  });
});
