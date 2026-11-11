# CLAUDE.md

Context for any Claude session working in this repo.

## Secrets: read this first

Never put a key, password, token or connection string in this file, or in any
file that is committed. That includes Supabase keys, the Anthropic key and the
QA bot's credentials.

Real values live in `.env.local`, which is gitignored. `.env.example` holds the
variable names with blank values. CI runs gitleaks. The assessment explicitly
asks for secrets to be kept out of the repository, so a leaked key here is a
scored failure, not just untidiness.

Variables used:

```
SUPABASE_URL=            # new project, not Namzoed
SUPABASE_SECRET_KEY=     # server side only, never NEXT_PUBLIC_
ANTHROPIC_API_KEY=       # optional, for AI_MODE=claude
SEED_QA_EMAIL=           # QA bot, external targets only
SEED_QA_PASSWORD=
SEED_QA_TOTP_SECRET=
ADMIN_EMAIL=           # /admin portal, off unless all three are set
ADMIN_PASSWORD=        # 16+ chars; npm run admin-key fills these
ADMIN_TOTP_SECRET=     # key the admin phone scanned
```

## What this is

Candidate assessment for Eclypse AI (platform QA / AI engineering).
Owner: Sonam Dorji (Yamnang), GitHub `Yaamnang`, repo `Yaamnang/qa-platform` (private).

Eclypse runs a multi-tenant AI platform used by pharma and healthcare clients.
The task is to design and prototype an automated QA system that tests that
platform's frontend the way a real user would.

Repo due Monday 9 Nov 2026, 11:00 Singapore. Demo around 10 Nov.
A working core beats a broad, shallow system.

## Their five requirements

1. Runs by itself: on every code change, after every release, on a schedule against live.
2. Uses the platform like a real user: signs in with a one-time code, clicks, fills forms,
   uploads and downloads files, and checks each action really worked.
3. Follows long AI jobs to the end and checks that what they report is true.
4. Never touches or exposes client data.
5. Explains clearly what broke, with no false alarms.

Prototype must run from one command with a clear PASS/FAIL and a report, catch
several kinds of bugs, and give the same result ten runs in a row.

## Current state

Core works. Latest local run: PASS, 21 tests, 0 failed, 62s, AI mode mock.

Built: the stand-in in `app/` with auth (password plus TOTP, real QR enrolment),
documents, jobs, reports, orgs, team, settings, flags, health. The runner in
`qa/` with nine spec files, the guard fixture, `run.ts` with `--repeat` and
`--bug-matrix`, plain-language reporter, TOTP helper, triage, AI output checks.
Bug switches in `lib/bug-catalog.ts`. Three GitHub workflows. `docs/DESIGN.md` drafted.

In progress: Supabase store adapter, Vultr deployment, UI makeover.

Already handled, worth pointing at rather than fixing: TOTP replay protection
(`verify` rejects a step at or below `user.lastTotpStep`) and sign-in attempt
limiting (five tries, then 429).

## Architecture

Two parts in one repo. The runner never imports from the app.

### Stand-in platform

Next.js App Router, TypeScript. Pretends to be Eclypse's platform.

- Tenants: a pharma client, a hospital client, and a QA tenant the robot uses.
- Roles: Admin and Viewer.
- Journeys: sign in with password plus six-digit code, upload a CSV of adverse
  event reports, run the analysis job with progress, read the report, download
  it, invite a teammate, change settings, sign out.
- AI job: mock by default, computes the summary from the uploaded CSV.
  `AI_MODE=claude` calls Claude Haiku, cached. `AI_MODE=replay` serves cache
  only and never spends. A missing key falls back to mock and says so. A present
  key that fails is a failure, never a silent fallback.
- Bug switches, all off by default. One per failure mode, including
  `slow-documents`, which must NOT fail the run. That one proves the system does
  not cry wolf and it is the most valuable entry in the catalog.

### Storage

Two backends behind one switch.

- No Supabase env vars: in-memory store, reseeded on every start. This stays the
  default and it is the reviewer path, so `npm run qa` works on a clean clone
  with no accounts and no setup. Do not break this.
- Supabase env vars set: cloud Postgres. New project of its own. Never the
  Namzoed project, never a shared database.
- Tables prefixed `eclypse_`. Migrations and setup SQL only create, alter or drop
  `eclypse_*` objects.
- `global-setup.ts` must reset and reseed before each run when Supabase is
  active. Persistent state otherwise breaks the ten-identical-runs proof, since
  single-use codes and created rows carry over between runs.

### The runner

Playwright, TypeScript.

- Stable `data-testid` selectors. Condition-based waits. No fixed sleeps.
- Checks outcomes, not page loads: the row appears, the downloaded bytes match,
  the numbers in the AI report match values computed from the uploaded CSV.
  Facts checked, wording ignored.
- Guard fixture on every test: write allow-list, deletes restricted to what the
  bot created, canary scan of every API response and the final screen, 5xx and
  uncaught JS errors become failures, console errors are evidence not failures,
  cleanup even on failure.
- A failure is rerun once before being reported. Infra errors labelled separately
  from product bugs.
- `--target=<url>` points it at any deployment. Without it, it starts the local
  stand-in.

## Hosting (Vultr)

One instance, Ubuntu 24.04, 2 vCPU / 4GB, Singapore region. Credits expire
7 Dec 2026. No domain, so bare IP with ports, or nip.io if TLS is wanted.

```
:3000   stand-in, clean
:3001   stand-in, same code, BUGS set
:4000   dashboard
cron    hourly: npm run qa -- --target http://IP:3000
```

pm2 keeps the three processes up. `npx playwright install --with-deps chromium`
for the browser libraries. Set `INSECURE_COOKIES=1` on both stand-ins, since
plain http. Add the server IP to `QA_ALLOWED_HOSTS` or preflight stops the run.

The repo must still work entirely locally with one command. Vultr is demo
infrastructure, not a submission dependency.

## UI

The UI is what a reviewer looks at during the demo, so it should look deliberate.
Modern and plain. No decoration.

- Tailwind v4 is already used across `app/` and `components/`. Keep it. Do not
  mix in plain CSS. Do not restyle working screens for their own sake.
- No redundant text. Delete every welcome line, every subtitle that restates the
  heading, every paragraph explaining what an obvious button does. If a sentence
  does not tell the user something they cannot see, cut it.
- No marketing voice, no exclamation marks, no emoji in the product UI.
- Dark neutral background, one accent colour, semantic colour only for state:
  green pass, red fail, amber warning, grey skipped.
- One type scale. Monospace for ids, counts, durations and file names.
- Real loading, empty and error states on every screen. The robot tests these.
- Status as a small dot plus a word. No badge soup, no stacked shadows.
- Forms: visible labels above inputs, never a placeholder as a label. Inline
  errors under the field, not in a toast.
- Keep the three.js shader off every app screen. Sign-in at most, cutting it is fine.
- Never rename a `data-testid` while restyling. It breaks the suite.

## CI

- PR: full suite against the local stand-in, mock AI.
- Post-release: smoke suite against staging.
- Scheduled: read-only checks against live plus one small real AI job, QA tenant
  only, with a cost cap.

## Rules for working here

- Commit author is always Sonam Dorji <sonamd5dorji@gmail.com>. Never add Claude
  as author or co-author.
- Keep code simple enough to explain file by file in a live Q&A.
- State honestly in the README where AI tools were used.
- Writing style for docs, README and UI copy: plain and direct. No em dashes. No
  AI-sounding filler.
- Cut extras before cutting the core flow.

## Risks for the design doc

One-time code lockouts and rate limits. Test data piling up on live. AI cost
runaway. The robot account as a security hole, so least privilege. Screenshots
and traces leaking data. Selectors breaking on redesigns. Sessions expiring
during long AI jobs. Alert fatigue. A job that completes successfully and
reports numbers that are wrong.
