# Automated QA for the Eclypse platform: design

**Goal:** a system that uses the platform the way a client's team does (signs in, uploads, runs AI jobs, downloads, changes settings), proves each action really worked, and tells the right person in plain language when something breaks, without touching client data or raising false alarms.

The prototype in this repository implements the core of this design against a stand-in platform: `npm run qa`.

## 1. How it works

```
 trigger (PR / release / schedule)
        │
        ▼
 qa/run.ts ── preflight: host allow-list · health check · live-mode guard
        │
        ▼
 Playwright (Chromium) ── setup: sign in as QA bot (password + TOTP) ──► SAFETY STOP unless tenant == qa-synthetic
        │                                         │ session reused by all tests
        ▼                                         ▼
 user-journey tests ─── every test wrapped in a GUARD fixture:
   sign-in, upload, delete,     · write allow-list; may only delete what it created
   AI job, download, settings,  · canary scan of every API response + final screen
   tenant isolation             · uncaught JS errors and 5xx → failure; console errors → evidence
        │                       · cleans up its own data, even on failure
        ▼
 plain-language reporter ── groups failures by root cause → report.md + summary.json + HTML/trace
        │
        ▼
 optional Claude triage (advisory) ──► CI summary · merge gate · Slack page (live)
```

**What it checks.** Journeys, not page loads. Each test performs a task end-to-end and then verifies the outcome a user cares about: the uploaded file appears *with the right row count* and survives a reload; delete removes *that* document and *nothing else*; "Settings saved" is *actually* saved; an AI job reaches "Complete" and *every number it reports matches the input file*; the downloaded CSV/JSON match what was on screen. Negative paths count too: wrong password, wrong code, wrong file type and invalid email must each fail with a clear message.

**When it runs.**

| Trigger | Target | Scope | AI | Retries | On failure |
|---|---|---|---|---|---|
| Every PR / push | Fresh stand-in or ephemeral env built from the branch | Everything | Fake AI: true facts, varied wording, free | 1 (pass-on-retry is reported as "flaky") | Blocks merge |
| After every release | Staging (or production canary slice) | Everything | Real model via record/replay gateway | 1 (pass-on-retry = "flaky") | Blocks promotion, release owner notified |
| Every 30 min | **Live** | `@live-safe` only, synthetic tenant | n/a | 1 | Page only if confirmed (see §6) |
| Every 6 h | **Live** | + one real AI job (`@costly`) | Real, small fixture | 1 | As above |

## 2. Tools and why

| Choice | Why | Alternatives considered |
|---|---|---|
| **Playwright** (TypeScript) | Real browsers; auto-waiting and web-first assertions (main defence against flakiness); first-class file upload/download, multiple contexts, network interception (used for the safety allow-list); traces with DOM snapshots for debugging. Same language as the Next.js frontend, so frontend engineers can maintain it. | **Cypress**: weaker on downloads, multi-tab and multi-origin, no true network-level blocking. **Selenium**: more plumbing, more flake. **AI browser agents**: non-deterministic and costly; good for exploratory testing, wrong for a merge gate. |
| **Accessible locators** (`getByRole`, `getByLabel`) | Tests find things the way users and screen readers do, so restyling doesn't break tests, and a missing label is a real finding. | CSS/XPath selectors break on every redesign. |
| **GitHub Actions** | Same place the code lives; secrets, environments, concurrency groups, artifacts. | Any CI works; the runner is one command. |
| **Claude (Anthropic SDK)** | Advisory only: a judge for free-text AI summaries and plain-English failure triage. Structured output, cached by input hash. | No LLM in the pass/fail path (see §5). |
| **TOTP for the bot's MFA** | See §3. | Email-OTP inbox services (fallback only). |

## 3. Signing in when sign-in needs a one-time code

- **The bot is a real user with real MFA.** Its account is enrolled with an authenticator (TOTP) secret stored in the CI secret store per environment. The runner computes the 6-digit code exactly as a phone app would (`qa/lib/totp.ts`). The product has no test-only backdoor or "skip MFA" flag. Such a flag is the kind of thing that eventually ships to production.
- **Codes are single-use.** Platforms (correctly) reject a reused code, so two sign-ins in one 30-second window fail at random, a classic flaky test. `freshCode()` records the last window used and waits for the next one, and avoids the last 2 seconds of a window.
- **Sign in once per run.** A setup step signs in, then **checks which tenant it landed in and stops the whole run if it isn't the synthetic one**. It saves the session, which all tests reuse. Fewer sign-ins means fewer codes, less load on auth, no lockouts.
- **Secrets never leak through artifacts.** Traces record typed text, so tracing is off for steps that type secrets. The reporter redacts secrets from every message. The saved session is deleted and signed out server-side at the end of the run, so a token captured in a trace or screenshot is worthless.
- **Lockout is a real risk.** A misconfigured run retrying bad codes can lock the account and blind live monitoring. Mitigations: at most one sign-in attempt per run, `concurrency` groups so runs on one account never overlap, and separate bot accounts per environment.
- If the platform only offers email OTP: a dedicated inbox (e.g. Mailosaur) per bot account, read via API. The rest of the design is unchanged.

## 4. Staying safe on the live platform

The principle: **the bot can only ever see and change synthetic data, and it fails closed if it can't prove that.**

1. **Synthetic tenants only.** The bot is a member of `qa-synthetic` only, with a normal (non-admin) role. Least privilege means even a buggy test can't reach client data through the permission system.
2. **Fail-closed tenant check** after sign-in (above). An unexpected tenant stops the run before any click.
3. **Write allow-list in the browser.** Every non-GET request from the page goes through a network guard. Only expected writes pass, and **DELETE is only allowed for documents the bot created in this test**. Anything else is blocked and reported as a SAFETY finding.
4. **Isolation tested with canaries, not client data.** A second synthetic tenant (`qa-canary`) holds records with a unique marker. The guard scans every API response and the final screen of every test for those markers, so a cross-tenant leak anywhere is caught, as a CRITICAL. Direct ID access to the canary's document must return 404.
5. **Own-data hygiene.** Everything the bot creates has a `qa-run-<id>` prefix. Each test deletes what it created even when it fails, and a teardown sweeper removes leftovers from crashed runs, only by prefix and only after re-confirming the tenant.
6. **Live-mode interlocks.** Live runs refuse to start unless `QA_ALLOW_LIVE=1`, the host is allow-listed, and the run is limited to `@live-safe` tests.
7. **Evidence policy.** Screenshots and traces show only synthetic data, but production artifacts are still limited to the text report (7-day retention). Claude never receives page content, screenshots or traces, only the redacted failure text.
8. **Be a good citizen.** Bot traffic is identifiable (`X-QA-Run` header, known account), so it can be excluded from analytics, billing and usage alerts. Disabling the bot account is the kill switch.

## 5. AI output that changes every run, and cost

**Test facts, not wording.** The test uploads a synthetic file whose true answers are known and hand-checked (`adverse-events-24.expected.json`). Gating checks apply only to things that must always be true:
- every **structured** claim (counts, top event) equals ground truth;
- the summary exists and contains no junk (`undefined`, `NaN`, template braces);
- downloads match the screen.

**Prose is advisory.** Numbers in the summary that aren't in the findings, and an optional Claude judge reading the summary against the facts, produce **warnings**, never a red build. A judge that is wrong 2% of the time would otherwise cry wolf daily.

**Design for checkability.** This works because the product returns AI results as structured findings plus prose. Recommendation to the platform team: any AI feature whose claims matter should expose them in a structured form. That makes it testable and also safer for users.

**Long jobs.** The tracker watches what the user sees (stage, progress bar, status) and fails *early and specifically*: "stuck at *Analyzing with AI*, 75%, no change for 15s", "progress went backwards", or "page stopped rendering", rather than a vague 10-minute timeout. The timeline is attached as evidence.

**Cost control.**

| Where | AI mode | Cost |
|---|---|---|
| PR runs (dozens/day) | Mock | $0 |
| Release runs | Record/replay at the platform's LLM gateway: cache key = hash(model, prompt version, input). First run records; reruns replay identical output for free. A prompt or model change produces a new key, so it is re-tested for real. | ≈ $0 per rerun |
| Live, 4×/day | Real model (Claude Haiku 5.5), smallest representative fixture (~2k tokens in, ~1.5k out) | ≈ $0.001/job → well under $1/month |
| Judge / triage | Low effort, cached by input hash; triage only on failures | cents/month |

Retries are capped at one (a retried AI job costs money too), and real-model jobs are behind the `@costly` tag. If Claude is requested but no key is configured, the stand-in uses the fake AI *and says so on screen*; if a real key is configured and the call fails, the job fails. A silent fallback would make a broken AI integration look healthy.

## 6. When it finds a problem

1. **One problem, one entry.** Failures are grouped by root cause. If sign-in breaks, the report says "14 tests not run because the bot could not sign in" instead of 15 red lines. Guard findings (crash, data leak, safety) are listed before the assertion that tripped later, because they are the cause.
2. **Plain language.** Each problem says: area and severity, which user journey, which step failed, expected vs actual in user terms ("*Adverse events recorded* should be 24 (true value in the uploaded file)", received 25), and evidence (screenshot, trace, job timeline). Optional Claude triage adds a two-sentence explanation for a PM, a likely owner and a next step, clearly marked advisory.
3. **Severity routing.**
   - **Critical** (canary leak, safety stop): page security and on-call immediately.
   - **High** (a journey is broken): PR blocked / release halted / on-call paged if confirmed.
   - **Medium:** ticket.
4. **No false alarms by design.**
   - **"Environment unavailable"** is one distinct result, not N failures.
   - **Live monitoring confirms before paging:** two consecutive failures, except critical.
   - **Flaky ≠ failed:** pass-on-retry is reported separately and tracked; repeat offenders are quarantined with an owner and a deadline, not deleted.
   - **Console errors are evidence, not failures:** browsers log expected 401s.
   - **Prose is never gated.**
   - **Slow is not broken:** waits are condition-based with generous ceilings, and the bug matrix includes a slow-but-working page that must pass.

## 7. Risks the brief didn't mention

- **Framework noise as a false alarm.** We found this one in the prototype: Next.js injects a hidden `role="alert"` route announcer, which made "no error shown" assertions fail on success. Assertions are scoped to the page's `main` region.
- **Bot lockout, and concurrent runs sharing one account.** Handled with concurrency groups and per-environment bots.
- **Secrets and session tokens in traces.** Handled as described in §3.
- **Bot traffic polluting analytics and billing, or tripping rate limits and fraud rules.** Handled by tagging and allow-listing the bot.
- **AI-provider outage mistaken for a product bug.** The job's error text and triage classify it as environment. The platform should also show users a clear error, and the tests check that it does.
- **Stale recordings after prompt or model changes.** The prompt version and model are part of the cache key.
- **Canary drift.** If someone deletes the canary, isolation tests pass vacuously. Design: a daily check, signed in as the canary tenant's own bot, confirms the canary still exists. Not built in the prototype.
- **Data build-up from crashed runs.** Handled by the prefix sweeper.
- **Environment differences:** time zone, locale, viewport and feature flags. Pinned per run (UTC, en-GB, 1280×800); feature flags read from the environment.

## 8. Upkeep

- **Code layout.**
  - Locators live in a few helpers (`qa/lib/ui.ts`).
  - Journeys read like the steps a user takes.
  - "Arrange" steps (seeding a document) use the API, so a broken upload button fails *one* test, not five.
- **Expected effort:** about half a day per sprint once stable, mostly when UX flows change. Frontend PRs that change a journey update its test in the same PR.
- **Ownership:** QA owns the framework; feature teams own their journeys.
- **Not in the prototype (next steps):**
  - cross-browser runs (Firefox, WebKit) nightly;
  - an accessibility scan (axe) on each journey;
  - visual regression on key screens;
  - performance budgets;
  - email-OTP fallback;
  - quarantine automation.

## 9. Prototype results and use of AI tools

- `npm run qa`: 15 checks (sign-in setup + 14 user journeys), PASS in about 30s, including a 20-second AI job (back-to-back runs about 60s while waiting for fresh one-time codes).
- `npm run qa:bugs`: nine realistic injected regressions, each caught with a specific headline. See `results/bug-matrix.md`.
- `npm run qa:repeat`: ten consecutive runs with identical outcomes, even though the fake AI words its summary differently every time. See `results/stability.md`.
- A deliberately slow page (3s documents list) must still PASS: proof that slowness alone does not raise an alarm.

AI assistance: the code, tests and this document were developed with Claude Code (Anthropic) as a pair-programmer; every design decision, test oracle and result was reviewed and run locally. Claude is also *part of* the system, in clearly bounded, advisory roles: the stand-in's AI job, the summary judge, and failure triage.
