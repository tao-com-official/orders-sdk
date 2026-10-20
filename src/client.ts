import { Http, type AuthSource, type FetchLike } from "./http.js";
import type {
  Amount,
  AuthoredOrder,
  AuthorOrderRequest,
  EstimatedFee,
  Instruction,
  ListOrdersParams,
  Order,
  OrderEnvelope,
  OrderPage,
  OrderSummary,
  PlaceMarketOrderRequest,
  SubmitAuthoredOptions,
  RegisterOrderRequest,
  StakeRootRequest,
} from "./types.js";

export type Network = "mainnet" | "testnet";

export interface OrderServiceClientOptions {
  /** Service origin, e.g. `https://api.dev.tao.com`. Routes are under `/orders/v2`. */
  baseUrl: string;
  /**
   * Bearer JWT whose `username` claim is the signer's coldkey SS58. A function is called
   * per request so tokens can be refreshed.
   */
  auth?: AuthSource;
  /** Chain used by the root staking helpers to build asset URNs. Default `mainnet`. */
  network?: Network;
  /**
   * Validator hotkey (SS58) used for any alpha leg that has no `address`. A hotkey passed on a
   * call always wins. There is no built-in default; see `TAO_COM_VALIDATOR_HOTKEYS`.
   */
  hotkey?: string;
  /** Default 30s. */
  timeoutMs?: number;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

const BASE = "/orders/v2";

/** Wire amounts are digit strings. Fail early rather than on a 422. */
function wireAmount(value: Amount, field: string): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (!/^[0-9]+$/.test(text)) {
    throw new RangeError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return text;
}

/**
 * Where to post a signed order. The service returns an absolute link whose origin is whatever
 * the gateway forwarded, which may not be the origin this client talks to (a proxy, for one), so
 * only the path is followed, against `baseUrl`. It must stay under `/orders/`.
 */
function registerPath(href: string | undefined): string {
  if (href === undefined) return `${BASE}/orders`;
  const url = new URL(href, "http://localhost");
  if (!url.pathname.startsWith("/orders/")) {
    throw new Error(`refusing to follow an instruction link outside /orders/: ${href}`);
  }
  return url.pathname;
}

function lastSegment(href: string): string {
  return new URL(href, "http://localhost").pathname.split("/").filter(Boolean).pop() ?? "";
}

function cursorOf(link: { href: string } | undefined): string | undefined {
  if (link === undefined) return undefined;
  return new URL(link.href, "http://localhost").searchParams.get("cursor") ?? undefined;
}

export class OrderServiceClient {
  private readonly http: Http;
  private readonly network: Network;
  private readonly defaultHotkey: string | undefined;

  constructor(options: OrderServiceClientOptions) {
    this.network = options.network ?? "mainnet";
    this.defaultHotkey = options.hotkey;
    this.http = new Http({
      baseUrl: options.baseUrl,
      auth: options.auth,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  /**
   * Ask the service for the unsigned instruction. Market order: no `limit` is sent.
   * Sign `instruction`, then call `registerOrder` with the returned `order` and `provenanceToken`.
   */
  async authorOrder(input: AuthorOrderRequest): Promise<AuthoredOrder> {
    const request = this.withHotkey(input);
    const { body, headers } = await this.http.request<{
      _links?: { instruction?: { href?: string } };
      order: OrderEnvelope;
      instruction: Instruction;
      estimatedFees?: EstimatedFee[];
    }>({
      method: "POST",
      path: `${BASE}/order-intents`,
      authenticated: true,
      body: {
        source: {
          currency: request.source.currency,
          amount: wireAmount(request.source.amount, "source.amount"),
          ...(request.source.address !== undefined ? { address: request.source.address } : {}),
          ...(request.source.limitPrice !== undefined
            ? { limitPrice: wireAmount(request.source.limitPrice, "source.limitPrice") }
            : {}),
        },
        destination: {
          currency: request.destination.currency,
          ...(request.destination.address !== undefined
            ? { address: request.destination.address }
            : {}),
          ...(request.destination.limitPrice !== undefined
            ? { limitPrice: wireAmount(request.destination.limitPrice, "destination.limitPrice") }
            : {}),
        },
        signerAddress: request.signerAddress,
      },
    });
    const provenanceToken = headers.get("x-provenance-token");
    if (provenanceToken === null) {
      throw new Error("order service response is missing X-Provenance-Token");
    }
    const instructionHref = body._links?.instruction?.href;
    return {
      order: body.order,
      instruction: body.instruction,
      provenanceToken,
      ...(instructionHref !== undefined ? { instructionHref } : {}),
      ...(body.estimatedFees !== undefined ? { estimatedFees: body.estimatedFees } : {}),
    };
  }

  /** Register a signed order. Status `OPEN` on success; the matcher takes it from there. */
  async registerOrder(request: RegisterOrderRequest): Promise<Order> {
    const { body } = await this.http.request<Omit<Order, "id">>({
      method: "POST",
      path: registerPath(request.href),
      authenticated: true,
      headers: {
        "idempotency-key": request.idempotencyKey ?? crypto.randomUUID(),
        "x-provenance-token": request.provenanceToken,
      },
      body: {
        ...(request.sourceSystem !== undefined ? { sourceSystem: request.sourceSystem } : {}),
        order: request.order,
        signedInstruction: request.signedInstruction,
      },
    });
    return withId(body);
  }

  async getOrder(orderId: string): Promise<Order> {
    const { body } = await this.http.request<Omit<Order, "id">>({
      method: "GET",
      path: `${BASE}/orders/${encodeURIComponent(orderId)}`,
      authenticated: true,
    });
    return withId(body);
  }

  /** Only allowed while `OPEN`; otherwise throws `OrderServiceError` with code `cancel-not-allowed`. */
  async cancelOrder(orderId: string): Promise<Order> {
    const { body } = await this.http.request<Omit<Order, "id">>({
      method: "POST",
      path: `${BASE}/orders/${encodeURIComponent(orderId)}/cancel`,
      authenticated: true,
    });
    return withId(body);
  }

  /** The caller's orders, newest page first as the service orders them. Market orders by default. */
  async listOrders(params: ListOrdersParams = {}): Promise<OrderPage> {
    const { body } = await this.http.request<{
      _links: { next?: { href: string }; prev?: { href: string } };
      _embedded?: { order?: Omit<OrderSummary, "id">[] };
    }>({
      method: "GET",
      path: `${BASE}/orders`,
      authenticated: true,
      query: {
        status: params.status,
        orderType: params.orderType,
        orderCategory: params.orderCategory ?? "BITTENSOR_MARKET",
        limit: params.limit,
        cursor: params.cursor,
      },
    });
    const nextCursor = cursorOf(body._links.next);
    const prevCursor = cursorOf(body._links.prev);
    return {
      orders: (body._embedded?.order ?? []).map(withId),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    };
  }

  /**
   * Author, sign and register a market order in one call. Retrying with the same
   * `idempotencyKey` is safe only after a failure of the register step; a new author call
   * issues a new single-use provenance token.
   */
  async placeMarketOrder(request: PlaceMarketOrderRequest): Promise<Order> {
    const { signer, idempotencyKey, sourceSystem, beforeSign, ...authorRequest } = request;
    const authored = await this.authorOrder(authorRequest);
    await beforeSign?.(authored);
    return this.submitAuthored(authored, {
      signer,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(sourceSystem !== undefined ? { sourceSystem } : {}),
    });
  }

  /**
   * Sign an authored order and post it back to the instruction link it returned. This is the step
   * that opens the order.
   */
  async submitAuthored(authored: AuthoredOrder, options: SubmitAuthoredOptions): Promise<Order> {
    const signedInstruction = await options.signer(authored.instruction, {
      signerAddress: authored.order.signerAddress,
      order: authored.order,
    });
    return this.registerOrder({
      ...(authored.instructionHref !== undefined ? { href: authored.instructionHref } : {}),
      order: authored.order,
      signedInstruction,
      provenanceToken: authored.provenanceToken,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      ...(options.sourceSystem !== undefined ? { sourceSystem: options.sourceSystem } : {}),
    });
  }

  /** Stake TAO to Root (SN0). The network fee comes out of `amount`. */
  stakeToRoot(request: StakeRootRequest): Promise<Order> {
    const { amount, hotkey, ...rest } = request;
    return this.placeMarketOrder({
      ...rest,
      source: { currency: this.nativeUrn(), amount },
      destination: { currency: this.rootUrn(), ...(hotkey !== undefined ? { address: hotkey } : {}) },
    });
  }

  /** Unstake from Root (SN0) back to TAO. */
  unstakeFromRoot(request: StakeRootRequest): Promise<Order> {
    const { amount, hotkey, ...rest } = request;
    return this.placeMarketOrder({
      ...rest,
      source: { currency: this.rootUrn(), amount, ...(hotkey !== undefined ? { address: hotkey } : {}) },
      destination: { currency: this.nativeUrn() },
    });
  }

  /**
   * Fill the hotkey on an alpha leg that has none: the other leg's `address` (a same-validator
   * swap), else the client default. Legs that already carry an address are left alone, so two
   * different hotkeys stay different (a move between validators).
   */
  private withHotkey(request: AuthorOrderRequest): AuthorOrderRequest {
    const isAlpha = (currency: string) => currency.includes(":alpha:");
    if (
      (!isAlpha(request.source.currency) || request.source.address !== undefined) &&
      (!isAlpha(request.destination.currency) || request.destination.address !== undefined)
    ) {
      return request;
    }
    const hotkey = request.source.address ?? request.destination.address ?? this.defaultHotkey;
    if (hotkey === undefined) {
      throw new Error(
        "No validator hotkey: pass `hotkey` (or an address on the alpha leg), or set `hotkey` on the client.",
      );
    }
    return {
      ...request,
      source: isAlpha(request.source.currency) ? { ...request.source, address: hotkey } : request.source,
      destination: isAlpha(request.destination.currency)
        ? { ...request.destination, address: hotkey }
        : request.destination,
    };
  }

  private nativeUrn(): string {
    return `urn:bittensor:${this.network}:native`;
  }

  private rootUrn(): string {
    return `urn:bittensor:${this.network}:alpha:0`;
  }
}

function withId<T extends { _links: { self: { href: string } } }>(resource: T): T & { id: string } {
  return { ...resource, id: lastSegment(resource._links.self.href) };
}

