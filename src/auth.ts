import { AuthenticationError } from "./errors.js";
import { DEFAULT_AUTH_BASE_URL, trimTrailingSlashes, type FetchLike } from "./http.js";
import { exchangeToken } from "./token-exchange.js";

/**
 * Signs the exact challenge bytes with the wallet key and returns the signature as hex.
 * The service accepts sr25519 or ed25519. Sign the bytes verbatim: the server already wrapped
 * them as `<Bytes>…</Bytes>`, so do not wrap, hash or re-encode them.
 */
export type ChallengeSigner = (message: Uint8Array) => Promise<string> | string;

export interface WalletAuthOptions {
  /**
   * Origin of the tao.com authentication service (`POST /auth`). Default `https://api.tao.com`
   * (production); pass `https://api.dev.tao.com` for testnet.
   */
  authBaseUrl?: string;
  /** SS58 wallet address. It becomes the token's `username`, which the orders API requires to equal `signerAddress`. */
  address: string;
  sign: ChallengeSigner;
  fetch?: FetchLike;
  /**
   * Hand out a delegate token instead of the wallet's own access token: after logging in (or
   * refreshing), the SDK exchanges the access token for one that names an integration, and
   * `getToken()` returns that. The delegate token has no refresh token, so when it expires the
   * SDK gets a current wallet access token (cached, refreshed, or a new login) and exchanges again.
   */
  delegate?: DelegateOptions;
  /** Clock, for tests. */
  now?: () => number;
}

export interface ApiKeyAuthOptions {
  /** Origin of the tao.com authentication service. Default `https://api.tao.com`; `https://api.dev.tao.com` for testnet. */
  authBaseUrl?: string;
  /** Key ID from the partner dashboard (a UUID). It becomes the token's `username`. */
  apiKey: string;
  /** The key's secret, shown once when the key was created. Keep it on a server. */
  apiSecret: string;
  /** Custom `fetch` (defaults to the global one). */
  fetch?: FetchLike;
  /** Clock, for tests. */
  now?: () => number;
}

export interface DelegateOptions {
  /** The integration type the auth service should validate, see `exchangeToken`. */
  actorTokenType: string;
  /** Called on every exchange, so a launch payload that changes is read fresh. */
  actorToken: string | (() => string | Promise<string>);
  /** Extra form fields the actor type needs. */
  params?: Record<string, string>;
}

/** A token source for `OrderServiceClient`'s `auth`. */
export interface TokenAuth {
  /**
   * A valid access token: cached, refreshed, or freshly logged in as needed. Concurrent callers
   * share one login. Pass to the client as `auth: () => tokenAuth.getToken()`.
   */
  getToken(): Promise<string>;
  /** Forget the session; the next `getToken` logs in again. */
  reset(): void;
}

/** @deprecated Use `TokenAuth`. */
export type WalletAuth = TokenAuth;

// Lifetimes, as the tao.com apps use them. A refresh does not issue a new refresh token, so
// once the refresh token nears the end of its life a full login replaces it.
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 30_000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_RENEWAL_WINDOW_MS = 30 * 60 * 1000;

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenIssuedAt: number;
}

interface Challenge {
  token_uri: string;
  nonce: string;
  session: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function base64UrlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** `token_uri` is posted back as returned, query string included. An absolute URL is reduced to path + query. */
function resolveAuthPath(tokenUri: string): string {
  if (/^https?:\/\//i.test(tokenUri)) {
    const url = new URL(tokenUri);
    return `${url.pathname}${url.search}`;
  }
  return tokenUri.startsWith("/") ? tokenUri : `/${tokenUri}`;
}

/**
 * Wallet-ownership login against the tao.com authentication service, with token caching and
 * refresh. The first successful login for a wallet that is not registered yet creates its account.
 *
 *   POST /auth {type: SS58_42, username}              -> 401 {token_uri, nonce, session}
 *   sign(base64url-decoded nonce)
 *   POST <token_uri> {username, answer, session}      -> 200 {access_token, refresh_token, expires_in}
 *   POST /auth {type: REFRESH_TOKEN, username, refresh_token} -> 200 {access_token, expires_in}
 */
export function createWalletAuth(options: WalletAuthOptions): TokenAuth {
  return createSessionAuth({
    authBaseUrl: options.authBaseUrl,
    username: options.address,
    fetch: options.fetch,
    now: options.now,
    delegate: options.delegate,
    async login(post, sessionFrom) {
      const attempt = async (isRetry: boolean): Promise<Session> => {
        // The service always answers 401 with the challenge, so 401 is the success path here.
        const challenge = (await post("/auth", { type: "SS58_42", username: options.address }, [401])) as Challenge;
        if (!challenge?.token_uri || !challenge.nonce || !challenge.session) {
          throw new AuthenticationError("PROTOCOL", "malformed challenge response", { body: challenge });
        }
        const signature = await options.sign(base64UrlToBytes(challenge.nonce));
        const answer = signature.startsWith("0x") ? signature : `0x${signature}`;
        try {
          const tokens = await post(
            resolveAuthPath(challenge.token_uri),
            { username: options.address, answer, session: challenge.session },
            [200],
          );
          return sessionFrom(tokens as TokenResponse);
        } catch (error) {
          // 409: the wallet was registered after this challenge was issued (a concurrent first
          // login). A fresh challenge is now the existing-user one, so start over once.
          if (error instanceof AuthenticationError && error.status === 409 && !isRetry) return attempt(true);
          throw error;
        }
      };
      return attempt(false);
    },
  });
}

/**
 * API-key login for partner apps (a key from the TAO.com partner dashboard), with token caching and
 * refresh.
 *
 *   POST /auth {type: API_KEY, username: apiKey, password: apiSecret} -> 200 {access_token, refresh_token, expires_in}
 *   POST /auth {type: REFRESH_TOKEN, username: apiKey, refresh_token}  -> 200 {access_token, expires_in}
 *
 * Orders you register with this token are attributed to the partner ID you set in the partner
 * dashboard: the order service reads it from the key, so you pass nothing for it.
 *
 * The app authenticates with the key; your users' wallets still sign every order (`signer`). With
 * this token the order service lets you author and register orders for any wallet, and read and
 * finish the orders you registered. Listing, cancelling and deleting a wallet's orders need the
 * wallet's own token (`createWalletAuth`).
 *
 * @throws RangeError synchronously when `apiKey` or `apiSecret` is empty, when it runs in a browser page or
 *   worker or in React Native, or when `authBaseUrl` isn't an absolute URL using https (http only for localhost).
 */
export function createApiKeyAuth(options: ApiKeyAuthOptions): TokenAuth {
  if (!options.apiKey || !options.apiSecret) throw new RangeError("apiKey and apiSecret are required");
  if (isBrowser()) {
    throw new RangeError(
      "createApiKeyAuth runs on a server only: in a browser the API secret is visible to your users. " +
        "Get the token from your own backend and pass it to the client as `auth`.",
    );
  }
  assertSecureOrigin(options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL);
  return createSessionAuth({
    authBaseUrl: options.authBaseUrl,
    username: options.apiKey,
    fetch: options.fetch,
    now: options.now,
    async login(post, sessionFrom) {
      const tokens = await post("/auth", { type: "API_KEY", username: options.apiKey, password: options.apiSecret }, [200]);
      return sessionFrom(tokens as TokenResponse);
    },
  });
}

type Post = (path: string, body: unknown, expected: number[]) => Promise<unknown>;

/** Client code that ships to users: a browser page or worker, React Native, or a browser-like test environment. */
function isBrowser(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown; importScripts?: unknown; navigator?: { product?: unknown } };
  const page = typeof scope.window === "object" && scope.window !== null && typeof scope.document === "object";
  return page || typeof scope.importScripts === "function" || scope.navigator?.product === "ReactNative";
}

/** The API secret is long-lived, so it only travels over HTTPS (plain HTTP only to this machine). */
function assertSecureOrigin(authBaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(authBaseUrl);
  } catch {
    throw new RangeError("authBaseUrl must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new RangeError("authBaseUrl must use https (http is allowed for localhost only)");
  }
}

/** A malformed reply may still hold live tokens: errors keep only which fields it had. */
function redacted(reply: unknown): unknown {
  return reply !== null && typeof reply === "object" ? { fields: Object.keys(reply) } : typeof reply;
}

interface SessionAuthCore {
  authBaseUrl?: string | undefined;
  /** Cognito username: sent with refreshes. */
  username: string;
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  delegate?: DelegateOptions | undefined;
  login(post: Post, sessionFrom: (tokens: TokenResponse) => Session): Promise<Session>;
}

/** Caching, refresh and the optional delegate exchange, shared by every login type. */
function createSessionAuth(options: SessionAuthCore): TokenAuth {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = trimTrailingSlashes(options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL);
  const now = options.now ?? Date.now;
  let session: Session | undefined;
  let inFlight: Promise<string> | undefined;
  let delegateToken: { accessToken: string; expiresAt: number } | undefined;

  async function post(path: string, body: unknown, expected: number[]): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AuthenticationError("NETWORK_ERROR", `POST ${path} failed`, { cause });
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = text === "" ? "" : JSON.parse(text);
    } catch {
      // keep the raw text
    }
    if (expected.includes(response.status)) return parsed;
    if (response.status === 401) {
      throw new AuthenticationError("UNAUTHORIZED", `authentication failed (HTTP 401)`, {
        status: 401,
        body: parsed,
      });
    }
    throw new AuthenticationError("HTTP_ERROR", `HTTP ${response.status}`, {
      status: response.status,
      body: parsed,
    });
  }

  function sessionFrom(tokens: TokenResponse): Session {
    if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || typeof tokens.expires_in !== "number") {
      throw new AuthenticationError("PROTOCOL", "malformed token response", { body: redacted(tokens) });
    }
    const t = now();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: t + tokens.expires_in * 1000,
      refreshTokenIssuedAt: t,
    };
  }

  function login(): Promise<Session> {
    return options.login(post, sessionFrom);
  }

  async function refresh(current: Session): Promise<Session> {
    const refreshed = (await post(
      "/auth",
      { type: "REFRESH_TOKEN", username: options.username, refresh_token: current.refreshToken },
      [200],
    )) as { access_token?: string; expires_in?: number };
    if (typeof refreshed?.access_token !== "string" || typeof refreshed.expires_in !== "number") {
      throw new AuthenticationError("PROTOCOL", "malformed refresh response", { body: redacted(refreshed) });
    }
    // No new refresh token is issued: keep the original and its issue time.
    return { ...current, accessToken: refreshed.access_token, expiresAt: now() + refreshed.expires_in * 1000 };
  }

  async function renewSessionToken(): Promise<string> {
    const t = now();
    const current = session;
    const accessValid = current !== undefined && current.accessToken !== "" && current.expiresAt - t > ACCESS_TOKEN_EXPIRY_BUFFER_MS;
    const refreshExpiresAt = current === undefined ? 0 : current.refreshTokenIssuedAt + REFRESH_TOKEN_TTL_MS;
    const refreshUsable = current !== undefined && current.refreshToken !== "" && refreshExpiresAt > t;
    const renewDue = refreshUsable && refreshExpiresAt - t <= REFRESH_TOKEN_RENEWAL_WINDOW_MS;

    if (current !== undefined && accessValid && !renewDue) return current.accessToken;

    if (current !== undefined && refreshUsable && !renewDue) {
      try {
        session = await refresh(current);
        return session.accessToken;
      } catch (error) {
        // An expired or revoked refresh token: sign a new challenge. Anything else is a real failure.
        if (!(error instanceof AuthenticationError && error.code === "UNAUTHORIZED")) throw error;
        session = undefined;
      }
    }

    session = await login();
    return session.accessToken;
  }

  /** The wallet access token (cached, refreshed or newly logged in), exchanged for a delegate token. */
  async function renewDelegateToken(delegate: DelegateOptions): Promise<string> {
    const current = delegateToken;
    if (current !== undefined && current.expiresAt - now() > ACCESS_TOKEN_EXPIRY_BUFFER_MS) return current.accessToken;
    const exchange = async (subjectToken: string) =>
      exchangeToken({
        authBaseUrl: base,
        subjectToken,
        actorTokenType: delegate.actorTokenType,
        actorToken: typeof delegate.actorToken === "function" ? await delegate.actorToken() : delegate.actorToken,
        ...(delegate.params !== undefined ? { params: delegate.params } : {}),
        fetch: doFetch,
      });
    let delegated;
    try {
      delegated = await exchange(await renewSessionToken());
    } catch (error) {
      // The service rejected the wallet token (revoked or expired early): sign in again and exchange once more.
      if (!(error instanceof AuthenticationError && error.oauthError === "invalid_grant")) throw error;
      session = undefined;
      delegated = await exchange(await renewSessionToken());
    }
    delegateToken = { accessToken: delegated.accessToken, expiresAt: now() + delegated.expiresIn * 1000 };
    return delegateToken.accessToken;
  }

  return {
    getToken() {
      // One login, refresh or exchange at a time, however many requests ask at once.
      inFlight ??= (options.delegate !== undefined ? renewDelegateToken(options.delegate) : renewSessionToken()).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    reset() {
      session = undefined;
      delegateToken = undefined;
    },
  };
}
