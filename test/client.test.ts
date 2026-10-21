import { describe, expect, it, vi } from "vitest";

import {
  OrderServiceClient,
  OrderServiceError,
  OrderServiceNetworkError,
  TAO_COM_VALIDATOR_HOTKEYS,
  type InstructionSigner,
} from "../src/index.js";

const BASE = "https://orders.test";
const SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const NATIVE = "urn:bittensor:mainnet:native";
const ROOT = "urn:bittensor:mainnet:alpha:0";

type Call = { url: URL; init: RequestInit; headers: Headers; body: unknown };

function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    const text = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url: new URL(input.toString()),
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: text === undefined ? undefined : JSON.parse(text),
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

function problem(status: number, path: string, detail: string) {
  return new Response(
    JSON.stringify({
      type: `${BASE}/problems/${path}`,
      title: "Problem",
      status,
      detail,
      requestId: "req-1",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

const stakeEnvelope = {
  type: "tao_to_sn0",
  source: { currency: NATIVE, amount: "1000000000" },
  destination: { currency: ROOT, address: HOTKEY },
  signerAddress: SIGNER,
};
const instruction = { type: "SUBSTRATE_EXTRINSIC", payload: { callData: "0x0102" }, mevEncryption: false };

const authorResponse = () =>
  hal(
    200,
    {
      _links: { instruction: { href: `${BASE}/orders/v2/orders` } },
      order: stakeEnvelope,
      instruction,
      estimatedFees: [
        {
          amount: [
            { value: "812723", currency: NATIVE },
            { value: "0.325089", currency: "USD" },
          ],
          feeType: "TRANSACTION",
          userPayable: true,
        },
      ],
    },
    { "x-provenance-token": "prov-token" },
  );

const orderResponse = (status = "OPEN", cancel = true) => ({
  _links: {
    self: { href: `${BASE}/orders/v2/orders/ord_123` },
    ...(cancel ? { cancel: { href: `${BASE}/orders/v2/orders/ord_123/cancel` } } : {}),
  },
  type: "tao_to_sn0",
  status,
  source: stakeEnvelope.source,
  destination: stakeEnvelope.destination,
  signerAddress: SIGNER,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const signer: InstructionSigner = vi.fn(async () => ({ type: "sr25519" as const, value: "0xabcd" }));

describe("authorOrder", () => {
  it("rejects a non-integer amount before sending", async () => {
    const { fetch } = fakeFetch();
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(
      client.authorOrder({
        source: { currency: NATIVE, amount: "1.5" },
        destination: { currency: ROOT, address: HOTKEY },
        signerAddress: SIGNER,
      }),
    ).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a market order (no limit) with the bearer token and reads the provenance header", async () => {
    const { fetch, calls } = fakeFetch(authorResponse());
    const client = new OrderServiceClient({ baseUrl: `${BASE}/`, auth: () => "jwt", fetch });
    const authored = await client.authorOrder({
      source: { currency: NATIVE, amount: "1000000000" },
      destination: { currency: ROOT, address: HOTKEY },
      signerAddress: SIGNER,
    });
    expect(authored.provenanceToken).toBe("prov-token");
    expect(authored.order.type).toBe("tao_to_sn0");
    expect(authored.estimatedFees?.[0]?.feeType).toBe("TRANSACTION");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt");
    expect(calls[0]?.body).not.toHaveProperty("limit");
  });

  it("fails clearly when no token is configured", async () => {
    const { fetch } = fakeFetch();
    const client = new OrderServiceClient({ baseUrl: BASE, fetch });
    await expect(
      client.authorOrder({
        source: { currency: NATIVE, amount: "1" },
        destination: { currency: ROOT, address: HOTKEY },
        signerAddress: SIGNER,
      }),
    ).rejects.toThrow(/bearer token/);
  });
});

describe("getQuote", () => {
  const quote = {
    amount: [
      { value: "990000000", currency: ROOT },
      { value: "300.00", currency: "USD" },
    ],
    fees: [
      {
        amount: [
          { value: "812723", currency: NATIVE },
          { value: "0.325089", currency: "USD" },
        ],
        feeType: "TRANSACTION",
        userPayable: true,
      },
    ],
  };
  const withQuotes = (quotes?: unknown[]) =>
    hal(
      200,
      { _links: {}, order: stakeEnvelope, instruction, ...(quotes !== undefined ? { quotes } : {}) },
      { "x-provenance-token": "prov-token" },
    );
  const request = {
    source: { currency: NATIVE, amount: "1000000000" },
    destination: { currency: ROOT, address: HOTKEY },
    signerAddress: SIGNER,
  };

  it("returns the quote from a single author request and registers nothing", async () => {
    const { fetch, calls } = fakeFetch(withQuotes([quote]));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(client.getQuote(request)).resolves.toEqual(quote);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/orders/v2/order-intents");
  });

  it("exposes quotes on the authored order", async () => {
    const { fetch } = fakeFetch(withQuotes([quote]));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    expect((await client.authorOrder(request)).quotes).toEqual([quote]);
  });

  it("throws when the service returns no quote", async () => {
    const { fetch } = fakeFetch(withQuotes());
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(client.getQuote(request)).rejects.toThrow(/no quote/);
  });
});

describe("registerOrder", () => {
  it("sends idempotency and provenance headers and derives the order id", async () => {
    const { fetch, calls } = fakeFetch(hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const order = await client.registerOrder({
      order: stakeEnvelope as never,
      signedInstruction: { type: "sr25519", value: "0xabcd" },
      provenanceToken: "prov-token",
      idempotencyKey: "idem-1",
      sourceSystem: "bridge",
    });
    expect(order.id).toBe("ord_123");
    expect(order.status).toBe("OPEN");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("idem-1");
    expect(calls[0]?.headers.get("x-provenance-token")).toBe("prov-token");
    expect(calls[0]?.body).toEqual({
      sourceSystem: "bridge",
      order: stakeEnvelope,
      signedInstruction: { type: "sr25519", value: "0xabcd" },
    });
  });

  it("generates an idempotency key when none is given", async () => {
    const { fetch, calls } = fakeFetch(hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await client.registerOrder({
      order: stakeEnvelope as never,
      signedInstruction: { type: "sr25519", value: "0xab" },
      provenanceToken: "p",
    });
    expect(calls[0]?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("getOrder / cancelOrder", () => {
  it("gets an order and cancels without a body or content-type", async () => {
    const { fetch, calls } = fakeFetch(
      hal(200, orderResponse()),
      hal(200, orderResponse("CANCELLED", false)),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    expect((await client.getOrder("ord_123")).status).toBe("OPEN");
    const cancelled = await client.cancelOrder("ord_123");
    expect(cancelled.status).toBe("CANCELLED");
    expect(calls[1]?.url.pathname).toBe("/orders/v2/orders/ord_123/cancel");
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toBeUndefined();
    expect(calls[1]?.headers.has("content-type")).toBe(false);
  });

  it("surfaces problem+json as OrderServiceError", async () => {
    const { fetch } = fakeFetch(problem(409, "cancel-not-allowed", "Order is SUBMITTED"));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const error = await client.cancelOrder("ord_123").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderServiceError);
    expect(error).toMatchObject({ status: 409, code: "cancel-not-allowed", requestId: "req-1" });
  });
});

describe("listOrders", () => {
  const summary = {
    _links: { self: { href: `${BASE}/orders/v2/orders/ord_1` } },
    type: "sn0_to_tao",
    status: "FILLED",
    source: { currency: ROOT, amount: "5" },
    destination: { currency: NATIVE, amount: "4" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("scopes to market orders, forwards filters, and extracts cursors", async () => {
    const { fetch, calls } = fakeFetch(
      hal(200, {
        _links: {
          self: { href: `${BASE}/orders/v2/orders?limit=1` },
          next: { href: `${BASE}/orders/v2/orders?limit=1&cursor=NEXT` },
        },
        _embedded: { order: [summary] },
      }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const page = await client.listOrders({ status: "FILLED", limit: 1 });
    expect(page.orders.map((o) => o.id)).toEqual(["ord_1"]);
    expect(page.nextCursor).toBe("NEXT");
    expect(page.prevCursor).toBeUndefined();
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      status: "FILLED",
      limit: "1",
      orderCategory: "BITTENSOR_MARKET",
    });
  });

  it("returns an empty page", async () => {
    const { fetch } = fakeFetch(
      hal(200, { _links: { self: { href: `${BASE}/orders/v2/orders` } }, _embedded: { order: [] } }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    expect(await client.listOrders()).toEqual({ orders: [] });
  });
});

describe("placeMarketOrder and root staking", () => {
  it("authors, signs the authored instruction, and registers with the same token and order", async () => {
    const { fetch, calls } = fakeFetch(authorResponse(), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const order = await client.stakeToRoot({
      amount: 1_000_000_000n,
      hotkey: HOTKEY,
      signerAddress: SIGNER,
      signer,
    });
    expect(order.id).toBe("ord_123");
    expect(signer).toHaveBeenCalledWith(instruction, { signerAddress: SIGNER, order: stakeEnvelope });
    expect(calls[0]?.body).toEqual({
      source: { currency: NATIVE, amount: "1000000000" },
      destination: { currency: ROOT, address: HOTKEY },
      signerAddress: SIGNER,
    });
    expect(calls[1]?.headers.get("x-provenance-token")).toBe("prov-token");
    expect((calls[1]?.body as { order: unknown }).order).toEqual(stakeEnvelope);
  });

  it("puts the hotkey on the source leg when unstaking, and honours testnet", async () => {
    const { fetch, calls } = fakeFetch(authorResponse(), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", network: "testnet", fetch });
    await client.unstakeFromRoot({ amount: "7", hotkey: HOTKEY, signerAddress: SIGNER, signer });
    expect(calls[0]?.body).toEqual({
      source: { currency: "urn:bittensor:testnet:alpha:0", amount: "7", address: HOTKEY },
      destination: { currency: "urn:bittensor:testnet:native" },
      signerAddress: SIGNER,
    });
  });

  it("beforeSign sees the fee estimates, and throwing aborts before signing or registering", async () => {
    const seen: unknown[] = [];
    const ok = fakeFetch(authorResponse(), hal(201, orderResponse()));
    await new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: ok.fetch }).placeMarketOrder({
      source: { currency: NATIVE, amount: "1" },
      destination: { currency: ROOT, address: HOTKEY },
      signerAddress: SIGNER,
      signer,
      beforeSign: (authored) => void seen.push(authored.estimatedFees?.[0]?.feeType),
    });
    expect(seen).toEqual(["TRANSACTION"]);

    vi.mocked(signer).mockClear();
    const aborted = fakeFetch(authorResponse());
    await expect(
      new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: aborted.fetch }).placeMarketOrder({
        source: { currency: NATIVE, amount: "1" },
        destination: { currency: ROOT, address: HOTKEY },
        signerAddress: SIGNER,
        signer,
        beforeSign: () => {
          throw new Error("too small");
        },
      }),
    ).rejects.toThrow("too small");
    expect(aborted.calls).toHaveLength(1); // authored only: nothing registered
    expect(signer).not.toHaveBeenCalled();
  });

  it("does not register when signing fails", async () => {
    const { fetch, calls } = fakeFetch(authorResponse());
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(
      client.placeMarketOrder({
        source: { currency: NATIVE, amount: "1" },
        destination: { currency: ROOT, address: HOTKEY },
        signerAddress: SIGNER,
        signer: () => {
          throw new Error("user rejected");
        },
      }),
    ).rejects.toThrow("user rejected");
    expect(calls).toHaveLength(1);
  });
});

describe("author and submit (order-intents is a dry run; the order opens only when posted back)", () => {
  const request = {
    source: { currency: NATIVE, amount: "1000000000" },
    destination: { currency: ROOT, address: HOTKEY },
    signerAddress: SIGNER,
  };
  const authorWithFees = (href = `${BASE}/orders/v2/orders`) =>
    hal(
      200,
      {
        _links: { instruction: { href } },
        order: stakeEnvelope,
        instruction,
        estimatedFees: [
          { amount: [{ value: "5000", currency: NATIVE }, { value: "0.002", currency: "USD" }], feeType: "SUBNET_AMM", userPayable: false },
          { amount: [{ value: "812723", currency: NATIVE }, { value: "0.325089", currency: "USD" }], feeType: "TRANSACTION", userPayable: true },
          { amount: [{ value: "3000", currency: NATIVE }, { value: "1.2", currency: "USD" }], feeType: "PLATFORM", userPayable: true },
          { amount: [{ value: "94548", currency: NATIVE }, { value: "0.037819", currency: "USD" }], feeType: "MEV_SHIELD", userPayable: true },
        ],
      },
      { "x-provenance-token": "prov-token" },
    );

  it("authorOrder alone opens nothing: one request, no registration, with the instruction link and fees", async () => {
    const { fetch, calls } = fakeFetch(authorWithFees());
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const authored = await client.authorOrder(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/orders/v2/order-intents");
    expect(authored.provenanceToken).toBe("prov-token");
    expect(authored.instructionHref).toBe(`${BASE}/orders/v2/orders`);
    expect(authored.estimatedFees).toHaveLength(4);
  });

  it("submitAuthored signs the authored instruction and posts it to the returned link, without re-authoring", async () => {
    const { fetch, calls } = fakeFetch(authorWithFees(), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const authored = await client.authorOrder(request);
    vi.mocked(signer).mockClear();
    const order = await client.submitAuthored(authored, { signer, idempotencyKey: "idem-9", sourceSystem: "bridge" });
    expect(order.id).toBe("ord_123");
    expect(calls).toHaveLength(2); // author once, register once
    expect(calls[1]?.url.pathname).toBe("/orders/v2/orders");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("idem-9");
    expect(calls[1]?.headers.get("x-provenance-token")).toBe("prov-token");
    expect(signer).toHaveBeenCalledWith(instruction, { signerAddress: SIGNER, order: stakeEnvelope });
  });

  it("follows the link's path against baseUrl, ignoring the origin the gateway reported", async () => {
    const { fetch, calls } = fakeFetch(authorWithFees("https://api.dev.tao.com/orders/v2/orders"), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await client.submitAuthored(await client.authorOrder(request), { signer });
    expect(calls[1]?.url.origin).toBe(BASE);
    expect(calls[1]?.url.pathname).toBe("/orders/v2/orders");
  });

  it("refuses an instruction link outside /orders/", async () => {
    const { fetch, calls } = fakeFetch(authorWithFees("https://evil.test/steal"));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const authored = await client.authorOrder(request);
    await expect(client.submitAuthored(authored, { signer })).rejects.toThrow(/outside \/orders\//);
    expect(calls).toHaveLength(1);
  });

  it("falls back to /orders/v2/orders when no link was returned, and accepts an ed25519 signature", async () => {
    const noLink = hal(200, { order: stakeEnvelope, instruction }, { "x-provenance-token": "prov-token" });
    const { fetch, calls } = fakeFetch(noLink, hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const authored = await client.authorOrder(request);
    expect(authored.instructionHref).toBeUndefined();
    const ledgerSigner: InstructionSigner = async () => ({ type: "ed25519", value: "0xbeef" });
    await client.submitAuthored(authored, { signer: ledgerSigner });
    expect(calls[1]?.url.pathname).toBe("/orders/v2/orders");
    expect((calls[1]?.body as { signedInstruction: unknown }).signedInstruction).toEqual({ type: "ed25519", value: "0xbeef" });
  });
});

describe("slippage limits and legs", () => {
  const ALPHA1 = "urn:bittensor:mainnet:alpha:1";
  const ALPHA2 = "urn:bittensor:mainnet:alpha:2";
  const OTHER = "5EYCAe5jLQhn6ofDSvsxWyyxAbcVxHxTKwQfhfZHLG7fZUJG";
  const envelopeOf = (over: object) => ({ ...stakeEnvelope, ...over });
  const authorWith = (envelope: object) =>
    hal(200, { _links: { instruction: { href: `${BASE}/orders/v2/orders` } }, order: envelope, instruction }, { "x-provenance-token": "prov-token" });

  it("sends limitPrice on the leg it is set on (bigint or digits), and only there", async () => {
    const { fetch, calls } = fakeFetch(authorWith(envelopeOf({ type: "tao_to_alpha" })));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await client.authorOrder({
      source: { currency: NATIVE, amount: "1000000000" },
      destination: { currency: ALPHA1, address: HOTKEY, limitPrice: 1_050_000_000n },
      signerAddress: SIGNER,
    });
    expect(calls[0]?.body).toEqual({
      source: { currency: NATIVE, amount: "1000000000" },
      destination: { currency: ALPHA1, address: HOTKEY, limitPrice: "1050000000" },
      signerAddress: SIGNER,
    });

    const sell = fakeFetch(authorWith(envelopeOf({ type: "alpha_to_tao" })));
    await new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: sell.fetch }).authorOrder({
      source: { currency: ALPHA1, amount: "5", address: HOTKEY, limitPrice: "950000000" },
      destination: { currency: NATIVE },
      signerAddress: SIGNER,
    });
    expect(sell.calls[0]?.body).toMatchObject({ source: { limitPrice: "950000000" } });
    expect(sell.calls[0]?.body).not.toHaveProperty("destination.limitPrice");
  });

  it("rejects a malformed limitPrice before any request", async () => {
    const { fetch } = fakeFetch();
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(
      client.authorOrder({
        source: { currency: NATIVE, amount: "1" },
        destination: { currency: ALPHA1, address: HOTKEY, limitPrice: "1.05" },
        signerAddress: SIGNER,
      }),
    ).rejects.toThrow(/destination.limitPrice/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps two different hotkeys different (a validator move) and fills only a missing one", async () => {
    const a = fakeFetch(authorWith(envelopeOf({ type: "alpha_swap_move" })));
    await new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: a.fetch }).authorOrder({
      source: { currency: ALPHA1, amount: "5", address: HOTKEY },
      destination: { currency: ALPHA2, address: OTHER, limitPrice: "1000000000" },
      signerAddress: SIGNER,
    });
    const body = a.calls[0]?.body as { source: { address: string }; destination: { address: string } };
    expect(body.source.address).toBe(HOTKEY);
    expect(body.destination.address).toBe(OTHER);

    const b = fakeFetch(authorWith(envelopeOf({ type: "alpha_swap" })));
    await new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch: b.fetch }).authorOrder({
      source: { currency: ALPHA1, amount: "5", address: HOTKEY },
      destination: { currency: ALPHA2, limitPrice: "1000000000" },
      signerAddress: SIGNER,
    });
    expect((b.calls[0]?.body as { destination: { address: string } }).destination.address).toBe(HOTKEY);
  });

  it("registers the authored envelope verbatim, limitPrice included", async () => {
    const envelope = envelopeOf({
      type: "tao_to_alpha",
      destination: { currency: ALPHA1, address: HOTKEY, limitPrice: "1050000000" },
    });
    const { fetch, calls } = fakeFetch(authorWith(envelope), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await client.placeMarketOrder({
      source: { currency: NATIVE, amount: "1000000000" },
      destination: { currency: ALPHA1, address: HOTKEY, limitPrice: "1050000000" },
      signerAddress: SIGNER,
      signer,
    });
    expect((calls[1]?.body as { order: unknown }).order).toEqual(envelope);
  });
});

describe("validator hotkey resolution", () => {
  const OWN = "5EYCAe5jLQhn6ofDSvsxWyyxAbcVxHxTKwQfhfZHLG7fZUJG";
  const run = async (options: { hotkey?: string }, call: (c: OrderServiceClient) => Promise<unknown>) => {
    const { fetch, calls } = fakeFetch(authorResponse(), hal(201, orderResponse()));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch, ...options });
    await call(client);
    return calls[0]?.body as { source: { address?: string }; destination: { address?: string } };
  };

  it("uses the client default when the call sets no hotkey", async () => {
    const body = await run({ hotkey: OWN }, (c) =>
      c.stakeToRoot({ amount: "1", signerAddress: SIGNER, signer }),
    );
    expect(body.destination.address).toBe(OWN);
  });

  it("lets a call hotkey override the client default", async () => {
    const body = await run({ hotkey: OWN }, (c) =>
      c.unstakeFromRoot({ amount: "1", hotkey: HOTKEY, signerAddress: SIGNER, signer }),
    );
    expect(body.source.address).toBe(HOTKEY);
  });

  it("fills only alpha legs, and reuses the other leg's address", async () => {
    const body = await run({ hotkey: OWN }, (c) =>
      c.placeMarketOrder({
        source: { currency: "urn:bittensor:mainnet:alpha:18", amount: "1", address: HOTKEY },
        destination: { currency: "urn:bittensor:mainnet:alpha:44" },
        signerAddress: SIGNER,
        signer,
      }),
    );
    expect(body.source.address).toBe(HOTKEY);
    expect(body.destination.address).toBe(HOTKEY);
    const tao = await run({ hotkey: OWN }, (c) =>
      c.placeMarketOrder({
        source: { currency: NATIVE, amount: "1" },
        destination: { currency: "urn:bittensor:mainnet:alpha:18" },
        signerAddress: SIGNER,
        signer,
      }),
    );
    expect(tao.source).not.toHaveProperty("address");
    expect(tao.destination.address).toBe(OWN);
  });

  it("does not apply the exported tao.com hotkeys unless asked", async () => {
    const { fetch } = fakeFetch();
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(client.stakeToRoot({ amount: "1", signerAddress: SIGNER, signer })).rejects.toThrow(
      /No validator hotkey/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(TAO_COM_VALIDATOR_HOTKEYS.mainnet).toBe("5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN");
    expect(TAO_COM_VALIDATOR_HOTKEYS.testnet).toBe("5HDmsjdFG53WG7WHjnS1HW6Eymz1BR6zgAhxXHMERFczeaAt");
  });
});

describe("transport failures", () => {
  it("wraps fetch rejections", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("boom");
    }) as unknown as typeof globalThis.fetch;
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(client.getOrder("x")).rejects.toBeInstanceOf(OrderServiceNetworkError);
  });

  it("wraps non-problem error bodies", async () => {
    const { fetch } = fakeFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    await expect(client.getOrder("x")).rejects.toBeInstanceOf(OrderServiceNetworkError);
  });

  it("surfaces the gateway's status and www-authenticate reason on a non-problem 401", async () => {
    const { fetch } = fakeFetch(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "www-authenticate": 'Bearer scope="" error="invalid_token"' },
      }),
    );
    const client = new OrderServiceClient({ baseUrl: BASE, auth: "jwt", fetch });
    const error = await client.getOrder("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderServiceNetworkError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toContain('error="invalid_token"');
    expect((error as Error).message).toContain("Unauthorized");
  });
});
