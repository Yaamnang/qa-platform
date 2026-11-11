# Knowledge: decisions and the reasons behind them

Questions a reviewer is likely to ask, with the answer and where it lives in the
code. Each one is a decision made on purpose.

## Security

**Why does asking for someone else's workspace give the same error as asking for one that does not exist?**
If the two answers differed, you could try ids one by one and learn which
workspaces are real, which is Eclypse's client list, without ever signing in to
one. Same bug as a login form that says "no such user" for one email and "wrong
password" for another. `/api/orgs/select` returns the same 404 and the same text
for both, and `tenant-isolation.spec.ts` asserts the two responses are identical
so nobody can "improve" the message later without the build failing.

**Can the QA bot sign in as a client?**
No, and not because of a rule it could ignore. Client accounts are seeded with a
random password and a random TOTP secret that are generated at startup and never
written anywhere readable. The credentials to impersonate a client do not exist.
That is the strongest form of least privilege. `seed()` in `lib/server/store.ts`
and `scripts/seed-supabase.ts`.

**Why does the bot never get a staff or cross-workspace role?**
If the bot could legitimately see across workspaces, then "the bot can see
Northwind's data" stops being a bug and the canary test proves nothing. The bot is
a member of QA Synthetic only.

**How do you know isolation actually holds?**
Three layers. The bot's workspace list comes from its memberships only, so
nothing tells it another workspace exists. Fetching the canary document by its
exact id must return 404, which proves knowing an id gets you nothing. And the
guard in `qa/lib/test.ts` scans every API response body and the final screen in
every test for the canary marker, so a leak in any journey fails the run, not just
in the isolation test.

**What is the canary?**
A document planted in a second synthetic workspace the QA team owns, carrying a
unique marker string. If that string ever reaches the bot, isolation is broken.
It lets you test the most dangerous failure on the platform without touching a
real client's data.

**Why is row level security on with no policies?**
Nothing can read or write the tables except the server's secret key, which
bypasses RLS. A leaked publishable key grants nothing. That is also why the
publishable key cannot be used for the store: it cannot seed or reset tables.
`db/schema.sql`.

**What stops one-time code replay and brute force?**
`verify` rejects any code whose time step is at or below `user.lastTotpStep`, so a
code works once. Five wrong attempts and the challenge is destroyed with a 429.
Code comparison uses `timingSafeEqual`. `app/api/auth/verify/route.ts`.

**Two apps on one server, anything to watch?**
Cookies ignore ports. A cookie set on IP:3000 is sent to IP:4000. The stand-in and
the dashboard must use different cookie names or one app's session is visible to
the other.

**Why are console employees managed from the terminal and not an admin page?**
Whoever can run `npm run admin` already holds the Supabase secret key, and that
key is the real admin power: it reads and writes every table. A login on the
command would guard nothing the key does not already open. An admin page would
be new attack surface: anyone with a stolen console session could add
themselves or remove everyone else. Without one, a console session can run QA
but never change who has access. Removing an employee deletes their sessions
too, so access ends at once. `scripts/admin.ts`.

**The job chat asks for the QA login and one-time code. Can Claude or the transcript see them?**
No. An answer to a login or code question is held only in the console server's
memory, inside the pending question, until the run collects it, and is then
dropped. It is never written to the job's messages, its log or the database:
the chat records "Login provided" or "Code provided". The values are added to the
job's redaction list, so they are cut from the log tail if a child ever prints
them. When Claude Haiku words the run's chat lines, it sees a short event and the
last few chat lines, which never hold a secret. The run reaches the chat with a
random token made for that job only (only its hash is kept, compared in constant
time, 404 on mismatch), so nothing else can read an answer. Inside one Probe, the
sign-in worker shares the login with later Playwright workers through a file
encrypted with a key made from that token, deleted at teardown. "Remember for this
workspace" stores them with the same AES-256-GCM encryption as the workspace form.
`lib/console/server/chat.ts`, `qa/lib/console-link.ts`.

**What stops the console's live view of the QA browser from leaking something?**
Password and one-time-code inputs are masked in the browser before the screenshot is taken, the server keeps only the latest frame per job in memory and drops it when the job ends (never on disk or in the database), and frames are only sent when a run was started from the console, so CI and `npm run qa` send nothing. `qa/lib/live-view.ts`, `lib/console/server/live-frames.ts`.

**Can the job summary change a verdict or leak a secret?**
No. It is advisory text shown above the result, which still comes from the run itself, and it is built only from text that is already redacted: counts, problem headlines, the stored log tail and the chat transcript. `lib/console/server/summary.ts`.

## Reliability and false alarms

**How do you get identical results ten runs in a row?**
State resets before every run. The in-memory store reseeds on start, and on
Supabase `eclypse_reset()` truncates everything first. No model decides pass or
fail. Waits are condition-based, never fixed sleeps. Selectors are `data-testid`.

**Why would a persistent database break that?**
Single-use things get consumed. Run one spends a code or creates a row, run five
starts from a different place, so the runs are not identical by construction.
Resetting first is what keeps the proof true.

**Why are browser console errors evidence and not failures?**
Browsers log expected 4xx responses as console errors. Failing on them would raise
alarms on correct behaviour. Uncaught JavaScript exceptions and 5xx responses do
fail the run.

**How do you prove you do not cry wolf?**
The `slow-documents` bug makes the documents list take three seconds. Slow but
working, so the run must still pass. The bug matrix checks that it does. That is
the only injected problem that is supposed to pass.

**Why TOTP instead of an emailed code?**
The robot derives the code from the same secret an authenticator app uses,
instantly and deterministically. Emailed codes mean polling a mailbox on every
sign-in, which is slow and flaky, and flakiness is one of the things being graded.
`qa/lib/totp.ts` also waits for a fresh time step and avoids the last two seconds
of a window so a slow page cannot fail on an expiring code.

## AI jobs

**How do you check an AI result when the wording changes every run?**
Check the facts, ignore the wording. Every number the job reports is compared with
values computed from the uploaded file, which were checked by hand into
`qa/fixtures/adverse-events-24.expected.json`. The downloaded CSV and JSON reports
must match what was on screen.

**Why is no model allowed to decide pass or fail?**
A model can give a different answer to the same input. The optional judge and
triage are advisory only and write warnings, never verdicts. That one rule answers
both the determinism question and the false-alarm question.

**How is AI cost controlled?**
The suite runs on the mock by default and costs nothing. Real calls are opt-in,
cached by a hash of the input and prompt version, and replay mode serves only
cached answers and never spends. Scheduled live runs get one small real job with a
cost cap.

**Why may Claude drive Explore but never Probe, and why can a hostile page not make it write?**
Explore only draws a map and drafts checks a person must approve, so a model
choosing a different route on another run costs nothing but detail. Probe gives
the verdict, and a verdict has to be the same ten runs in a row, so no model
touches it and the console never passes the API key to the Probe process. A
browsed page can contain text written to steer the model, so the snapshot is
sent as marked, untrusted data, but safety does not depend on the model
obeying. It can only pick from a menu that `qa/explore/agent.ts` checks
against the page: open a same-origin path, click a listed link, tab, menu or
non-submit button, or stop. It cannot type or submit a form. Underneath, the
read-only guard in `qa/explore/readonly.ts` aborts every request that is not a
GET inside the browser, apart from signing in. A steered model can waste
steps. It cannot send a write.

**Why does Explore let the sign-in request through, and nothing else?**
Signing in is a POST, so a guard that blocks every non-GET would also block
the login, and the explorer could never see past a sign-in screen. On a site
we do not own we cannot list its login endpoints in advance, so the exception
is a window in time instead of a list. The sign-in code in
`qa/explore/crawl.ts` opens it immediately before it submits the login or code
form, and it closes once the page settles, or after 15 seconds at most. While
it is open, non-GET requests to the target's own origin go through, plus the
identity provider's host when the form posts to another origin. Everything
else stays blocked, and every request the window lets out is logged as
"allowed for sign-in: METHOD path". It is safe because the explorer chooses
when the window opens: only its own sign-in code opens it, the model has no
type or submit action, and a login form only proves who we are. Outside that
one moment the guard is exactly as strict as before. `qa/explore/readonly.ts`.

**What does "checks that what they report is true" mean in practice?**
A job can finish, show a green tick, and be wrong. The `report-wrong-count` bug
makes the job report one more event than exists. A suite that only checked the job
finished would pass it. This one fails it.

**How can the Probe test a site we have never seen without a model deciding pass or fail?**
On our own stand-in the Probe is the built-in suite, unchanged. On any other site
it is the AI Probe (`qa/probe/`). The first run opens the site as a visitor, looks
at a few pages and asks Claude Haiku, through one forced tool call, for 3 to 6
short journeys. Each step is one action (navigate, click, fill, select, upload,
download) plus the outcome that proves it worked. Playwright runs every step and
checks that outcome with a timeout; a click after which nothing changed at all is
reported as "Button did nothing". The model only plans. Verdicts come from those
checks alone. The journeys as run are saved on the workspace, and every later
Probe replays them with no model call, so results repeat and cost nothing until
someone presses Re-plan. Without Full access the Probe runs behind the read-only
guard: a step whose write gets blocked is skipped, not failed, while downloads and
navigation, both GETs, are still checked.

## Architecture

**Why is the in-memory store the default?**
A clean clone runs the whole suite with one command and no accounts, which the
brief asks for. Runs are hermetic. Supabase is opt-in with `STORE=supabase`, so it
is never switched on just because credentials happen to be lying around, and you
can still work offline.

**What broke when moving from memory to Postgres?**
The routes mutated objects in place, for example `user.lastTotpStep = step`. On the
in-memory store that works by accident, because the object handed out is the live
one in the Map, so changing it is the write. Against Postgres you change a copy and
the write silently disappears. Every write became an explicit method in
`lib/server/auth-store.ts`. The same trap existed in `createJob`, where the result
is written long after the request has returned.

**Why not run the test runner on Vercel?**
Chromium is larger than the function size limit, the filesystem is read-only and
wiped between calls, and a run takes longer than the function timeout. The runner
lives in GitHub Actions or on a long-running server.

**Why is the QA dashboard a separate app from the platform?**
Internal QA tooling does not belong inside the customer-facing product. Clients
work in workspaces in the platform. Eclypse engineers use the dashboard, where a
project is one target plus one environment.

## Scope

**Why no security scanner in the future work?**
Eclypse will already run CodeQL or Semgrep and Dependabot. Rebuilding that would
duplicate mature tools without improving frontend QA. Repository access is used
instead to explain failures from the diff. See `docs/FUTURE.md`.

**Why no password reset or account recovery?**
Out of scope for a frontend QA prototype. A real platform has them and they are a
QA surface worth covering. Backup codes would be the first, since they need no
email.
