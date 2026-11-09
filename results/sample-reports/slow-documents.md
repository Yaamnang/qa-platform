# QA report: ✅ PASS

- **Run:** `20261107T102631-1151` · started 2026-11-07T10:26:32.215Z · took 88s
- **Target:** http://localhost:3100 (local) · AI mode: mock
- **Checks:** 15 passed · 0 failed · 0 flaky · 0 not run

## All checks

| Area | User journey | Result | Time |
|---|---|---|---|
| Sign-in | sign in as the QA bot with password + one-time code | ✅ pass | 27.2s |
| AI jobs | AI analysis jobs › an analysis runs to completion and everything it reports is true | ✅ pass | 24.4s |
| Sign-in | Sign-in › signed-out visitors are sent to the sign-in page | ✅ pass | 0.3s |
| Sign-in | Sign-in › a wrong password is refused with a clear message | ✅ pass | 0.3s |
| Sign-in | Sign-in › a wrong one-time code is refused and the user stays signed out | ✅ pass | 0.5s |
| Sign-in | Sign-in › a user can sign in with a one-time code and sign out again | ✅ pass | 0.6s |
| Documents | Documents › uploading a CSV adds it to the list with the right row count | ✅ pass | 7.1s |
| Documents | Documents › a non-CSV file is refused with a helpful message | ✅ pass | 6.3s |
| Documents | Documents › a CSV with missing columns is refused and names the missing columns | ✅ pass | 0.3s |
| Documents | Documents › deleting a document removes that document and nothing else | ✅ pass | 10.4s |
| Settings | Settings › profile changes are saved and survive a reload | ✅ pass | 0.4s |
| Settings | Settings › an invalid email is refused, explained, and not saved | ✅ pass | 0.4s |
| Security / tenant isolation | Tenant isolation › the documents list shows only this tenant's documents | ✅ pass | 3.5s |
| Security / tenant isolation | Tenant isolation › another tenant's document cannot be opened by its ID | ✅ pass | 0.1s |
| Security / tenant isolation | Tenant isolation › an unknown analysis link shows a clear 'not found' message | ✅ pass | 0.5s |
