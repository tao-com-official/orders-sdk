/** RFC 9457 problem body returned by the service. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  field?: string;
  requestId?: string;
}

/** The service answered with a non-2xx status. */
export class OrderServiceError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(`${problem.title}: ${problem.detail}`);
    this.name = "OrderServiceError";
    this.status = problem.status;
    this.problem = problem;
  }

  /** Last path segment of the problem type, e.g. `cancel-not-allowed`, `invalid-signature`. */
  get code(): string {
    return this.problem.type.split("/").filter(Boolean).pop() ?? "unknown";
  }

  get requestId(): string | undefined {
    return this.problem.requestId;
  }
}

/** No usable response: network failure, timeout, or a non-problem error body. */
export class OrderServiceNetworkError extends Error {
  /** HTTP status when a response arrived but was not the service's problem body. */
  readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OrderServiceNetworkError";
    this.status = options?.status;
  }
}

/** Failure talking to the tao.com authentication service (`POST /auth`). */
export class AuthenticationError extends Error {
  /** `UNAUTHORIZED` (HTTP 401: bad signature, expired session or refresh token), `HTTP_ERROR`, `NETWORK_ERROR` or `PROTOCOL` (unexpected response shape). */
  readonly code: "UNAUTHORIZED" | "HTTP_ERROR" | "NETWORK_ERROR" | "PROTOCOL";
  readonly status: number | undefined;
  readonly body: unknown;
  /** The OAuth `error` of a failed token exchange, e.g. `invalid_grant` (the wallet token is no good) or `invalid_request`. */
  readonly oauthError: string | undefined;

  constructor(
    code: AuthenticationError["code"],
    message: string,
    details: { status?: number; body?: unknown; cause?: unknown; oauthError?: string } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "AuthenticationError";
    this.code = code;
    this.status = details.status;
    this.body = details.body;
    this.oauthError = details.oauthError;
  }
}
