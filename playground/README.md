# Orders SDK Playground

A local page that drives `@tao.com/orders-sdk` from `../src`, so an SDK change shows here without a build.

```sh
cd playground
npm ci
npm run dev     # http://localhost:5173
```

- **Network:** testnet (`api.dev.tao.com`) or mainnet (`api.tao.com`). The Vite dev server proxies both: the API gateway answers the browser's CORS preflight with 401, so the page cannot call it directly.
- **Wallet:** any Polkadot extension in `window.injectedWeb3` (TAO.com, Talisman, SubWallet, polkadot.js, Bittensor), or a seed phrase. The seed lives in page memory only and is never stored. Use a throwaway wallet for it.
- **Market:** one form for every market order type. Quote shows what you get and the fees; Sign & Place signs that same authored order.
- **Limit:** Limit Buy (with optional SL/TP), Take Profit, Stop Loss, Profit Lock, Market Buy + SL/TP. A type the environment has not enabled answers 422.
- **History:** Orders (`listOrders`, polled every 5 s while any order can still change) and Activity (`listTransactions`). Click a row for the full order, Cancel while it is open.
- **Requests:** every SDK call with its request and response. Calls to the auth service are listed without their bodies.

Signing an extrinsic needs the runtime metadata, which the service leaves out of the payload, so the page reads it once from the chain RPC (`wss://testnet.prod.tao.com`, `wss://lite.prod.tao.com`).

`src/signers.ts` turns a seed or an extension account into the SDK's `ChallengeSigner` and `InstructionSigner`. It will move into the SDK once an app has used it.
