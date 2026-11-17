export { OrderServiceClient } from "./client.js";
export type { Network, OrderServiceClientOptions } from "./client.js";
export { TAO_COM_VALIDATOR_HOTKEYS } from "./hotkeys.js";
export { AuthenticationError, OrderServiceError, OrderServiceNetworkError, PreflightError } from "./errors.js";
export { createApiKeyAuth, createWalletAuth } from "./auth.js";
export type { ApiKeyAuthOptions, ChallengeSigner, DelegateOptions, TokenAuth, WalletAuth, WalletAuthOptions } from "./auth.js";
export { ACCESS_TOKEN_TYPE, exchangeToken, TOKEN_EXCHANGE_GRANT } from "./token-exchange.js";
export type { DelegateToken, TokenExchangeOptions } from "./token-exchange.js";
export type { Problem } from "./errors.js";
export { DEFAULT_AUTH_BASE_URL, DEFAULT_BASE_URL } from "./http.js";
export type { AuthSource, FetchLike } from "./http.js";
export { MARKET_ORDER_TYPES } from "./types.js";
export { feesInCurrency, feesUsd, netAfterFees } from "./fees.js";
export { RAO, ROOT_PRICE, spotPrice } from "./slippage.js";
// Listed rather than `export type *`, which Semgrep (funds-safety) can't parse.
export type {
  Amount,
  AuthorOrderRequest,
  AuthoredOrder,
  CurrencyAmount,
  EstimatedFee,
  FeeType,
  HalLink,
  Instruction,
  InstructionSigner,
  ListOrdersParams,
  ListableOrderStatus,
  MarketOrderType,
  Order,
  OrderCategory,
  OrderEnvelope,
  OrderEvent,
  OrderEventType,
  OrderItem,
  OrderLegInput,
  OrderPage,
  OrderStatus,
  OrderSummary,
  PlaceMarketOrderOptions,
  PlaceMarketOrderRequest,
  PreflightCode,
  PreflightWarning,
  Quote,
  RawInstruction,
  RegisterOrderRequest,
  SignatureType,
  SignedInstruction,
  StakeRootRequest,
  SubmitAuthoredOptions,
  SubstrateExtrinsicInstruction,
} from "./types.js";
