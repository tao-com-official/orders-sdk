import { describe, expect, it, vi } from "vitest";

import { AuthenticationError, createApiKeyAuth } from "../src/index.js";

const BASE = "https://auth.test";
const KEY = crypto.randomUUID();

type Call = { path: string; body: Record<string, string> };
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function server(handlers: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const raw = String(init?.body);
    let body: Record<string, string>;
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const call = { path: new URL(input.toString()).pathname, body };
    calls.push(call);
    const handler = handlers.shift();
    if (handler === undefined) throw new Error(`unexpected request ${call.path}`);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const loggedIn = (access: string, expiresIn = 1800) => () =>
  json(200, { access_token: access, token_type: "Bearer", refresh_token: "refresh-1", expires_in: expiresIn });
describe("createApiKeyAuth", () => {
  it("logs in with the key and secret and returns the access token", async () => {
    const s = server([loggedIn("key.jwt")]);
    const auth = createApiKeyAuth({ authBaseUrl: BASE, apiKey: KEY, apiSecret: "secret", fetch: s.fetch });
    expect(await auth.getToken()).toBe("key.jwt");
    expect(s.calls).toEqual([{ path: "/auth", body: { type: "API_KEY", username: KEY, password: "secret" } }]);
  });

  it("refreshes with the key ID as the username, then logs in again when the refresh is refused", async () => {
    let t = 0;
    const s = server([loggedIn("a", 60), () => json(401, "Unauthorized"), loggedIn("b")]);
    const auth = createApiKeyAuth({ authBaseUrl: BASE, apiKey: KEY, apiSecret: "secret", fetch: s.fetch, now: () => t });
    expect(await auth.getToken()).toBe("a");
    t = 60_000;
    expect(await auth.getToken()).toBe("b");
    expect(s.calls[1]).toEqual({ path: "/auth", body: { type: "REFRESH_TOKEN", username: KEY, refresh_token: "refresh-1" } });
    expect(s.calls[2]!.body.type).toBe("API_KEY");
  });

  it("surfaces a wrong secret as UNAUTHORIZED, with the reply and never the request", async () => {
    const secret = "never-in-an-error-0123456789";
    const s = server([() => json(401, "Unauthorized")]);
    const auth = createApiKeyAuth({ authBaseUrl: BASE, apiKey: KEY, apiSecret: secret, fetch: s.fetch });
    const error = (await auth.getToken().catch((e: unknown) => e)) as AuthenticationError;
    expect(error).toMatchObject({ name: "AuthenticationError", code: "UNAUTHORIZED", body: "Unauthorized" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error.message)).not.toContain(secret);
    expect(String(error.cause ?? "")).not.toContain(secret);
  });

  it("keeps tokens out of the error when a reply is malformed", async () => {
    const s = server([() => json(200, { access_token: "live.jwt", expires_in: 1800 })]);
    const auth = createApiKeyAuth({ authBaseUrl: BASE, apiKey: KEY, apiSecret: "secret", fetch: s.fetch });
    const error = (await auth.getToken().catch((e: unknown) => e)) as AuthenticationError;
    expect(error).toMatchObject({ code: "PROTOCOL", body: { fields: ["access_token", "expires_in"] } });
    expect(JSON.stringify(error)).not.toContain("live.jwt");
  });

  it("keeps tokens out of the error when a refresh reply is malformed", async () => {
    let t = 0;
    const s = server([loggedIn("first.jwt", 60), () => json(200, { access_token: "live.jwt" })]);
    const auth = createApiKeyAuth({ authBaseUrl: BASE, apiKey: KEY, apiSecret: "secret", fetch: s.fetch, now: () => t });
    await auth.getToken();
    t = 60_000;
    const error = (await auth.getToken().catch((e: unknown) => e)) as AuthenticationError;
    expect(s.calls[1]!.body.type).toBe("REFRESH_TOKEN");
    expect(error).toMatchObject({ code: "PROTOCOL", body: { fields: ["access_token"] } });
    expect(JSON.stringify(error)).not.toContain("live.jwt");
  });

  it("requires a key and a secret", () => {
    expect(() => createApiKeyAuth({ apiKey: KEY, apiSecret: "" })).toThrow(RangeError);
    expect(() => createApiKeyAuth({ apiKey: "", apiSecret: "secret" })).toThrow(RangeError);
  });

  it("sends the secret over HTTPS only, or plain HTTP to this machine", () => {
    expect(() => createApiKeyAuth({ authBaseUrl: "http://api.dev.tao.com", apiKey: KEY, apiSecret: "s" })).toThrow(
      "authBaseUrl must use https",
    );
    expect(() => createApiKeyAuth({ authBaseUrl: "not a url", apiKey: KEY, apiSecret: "s" })).toThrow(RangeError);
    expect(() => createApiKeyAuth({ authBaseUrl: "http://localhost:3001", apiKey: KEY, apiSecret: "s" })).not.toThrow();
    expect(() => createApiKeyAuth({ apiKey: KEY, apiSecret: "s" })).not.toThrow();
  });

  it("refuses to run in a browser, where the secret would be visible", () => {
    const scope = globalThis as { window?: unknown; document?: unknown };
    scope.window = {};
    scope.document = {};
    try {
      expect(() => createApiKeyAuth({ apiKey: KEY, apiSecret: "s" })).toThrow("server only");
    } finally {
      delete scope.window;
      delete scope.document;
    }
  });

  it("refuses to run in a browser worker too", () => {
    const scope = globalThis as { importScripts?: unknown };
    scope.importScripts = () => {};
    try {
      expect(() => createApiKeyAuth({ apiKey: KEY, apiSecret: "s" })).toThrow("server only");
    } finally {
      delete scope.importScripts;
    }
  });

  it("refuses to run in React Native, whose bundle ships to users", () => {
    const scope = globalThis as { navigator?: unknown };
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true });
    try {
      expect(() => createApiKeyAuth({ apiKey: KEY, apiSecret: "s" })).toThrow("server only");
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete scope.navigator;
    }
  });
});
