/** Integer amount on the wire: digit string. Callers may pass a bigint. */
export type Amount = string | bigint;

/**
 * Order types the service authors for market orders. The service picks the type from the legs:
 * `alpha_swap` changes subnet and keeps the validator (same hotkey), `alpha_move` changes the
 * validator within one subnet, `alpha_swap_move` changes both. `*_sn0` is Root (SN0).
 */
export const MARKET_ORDER_TYPES = [
  "tao_to_sn0",
  "sn0_to_tao",
  "tao_to_alpha",
  "alpha_to_tao",
  "alpha_swap",
  "alpha_move",
  "alpha_swap_move",
  "alpha_to_sn0",
  "sn0_to_alpha",
] as const;
export type MarketOrderType = (typeof MARKET_ORDER_TYPES)[number];

/** The statuses `listOrders` can filter by. */
export type ListableOrderStatus = "OPEN" | "SUBMITTED" | "FILLED" | "FAILED" | "CANCELLED" | "EXPIRED";

/**
 * An order's status. Besides the five lifecycle statuses, the service stores whatever the matcher
 * last reported, so an order can also read `CLAIMED` (the matcher picked it up), `ACCEPTED` (the
 * network accepted the transaction; it is not final yet) or `ERROR` (the matcher hit an error;
 * see the event's `failureReason`). `FILLED` and `FAILED` are the on-chain outcomes.
 */
export type OrderStatus = ListableOrderStatus | "PENDING_SIGNATURES" | "CLAIMED" | "ACCEPTED" | "ERROR";

/** Statuses an order does not leave. Anything else may still change: poll it. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["FILLED", "FAILED", "CANCELLED", "EXPIRED"];

export type OrderCategory = "BITTENSOR_LIMIT" | "BITTENSOR_MARKET" | "CROSS_CHAIN";

export type CurrencyAmount = { value: string; currency: string };

export type FeeType = "TRANSACTION" | "PLATFORM" | "SUBNET_AMM" | "MEV_SHIELD" | (string & {});

export interface HalLink {
  href: string;
  templated?: true;
}

// ---- limit -----------------------------------------------------------------

/** A single limit order. Add `stopLoss` / `takeProfit` to a `LIMIT_BUY` to make it a linked plan. */
export type LimitOrderType = "LIMIT_BUY" | "TAKE_PROFIT" | "STOP_LOSS";

/** An exit leg of a plan: how far off the entry (or reference) price it fires. */
export interface ExitLeg {
  /** A fraction, not a percent: `0.1` is 10% below (stop loss) or above (take profit). */
  percentage: number;
}

export interface PriceInput {
  /** Rao per whole unit of the asset, as an integer. */
  value: Amount;
  currency: string;
}

/**
 * The `limit` of an author request, told apart by `type`:
 *
 * - `LIMIT_BUY`, `TAKE_PROFIT`, `STOP_LOSS`: one order that fires at `triggerPrice` and fills no
 *   worse than `limitPrice`. A `LIMIT_BUY` with `stopLoss` / `takeProfit` is a linked plan.
 * - `MARKET_BUY`: buy now, with `stopLoss` / `takeProfit` exits on what it buys.
 * - `PROFIT_LOCK`: exits on a stake you already hold. No amount: the service sizes it.
 *
 * Which types an environment accepts is server config (`LIMIT_ORDER_ENABLED_TYPES`): a disabled
 * one answers 422.
 */
export type LimitInput =
  | {
      type: LimitOrderType;
      /** Default: `limitPrice`. */
      triggerPrice?: PriceInput;
      /** `currency` defaults to the source (buy) or destination (sell) native currency. */
      limitPrice: { value: Amount; currency?: string };
      /** Fraction from 0 to 1. */
      maxSlippage: number;
      /** Default set by the service. */
      expiresAt?: string | Date;
      notBefore?: string | Date;
      stopLoss?: ExitLeg;
      takeProfit?: ExitLeg;
    }
  | { type: "MARKET_BUY"; maxSlippage: number; stopLoss?: ExitLeg; takeProfit?: ExitLeg }
  | { type: "PROFIT_LOCK"; stopLoss?: ExitLeg; takeProfit?: ExitLeg };

/** An exit leg as the service shows it: the percentage and the price it derives to. */
export interface ExitLegView extends ExitLeg {
  targetPrice?: CurrencyAmount;
}

/** A `limit` as the service returns it. Which fields are set depends on `type`. */
export interface OrderLimit {
  type: LimitOrderType | "MARKET_BUY" | "PROFIT_LOCK";
  triggerPrice?: CurrencyAmount;
  limitPrice?: CurrencyAmount;
  maxSlippage?: number;
  expiresAt?: string;
  notBefore?: string;
  currency?: string;
  stopLoss?: ExitLegView;
  takeProfit?: ExitLegView;
}

/**
 * A limit order or plan to author. `source.amount` is required except on a `PROFIT_LOCK`, which
 * takes none. There is no receive-side (`destination.amount`) limit order.
 */
export interface AuthorLimitOrderRequest {
  signerAddress: string;
  source: OrderLegInput & { amount?: Amount };
  destination: OrderLegInput & { amount?: never };
  limit: LimitInput;
}

export type ComponentRole = "SINGLE" | "ENTRY" | "STOP_LOSS" | "TAKE_PROFIT";

/** One part of a limit order or plan, in `Order._embedded.components`. */
export interface OrderComponent {
  role: ComponentRole;
  type: MarketOrderType;
  status: OrderStatus;
  source: { currency: string; amount?: string; address?: string };
  destination: { currency: string; amount?: string; address?: string };
  limit?: OrderLimit;
  events?: OrderEvent[];
  items?: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A plan waiting for its next signature (`PENDING_SIGNATURES`): sign `instruction` and pass all
 * three to `submitComponent`. Unsigned plans expire after a few minutes.
 */
export interface NextSignature {
  instruction: Instruction;
  href: string;
  provenanceToken: string;
}

// ---- author ----------------------------------------------------------------

/**
 * One side of an order. `address` is the validator hotkey and is required on any alpha leg,
 * including SN0 (root). The two legs may carry different hotkeys: that is how a move between
 * validators is expressed.
 *
 * `limitPrice` is the maximum slippage against the current subnet price, as a fraction from 0 to 1
 * (`0.05` = 5%). The service simulates the order against it, and the extrinsic it authors fails on
 * chain instead of filling worse. It is required on exactly one leg for some order types:
 *
 * | Order type                          | Where           |
 * |-------------------------------------|-----------------|
 * | `tao_to_alpha`                      | destination leg |
 * | `alpha_to_tao`                      | source leg      |
 * | `alpha_swap`, `alpha_swap_move`     | destination leg |
 *
 * Any swap between two different alpha legs is an `alpha_swap`, Root (SN0) included. Not needed
 * for `tao_to_sn0`, `sn0_to_tao` or `alpha_move`.
 */
export interface OrderLegInput {
  currency: string;
  address?: string;
  limitPrice?: number;
}

/**
 * Set the amount on exactly one leg. `source.amount` spends that much. `destination.amount` is a
 * receive-side order: the service solves for the smallest source amount that, after every fee,
 * pays out at least that much, and the authored order carries both amounts.
 */
export type AuthorOrderRequest = {
  /** Coldkey SS58. Must equal the `username` claim of the bearer token. */
  signerAddress: string;
} & (
  | { source: OrderLegInput & { amount: Amount }; destination: OrderLegInput & { amount?: never } }
  | { source: OrderLegInput & { amount?: never }; destination: OrderLegInput & { amount: Amount } }
);

export interface RawInstruction {
  type: "RAW";
  payload: string;
  mevEncryption?: boolean;
}

/** `payload` is the PAPI TxPayloadV1 JSON the wallet signs. */
export interface SubstrateExtrinsicInstruction {
  type: "SUBSTRATE_EXTRINSIC";
  payload: Record<string, unknown>;
  mevEncryption?: boolean;
}

export type Instruction = RawInstruction | SubstrateExtrinsicInstruction;

/** The order envelope. Authored by the service, repeated verbatim on register. */
export interface OrderEnvelope {
  type: MarketOrderType;
  source: { currency: string; amount: string; address?: string; limitPrice?: number };
  /** `amount` is set on a receive-side order: the amount asked for. */
  destination: { currency: string; amount?: string; address?: string; limitPrice?: number };
  signerAddress: string;
  /** Set on a limit order or plan: the limit as the service resolved it. */
  limit?: OrderLimit;
}

export interface EstimatedFee {
  /** The fee in its own currency first, USD last. Some fees also carry a TAO-converted amount in between. */
  amount: CurrencyAmount[];
  feeType: FeeType;
  userPayable: boolean;
}

/**
 * What the order is expected to pay out, after fees. `amount` lists the destination currency
 * first, then native TAO when that differs, then USD last. Every fee is subtracted, the subnet
 * AMM fee (`userPayable: false`) included. It is an estimate from the pool as the service sees
 * it now; the fill can differ as the price moves, bounded by `limitPrice` if you set one.
 *
 * On a receive-side order (`destination.amount`) it is the other way round: `amount` is what you
 * pay, in the source currency first, every fee added.
 */
export interface Quote {
  amount: CurrencyAmount[];
  fees: EstimatedFee[];
}

/**
 * A quote as `authorOrder` returns it. A market order's carries `amount` (see `Quote`); a limit
 * order's may carry only the fees, the execution `rate` (TAO per alpha, 9 decimals) and the
 * `priceImpact` (a fraction) at today's pool.
 */
export interface AuthoredQuote extends Omit<Quote, "amount"> {
  amount?: CurrencyAmount[];
  rate?: string;
  priceImpact?: number;
}

/**
 * The pre-flight check codes. `SLIPPAGE_EXCEEDED`: the simulated slippage is beyond `limitPrice`.
 * `DESTINATION_AMOUNT_TOO_LOW`, `FEES_EXCEED_AMOUNT`: the amount is too small (see `minimumAmount`).
 */
export type PreflightCode =
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_STAKE"
  | "INVALID_DESTINATION_ADDRESS"
  | "DESTINATION_AMOUNT_TOO_LOW"
  | "FEES_EXCEED_AMOUNT"
  | "SLIPPAGE_EXCEEDED"
  | "INSUFFICIENT_LIQUIDITY"
  | "INVALID_SWAP"
  | (string & {});

/**
 * A pre-flight check the order fails. Authoring still succeeds and returns it as a warning, but
 * registering an order with a warning is rejected (422, `preflight-failed`), so do not ask the
 * user to sign one.
 */
export interface PreflightWarning {
  code: PreflightCode;
  /** Smallest source amount that passes, in the source currency (on amount-too-low codes). */
  minimumAmount?: string;
  /** Largest source amount that stays within `limitPrice` (on `SLIPPAGE_EXCEEDED`). */
  maximumAmount?: string;
}

export interface AuthoredOrder {
  order: OrderEnvelope;
  instruction: Instruction;
  /**
   * The link the signed order is posted back to (`_links.instruction.href`). Nothing exists on the
   * server until it is: authoring is a dry run. `submitAuthored` and `registerOrder({ href })` follow it.
   */
  instructionHref?: string;
  /** From the `X-Provenance-Token` header. Single-use: pass it to `registerOrder`. */
  provenanceToken: string;
  /** Absent for alpha↔alpha. Empty for TAO↔SN0 is possible. */
  estimatedFees?: EstimatedFee[];
  /** What you receive after fees: with `amount` on market orders. Absent on older services. */
  quotes?: AuthoredQuote[];
  /** Failed pre-flight checks. Empty when the order passes; registering it with any is rejected. */
  warnings: PreflightWarning[];
}

// ---- register / read -------------------------------------------------------

/** The signature schemes the service accepts. `ed25519` is what a Ledger signs with. */
export type SignatureType = "sr25519" | "ed25519";

export interface SignedInstruction {
  type: SignatureType;
  /** 0x-prefixed hex. For SUBSTRATE_EXTRINSIC this is the whole signed extrinsic. */
  value: string;
}

export interface RegisterOrderRequest {
  /** `AuthoredOrder.instructionHref`. Only its path is used, against the client's `baseUrl`. Default `/orders/v2/orders`. */
  href?: string;
  order: OrderEnvelope;
  signedInstruction: SignedInstruction;
  provenanceToken: string;
  /** Defaults to a fresh UUID. Reuse the same key to retry safely. */
  idempotencyKey?: string;
  sourceSystem?: string;
}

export type OrderEventType =
  | "CREATED"
  | "SUBMITTED"
  | "FILLED"
  | "FAILED"
  | "CANCELLED"
  | "CLAIMED"
  | "ACCEPTED"
  | "ERROR"
  | "transaction_appended";

export interface OrderEvent {
  type: OrderEventType;
  at: string;
  transactionHash?: string;
  failureReason?: string;
  observedAt?: string;
  blockNumber?: number;
  transactionIndex?: number;
}

export interface OrderItem {
  amount: CurrencyAmount;
  itemKind: "BUY" | "SELL" | "FEE";
  feeType?: FeeType;
  secondaryAmount?: CurrencyAmount;
}

export interface Order {
  /** Parsed from `_links.self`. */
  id: string;
  type: MarketOrderType;
  status: OrderStatus;
  source: { currency: string; amount?: string; address?: string; limitPrice?: number };
  destination: { currency: string; amount?: string; address?: string; limitPrice?: number };
  signerAddress: string;
  sourceSystem?: string;
  events?: OrderEvent[];
  items?: OrderItem[];
  limit?: OrderLimit;
  createdAt: string;
  updatedAt: string;
  _links: { self: HalLink; cancel?: HalLink; instruction?: HalLink };
  /** Limit orders and plans: one entry per component. */
  _embedded?: { components?: OrderComponent[] };
  /** Set while the plan is `PENDING_SIGNATURES`. */
  nextSignature?: NextSignature;
}

export interface OrderSummary {
  id: string;
  type: MarketOrderType;
  status: OrderStatus;
  source: { currency: string; amount: string };
  destination: { currency: string; amount?: string };
  limit?: OrderLimit;
  createdAt: string;
  updatedAt: string;
  _links: { self: HalLink; cancel?: HalLink };
}

export interface ListOrdersParams {
  status?: ListableOrderStatus;
  orderType?: MarketOrderType;
  /** Defaults to `BITTENSOR_MARKET`. `BITTENSOR_LIMIT` lists limit orders and plans. */
  orderCategory?: OrderCategory;
  /** 1..100. Server default is 50. */
  limit?: number;
  cursor?: string;
}

export interface OrderPage {
  orders: OrderSummary[];
  /** Pass to `listOrders({ cursor })`. Undefined on the last page. */
  nextCursor?: string;
  prevCursor?: string;
}

// ---- signing ---------------------------------------------------------------

/**
 * Turns the service's unsigned instruction into a signature the service accepts.
 * For `SUBSTRATE_EXTRINSIC` return the full signed extrinsic hex (immortal era, call
 * and extensions exactly as authored); for `RAW` return the signature over the payload bytes.
 */
export type InstructionSigner = (
  instruction: Instruction,
  context: { signerAddress: string; order: OrderEnvelope },
) => Promise<SignedInstruction> | SignedInstruction;

// ---- submit ----------------------------------------------------------------

export interface SubmitAuthoredOptions {
  signer: InstructionSigner;
  /**
   * A plan is signed one component at a time. Called after each signature the service accepted
   * while more remain (status `PENDING_SIGNATURES`), with how many are signed so far.
   */
  onComponentSigned?: (order: Order, signed: number) => void;
  idempotencyKey?: string;
  sourceSystem?: string;
}

// ---- high level ------------------------------------------------------------

export type PlaceMarketOrderRequest = AuthorOrderRequest & PlaceMarketOrderOptions;

export type PlaceLimitOrderRequest = AuthorLimitOrderRequest & PlaceMarketOrderOptions;

export interface PlaceMarketOrderOptions {
  signer: InstructionSigner;
  onComponentSigned?: SubmitAuthoredOptions["onComponentSigned"];
  /**
   * Called with the authored order (instruction and `estimatedFees`) before anything is signed,
   * once it has passed the pre-flight checks (an order with `warnings` throws `PreflightError`).
   * Throw to abort: nothing has been signed, registered or submitted yet. Use it to show fees
   * or to refuse a swap that fees would eat (a stake below the chain's minimum fails on chain
   * and still costs the network fee).
   */
  beforeSign?: (authored: AuthoredOrder) => void | Promise<void>;
  idempotencyKey?: string;
  sourceSystem?: string;
}

export interface StakeRootRequest {
  /** Rao (TAO) to stake, or rao of SN0 alpha to unstake. */
  amount: Amount;
  /** Validator hotkey SS58. Defaults to the client's `hotkey` option; one of the two is required. */
  hotkey?: string;
  signerAddress: string;
  signer: InstructionSigner;
  idempotencyKey?: string;
  sourceSystem?: string;
}

// ---- activity --------------------------------------------------------------

/** The `type` filter of `listTransactions`. */
export type ActivityType =
  | "all"
  | "stake"
  | "stake_added"
  | "stake_removed"
  | "transfer"
  | "unstake"
  | "swap"
  | "transfers"
  | "swaps"
  | "staking";

export type TransactionStatus =
  | "PENDING_SIGNATURES"
  | "OPEN"
  | "SUBMITTED"
  | "FILLED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "UNKNOWN";

/** One row of an account's activity: an order-service order or another on-chain transaction. */
export interface Transaction {
  /** Page-unique, built from chain data. Not an order id. */
  id: string;
  transactionHash?: string;
  blockNumber: number;
  blockTimestamp?: string;
  type: string;
  activityType?: string;
  status: TransactionStatus;
  sourceSystem?: string;
  source?: { currency: string; amount?: string; address?: string; account?: string };
  destination?: { currency: string; amount?: string; address?: string; account?: string };
  signerAddress: string;
  items?: OrderItem[];
  events?: OrderEvent[];
  slippage?: number;
  priceImpact?: number;
  createdAt: string;
  /** Only on an order-service order: `order` links to it. */
  _links?: { order?: HalLink };
}

export interface ListTransactionsParams {
  netuid?: number;
  type?: ActivityType;
  /** 1..100. Server default is 20. */
  limit?: number;
  cursor?: string;
}

export interface TransactionPage {
  transactions: Transaction[];
  /** Total rows the page was read against. */
  total?: number;
  nextCursor?: string;
  prevCursor?: string;
}
