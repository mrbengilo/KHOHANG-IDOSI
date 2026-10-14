# Content navigation release evidence

Baseline main and verified production before this release: `27303e8dc51ff4205899932e672156b939e1691a`.
Branch: `fix/content-navigation-and-reshare-focus`.
Audit and coverage definitions: [content-navigation-audit.md](content-navigation-audit.md).

## Evidence discipline

Local execution logs, screenshots and failure traces are retained under `.local-evidence/` and `apps/web/test-results/` in the working checkout, not committed because they may contain operational data. CI uploads its own artifacts. Counts below are updated only after completed commands. Post-merge SHA/CI/watcher evidence is recorded in the release report rather than guessed in advance of the merge commit.

## Local environment and regression

- Node 24; locked install `npm ci --no-audit --no-fund` completed.
- PostgreSQL 17.6 isolated container `khohang-navigation-pg`, loopback port 15439, database `idosi_navigation_test`; `RUN_POSTGRES_TESTS=1` and test-only bootstrap credentials.
- Production migrations run twice, reference seed run twice, Admin bootstrap completed. On Windows the wrapper's `spawn('npm')` produced ENOENT; the same workspace migration script was run directly. Linux CI must still pass the unmodified wrapper.
- Original production-bundle long-list regression: 2 FAIL (desktop/mobile), heading intersection ratio 0 immediately after clicking row 20. Reproduction traces and before/after screenshots retained.
- First broad production check exposed two behavior regressions (4 project cases): inbound toggle focus and keyboard tab document movement. Both were corrected and their existing assertions retained.
- Full completed production fixture run before final additions: 162 PASS / 0 FAIL / 10 conditional project SKIP. Smoke: 47 PASS / 0 FAIL / 13 conditional project SKIP. Final run and CI evidence are required before merge.
- Workspace tests with PostgreSQL: API 98, worker 46, contracts 152, database 345 (1 existing conditional skip), domain 110 passed; web rerun 403 passed after updating heading markup assertions for the intentional focus target. Final full gate is required before merge.

## Verified production preflight

Read-only SSH to configured host on 14 October 2026: watcher active, `state=up-to-date`, target=running=baseline full SHA. Release symlink Git SHA matches. API/web/worker/database/Caddy healthy; `/health` returns `ok`, `/ready` returns `ready`. Disk 53% used (14 GiB available); memory about 2 GiB available. Backup `idosi-20261014T032326Z.dump` checksum verified and `pg_restore --list` readable. Evidence: local `production-preflight.txt`. This verifies an existing backup, not a claim that this task already created the release's backup.

## Release gates and rollback

Before merge: format, lint, typecheck, all-workspace test with PostgreSQL, production build, fixture discovery, full fixture/smoke/live suites, diff/secret review, exact-head required CI, and review-thread check. The existing CI already includes the new production testMatch and live directory; no workflow reduction is needed.

After merge: record main full SHA and successful main CI; watcher must show target=running=that SHA with deployed/up-to-date state. Compare release/container metadata, health/readiness, new assets, logs and release backup checksum. Use the already signed-in Admin session for read-only form open/close, navigation and mobile checks; do not save stock or create production fixtures. Record observation interval and unavailable roles separately.

No migration or schema change. Rollback reference is the baseline full SHA above. Prefer a reviewed revert/fix through main CI and watcher. For an urgent image rollback, follow the official runbook: coordinate pausing watcher, use `infra/scripts/rollback.sh` with the verified full SHA, recheck health/readiness/UI, then resume watcher on the corrected target. Do not restore or overwrite PostgreSQL for this UI-only release. No manual deployment while watcher is operational.

## Additional gate observations

A repeat workspace run after all live workflows exposed an existing fixture assumption: two worker specs select the first Admin without filtering active status; the accumulated database's first Admin was locked (confirmed by SQL). The clean CI-equivalent gate uses a new `idosi_navigation_gate` database, migrations/reference seed/bootstrap before tests. The failed accumulated-database log is retained, not reported as PASS. The database's one conditional skip is the opt-in `RUN_PERF_TESTS` benchmark, not a skipped PostgreSQL integration suite.

Added hash-anchor checks initially failed on both projects: the page heading mounted before catalog data and consumed the intent. The catalog table now announces readiness and pending hash intent waits for it; all 12 focused navigation cases passed afterward.

Final production fixture gate after the hash fix: **168 PASS / 0 FAIL / 10 conditional project SKIP** (178 discovered cases). The two navigation/Reshare files alone discover 98 cases. Full live gate completed **31 PASS / 0 FAIL / 0 SKIP**; a later focused rerun on accumulated data is retained separately and does not replace that full-run evidence. Canonical fresh-gate database name is `idosi_navigation_release_test`, satisfying the reset-suite's required `_test` suffix; an intermediate `_gate` name was rejected by that safety guard and is not treated as a successful reset check.

Gate follow-up: repaired the demonstrated fixture causes, without changing production code in API/database/worker. Worker shipment/multi-session fixtures and database multi-session fixtures now select an active, non-deleted Admin. The multi-session date allocator checks existing business dates before choosing one, eliminating observed random schedule collisions. Save-success navigation now reveals the status summary above the refreshed list; closing an unsaved form still returns to its originating row.

CI caught competing focus on the existing store editor: its native autofocus on the name field already provided the required viewport/focus behavior. Removed the redundant heading hook from AdminStoresPage and kept the existing smoke assertion unchanged. The final release has no AdminStoresPage source diff.

Linux CI then exposed an initial-POP race: layout/native anchoring scroll samples from the current visit were mistaken for an earlier history entry while detail/hash content was pending. A deterministic scroll event before releasing the delayed response reproduced both local project failures. History restore position is now captured at navigation entry; all 12 navigation cases, including real Back/Forward, pass with the regression retained. CI must verify the new head before merge.

The initial-POP correction alone did not clear Linux CI. Reproducing CI's NODE_ENV=test locally exposed all four remaining failures: React Strict Mode replays layout cleanup, and cleanup incorrectly advanced the prior location even though no navigation occurred. Prior/current location now advances only for a new history key, with child-before-parent layout ordering handled explicitly. The exact CI-mode navigation run passed 12/12 with retries disabled; normal-mode and CI-mode results remain distinguished.
