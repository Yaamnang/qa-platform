# Bug matrix

Generated 2026-11-08T13:50:13.983Z · AI mode: mock · command: `npm run qa:bugs`

**Baseline (no bugs): PASS** · **Bugs caught: 10/10** · **No false alarm on slow-but-working pages: 1/1** · retries: 1

| Injected problem | What it does | Result | Failing user journeys | Headline in the report |
|---|---|---|---|---|
| `none` | Baseline: nothing injected | ✅ clean | (nothing failed) |  |
| `otp-rejects-valid` | Sign-in: the one-time-code check rejects every valid code (users locked out). | ✅ caught | sign in as the QA bot with password + one-time code | Sign-in with a valid one-time code was refused: "That code is not valid. Check your authenticator app and try again." |
| `upload-button-dead` | Documents: the Upload button does nothing when clicked (broken button). | ✅ caught | Documents › uploading a CSV adds it to the list with the right row count; Documents › a non-CSV file is refused with a helpful message; Documents › a CSV with missing columns is refused and names the missing columns | After clicking Upload, a confirmation should appear (if not, the Upload button may be broken) |
| `delete-wrong-doc` | Documents: deleting a document removes a different document. | ✅ caught | Documents › deleting a document removes that document and nothing else | The deleted document should be gone (on screen) |
| `tenant-leak` | Security: the document list forgets the tenant filter and shows other clients' documents. | ✅ caught | sign in as the QA bot with password + one-time code | CRITICAL: data from another tenant reached the QA account (canary "QA-CANARY-7f3a2c" in GET /api/documents). |
| `job-stuck` | AI jobs: analysis jobs hang forever at the 'Analyzing' stage. | ✅ caught | AI analysis jobs › an analysis runs to completion and everything it reports is true | The job appears stuck: stage "Analyzing with AI" at 75% with no visible change for 15s (31s since start). |
| `report-wrong-count` | AI jobs: the report states the wrong number of adverse events (off-by-one). | ✅ caught | AI analysis jobs › an analysis runs to completion and everything it reports is true | "Adverse events recorded" should be 24 (true value in the uploaded file) |
| `download-mismatch` | Downloads: the CSV report drops its last row, so it no longer matches the screen. | ✅ caught | AI analysis jobs › an analysis runs to completion and everything it reports is true | Downloaded CSV is missing "Most common adverse event", which is shown on screen |
| `settings-not-saved` | Settings: 'Saved' confirmation shows but the change is never persisted. | ✅ caught | Settings › profile changes are saved and survive a reload | The page said 'Settings saved', so the new display name should still be there after a reload |
| `viewer-can-edit` | Roles: a Viewer can upload documents (the permission check is skipped). | ✅ caught | Roles › a Viewer can see documents but cannot upload, delete or analyse | A Viewer (read-only role) must not be able to upload documents: the server should refuse with 403 |
| `results-page-crash` | AI jobs: the results page throws a JavaScript error when a job finishes. | ✅ caught | AI analysis jobs › an analysis runs to completion and everything it reports is true | The page crashed with an uncaught JavaScript error on /jobs/job_0bf13c4acf86: Cannot read properties of undefined (reading 'map') |
| `slow-documents` | Performance: the documents list takes 3 seconds to load. Slow but working, so the run must still PASS (no false alarm). | ✅ passed (no false alarm) | (nothing failed) |  |

Each run's full report is in `qa-results/<run id>/report.md`:

- `none`: `20261108T133536-b6fd`
- `otp-rejects-valid`: `20261108T133614-f6c0`
- `upload-button-dead`: `20261108T133708-fe96`
- `delete-wrong-doc`: `20261108T133854-c0ec`
- `tenant-leak`: `20261108T133952-4ccb`
- `job-stuck`: `20261108T134032-0cd9`
- `report-wrong-count`: `20261108T134228-9819`
- `download-mismatch`: `20261108T134335-ab61`
- `settings-not-saved`: `20261108T134505-d161`
- `viewer-can-edit`: `20261108T134622-9e65`
- `results-page-crash`: `20261108T134735-f13d`
- `slow-documents`: `20261108T134851-798e`
