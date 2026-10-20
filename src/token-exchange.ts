import { AuthenticationError } from "./errors.js";
import type { FetchLike } from "./http.js";

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface TokenExchangeOptions {
  /** Origin of the tao.com authentication service. The exchange is `POST {authBaseUrl}/auth/tokens`. */
  authBaseUrl: string;
  /** The wallet-ownership access token, e.g. from `createWalletAuth(...).getToken()`. */
  subjectToken: string;
  /**
   * Which integration is vouching for this session. The auth service supports a fixed set of
   * types; each validates `actorToken` its own way and may need extra form fields in `params`.
   */
  actorTokenType: string;
  /** The integration's proof (for example a signed launch payload). Sent as one form field, so do not pre-encode it. */
  actorToken: string;
  /** Further form fields the actor type requires. They must not repeat the standard fields. */
  params?: Record<string, string>;
  fetch?: FetchLike;
}

/** A delegate token: the wallet's access token re-issued to an integration. Same power, no refresh token. */
export interface DelegateToken {
  accessToken: string;
  tokenType: "Bearer";
  /** Seconds until it expires (1800 at the time of writing). */
  expiresIn: number;
}

const STANDARD_FIELDS = new Set([
  "grant_type",
  "subject_token",
  "subject_token_type",
  "actor_token",
  "actor_token_type",
]);

/**
 * Exchange a wallet-ownership access token for a delegate token that names the integration
 * (RFC 8693 token exchange). The delegate token goes wherever the access token would: the
 * order service reads the same `username` claim from it. It carries an `act` claim naming the
 * integration, and no refresh token is issued: when it expires, get a fresh wallet access token
 * (refresh token or a new login) and exchange again. `createWalletAuth({ delegate })` does that.
 *
 * Failures throw `AuthenticationError`. `oauthError` carries the service's `error`;
 * `invalid_grant` means the wallet token was rejected (expired or wrong client), so refresh it and retry.
 */
export async function exchangeToken(options: TokenExchangeOptions): Promise<DelegateToken> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const form = new URLSearchParams();
  form.set("grant_type", TOKEN_EXCHANGE_GRANT);
  form.set("subject_token", options.subjectToken);
  form.set("subject_token_type", ACCESS_TOKEN_TYPE);
  form.set("actor_token", options.actorToken);
  form.set("actor_token_type", options.actorTokenType);
  for (const [name, value] of Object.entries(options.params ?? {})) {
    if (STANDARD_FIELDS.has(name)) throw new RangeError(`params must not set the standard field ${name}`);
    form.set(name, value);
  }

  let response: Response;
  try {
    response = await doFetch(`${options.authBaseUrl.replace(/\/+$/, "")}/auth/tokens`, {
      method: "POST",
      // A string body with an explicit type, as the service accepts only form data (optionally utf-8).
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (cause) {
    throw new AuthenticationError("NETWORK_ERROR", "POST /auth/tokens failed", { cause });
  }

  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text === "" ? "" : JSON.parse(text);
  } catch {
    // keep the raw text
  }
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const oauthError = typeof fields.error === "string" ? fields.error : undefined;
  const description = typeof fields.error_description === "string" ? fields.error_description : undefined;

  if (!response.ok) {
    const message = `token exchange rejected (HTTP ${response.status}${oauthError ? `, ${oauthError}` : ""})${description ? `: ${description}` : ""}`;
    throw new AuthenticationError(oauthError === "invalid_grant" || response.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR", message, {
      status: response.status,
      body,
      ...(oauthError !== undefined ? { oauthError } : {}),
    });
  }
  // The service can answer 200 with an error body (its Cognito-failure path), so check the shape.
  if (typeof fields.access_token !== "string" || typeof fields.expires_in !== "number") {
    throw new AuthenticationError("PROTOCOL", `malformed token exchange response${description ? `: ${description}` : ""}`, {
      status: response.status,
      body,
      ...(oauthError !== undefined ? { oauthError } : {}),
    });
  }
  return { accessToken: fields.access_token, tokenType: "Bearer", expiresIn: fields.expires_in };
}
