# What comes next

The prototype covers the core: it runs itself, uses the platform like a real
user, follows AI jobs to the end and checks their claims, stays inside a
synthetic tenant, and reports in plain language. These are the things worth
building after that, in the order I would build them.

## 1. Setup agent: discover journeys, propose checks

Today the checks are written by hand. That does not scale across a platform
that ships weekly.

Point an agent at a URL with test credentials. It explores in a throwaway
browser, maps the pages, forms and actions it finds, and proposes a set of
checks in plain language. A person reviews the list, deletes the noise, approves
the rest, and the approved checks are written out as normal test files and
committed.

The model does the authoring. It never runs in the critical path, so the suite
stays deterministic and free. A human always signs off, which is also what keeps
false alarms down.

## 2. Diff-aware triage

When a run fails, the system already says which journey broke and at which step.
The next question is always the same: what changed?

Give the runner read access to the repository. On a failed pull request run, it
reads that branch's diff and says the upload journey broke and this commit
touched the upload handler. On a scheduled run it bisects recent commits.

This is the highest-value use of repository access. Note what it is not: a
security scanner. Eclypse will already have CodeQL or Semgrep and Dependabot
doing that, and rebuilding it here would duplicate mature tooling while adding
nothing to frontend QA.

## 3. Coverage measured against real usage

A passing suite says the checks pass, not that the important journeys are
covered. Take the routes and actions clients actually use, from analytics or the
route map, and compare them against what the suite exercises. Report the gap.

That turns coverage from a guess into a number, and it tells you what to write
next instead of writing more of what you already have.

## 4. Flake quarantine

The suite reruns a failure once before reporting it. That handles the obvious
case and no more.

Track every check's outcome over time. A check that flips between pass and fail
without a related code change gets quarantined automatically: it still runs, it
still reports, but it stops blocking merges and it raises a ticket against
itself. Alert fatigue kills monitoring systems faster than missed bugs do.

## 5. More report verification as more AI features ship

The job verification generalises. Any AI output that makes a checkable claim can
be checked the same way: pull the claim out, recompute it from the source data,
compare. Citations resolve to real documents. Totals match row counts. Numbers
in prose appear in the findings.

As Eclypse adds AI features, each one gets an invariant set rather than a
screenshot comparison.

## 6. Visual checks, narrowly scoped

Whole-page pixel comparison fires on every margin change and trains people to
ignore it. A tight version is useful: a short allowlist of components, a
tolerance, and a human approving each baseline change. Worth doing only once the
functional suite is trusted.

## 7. Per-client canary tenants

Live monitoring runs read-only in one synthetic tenant today. Giving each client
environment its own canary tenant would catch problems specific to one client's
configuration, which is where multi-tenant platforms usually break, without ever
touching that client's real data.
