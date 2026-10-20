import { OrderServiceError, OrderServiceNetworkError, type Problem } from "./errors.js";

export type FetchLike = typeof fetch;
export type AuthSource = string | (() => string | Promise<string>);

export interface HttpOptions {
  baseUrl: string;
  auth?: AuthSource | undefined;
  fetch: FetchLike;
  timeoutMs: number;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestInput {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the bearer token. */
  authenticated?: boolean;
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Problem).type === "string" &&
    typeof (value as Problem).title === "string"
  );
}

export class Http {
  constructor(private readonly options: HttpOptions) {}

  async request<T>(input: RequestInput): Promise<HttpResponse<T>> {
    const url = new URL(this.options.baseUrl.replace(/\/+$/, "") + input.path);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: "application/hal+json, application/problem+json" };
    // Content-Type only with a body: the service rejects an empty JSON body.
    if (input.body !== undefined) headers["content-type"] = "application/json";
    if (input.authenticated) {
      const token = await this.token();
      headers.authorization = `Bearer ${token}`;
    }
    Object.assign(headers, input.headers);

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new OrderServiceNetworkError(`${input.method} ${input.path} failed`, { cause });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      if (isProblem(parsed)) throw new OrderServiceError(parsed);
      // Not the service's problem+json: usually the API gateway (e.g. a JWT authorizer 401).
      const reason = response.headers.get("www-authenticate");
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "");
      throw new OrderServiceNetworkError(
        `${input.method} ${input.path} returned HTTP ${response.status} without a problem body` +
          (reason !== null ? ` (www-authenticate: ${reason})` : "") +
          (detail !== "" && detail !== '""' ? `: ${detail.slice(0, 200)}` : ""),
        { status: response.status },
      );
    }
    return { status: response.status, headers: response.headers, body: parsed as T };
  }

  private async token(): Promise<string> {
    const { auth } = this.options;
    if (auth === undefined) {
      throw new Error("This call needs a bearer token: pass `auth` to the OrderServiceClient.");
    }
    return typeof auth === "function" ? await auth() : auth;
  }
}
