# Review contract (CI)

Used by the CI review of this repo, [`pr-review`](../SKILL.md). Adapted from the agent-harness `review` skill for a
pull request reviewed in CI, where there is no `task.md`, no `plan.md` and no suite to run.

**Interaction rule:** the review reports findings. It never says the PR is approved or fit to merge; a person decides.

## Inputs

| The harness review uses | In CI, use |
|---|---|
| The slice diff | `pr-diff.txt` (the PR's diff against its base), plus the PR's files at the repository root for context |
| `task.md` acceptance criteria | The PR title and description, and any Jira key (`API-123`) it names. If the description states no goal or acceptance criteria, say so once as a `major` (`PR:missing-acceptance-criteria`) and judge fitness against the title |
| `plan.md` locked decisions | Decisions the PR description states. A structure the description explicitly asks for is earned |
| Running the suite and the type checker | Do not run or re-derive them. The `Checks` workflow runs `npm run typecheck`, `npm test` and `npm run build` on every PR. Spend the review on what those cannot see, and write `SUITE: not-run (CI runs it)` |
| The previous round's report | `previous-review.md`: this review's last report on this PR, if any |

Standards (`CLAUDE.md` if present, the skill and its references) come from the base branch under `.review-base/`.
Judge the code against those copies. If the PR changes a standard, review that change as part of the diff.

## Severity

| Severity | Meaning | Typically |
|---|---|---|
| `blocker` | Shipping as-is would be wrong, unsafe, unverified, **or carries structure nothing asked for** | An acceptance criterion with a `gap`; a breaking public-API change without a major bump; a code-quality hard limit; no test for an acceptance criterion or for a new branch or error path; a security finding; any [unearned structure](#unearned-structure-blocks) |
| `major` | A real problem, not a correctness risk | A code-quality warn; an over-engineering cut worth roughly 15+ lines; a test that passes but asserts weakly |
| `nit` | Taste, naming, micro-simplification | Everything else worth a sentence |

When torn between `blocker` and `major`, ask: *if this shipped unchanged, would the behaviour be wrong, unsafe, or
unverified?* Yes → `blocker`. "I would have written it differently" → `major` or `nit`. Never inflate a taste-level
finding to `blocker`: a review that gates on taste gets ignored, and then its real blockers are ignored too.

### Unearned structure blocks

Every other check can only ask for more code. So a narrow, countable class of over-engineering blocks:

| Blocks | Test |
|---|---|
| Abstraction with one implementation and one caller | An interface, base class, factory or wrapper the diff introduces where exactly one concrete thing implements it and one place calls it |
| Dependency duplicating something already available | A new package whose used surface is covered by the standard library, the platform or a dependency already in `package.json` |
| Layer nobody asked for | New indirection with a single caller that the PR description does not name |
| Dead flexibility | Options nobody sets, parameters no caller passes, internal symbols nothing imports, branches nothing reaches |

Each is a yes/no question about how many implementations, callers or importers exist. Count them; don't judge elegance.
Two exemptions, and say which applies: structure the PR description explicitly requires, and a public option or
injection point (such as `fetch` or a signer function) that callers of a published SDK need to test or customise it.

### Unclear findings

`unclear` means the code alone cannot show whether a behaviour holds. Give it a severity anyway: `blocker` when it
touches amounts, prices, fees, signing, authentication or which order gets registered; `major` otherwise. Always say
what evidence would settle it (a test, the service's API spec, a run against testnet).

## IDs and fingerprints

Number findings per severity (`B1`, `B2`, `M1`, `N1`) and give each a fingerprint `<path>:<symbol-or-rule>`, for
example `src/client.ts:placeMarketOrder` or `package.json:version-bump`.

When `previous-review.md` exists, read it first. For a problem that is still present, reuse its ID and fingerprint. List
the previous IDs that are now fixed under `RESOLVED`. New findings take the next free number. A fingerprint is what
lets a reader tell "the same problem is still here" from "a new problem appeared".

## Output

Write `review-body.md` in this order:

1. The review's own sections, as its skill defines them.
2. `### Findings`, one table for every finding:

   ```markdown
   | ID | Severity | Fingerprint | Finding | Fix |
   |----|----------|-------------|---------|-----|
   | B1 | blocker | `src/...:symbol` | ... | ... |
   ```

   If there are none, write `No findings.`
3. `### Quick fix prompt`: a fenced `text` block the developer can paste into Claude Code, listing the blockers and
   majors as `<file>:<line> — <severity>: <what to fix>`. Omit the section when there are none.
4. The verdict block, last, with nothing after it. The workflow reads it from the end of the file:

   ```text
   VERDICT: pass | changes-required
   BLOCKERS: <count>
   MAJORS: <count>
   NITS: <count>
   SUITE: not-run (CI runs it)
   OPEN: <blocker IDs with fingerprints, comma-separated, or none>
   NEW: <blocker IDs first raised in this review, or none>
   RESOLVED: <IDs from previous-review.md that are now fixed, or none>
   NOTE: <one line: a dispute, or a decision only a person can make; else empty>
   ```

`VERDICT: pass` requires zero blockers. Majors and nits never gate; they are a punch list. `pass` means "this review
found no blockers", not "approved".

Write `review-comments.json` with inline comments for blockers and majors only; nits stay in the body. Each comment
starts with its ID and severity, for example `**B1 (blocker)** ...`.

## Do not

- Claim the PR is approved or fit for purpose.
- Demand ceremony for code that is already simple, or invent layers.
- Repeat what the type checker or the test suite already enforce.
