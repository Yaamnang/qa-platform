# QA report: ❌ FAIL

- **Run:** `20261107T101944-6284` · started 2026-11-07T10:19:45.190Z · took 45s
- **Target:** http://localhost:3100 (local) · AI mode: mock
- **Checks:** 0 passed · 1 failed · 0 flaky · 14 not run

## What broke (1 problem)

### 1. [CRITICAL] Security / tenant isolation: CRITICAL: data from another tenant reached the QA account (canary "QA-CANARY-7f3a2c" in GET /api/documents).

- **User journey:** sign in as the QA bot with password + one-time code
- CRITICAL: another tenant's data was visible on screen at /workspace (canary "QA-CANARY-7f3a2c").

> 14 test(s) were not run: the run was stopped for safety right after sign-in (see problem 1).

## All checks

| Area | User journey | Result | Time |
|---|---|---|---|
| Security / tenant isolation | sign in as the QA bot with password + one-time code | ❌ FAIL | 29.8s |
| AI jobs | AI analysis jobs › an analysis runs to completion and everything it reports is true | ⏭️ not run | 0.0s |
| Sign-in | Sign-in › signed-out visitors are sent to the sign-in page | ⏭️ not run | 0.0s |
| Sign-in | Sign-in › a wrong password is refused with a clear message | ⏭️ not run | 0.0s |
| Sign-in | Sign-in › a wrong one-time code is refused and the user stays signed out | ⏭️ not run | 0.0s |
| Sign-in | Sign-in › a user can sign in with a one-time code and sign out again | ⏭️ not run | 0.0s |
| Documents | Documents › uploading a CSV adds it to the list with the right row count | ⏭️ not run | 0.0s |
| Documents | Documents › a non-CSV file is refused with a helpful message | ⏭️ not run | 0.0s |
| Documents | Documents › a CSV with missing columns is refused and names the missing columns | ⏭️ not run | 0.0s |
| Documents | Documents › deleting a document removes that document and nothing else | ⏭️ not run | 0.0s |
| Settings | Settings › profile changes are saved and survive a reload | ⏭️ not run | 0.0s |
| Settings | Settings › an invalid email is refused, explained, and not saved | ⏭️ not run | 0.0s |
| Security / tenant isolation | Tenant isolation › the documents list shows only this tenant's documents | ⏭️ not run | 0.0s |
| Security / tenant isolation | Tenant isolation › another tenant's document cannot be opened by its ID | ⏭️ not run | 0.0s |
| Security / tenant isolation | Tenant isolation › an unknown analysis link shows a clear 'not found' message | ⏭️ not run | 0.0s |
