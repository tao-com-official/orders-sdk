---
name: pr-review
description: >-
  CI review of a @tao.com/orders-sdk pull request, run by the Claude Code Review workflow on every push. Applies the
  agent-harness review checks (over-engineering, task fitness against the PR description, code quality, a "name the
  bug" test audit) plus this SDK's public-API, wire-contract and security rules. Labels every finding
  blocker/major/nit with a stable fingerprint and ends with a machine-readable verdict block. Use when the workflow
  runs it or when asked to review a PR the way CI does.
allowed-tools: Read Grep Glob
---

# PR review

Review one pull request of `@tao.com/orders-sdk`: a published, ESM-only TypeScript SDK for the TAO.com order service
(market orders that swap, stake and move TAO, Root and subnet alpha on Bittensor). It has no runtime dependencies,
uses the global `fetch` (Node 20+ and browsers) and never holds keys: callers pass signing functions.

Follow the [review contract](references/review-contract.md) for inputs, severity, fingerprints and the output format.
Read it first.

## 1. Over-engineering

What can be deleted? One line per finding: `<file>:L<line>: <tag> <what>. <replacement>.`

- `delete:` dead code, unused flexibility, a speculative feature. Replacement: nothing.
- `stdlib:` a hand-rolled thing Node, the browser platform or TypeScript ships. Name the function.
- `native:` code doing what the platform already does. Name it.
- `yagni:` an abstraction with one implementation, an option nobody sets, a layer with one caller.
- `shrink:` the same logic in fewer lines. Show the shorter form.

End with `net: -<N> lines possible.` or `Lean already. Ship.` Most findings are `major` or `nit`; anything matching
[unearned structure](references/review-contract.md#unearned-structure-blocks) is a `blocker`.

## 2. Task fitness

Treat the PR title and description as the task. Extract its goal, acceptance criteria and non-goals, then walk each
criterion:

| Status | Meaning |
|---|---|
| `pass` | The behaviour is clearly present in the diff |
| `gap` | Missing, partial or contradicted (`blocker`) |
| `unclear` | The code cannot show it; say what evidence would (see the contract for its severity) |
| `out-of-scope held` | A stated non-goal is correctly not implemented |

Also report overreach (code for something the description does not ask for) and anything the description promises
that the diff lacks. Cite files and symbols; never rubber-stamp.

## 3. Public API and packaging

The public surface is what `src/index.ts` exports, plus the shape of every exported type. It is published to npm, so
consumers depend on it.

| Check | Typical severity |
|---|---|
| An exported symbol, option, parameter or type field removed, renamed or narrowed, or a default changed, without a major version bump in `package.json` | `blocker` |
| A new public symbol, option or behaviour without a minor version bump, or a fix without a patch bump, when the PR is meant to be released | `major` |
| A runtime `dependency` added (the SDK has none by design) | `blocker` |
| Node-only APIs (`fs`, `Buffer`, `process`, `crypto` from `node:`) in `src/` (the SDK also runs in browsers) | `blocker` |
| A new export missing from `src/index.ts`, or an internal helper exported by accident | `major` |
| Build output (`dist/`), `.env*` or other ignored files committed | `blocker` |
| `README.md` describing behaviour, options or examples the diff changes, left outdated | `major` |

## 4. Wire contract with the order service

The SDK mirrors the order service's HTTP API (`/orders/v2`, HAL+JSON responses, `application/problem+json` errors).

- Amounts are integers in rao (`bigint` or digit strings) end to end. A conversion through `number`, a float, or
  rounding of an amount or price: `blocker`.
- Currencies are URNs (`urn:bittensor:<network>:native`, `urn:bittensor:<network>:alpha:<netuid>`); building one for
  the wrong network or netuid: `blocker`.
- A request field, query parameter or response field the code reads or sends whose name or shape the diff changes
  without evidence (a link to the service's spec or PR in the description) that the service matches: `unclear`, rated
  per the contract.
- Error paths: a non-2xx response or a network failure that is not surfaced as `OrderServiceError`,
  `OrderServiceNetworkError`, `AuthenticationError` or `PreflightError`, or that loses the `Problem` details: `major`.
- The `placeMarketOrder` order of operations (author, pre-flight check, `beforeSign`, sign, register) is a safety
  property: anything that signs or registers before the pre-flight check or `beforeSign` hook: `blocker`.

## 5. Code quality

| Rule | Warn (`major`) | Hard (`blocker`) |
|---|---|---|
| Cyclomatic complexity | > 10 | > 15 |
| Function length | > 40 lines | > 75 lines |
| Argument count | > 4 | > 6 |
| Nesting depth | > 3 | > 4 |
| Hardcoded credential, token or environment-specific config in logic | | any |

Also flag magic numbers and strings, boolean flag parameters, swallowed errors, duplicated logic and unclear naming
(`major` or `nit`), and this repo's conventions (`major` unless they break behaviour):

- TypeScript strict: no `any`, no unchecked non-null assertions, return types on exported functions.
- Relative imports end in `.js` (ESM output).
- Public symbols carry a doc comment that says what a caller needs to know (units, defaults, what throws).
- Regexes on caller- or server-supplied strings must not backtrack catastrophically (see `trimTrailingSlashes`).
- Comments only where the why is not obvious; no stray `TODO`/`FIXME` without a ticket.

## 6. Test audit

Audit tests (`test/*.test.ts`, vitest) by the defects they would catch. For each new or changed behaviour, answer:

1. **What is the plausible wrong answer?** The specific way it could compute something incorrect and still run: an
   inverted comparison, an off-by-one at a boundary, rao vs TAO, rounding the wrong way, truncating a `bigint`, gross
   where net was meant, the wrong network in a URN, a fee in the wrong currency, a token reused after it expired.
2. **Which test fails if that happens?** Name it. If none does, that is a missing test: a `blocker` when the behaviour
   touches amounts, prices, slippage, fees, signing or authentication, or is a new branch or error path; otherwise
   `major`.

Then check:

- **Missing tests:** acceptance criteria, new branches and error paths with no test.
- **Useless tests:** tests that cannot fail meaningfully, assert only mocks, restate the implementation, or duplicate
  another (`major`).
- **Shared output changes:** when a function's output changes, its literal expected values are updated across `test/`
  (`major`).

## 7. Security

- A private key, seed, signature or token held, logged, put in an error message, or sent anywhere but its intended
  request: `blocker`.
- A challenge or instruction signed in any form other than the bytes the service sent (wrapped, hashed, re-encoded),
  or a signature attached to a different order than the one authored: `blocker`.
- A bearer token sent to a host other than the configured `baseUrl` / `authBaseUrl`, or over plain HTTP by default:
  `blocker`.
- Server responses used without the type guards or validation the code relies on: `major`.
- `console` output from library code: `major` (a library must not write to the caller's console).

## Sections of `review-body.md`

`### Over-engineering`, `### Task fitness` (table), `### Public API` (table: symbol, change, semver impact, verdict),
`### Wire contract`, `### Code quality` (table: location, rule, value, verdict), `### Test audit` (table: behaviour,
plausible wrong answer, test that catches it or **none**, then missing and useless), `### Security`, then the findings
table, the quick fix prompt and the verdict block as the [contract](references/review-contract.md#output) defines.
