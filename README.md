# @tao.com/orders-sdk

TypeScript SDK for the TAO.com order service: market orders that swap, stake and move TAO, Root (SN0) and subnet alpha on Bittensor.

```bash
npm install @tao.com/orders-sdk
```

The SDK is ESM-only, has no runtime dependencies and uses the global `fetch` (Node 20+ and browsers). It never holds keys: you pass it functions that sign with whatever wallet you use.

## Quick start

```ts
import { buyLimitPrice, createWalletAuth, OrderServiceClient, spotPrice } from "@tao.com/orders-sdk";

const walletAuth = createWalletAuth({
  authBaseUrl: "https://api.dev.tao.com",
  address: coldkey,                          // the wallet's SS58 address
  sign: (bytes) => wallet.signHex(bytes),    // the wallet's signature over the login challenge, as hex
});

const client = new OrderServiceClient({
  baseUrl: "https://api.dev.tao.com",
  auth: () => walletAuth.getToken(),
  network: "testnet",
});

// Stake 1 TAO into subnet 18, paying at most 1% over the current price.
const spot = spotPrice({ taoIn, alphaIn });  // from the subnet's pool on chain

const order = await client.placeMarketOrder({
  source: { currency: "urn:bittensor:testnet:native", amount: 1_000_000_000n },
  destination: {
    currency: "urn:bittensor:testnet:alpha:18",
    address: hotkey,                         // the validator to stake with
    limitPrice: buyLimitPrice(spot, 100),    // slippage limit, 100 basis points = 1%
  },
  signerAddress: coldkey,
  signer: signInstruction,                   // see "Signing"
});

console.log(order.id, order.status);         // "OPEN"
```

`placeMarketOrder` does everything in order:

1. asks the service to **author** the order. This is a dry run: it returns the unsigned instruction, a single-use provenance token and the fee estimates, and opens nothing;
2. calls your `beforeSign` hook, if any, so you can refuse an order before anything is signed;
3. calls your `signer` to sign the instruction;
4. **registers** the signed order, which is what opens it.

Amounts are integers in rao (1 TAO = `1_000_000_000`); pass a `bigint` or a digit string. Currencies are URNs: `urn:bittensor:<network>:native` for TAO and `urn:bittensor:<network>:alpha:<netuid>` for a subnet's alpha, where netuid `0` is Root.

An order that is registered still has to execute on chain. See [Order status](#order-status) for what happens next, and [Fees and minimum sizes](#fees-and-minimum-sizes) before you test with small amounts.

## Authentication

Every order call needs a Bearer JWT. The API gateway verifies it, and the order service requires its `username` claim to equal the order's `signerAddress`, otherwise it answers 403. The token comes from the TAO.com authentication service by proving ownership of the wallet: it sends a challenge, the wallet signs it, and the service returns an access token and a refresh token.

`createWalletAuth` does this and keeps the token current. `getToken()` signs in when needed, reuses the token until shortly before it expires, then refreshes it; when the refresh token nears the end of its life it signs in again. Concurrent callers share one login. Pass it to the client as `auth: () => walletAuth.getToken()`.

- `sign` receives the challenge bytes and must sign them verbatim (sr25519 or ed25519) and return the signature as hex. Do not wrap or hash them.
- **The first successful login for a wallet that is not registered yet creates its account.**
- If you already have a token from somewhere else, skip all of this and pass `auth: token` (a string, or a function called on each request).

### Delegate tokens

An integration that sits in front of the wallet (a bot or a mini-app host, for example) must exchange the wallet's access token for a **delegate token** that names the integration. The delegate token has the same power and carries an `act` claim; the order service reads the same `username` claim from it. It lasts 30 minutes and has no refresh token.

Pass `delegate` and `getToken()` returns the delegate token. When it expires, the SDK takes a current wallet token (cached, refreshed, or a new login) and exchanges again.

```ts
const walletAuth = createWalletAuth({
  authBaseUrl, address, sign,
  delegate: {
    actorTokenType: "<a type the auth service supports>",
    actorToken: () => launchPayload(),       // read fresh on every exchange, do not pre-encode it
    params: { /* extra form fields that type needs */ },
  },
});
```

To exchange once by hand: `exchangeToken({ authBaseUrl, subjectToken, actorTokenType, actorToken, params })` returns `{ accessToken, tokenType, expiresIn }`. What `actorToken` must contain, and which `params` a type needs, is defined by the auth service. If it answers `invalid_grant` the wallet token was rejected; the SDK signs in again and retries once.

## Signing

The service never sees your keys. Both the login challenge and every order are signed by functions you provide.

An order's `instruction` is one of:

- `SUBSTRATE_EXTRINSIC`: `payload` is a Polkadot-API `TxPayloadV1` JSON describing a batched call. Build the signed extrinsic from it **exactly as authored** (immortal era, call data and extensions untouched) and return its full hex.
- `RAW`: `payload` is hex bytes; return the signature over them.

```ts
import type { InstructionSigner } from "@tao.com/orders-sdk";

const signInstruction: InstructionSigner = async (instruction, { signerAddress, order }) => {
  // `instruction.payload` carries no chain metadata: fetch it from a node or take it from your wallet.
  const signedExtrinsicHex = await wallet.signExtrinsic(instruction.payload, signerAddress);
  return { type: "sr25519", value: signedExtrinsicHex };   // or "ed25519", e.g. for a Ledger
};
```

The service accepts only `sr25519` and `ed25519`. It rejects a mortal era or a changed call with `invalid-signature`.

## Orders

Describe both sides of the swap and the service works out the order type. `order.type` tells you which it chose:

| Swap | `order.type` |
| --- | --- |
| TAO to subnet alpha | `tao_to_alpha` |
| Subnet alpha to TAO | `alpha_to_tao` |
| TAO to Root, Root to TAO | `tao_to_sn0`, `sn0_to_tao` |
| Alpha to other alpha, same validator (Root counts as alpha) | `alpha_swap` |
| Same subnet, different validator | `alpha_move` |
| Different subnet and different validator | `alpha_swap_move` |

Every alpha leg needs `address`, the validator hotkey (SS58). The two legs of a swap may carry different hotkeys: that is how you move stake between validators. For a leg you leave without a hotkey, the SDK uses the other leg's, or the client's `hotkey` option.

```ts
// Move stake from SN18 to SN44, keeping the validator. Both legs get the same hotkey.
await client.placeMarketOrder({
  source: { currency: "urn:bittensor:testnet:alpha:18", amount: 5_000_000_000n, address: hotkey },
  destination: {
    currency: "urn:bittensor:testnet:alpha:44",
    limitPrice: swapLimitPrice({ origin: spot18, destination: spot44 }, 100),
  },
  signerAddress: coldkey,
  signer: signInstruction,
});
```

For Root there are two shortcuts: `client.stakeToRoot({ amount, hotkey, signerAddress, signer })` and `client.unstakeFromRoot(...)`.

`TAO_COM_VALIDATOR_HOTKEYS.mainnet` and `.testnet` are the TAO.com validator's hotkeys. They are only constants: nothing uses them unless you pass one as `hotkey`.

Pass `idempotencyKey` to `placeMarketOrder` (or `registerOrder`) to make a retry safe: the same key with the same order returns the same order. By default each call gets a fresh key. `sourceSystem` is an optional free-text tag stored on the order; it is self-reported, not authenticated.

## Slippage limits

Market orders carry a `limitPrice` on one leg for some swaps. It is enforced on chain: if the price moved past it, the transaction fails and nothing fills. Prices are integers scaled by 1e9 (`1000000000` means 1). When a required limit is missing the service answers 422 and names the field.

| Swap | `limitPrice` goes on | Meaning |
| --- | --- | --- |
| TAO to subnet alpha | `destination` | the most you will pay per alpha, in rao of TAO |
| Subnet alpha to TAO | `source` | the least you will accept per alpha |
| Alpha to other alpha, Root included | `destination` | the minimum destination alpha per origin alpha, ×1e9 |
| TAO to or from Root, same-subnet validator move | not needed | |

These pure helpers (no I/O) turn a price and a tolerance in basis points (100 = 1%) into a limit:

```ts
spotPrice({ taoIn, alphaIn });                               // rao of TAO per alpha, ×1e9
buyLimitPrice(spot, 100);                                    // TAO to alpha: spot + 1%
sellLimitPrice(spot, 100);                                   // alpha to TAO: spot − 1%
swapLimitPrice({ origin: spotA, destination: spotB }, 500);  // alpha to alpha: ratio − 5%
```

Read `taoIn` and `alphaIn` from the chain (`SubtensorModule.SubnetTAO` and `SubnetAlphaIn`). Root has no pool: its price is the constant `ROOT_PRICE` (1e9), so use that in `swapLimitPrice` for a Root leg. A limit that is too tight makes the order fail on chain and still costs the network fee, so leave room for the price to move between authoring and execution.

## Reviewing before you submit

Authoring is a dry run, so you can show the user what an order will cost before anything is signed or opened. `authorOrder` returns the unsigned instruction, the fee estimates and a provenance token. `submitAuthored` signs that same authored order and posts it back to the instruction link it returned, which is the step that opens the order. The order that opens is exactly the one you showed.

```ts
const authored = await client.authorOrder({ source, destination, signerAddress: coldkey });

const { fees, net } = netAfterFees(source.amount, authored.estimatedFees, source.currency);
// fees: what you pay in the source currency, in rao. They come out of the amount.
// net: source.amount minus those fees, which is what is actually swapped or staked.
feesUsd(authored.estimatedFees);   // estimated USD total of the fees you pay

// ...show it, and only if the user confirms:
const order = await client.submitAuthored(authored, { signer: signInstruction });
```

Dropping `authored` abandons the order at no cost: the provenance token is a signed, stateless claim that is only spent when an order is registered.

The fee estimates are what the service returns before you sign; it does not estimate what you will receive. The authored instruction is built from the wallet's current nonce and chain state, so submit it promptly and author again if anything changed (another transaction from the wallet, a long wait).

Each fee in `authored.estimatedFees` lists its amount in its own currency, a TAO conversion when it has one, and USD last; `userPayable: false` marks fees you do not pay (the subnet AMM fee). The helpers `netAfterFees`, `feesInCurrency` and `feesUsd` are exported.

### Fees and minimum sizes

When you pay in TAO, the service deducts the fees (network, platform and MEV shield) from `source.amount` and stakes what is left. The chain refuses a stake below its minimum (0.002 TAO, `AmountTooLow`). Such a transaction is still included and still pays the network fee, which is roughly 0.0009 TAO on testnet, and nothing is staked. A 0.001 TAO swap therefore stakes about 0.00009 TAO and fails.

Use `beforeSign` to refuse an order that fees would eat. It receives the authored order, fees included, before anything is signed, and throwing aborts with nothing signed or registered:

```ts
await client.placeMarketOrder({
  ...order,
  beforeSign: ({ estimatedFees }) => {
    const { net } = netAfterFees(amount, estimatedFees, nativeUrn);
    if (net < minStake) throw new Error("Too small: fees would leave less than the chain minimum");
  },
});
```

## Order status

```ts
const order = await client.getOrder(id);
order.status;   // see below
order.events;   // lifecycle events: type, time, and `failureReason` on a failure
order.items;    // once filled: what was bought, sold and charged
```

An order's status is the last thing the matcher reported:

| Status | Meaning |
| --- | --- |
| `OPEN` | Registered. Waiting for the matcher. You can cancel. |
| `CLAIMED` | The matcher has picked the order up. |
| `SUBMITTED` | The transaction was sent to the network. |
| `ACCEPTED` | The network accepted the transaction. It is not final until `FILLED`. |
| `FILLED` | Executed on chain. |
| `FAILED` | The order did not execute. The event's `failureReason` says why. |
| `ERROR` | The matcher reported an error with the order. See the event's `failureReason`. |
| `CANCELLED` | You cancelled it while it was `OPEN`. |

`FILLED`, `FAILED` and `CANCELLED` are final. Poll `getOrder` until the order reaches one of them.

```ts
await client.cancelOrder(id);   // only while OPEN; otherwise throws `cancel-not-allowed`

let page = await client.listOrders({ status: "FILLED", limit: 20 });   // your orders, market orders by default
while (page.nextCursor) page = await client.listOrders({ cursor: page.nextCursor });
```

`listOrders` also filters by `orderType` and `orderCategory` and returns `{ orders, nextCursor, prevCursor }`. It can filter by `OPEN`, `SUBMITTED`, `FILLED`, `FAILED` and `CANCELLED`.

## Errors

Failures throw one of three classes:

| Class | When |
| --- | --- |
| `OrderServiceError` | The service answered with a problem (RFC 9457). Has `status`, `code`, `problem` (with `field` for a bad input) and `requestId`. |
| `OrderServiceNetworkError` | No usable response: a network failure, a timeout, or an error that did not come from the service, such as the gateway rejecting a token. Has `status` when a response arrived. |
| `AuthenticationError` | Login, refresh or token exchange failed. `code` is `UNAUTHORIZED`, `HTTP_ERROR`, `NETWORK_ERROR` or `PROTOCOL`; `oauthError` carries the exchange's OAuth code. |

`OrderServiceError.code` is the last segment of the problem type:

| `code` | Status | Meaning |
| --- | --- | --- |
| `invalid-request` | 422 (400 for an unreadable body) | A field is wrong or missing, including a required `limitPrice`; see `problem.field`. |
| `invalid-address` | 422 | An address is not valid SS58. |
| `unsupported-swap`, `same-asset` | 422 | The pair is not supported. |
| `invalid-provenance` | 403 | The provenance token does not match the order, or was already used. Author again. |
| `invalid-signature` | 422 | The signature does not verify, or the call or era differs from what was authored. |
| `forbidden` | 403 | The token's `username` is not the order's `signerAddress`. |
| `idempotency-conflict` | 409 | The idempotency key was used with a different order. |
| `order-not-found` | 404 | No such order for this wallet. |
| `cancel-not-allowed` | 409 | The order is no longer `OPEN`. |
| `chain-unavailable`, `store-unavailable` | 503 | A dependency is down. Retry later. |
| `internal-error` | 500 | Unexpected. Report the `requestId`. |

```ts
try {
  await client.placeMarketOrder({ ... });
} catch (e) {
  if (e instanceof OrderServiceError && e.code === "invalid-request") show(`${e.problem.field}: ${e.problem.detail}`);
  else if (e instanceof OrderServiceError && e.status === 503) retryLater();
  else throw e;
}
```

Amount and limit arguments are checked before any request is sent, and throw a `RangeError` if they are not non-negative integers.

## Configuration

```ts
new OrderServiceClient({
  baseUrl: "https://api.dev.tao.com",  // the service origin; routes live under /orders/v2
  auth: () => walletAuth.getToken(),   // a token string, or a function called on every request
  network: "testnet",                  // "mainnet" (default) or "testnet": picks URNs for the Root helpers
  hotkey: myValidatorHotkey,           // used for an alpha leg that has no `address`
  timeoutMs: 30_000,                   // per request, default 30s
  fetch: customFetch,                  // defaults to the global fetch
});
```

## License

MIT
