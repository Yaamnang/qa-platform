# Results

All produced by real runs of this repository (AI mode: `mock`, the PR-pipeline setting).

| File | Command | What it shows |
|---|---|---|
| [`bug-matrix.md`](bug-matrix.md) | `npm run qa:bugs` | Baseline passes; each of the 9 injected regressions is caught, with the headline the report gives; a slow-but-working page still passes |
| [`stability.md`](stability.md) | `npm run qa:repeat` | 10 consecutive runs against the same server, nothing changed: identical outcome every time, zero flaky |
| [`sample-reports/`](sample-reports/) | `npm run qa` (± `--bugs <id>`) | What the plain-language report looks like: a clean run and four failures (wrong AI number, stuck job, cross-tenant leak, page crash) |

Screenshot/trace links inside the sample reports point to `qa-results/`, which is git-ignored. Run the same command locally to regenerate them, then `npm run qa:report` to browse traces.

Timing: a single run takes about 1 minute (the fake AI job deliberately takes ~20s, like a real one). Back-to-back runs take ~60s because one-time codes can only be used once: each run waits for a fresh 30-second code window (twice: the shared sign-in and the sign-in/sign-out journey). That waiting is deliberate (see `qa/lib/totp.ts`).
