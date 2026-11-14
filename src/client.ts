import { PreflightError } from "./errors.js";
import { DEFAULT_BASE_URL, Http, type AuthSource, type FetchLike } from "./http.js";
import type {
  Amount,
  AuthoredOrder,
  AuthoredQuote,
  AuthorLimitOrderRequest,
  AuthorOrderRequest,
  LimitInput,
  ListTransactionsParams,
  NextSignature,
  OrderLimit,
  PlaceLimitOrderRequest,
  SignedInstruction,
  Transaction,
  TransactionPage,
  EstimatedFee,
  Instruction,
  ListOrdersParams,
  Order,
  OrderEnvelope,
  OrderPage,
  OrderSummary,
  PlaceMarketOrderRequest,
  PreflightWarning,
  Quote,
  SubmitAuthoredOptions,
  RegisterOrderRequest,
  StakeRootRequest,
} from "./types.js";

export type Network = "mainnet" | "testnet";

export interface OrderServiceClientOptions {
  /**
   * Service origin. Default `https://api.tao.com` (production); pass `https://api.dev.tao.com`
   * for testnet. Routes are under `/orders/v2`.
   */
  baseUrl?: string;
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

function wireSlippage(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be a slippage fraction from 0 to 1, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Signing an order with warnings is wasted: register re-runs the checks and rejects it. */
function assertPreflight(authored: AuthoredOrder): void {
  if (authored.warnings.length > 0) throw new PreflightError(authored.warnings);
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

/** Wire dates are ISO-8601 strings. */
function wireDate(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

function exitLegs(limit: { stopLoss?: { percentage: number }; takeProfit?: { percentage: number } }) {
  return {
    ...(limit.stopLoss !== undefined ? { stopLoss: { percentage: limit.stopLoss.percentage } } : {}),
    ...(limit.takeProfit !== undefined ? { takeProfit: { percentage: limit.takeProfit.percentage } } : {}),
  };
}

function wireLimit(limit: LimitInput): Record<string, unknown> {
  if (limit.type === "PROFIT_LOCK") return { type: limit.type, ...exitLegs(limit) };
  if (limit.type === "MARKET_BUY") {
    return { type: limit.type, maxSlippage: wireSlippage(limit.maxSlippage, "limit.maxSlippage"), ...exitLegs(limit) };
  }
  return {
    type: limit.type,
    ...(limit.triggerPrice !== undefined
      ? {
          triggerPrice: {
            value: wireAmount(limit.triggerPrice.value, "limit.triggerPrice.value"),
            currency: limit.triggerPrice.currency,
          },
        }
      : {}),
    limitPrice: {
      value: wireAmount(limit.limitPrice.value, "limit.limitPrice.value"),
      ...(limit.limitPrice.currency !== undefined ? { currency: limit.limitPrice.currency } : {}),
    },
    maxSlippage: wireSlippage(limit.maxSlippage, "limit.maxSlippage"),
    ...(limit.expiresAt !== undefined ? { expiresAt: wireDate(limit.expiresAt) } : {}),
    ...(limit.notBefore !== undefined ? { notBefore: wireDate(limit.notBefore) } : {}),
    ...exitLegs(limit),
  };
}

/**
 * The register body repeats the order, but its `limit` takes only what a client can choose: the
 * authored one also shows what the service derived (exit `targetPrice`, a plan's fixed slippage
 * and expiry), which register rejects. A Profit Lock is sized by the service, so it takes no
 * `source.amount`.
 */
function registerEnvelope(order: OrderEnvelope): OrderEnvelope {
  const limit = order.limit;
  if (limit === undefined) return order;
  if (limit.type === "PROFIT_LOCK") {
    const { amount: _sized, ...source } = order.source;
    return { ...order, source: source as OrderEnvelope["source"], limit: { type: limit.type, ...exitLegs(limit) } };
  }
  if (limit.type === "MARKET_BUY") {
    return {
      ...order,
      limit: {
        type: limit.type,
        ...(limit.maxSlippage !== undefined ? { maxSlippage: limit.maxSlippage } : {}),
        ...exitLegs(limit),
      },
    };
  }
  const resolved: OrderLimit = {
    type: limit.type,
    ...(limit.triggerPrice !== undefined ? { triggerPrice: limit.triggerPrice } : {}),
    ...(limit.limitPrice !== undefined ? { limitPrice: limit.limitPrice } : {}),
    ...(limit.maxSlippage !== undefined ? { maxSlippage: limit.maxSlippage } : {}),
    ...(limit.expiresAt !== undefined ? { expiresAt: limit.expiresAt } : {}),
    ...(limit.notBefore !== undefined ? { notBefore: limit.notBefore } : {}),
    ...exitLegs(limit),
  };
  return { ...order, limit: resolved };
}

type OrderBody = Omit<Order, "id" | "nextSignature"> & { instruction?: Instruction };

/** A 202 is a plan with more to sign: its next instruction, link and token. */
function orderFromResponse(response: { status: number; headers: Headers; body: OrderBody }): Order {
  const { instruction, ...body } = response.body;
  const order = withId(body);
  const href = body._links.instruction?.href;
  const provenanceToken = response.headers.get("x-provenance-token");
  if (response.status !== 202) return order;
  if (instruction === undefined || href === undefined || provenanceToken === null) {
    throw new Error("order service answered 202 without the next instruction, link or X-Provenance-Token");
  }
  return { ...order, nextSignature: { instruction, href, provenanceToken } };
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

  constructor(options: OrderServiceClientOptions = {}) {
    this.network = options.network ?? "mainnet";
    this.defaultHotkey = options.hotkey;
    this.http = new Http({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      auth: options.auth,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  /**
   * Ask the service for the unsigned instruction. Market order: no `limit` is sent.
   * Sign `instruction`, then call `registerOrder` with the returned `order` and `provenanceToken`.
   * With `destination.amount` (receive-side) the returned `order.source.amount` is the solved
   * amount the signed instruction spends.
   */
  async authorOrder(input: AuthorOrderRequest | AuthorLimitOrderRequest): Promise<AuthoredOrder> {
    const request = this.withHotkey(input);
    const limit = "limit" in request ? request.limit : undefined;
    if (limit !== undefined) {
      if (request.destination.amount !== undefined) {
        throw new RangeError("A limit order takes no destination.amount");
      }
      if ((limit.type === "PROFIT_LOCK") !== (request.source.amount === undefined)) {
        throw new RangeError(
          limit.type === "PROFIT_LOCK"
            ? "A PROFIT_LOCK takes no source.amount: the service sizes it"
            : "A limit order needs source.amount",
        );
      }
    } else if ((request.source.amount === undefined) === (request.destination.amount === undefined)) {
      throw new RangeError("Set exactly one of source.amount or destination.amount");
    }
    const { body, headers } = await this.http.request<{
      _links?: { instruction?: { href?: string } };
      order: OrderEnvelope;
      instruction: Instruction;
      estimatedFees?: EstimatedFee[];
      quotes?: AuthoredQuote[];
      warnings?: PreflightWarning[];
    }>({
      method: "POST",
      path: `${BASE}/order-intents`,
      authenticated: true,
      body: {
        source: {
          currency: request.source.currency,
          ...(request.source.amount !== undefined
            ? { amount: wireAmount(request.source.amount, "source.amount") }
            : {}),
          ...(request.source.address !== undefined ? { address: request.source.address } : {}),
          ...(request.source.limitPrice !== undefined
            ? { limitPrice: wireSlippage(request.source.limitPrice, "source.limitPrice") }
            : {}),
        },
        destination: {
          currency: request.destination.currency,
          ...(request.destination.amount !== undefined
            ? { amount: wireAmount(request.destination.amount, "destination.amount") }
            : {}),
          ...(request.destination.address !== undefined
            ? { address: request.destination.address }
            : {}),
          ...(request.destination.limitPrice !== undefined
            ? { limitPrice: wireSlippage(request.destination.limitPrice, "destination.limitPrice") }
            : {}),
        },
        signerAddress: request.signerAddress,
        ...(limit !== undefined ? { limit: wireLimit(limit) } : {}),
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
      ...(body.quotes !== undefined ? { quotes: body.quotes } : {}),
      warnings: body.warnings ?? [],
    };
  }

  /**
   * Estimate what a swap pays out, without signing or opening anything. This authors the order
   * (a dry run) and returns the service's quote: the destination amount after fees, in the
   * destination currency, in TAO when that differs, and in USD. Throws if the service returns
   * no quote for the pair.
   *
   * A quote that fails a pre-flight check still comes back, with `warnings` (for example
   * `SLIPPAGE_EXCEEDED` when the simulated slippage is beyond `limitPrice`). Check them before
   * asking the user to sign: such an order would be rejected.
   */
  async getQuote(input: AuthorOrderRequest): Promise<Quote & { warnings: PreflightWarning[] }> {
    const { quotes, warnings } = await this.authorOrder(input);
    const quote = quotes?.[0];
    if (quote?.amount === undefined) throw new Error("order service returned no quote for this order");
    return { amount: quote.amount, fees: quote.fees, warnings };
  }

  /**
   * Register a signed order. Status `OPEN` on success; the matcher takes it from there. The
   * service re-runs the pre-flight checks first: if one fails it throws `OrderServiceError` with
   * code `preflight-failed` (422) and the failed checks in `problem.errors`.
   */
  async registerOrder(request: RegisterOrderRequest): Promise<Order> {
    const response = await this.http.request<OrderBody>({
      method: "POST",
      path: registerPath(request.href),
      authenticated: true,
      headers: {
        "idempotency-key": request.idempotencyKey ?? crypto.randomUUID(),
        "x-provenance-token": request.provenanceToken,
      },
      body: {
        ...(request.sourceSystem !== undefined ? { sourceSystem: request.sourceSystem } : {}),
        order: registerEnvelope(request.order),
        signedInstruction: request.signedInstruction,
      },
    });
    return orderFromResponse(response);
  }

  /**
   * Post the signature of a plan's next component (`order.nextSignature`). Returns the plan: with
   * another `nextSignature` while more remain, `OPEN` after the last one. To resume a plan whose
   * response was lost, `getOrder` it: a pending plan carries its `nextSignature`.
   */
  async submitComponent(next: NextSignature, signedInstruction: SignedInstruction): Promise<Order> {
    const response = await this.http.request<OrderBody>({
      method: "POST",
      path: registerPath(next.href),
      authenticated: true,
      headers: { "x-provenance-token": next.provenanceToken },
      body: { signedInstruction },
    });
    return orderFromResponse(response);
  }

  async getOrder(orderId: string): Promise<Order> {
    const response = await this.http.request<OrderBody>({
      method: "GET",
      path: `${BASE}/orders/${encodeURIComponent(orderId)}`,
      authenticated: true,
    });
    // A pending plan answers 200: its next step is there when it has an instruction link.
    return orderFromResponse({
      ...response,
      status: response.body._links.instruction !== undefined ? 202 : response.status,
    });
  }

  /** Allowed while `OPEN` or `PENDING_SIGNATURES`; otherwise throws `OrderServiceError` with code `cancel-not-allowed`. */
  async cancelOrder(orderId: string): Promise<Order> {
    const { body } = await this.http.request<Omit<Order, "id">>({
      method: "POST",
      path: `${BASE}/orders/${encodeURIComponent(orderId)}/cancel`,
      authenticated: true,
      // The service answers 415 to a POST with no content type, and 400 to an empty JSON body.
      body: {},
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
   * The account's activity, newest first: its order-service orders and its other on-chain
   * transactions (transfers, stakes made elsewhere). `account` must be the token's wallet.
   * Rows appear once the chain history has them, so a just-placed order shows in `listOrders`
   * first.
   */
  async listTransactions(account: string, params: ListTransactionsParams = {}): Promise<TransactionPage> {
    const { body } = await this.http.request<{
      _links: { next?: { href: string }; prev?: { href: string } };
      _embedded?: { transactions?: Transaction[] };
      page?: { total?: number };
    }>({
      method: "GET",
      path: `${BASE}/bittensor/accounts/${encodeURIComponent(account)}/transactions`,
      authenticated: true,
      query: { netuid: params.netuid, type: params.type, limit: params.limit, cursor: params.cursor },
    });
    const nextCursor = cursorOf(body._links.next);
    const prevCursor = cursorOf(body._links.prev);
    return {
      transactions: body._embedded?.transactions ?? [],
      ...(body.page?.total !== undefined ? { total: body.page.total } : {}),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    };
  }

  /**
   * Author, sign and register a market order in one call. Retrying with the same
   * `idempotencyKey` is safe only after a failure of the register step; a new author call
   * issues a new single-use provenance token.
   */
  placeMarketOrder(request: PlaceMarketOrderRequest): Promise<Order> {
    return this.place(request);
  }

  /**
   * Author, sign and register a limit order or plan in one call. A plan asks `signer` once per
   * component (entry, stop loss, take profit) and opens after the last; `onComponentSigned`
   * reports progress in between.
   */
  placeLimitOrder(request: PlaceLimitOrderRequest): Promise<Order> {
    return this.place(request);
  }

  private async place(request: PlaceMarketOrderRequest | PlaceLimitOrderRequest): Promise<Order> {
    const { signer, idempotencyKey, sourceSystem, beforeSign, onComponentSigned, ...authorRequest } = request;
    const authored = await this.authorOrder(authorRequest as AuthorOrderRequest | AuthorLimitOrderRequest);
    assertPreflight(authored);
    await beforeSign?.(authored);
    return this.submitAuthored(authored, {
      signer,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(sourceSystem !== undefined ? { sourceSystem } : {}),
      ...(onComponentSigned !== undefined ? { onComponentSigned } : {}),
    });
  }

  /**
   * Sign an authored order and post it back to the instruction link it returned. This is the step
   * that opens the order. Throws `PreflightError`, before signing, if the order carries `warnings`.
   */
  async submitAuthored(authored: AuthoredOrder, options: SubmitAuthoredOptions): Promise<Order> {
    assertPreflight(authored);
    const signedInstruction = await options.signer(authored.instruction, {
      signerAddress: authored.order.signerAddress,
      order: authored.order,
    });
    let order = await this.registerOrder({
      ...(authored.instructionHref !== undefined ? { href: authored.instructionHref } : {}),
      order: authored.order,
      signedInstruction,
      provenanceToken: authored.provenanceToken,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      ...(options.sourceSystem !== undefined ? { sourceSystem: options.sourceSystem } : {}),
    });
    // A plan: one signature per component until the service opens it.
    for (let signed = 1; order.nextSignature !== undefined; signed++) {
      options.onComponentSigned?.(order, signed);
      const next: NextSignature = order.nextSignature;
      const signature = await options.signer(next.instruction, {
        signerAddress: authored.order.signerAddress,
        order: authored.order,
      });
      order = await this.submitComponent(next, signature);
    }
    return order;
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
  private withHotkey<T extends AuthorOrderRequest | AuthorLimitOrderRequest>(request: T): T {
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
    // Only addresses change, so the amounts stay on the leg they were on.
    return {
      ...request,
      source: isAlpha(request.source.currency) ? { ...request.source, address: hotkey } : request.source,
      destination: isAlpha(request.destination.currency)
        ? { ...request.destination, address: hotkey }
        : request.destination,
    } as T;
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

