# Security review rules

The automated security review (`security-review / review`) reads this file from `main`. Where it
conflicts with the shared checklists, it wins. Each rule below is a finding when a diff breaks it:
name the `file:line` and the attack, meaning who sends what and what they get.

`@tao.com/orders-sdk` is a **public npm package** for the TAO.com order service. It never holds a
key: the integrator passes `sign` (the login challenge) and `signer` (the order instruction)
functions backed by their own wallet. But it decides what those functions are asked to sign and
where the resulting tokens and signed orders are sent, so a bug here can move funds or leak a
session in every app that installs the release. Treat a reachable break of these rules as a
Security finding.

## What the wallet signs

- `createWalletAuth` (`auth.ts`) passes the service's challenge bytes to `sign` **verbatim**. Never
  wrap, hash, re-encode or build them from caller or response data other than the challenge.
- `placeMarketOrder` and `submitAuthored` (`client.ts`) sign the instruction the service authored
  for the order the caller described. Report any change that signs before the `warnings` /
  `PreflightError` check or the `beforeSign` hook, signs an instruction whose source, destination,
  amount, `signerAddress` or `limitPrice` differs from the request, or registers something other
  than what was signed.
- Amounts are integer rao as `bigint` or digit strings. Report any `Number` or floating-point maths
  on an amount, any unit change (TAO vs rao, USD vs TAO), and any rounding in `fees.ts`,
  `slippage.ts` or `token-exchange.ts` that favours the house or hides a fee from `userPayable`.
- Slippage: `limitPrice` is a fraction (0.01 = 1%). A default, clamp or conversion that widens it is
  a finding.
- Hotkeys in `hotkeys.ts` are never applied automatically; a change that defaults the validator a
  user stakes with is a finding.

## Sessions and tokens

- Access, refresh and delegate tokens live only in the SDK's memory. Never write them to storage,
  put them in a URL or query string, or include them in an error, log or thrown `body`.
- Tokens go only to `authBaseUrl` / `baseUrl` (default `https://api.tao.com`). Signed-order links
  from the service are followed by **path only**, against `baseUrl`, and must stay under `/orders/`.
  Following a returned origin or a path outside `/orders/` sends the Bearer token to another host.
- Auth and session changes use the JWT checklist. Comparisons of tokens or nonces use the
  timing-safe compare checklist.
- The SDK takes no API key. Adding one, or a header taken from a response, needs a reason in the PR.

## Remote data is untrusted

- Service responses (`http.ts`, `client.ts`, `auth.ts`) are shape-checked before use. A field that
  reaches signing, an amount or a URL without a check is a finding; a malformed reply fails, never
  falls back to a default.

## Supply chain and release

This package ships to the public registry with npm trusted publishing (OIDC), from `main` only,
through the `release` environment. In scope as well as `src/`: `.github/**`, `package.json`
(dependencies, `files`, `exports`, lifecycle scripts), `package-lock.json`, `tsconfig.build.json`
and `.agents/**`. The SDK has no runtime dependencies; adding one needs a reason. Look for install
scripts, `pull_request_target`, secrets reaching logs or artifacts, untrusted input (PR titles,
branch names, comment bodies) in `run:` lines, unpinned actions, widened `permissions`, and anything
that lets a publish run from a branch other than `main` or outside the `release` environment.
