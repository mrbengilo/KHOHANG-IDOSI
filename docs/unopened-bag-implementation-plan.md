# Implementation plan: unopened discrepancy and opening history

Baseline: 25f9efdc56701e9c166addab2bd15d7998a33b36, clean isolated clone.

Acceptance: only available never-opened bags may enter a new discrepancy; server checks under locks and rejects the whole payload. Own quarantined holds from available bags remain processable. Legacy pending opened bags cannot resubmit/verify/apply; cancel/reject and applied return workflows remain unchanged. Opening must remain atomic with IDOSI settlement and replay. Unopened inventory and persistent opening history require scoped server pagination, filters and independent UI states.

Evidence: create currently records a line even when canHold returns false; verify records blockers without rejecting. Opening audit contains before/after product, store, kg, actor and event time. Existing audit does not snapshot catalog labels: show missing historical labels honestly; do not substitute current labels as snapshots. Sorting and transfer also set openedAt. History must distinguish these sources and retain unknown fields as null.

## Lock order (transaction-level locks persist to commit)

| Command            | Existing order                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CREATE discrepancy | idempotency -> receipt advisory -> bag advisory ascending ID -> bag row                                            |
| RESUBMIT / VERIFY  | idempotency -> receipt advisory -> adjustment row; add bag advisory/row ascending ID before checking facts         |
| APPLY              | idempotency -> receipt advisory -> adjustment row -> bag advisory/row ascending ID -> warehouse balance by product |
| Open               | idempotency -> store-sorting advisory -> bag advisory -> bag row -> IDOSI progress/bag rows                        |
| Sorting            | idempotency -> store-sorting advisory -> bag row -> sorted stock rows                                              |
| Transfer create    | idempotency -> bag advisory -> bag row                                                                             |
| Transfer dispatch  | idempotency -> transfer advisory/row -> bag advisory/row                                                           |
| IDOSI settlement   | enclosing store-sorting advisory -> progress/bag rows                                                              |

Do not acquire store-sorting after bag locks. Check history and dependency facts under bag lock, preserve bounded serializable retries. No changes to applied documents or original receipt/ledger/audit.

Scope: domain policy and tests; contracts; database adjustment context/commands, inventory list/history/open guard; API interface/adapters/routes; production adjustment/open UI and helpers; database/API/UI/concurrency tests; operational docs. Sorting, transfer, worker, CI and migration sources inspected; modify only where evidence demands.

Commit plan: (1) domain/contracts/database eligibility and regression tests; (2) scoped opening history, paginated UI/API, tests; (3) production E2E, documentation and any justified additive index. Each commit must build. Gates: npm quality, isolated PostgreSQL migrations twice, integration, e2e and live e2e, responsive production captures, execution plans; then PR/CI/review/merge/watcher only with gates passing.

Test environment: dedicated Docker postgres:17.6-bookworm, localhost port 55439, database idosi_ci. Never seed production. Existing nullable opening time is not the sole eligibility evidence: include status, own prior hold state, opening audit, sale/sort/transfer dependencies.
