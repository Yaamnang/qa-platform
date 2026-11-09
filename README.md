# Eclypse automated QA

A robot that tests a web platform the way a real user would: it signs in with a one-time code, clicks, fills in forms, uploads and downloads files, follows long AI jobs to the end, and checks that every step really worked. It stays away from client data and explains failures in plain English.

The design document is [`docs/DESIGN.pdf`](docs/DESIGN.pdf).

## What is in this repository

There are two apps in one project.

- **The QA console** (`/console`): what Eclypse engineers use. Add a website, press **Explore** or **Probe**, watch the robot's browser live, chat with it, read the result.
- **The stand-in** (`/login`): a small copy of an AI platform for pharma teams. The robot practises on it. It has switches that break it on purpose, so you can see the robot catch real bugs.

## Run the app (one command)

Needs Node.js 20.9 or newer. Nothing else: no accounts, keys or database.

```bash
npm install
npm run demo
```

This builds and starts the app at http://localhost:3000 and prints an email, a password and a sign-in code. Open http://localhost:3000/console/login, sign in, open the ready workspace and press **Probe** to watch the robot test the stand-in live.

The stand-in platform itself is at http://localhost:3000/login.

## Run the tests (terminal only)

```bash
npm run qa
```

This one does not open anything for you to click. It starts the stand-in in the background, runs every check in a hidden browser, prints PASS or FAIL in the terminal, saves a report and shuts down:

```
 QA RESULT: PASS   19 passed, 0 failed, about 40s
 Report: qa-results/latest/report.md
```

## See it catch bugs

```bash
npm run qa:bugs      # one clean run, then one run per planted problem (10)
npm run qa:repeat    # 10 runs with nothing changed: all must give the same result
```

Results are saved in [`results/`](results/). One of the 10 is a page that is slow but working. The robot must pass it, which proves it does not raise false alarms.

## The three buttons in a workspace

| Button | What it does |
|---|---|
| **Explore** | Walks the site like a visitor without changing anything, and suggests checks for you to approve. Uses Claude Haiku when `ANTHROPIC_API_KEY` is set. |
| **Probe** | Uses the site like a real user and ends on PASS or FAIL. On our stand-in it runs the fixed test suite. On any other site, Claude plans the journeys once and later runs replay them without AI. |
| **GitHub** | Watches a branch and runs a Probe on every new commit, then marks the commit pass or fail. |

When a run reaches a sign-in page, it asks for your login and code in the job chat. Your answers go straight to the browser, never to Claude. On sites that are not on your allow-list, nothing that saves or deletes is ever sent.

## Use a real database (optional)

1. Create a Supabase project. In its SQL editor run `db/schema.sql`, then `db/schema-console.sql`.
2. In `.env` set `STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
3. Run:

```bash
npm run otp -- --init
npm run admin -- setup --email you@eclypse.ai --name "Your Name"
npm run dev
```

4. Open `http://localhost:3000/console/login` and sign in with the password it printed.

Add or remove engineers with `npm run admin -- add` / `list` / `remove`.

## Put it on a server

On an Ubuntu server: clone the repo, copy `.env.example` to `.env` and fill it in, then:

```bash
INSECURE_COOKIES=0 bash scripts/deploy.sh
```

For HTTPS without buying a domain, put Caddy in front with a `<your-ip>.nip.io` address.

## Settings

All optional. The full list is in `.env.example`.

| Setting | What it does |
|---|---|
| `STORE` | Empty: keep data in memory. `supabase`: use the database. |
| `ANTHROPIC_API_KEY` | Lets Claude Haiku drive Explore, plan Probes and write job summaries. |
| `CONSOLE_QA_HOSTS` | Sites where a Probe may save and delete. Everything else is read-only. |
| `CONSOLE_PUBLIC_URL` | The console's public address, used in links on GitHub commits. |
| `CONSOLE_SECRET_KEY` | Encrypts saved logins and GitHub tokens. |

## Secrets

None are in this repository. Local runs make up fresh logins each time, saved logins are encrypted, reports are scrubbed of secrets, and `.env` files are never committed.

## Use of AI tools

Built with Claude Code as a pair programmer. I reviewed and ran the work locally, and `results/` comes from real runs. Claude is also part of the system: it can drive Explore, plan a Probe on a new site, and summarise jobs. It never decides pass or fail.
