import { describe, expect, it, vi } from "vitest";

import { AuthenticationError, createWalletAuth } from "../src/index.js";

const BASE = "https://auth.test";
const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
// A real server nonce: base64url, padded, with bytes that differ between base64 and base64url.
const NONCE_BYTES = new TextEncoder().encode("<Bytes>Sign in to TAO.com. Nonce: t-VeGq?>~</Bytes>");
const NONCE = btoa(String.fromCharCode(...NONCE_BYTES)).replace(/\+/g, "-").replace(/\//g, "_");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Call = { path: string; body: Record<string, unknown> };
type Handler = (call: Call) => Response;

function server(handlers: Handler[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const raw = String(init?.body);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw)); // the token exchange posts a form
    }
    const call = { path: url.pathname + url.search, body };
    calls.push(call);
    const handler = handlers.shift();
    if (handler === undefined) throw new Error(`unexpected request ${call.path}`);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const challenge = (tokenUri = "/auth/challenge"): Handler => () =>
  json(401, { token_uri: tokenUri, nonce: NONCE, session: "sess-1" });
const tokens = (access: string, expiresIn = 3600): Handler => () =>
  json(200, { access_token: access, token_type: "Bearer", refresh_token: "refresh-1", expires_in: expiresIn });
const refreshed = (access: string, expiresIn = 3600): Handler => () =>
  json(200, { access_token: access, token_type: "Bearer", expires_in: expiresIn });

function make(handlers: Handler[], extra: { now?: () => number; sign?: (m: Uint8Array) => string } = {}) {
  const s = server(handlers);
  const auth = createWalletAuth({
    authBaseUrl: BASE,
    address: ADDRESS,
    sign: extra.sign ?? (() => "0x01"),
    fetch: s.fetch,
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { auth, ...s };
}

describe("login", () => {
  it("new wallet: posts token_uri verbatim and signs the decoded nonce bytes", async () => {
    const sign = vi.fn((_m: Uint8Array) => "abcd");
    const { auth, calls } = make([challenge("/auth/challenge?nonce=XYZ&type=SS58_42"), tokens("jwt-1")], { sign });
    expect(await auth.getToken()).toBe("jwt-1");
    expect(calls[0]).toEqual({ path: "/auth", body: { type: "SS58_42", username: ADDRESS } });
    expect(calls[1]).toEqual({
      path: "/auth/challenge?nonce=XYZ&type=SS58_42",
      body: { username: ADDRESS, answer: "0xabcd", session: "sess-1" },
    });
    expect(Array.from(sign.mock.calls[0]![0])).toEqual(Array.from(NONCE_BYTES));
  });

  it("existing wallet: bare /auth/challenge, and an already 0x-prefixed signature is not doubled", async () => {
    const { auth, calls } = make([challenge(), tokens("jwt-1")], { sign: () => "0xbeef" });
    await auth.getToken();
    expect(calls[1]?.path).toBe("/auth/challenge");
    expect(calls[1]?.body.answer).toBe("0xbeef");
  });

  it("reduces an absolute token_uri to path and query", async () => {
    const { auth, calls } = make([challenge("https://other.test/auth/challenge?nonce=Q&type=SS58_42"), tokens("jwt-1")]);
    await auth.getToken();
    expect(calls[1]?.path).toBe("/auth/challenge?nonce=Q&type=SS58_42");
  });

  it("starts over once on 409 (registered after the challenge was issued), but not twice", async () => {
    const a = make([challenge("/auth/challenge?nonce=Q"), () => json(409, { error: "exists" }), challenge(), tokens("jwt-1")]);
    expect(await a.auth.getToken()).toBe("jwt-1");
    expect(a.calls[3]?.path).toBe("/auth/challenge");

    const b = make([challenge(), () => json(409, {}), challenge(), () => json(409, {})]);
    await expect(b.auth.getToken()).rejects.toMatchObject({ code: "HTTP_ERROR", status: 409 });
  });

  it("maps a rejected signature to UNAUTHORIZED with the body", async () => {
    const { auth } = make([challenge(), () => json(401, "Invalid answer")]);
    await expect(auth.getToken()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401, body: "Invalid answer" });
  });

  it("rejects an unexpected challenge status, a malformed challenge and a malformed token response", async () => {
    await expect(make([() => json(200, { access_token: "x" })]).auth.getToken()).rejects.toMatchObject({ code: "HTTP_ERROR", status: 200 });
    await expect(make([() => json(401, { nonce: NONCE })]).auth.getToken()).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(make([challenge(), () => json(200, { access_token: "x" })]).auth.getToken()).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("wraps network failures", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch;
    const auth = createWalletAuth({ authBaseUrl: BASE, address: ADDRESS, sign: () => "0x01", fetch });
    const error = await auth.getToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("token lifetime", () => {
  it("reuses the token until 30s before expiry, then refreshes with the original refresh token", async () => {
    let now = 0;
    const { auth, calls } = make(
      [challenge(), tokens("jwt-1", 3600), refreshed("jwt-2", 3600), refreshed("jwt-3", 3600)],
      { now: () => now },
    );
    expect(await auth.getToken()).toBe("jwt-1");
    now = 3600_000 - 31_000;
    expect(await auth.getToken()).toBe("jwt-1");
    expect(calls).toHaveLength(2);
    now = 3600_000 - 29_000;
    expect(await auth.getToken()).toBe("jwt-2");
    expect(calls[2]?.body).toEqual({ type: "REFRESH_TOKEN", username: ADDRESS, refresh_token: "refresh-1" });
    now = 2 * 3600_000;
    expect(await auth.getToken()).toBe("jwt-3");
    expect(calls[3]?.body).toMatchObject({ refresh_token: "refresh-1" }); // still the original
  });

  it("falls back to a full login when the refresh token is rejected (401)", async () => {
    let now = 0;
    const { auth, calls } = make(
      [challenge(), tokens("jwt-1", 100), () => json(401, "Unauthorized"), challenge(), tokens("jwt-2")],
      { now: () => now },
    );
    await auth.getToken();
    now = 200_000;
    expect(await auth.getToken()).toBe("jwt-2");
    expect(calls.map((c) => c.path)).toEqual(["/auth", "/auth/challenge", "/auth", "/auth", "/auth/challenge"]);
  });

  it("does not hide a non-401 refresh failure behind a new login", async () => {
    let now = 0;
    const { auth, calls } = make([challenge(), tokens("jwt-1", 100), () => json(500, "boom")], { now: () => now });
    await auth.getToken();
    now = 200_000;
    await expect(auth.getToken()).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
    expect(calls).toHaveLength(3);
  });

  it("does a full login instead of refreshing once the refresh token is within 30 minutes of its 7 days", async () => {
    let now = 0;
    const { auth, calls } = make(
      [challenge(), tokens("jwt-1", 3600), challenge(), tokens("jwt-2", 3600)],
      { now: () => now },
    );
    await auth.getToken();
    now = 7 * DAY - 29 * MIN; // access token long expired, refresh token about to expire
    expect(await auth.getToken()).toBe("jwt-2");
    expect(calls.map((c) => c.body.type ?? "answer")).toEqual(["SS58_42", "answer", "SS58_42", "answer"]);
  });

  it("also replaces a still-valid access token when the refresh token is due for renewal", async () => {
    let now = 0;
    const { auth } = make([challenge(), tokens("jwt-1", 8 * 24 * 3600), challenge(), tokens("jwt-2")], { now: () => now });
    await auth.getToken();
    now = 7 * DAY - 10 * MIN;
    expect(await auth.getToken()).toBe("jwt-2");
  });

  it("logs in again when the refresh token has expired", async () => {
    let now = 0;
    const { auth } = make([challenge(), tokens("jwt-1", 100), challenge(), tokens("jwt-2")], { now: () => now });
    await auth.getToken();
    now = 8 * DAY;
    expect(await auth.getToken()).toBe("jwt-2");
  });

  it("shares one login between concurrent callers, and reset() forces a new one", async () => {
    const { auth, calls } = make([challenge(), tokens("jwt-1"), challenge(), tokens("jwt-2")]);
    expect(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()])).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    expect(calls).toHaveLength(2);
    auth.reset();
    expect(await auth.getToken()).toBe("jwt-2");
  });

  it("a failed login does not poison later calls", async () => {
    const { auth } = make([() => json(500, "down"), challenge(), tokens("jwt-1")]);
    await expect(auth.getToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(await auth.getToken()).toBe("jwt-1");
  });
});


// ---- delegate (token exchange) lifecycle -----------------------------------------------------------

describe("delegate token", () => {
  const exchanged = (access: string, expiresIn = 1800): Handler => () =>
    json(200, { access_token: access, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: expiresIn });
  const delegate = { actorTokenType: "demo:actor", actorToken: "init-data", params: { bot_id: "42" } };

  function makeWith(handlers: Handler[], opts: { now?: () => number; delegate?: Parameters<typeof createWalletAuth>[0]["delegate"] } = {}) {
    const s = server(handlers);
    const auth = createWalletAuth({
      authBaseUrl: BASE,
      address: ADDRESS,
      sign: () => "0x01",
      fetch: s.fetch,
      delegate: opts.delegate ?? delegate,
      ...(opts.now ? { now: opts.now } : {}),
    });
    return { auth, ...s };
  }

  it("logs in, exchanges the wallet token, and returns the delegate token", async () => {
    const { auth, calls } = makeWith([challenge(), tokens("wallet.jwt"), exchanged("delegate.jwt")]);
    expect(await auth.getToken()).toBe("delegate.jwt");
    expect(calls.map((c) => c.path)).toEqual(["/auth", "/auth/challenge", "/auth/tokens"]);
  });

  it("sends the wallet access token as the subject and the delegate options as the actor", async () => {
    const { auth, calls } = makeWith([challenge(), tokens("wallet.jwt"), exchanged("delegate.jwt")]);
    await auth.getToken();
    expect(calls[2]?.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "wallet.jwt",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      actor_token: "init-data",
      actor_token_type: "demo:actor",
      bot_id: "42",
    });
  });

  it("reuses the delegate token until 30s before it expires", async () => {
    let now = 0;
    const { auth, calls } = makeWith([challenge(), tokens("wallet.jwt", 3600), exchanged("delegate-1", 1800), exchanged("delegate-2", 1800)], { now: () => now });
    expect(await auth.getToken()).toBe("delegate-1");
    now = 1_700_000;
    expect(await auth.getToken()).toBe("delegate-1");
    expect(calls).toHaveLength(3);
    now = 1_771_000; // inside the 30s buffer
    expect(await auth.getToken()).toBe("delegate-2");
    // The wallet token (valid for an hour) was reused: only the exchange ran again.
    expect(calls.map((c) => c.path)).toEqual(["/auth", "/auth/challenge", "/auth/tokens", "/auth/tokens"]);
  });

  it("when the delegate expires after the wallet token did too, refreshes the wallet token and exchanges again", async () => {
    let now = 0;
    const { auth, calls } = makeWith(
      [challenge(), tokens("wallet-1", 1000), exchanged("delegate-1", 1800), refreshed("wallet-2", 3600), exchanged("delegate-2", 1800)],
      { now: () => now },
    );
    await auth.getToken();
    now = 1_800_000;
    expect(await auth.getToken()).toBe("delegate-2");
    expect(calls.map((c) => c.body.type ?? c.path)).toEqual(["SS58_42", "/auth/challenge", "/auth/tokens", "REFRESH_TOKEN", "/auth/tokens"]);
  });

  it("on invalid_grant, signs in again and retries the exchange once", async () => {
    const { auth, calls } = makeWith([
      challenge(), tokens("wallet-1"), () => json(400, { error: "invalid_grant", error_description: "subject_token is not valid" }),
      challenge(), tokens("wallet-2"), exchanged("delegate-1"),
    ]);
    expect(await auth.getToken()).toBe("delegate-1");
    expect(calls.map((c) => c.path)).toEqual(["/auth", "/auth/challenge", "/auth/tokens", "/auth", "/auth/challenge", "/auth/tokens"]);
  });

  it("does not retry other exchange failures, and does not cache them", async () => {
    const { auth } = makeWith([challenge(), tokens("wallet-1"), () => json(400, { error: "invalid_request", error_description: "signature is not valid" }), exchanged("delegate-1")]);
    await expect(auth.getToken()).rejects.toMatchObject({ oauthError: "invalid_request" });
    expect(await auth.getToken()).toBe("delegate-1"); // the wallet token was kept; only the exchange ran again
  });

  it("reads the actor token fresh on every exchange", async () => {
    let now = 0;
    let launch = 0;
    const actorToken = vi.fn(() => `init-${++launch}`);
    const { auth, calls } = makeWith([challenge(), tokens("wallet-1", 7200), exchanged("delegate-1", 100), exchanged("delegate-2", 100)], {
      now: () => now,
      delegate: { actorTokenType: "demo:actor", actorToken },
    });
    await auth.getToken();
    now = 200_000;
    await auth.getToken();
    expect(actorToken).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.path === "/auth/tokens").map((c) => c.body.actor_token)).toEqual(["init-1", "init-2"]);
  });

  it("shares one login and exchange between concurrent callers, and reset() forces a new session", async () => {
    const { auth, calls } = makeWith([challenge(), tokens("wallet-1"), exchanged("delegate-1"), challenge(), tokens("wallet-2"), exchanged("delegate-2")]);
    expect(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()])).toEqual(["delegate-1", "delegate-1", "delegate-1"]);
    expect(calls).toHaveLength(3);
    auth.reset();
    expect(await auth.getToken()).toBe("delegate-2");
  });

  it("without the delegate option nothing changes: the wallet token is returned and /auth/tokens is never called", async () => {
    const { auth, calls } = make([challenge(), tokens("wallet-1")]);
    expect(await auth.getToken()).toBe("wallet-1");
    expect(calls.map((c) => c.path)).not.toContain("/auth/tokens");
  });
});
