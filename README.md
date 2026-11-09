# Eclypse automated QA (prototype)

A QA system that uses a web platform like a real user, checks that every action really worked, follows long AI jobs to the end and verifies what they report, stays away from client data, and explains failures in plain language.

| Path | What it is |
|---|---|
| `docs/DESIGN.pdf` | The design document (3 pages) |
| `qa/` | The QA system: Playwright journeys, safety guard, AI output checks, plain-language reporter, the one-command runner, and the explorer |
| `app/console/`, `lib/console/` | The QA console: the web app Eclypse engineers use to run QA |
| `app/`, `lib/server/`, `components/` | The stand-in: a small copy of an AI platform for pharma teams, with switchable injected bugs. This is what the QA system tests in the prototype |
| `results/` | Bug matrix, 10-run stability proof, sample reports |
| `.github/workflows/` | When it runs: every change, after every release, on a schedule against live |

## 1. Run it: one command

Needs Node.js 20.9 or newer. The first run downloads Chromium (about 150 MB). No accounts, keys or database needed.

```bash
npm install
npm run qa
```

It builds the stand-in, starts it with credentials made up for this run, signs in with password plus one-time code, runs every user journey and prints the verdict:

```
 QA RESULT: PASS   22 passed, 0 failed, 0 flaky, 0 not run, about 60s
 Report: qa-results/latest/report.md
```

Exit codes: 0 pass, 1 fail, 2 environment unavailable or safety stop, 3 runner error.

## 2. Prove it catches bugs and does not cry wolf

```bash
npm run qa:bugs      # every injected bug, one run each      -> results/bug-matrix.md
npm run qa:repeat    # 10 runs with nothing changed           -> results/stability.md
npm run qa -- --bugs report-wrong-count    # one run with one bug switched on
npm run qa:report    # open the last run's HTML report with traces and screenshots
```

| Bug | What breaks |
|---|---|
| `otp-rejects-valid` | Sign-in refuses every valid code |
| `upload-button-dead` | The Upload button does nothing |
| `delete-wrong-doc` | Delete removes a different document |
| `tenant-leak` | Another client's documents become visible |
| `job-stuck` | The AI job hangs forever |
| `report-wrong-count` | The AI report states a false number |
| `download-mismatch` | The download differs from the screen |
| `settings-not-saved` | "Saved" shows but nothing is saved |
| `viewer-can-edit` | A read-only user can upload |
| `results-page-crash` | The results page throws a JavaScript error |
| `slow-documents` | A slow but working page. This one must PASS: it proves slowness does not raise an alarm |

The tests never read this list. They find each problem through the UI, like a user would.

## 3. Try the QA console

```bash
npm run demo
```

It starts the console and prints everything you need:

- the address: `http://localhost:3000/console/login`
- an employee email and a password made for this run
- a QR code to scan with any authenticator app, plus a live six-digit code for anyone without a phone

A workspace pointing at the stand-in is already there. Open it. The menu on the left has:

- **Explore**: reads the site without changing anything and proposes checks for you to approve. With `ANTHROPIC_API_KEY` set it uses Claude Haiku to decide where to look; without one it uses built-in rules.
- **Probe**: the real-user run. Signs in, uploads, runs the AI job, downloads, and ends on PASS or FAIL. No AI decides the verdict.
- **GitHub**: watch a branch and run a Probe on every new commit (see section 5).

Each job page has a chat beside the live log. The run posts what it is doing, and when it reaches the sign-in screen or the one-time code screen it asks you there and waits. The QA account fields on a new workspace can be left empty for that reason; tick "Remember for this workspace" when answering to save them encrypted. While Explore runs with Claude you can type where it should look next. GitHub-triggered runs have nobody to ask, so they still need saved credentials.

Everything is in memory and gone when you press Ctrl+C. The demo refuses to start if `STORE=supabase` is set, so it never touches a database.

## 4. Use a real database (Supabase)

1. Create a Supabase project. In its SQL editor run `db/schema.sql`, then `db/schema-console.sql`. To start over later, run `db/drop-all.sql` first.
2. In `.env` set `STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (the secret key, not the publishable one).
3. Set up the QA account and yourself:

   ```bash
   npm run otp -- --init
   npm run admin -- setup --email you@eclypse.ai --name "Your Name"
   npm run dev
   ```

4. Open `http://localhost:3000/console/login`, sign in with the printed password and scan the QR code.

Employees are managed from the terminal. Whoever can run these already holds the database key, so there is no separate admin login:

```bash
npm run admin -- add    --email someone@eclypse.ai --name "Their Name"   # prints their password once
npm run admin -- list
npm run admin -- remove --email someone@eclypse.ai                       # also signs them out everywhere
```

## 5. Run on every commit (GitHub)

In a workspace, open **GitHub**:

1. Click **Create token on GitHub**. GitHub opens with the name and permission filled in. Generate it and copy it.
2. Paste it into the console and save. It is stored encrypted and never shown again.
3. Pick the repository and branch.

The console checks the branch about once a minute. On a new commit it runs a Probe and marks the commit pass or fail with a link to the report. This works on repositories where you are only a collaborator, and on localhost, because the console asks GitHub rather than waiting for GitHub to call in.

## 6. Settings

All optional. See `.env.example` for the full list.

| Variable | What it does |
|---|---|
| `STORE` | Empty: in memory. `supabase`: use the database |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | The database, when `STORE=supabase` |
| `CONSOLE_SECRET_KEY` | Encrypts saved QA passwords and GitHub tokens. Made automatically in memory mode, written by `admin setup` for Supabase |
| `CONSOLE_QA_HOSTS` | Hosts a Probe may run against. Default: this machine only |
| `CONSOLE_PUBLIC_URL` | The console's address, used in links on GitHub commits |
| `ANTHROPIC_API_KEY` | Turns on Claude Haiku for Explore. Nothing else needs it |
| `GITHUB_POLL_MS` | How often to check GitHub. Default one minute, 0 turns it off |

## 7. Test another deployment from the terminal

```bash
QA_EMAIL=... QA_PASSWORD=... QA_TOTP_SECRET=... QA_ALLOWED_HOSTS=staging.example.com \
  npm run qa -- --target https://staging.example.com
```

Live production also needs `QA_TARGET=live QA_ALLOW_LIVE=1` and `--grep @live-safe`, or the run refuses to start.

## Secrets

None in the repository. Local runs make up fresh credentials each time, CI reads them from its secret store, and the console encrypts what it saves. `.env*` files, saved sessions, run output and AI caches are git-ignored. Reports are redacted, and the QA account is signed out at the end of every run.

## Use of AI tools

Built with Claude Code as a pair programmer for the stand-in, the QA system and the docs. I reviewed and ran everything locally, and the files in `results/` come from real runs. Claude is also part of the system in bounded roles: it can drive Explore and write plain-English failure notes, and it never decides pass or fail.
