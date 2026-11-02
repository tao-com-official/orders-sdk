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
export type ListableOrderStatus = "OPEN" | "SUBMITTED" | "FILLED" | "FAILED" | "CANCELLED";

/**
 * An order's status. Besides the five lifecycle statuses, the service stores whatever the matcher
 * last reported, so an order can also read `CLAIMED` (the matcher picked it up), `ACCEPTED` (the
 * network accepted the transaction; it is not final yet) or `ERROR` (the matcher hit an error;
 * see the event's `failureReason`). `FILLED` and `FAILED` are the on-chain outcomes.
 */
export type OrderStatus = ListableOrderStatus | "CLAIMED" | "ACCEPTED" | "ERROR";

export type OrderCategory = "BITTENSOR_LIMIT" | "BITTENSOR_MARKET" | "CROSS_CHAIN";

export type CurrencyAmount = { value: string; currency: string };

export type FeeType = "TRANSACTION" | "PLATFORM" | "SUBNET_AMM" | "MEV_SHIELD" | (string & {});

export interface HalLink {
  href: string;
  templated?: true;
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
  /** What you receive after fees. Present for market orders; absent on older services. */
  quotes?: Quote[];
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
  createdAt: string;
  updatedAt: string;
  _links: { self: HalLink; cancel?: HalLink };
}

export interface OrderSummary {
  id: string;
  type: MarketOrderType;
  status: OrderStatus;
  source: { currency: string; amount: string };
  destination: { currency: string; amount?: string };
  createdAt: string;
  updatedAt: string;
  _links: { self: HalLink; cancel?: HalLink };
}

export interface ListOrdersParams {
  status?: ListableOrderStatus;
  orderType?: MarketOrderType;
  /** Defaults to `BITTENSOR_MARKET`, the only category this SDK models. */
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
  idempotencyKey?: string;
  sourceSystem?: string;
}

// ---- high level ------------------------------------------------------------

export type PlaceMarketOrderRequest = AuthorOrderRequest & PlaceMarketOrderOptions;

export interface PlaceMarketOrderOptions {
  signer: InstructionSigner;
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
