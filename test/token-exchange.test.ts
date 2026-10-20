import { describe, expect, it, vi } from "vitest";

import { ACCESS_TOKEN_TYPE, AuthenticationError, exchangeToken, TOKEN_EXCHANGE_GRANT } from "../src/index.js";

const BASE = "https://auth.test";

function fakeFetch(response: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const base = { authBaseUrl: BASE, subjectToken: "wallet.jwt", actorTokenType: "demo:actor", actorToken: "a=1&b=two words&signature=x/y+z=" };

describe("exchangeToken", () => {
  it("posts the RFC 8693 form to /auth/tokens, encoding the actor token once", async () => {
    const { fetch, calls } = fakeFetch(
      ok({ access_token: "delegate.jwt", issued_token_type: ACCESS_TOKEN_TYPE, token_type: "Bearer", expires_in: 1800 }),
    );
    const token = await exchangeToken({ ...base, params: { bot_id: "279058397" }, fetch });

    expect(token).toEqual({ accessToken: "delegate.jwt", tokenType: "Bearer", expiresIn: 1800 });
    expect(calls[0]?.url).toBe(`${BASE}/auth/tokens`);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const sent = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: "wallet.jwt",
      subject_token_type: ACCESS_TOKEN_TYPE,
      actor_token: base.actorToken, // decodes back to exactly what was passed: encoded once, not twice
      actor_token_type: "demo:actor",
      bot_id: "279058397",
    });
    expect(String(calls[0]?.init.body)).not.toContain("%2526"); // no double encoding of '&'
  });

  it("uses the constants the service expects", () => {
    expect(TOKEN_EXCHANGE_GRANT).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(ACCESS_TOKEN_TYPE).toBe("urn:ietf:params:oauth:token-type:access_token");
  });

  it("refuses params that would override a standard field, before any request", async () => {
    const { fetch } = fakeFetch(ok({}));
    await expect(exchangeToken({ ...base, params: { subject_token: "x" }, fetch })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps invalid_grant to UNAUTHORIZED (the wallet token is no good) and keeps the OAuth error", async () => {
    const { fetch } = fakeFetch(ok({ error: "invalid_grant", error_description: "subject_token is not valid" }, 400));
    const error = await exchangeToken({ ...base, fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 400, oauthError: "invalid_grant" });
    expect((error as Error).message).toContain("subject_token is not valid");
  });

  it("maps other rejections to HTTP_ERROR with the description", async () => {
    const { fetch } = fakeFetch(ok({ error: "invalid_request", error_description: "signature is not valid" }, 400));
    await expect(exchangeToken({ ...base, fetch })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 400,
      oauthError: "invalid_request",
      message: expect.stringContaining("signature is not valid"),
    });
  });

  it("treats a 200 with an error body (the service's Cognito-failure path) as a protocol error", async () => {
    const { fetch } = fakeFetch(ok({ error: "403", error_description: "invalid_request" }));
    await expect(exchangeToken({ ...base, fetch })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects a malformed success body, and wraps network failures", async () => {
    await expect(exchangeToken({ ...base, fetch: fakeFetch(ok({ access_token: "x" })).fetch })).rejects.toMatchObject({ code: "PROTOCOL" });
    const offline = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch;
    await expect(exchangeToken({ ...base, fetch: offline })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
