# Continuous ordering and combined shipments

The consolidated order and allocation-result UI is described in
[store/session documents](store-session-documents.md). Previously allocated goods
shipped in the current cycle remain separate from newly allocated quantities.

## Business rules

- Ordering is available at any time. Server configuration determines the next snapshot/allocation date; the submission window may start on the preceding date.
- The worker prepares today's cycle on every poll using the same business-date lock as the ordering API. Quiet days do not depend on page visits; restarting after 08:00 still prepares today's due cycle. Existing custom schedules and explicit cancellations are respected; historical dates are not invented.
- Two ordinary requests per store; closing a session does not reset the quota. Completed allocation is the reset boundary. Requests already queued for the next session still occupy its slots. Cancelling a request does not refund its slot.
- A request is released when its own session completes, or when any session whose allocation is scheduled at or after its own completes (a stuck or cancelled cycle replaced by a later completed allocation). With several sessions per day, completing an earlier session no longer releases requests still waiting for a later one; see [multiple allocation sessions](multiple-allocation-sessions.md).
- Priority acceptance is not an ordinary request and consumes no ordinary slot.
- Allocated priority goods remain actively reserved without an outbound until that store has an ordinary request in a later allocation (or the same allocation). They are excluded from stock available to other allocations. Only goods of a result the store **accepted** (or one that needed no answer, or a legacy result) are picked up by a later shipment; goods of a result still waiting for the store's answer, or rejected, never ride a shipment ([allocation result confirmation](allocation-result-confirmation.md)).
- A normal order still triggers shipment of the held priority goods if the new normal demand is entirely waitlisted.
- One outbound per allocation run and store, one line per product. Prior priority allocations and current ordinary allocations of the same product are summed on that line.
- The allocation run materializes each shipment as `reserved` and publishes a store decision for every store it allocated to, in the same serializable transaction. A shipment carrying goods granted by this run waits for the store to **accept** the result; the acceptance releases (dispatches) it and the store then sees it on `/receive`. A shipment carrying only goods accepted earlier (this run granted the store nothing new) needs no answer and is released by the run itself. A rejection releases the result's own reservations and cancels its reserved shipment. Dispatch only changes the shipment state; warehouse on-hand stock leaves once, when HTKD finalizes the store receipt, and store inventory grows only then.
- Held priority goods are visible, not silent: `GET /api/v1/held-allocations` lists the held goods of accepted results by store and product (Admin: all stores; HTKD and the wholesale desk: their stores; a store account: its own store), and the allocation page and the store's `/receive` page show them as "Hàng ưu tiên đang giữ chờ giao chung".
- Receiving acknowledges physical delivery separately from accepting a priority offer. Only actual received bags enter store inventory. Shortages release unused reservations and restore demand to the corresponding source waits.
- Priority offers may be partial or full ([wait ticket policy](wait-ticket-cancellation.md)). Accepting either one protects the offered units, converts the hold into an allocation reservation exactly once in the owning session's run, and the units then wait here for the store's next ordinary shipment. Accepting never adds to store stock and never ships on its own.
- Cancelling a wait (store, wholesale desk, or Admin) cancels only the unallocated remainder: goods already allocated stay reserved and still ship with the next ordinary order. A receipt shortage on goods allocated from a cancelled wait is queued as new demand; the cancelled remainder is never reopened.

## Persistence and compatibility

No new table or destructive backfill is required. Existing `reservations` retain each allocation source, quantity and outbound-line link, including after consumption/release. The outbound line's legacy `allocationLineId` is a representative source, **not the complete list**. The complete provenance is its linked reservations and the immutable `OUTBOUND_REQUEST_MATERIALIZED` audit `sources` array. The outbound header's allocation run is the shipping-trigger run, not necessarily every source run.

Existing dispatched/received outbounds are not regrouped. Already-linked reservations are not picked again. Materialization runs inside the worker's serializable transaction, locks unlinked active reservations, and uses deterministic shipment/line identifiers. Concurrent retry must create exactly one shipment.

An active allocation reservation with `outboundRequestLineId = NULL` is an intentional hold waiting for the store's next ordinary order; do not release it merely because its allocation session is completed.

## Verification and release

PostgreSQL integration tests cover concurrent ordering context preparation, unauthorized store scope, quota at close/completion, concurrent third-request rejection, held priority stock, same-product grouping, concurrent materialization, dispatch replay, and full/partial/zero receipt finalization replay with balance and active-wait conservation. Live browser tests use isolated HTKD accounts and assigned stores, verify inline quantity controls at 360/390/412/768/1366/1440 px, and verify persisted quotas after reload.

Deploy API/web/worker from one merged SHA after backup and green CI. Existing receipt/VAT migration is additive. If application rollback is needed after creating held priority reservations, pause allocation processing first: the older worker does not implement deferred shipment pickup. Preserve reservations, inventory and audit data; prefer a forward fix, then verify all held reservations are accounted for before resuming the worker. Since migration 0038 a worker older than store confirmation cannot complete an allocation at all (the database refuses runs without decisions and dispatches without acceptance); see [allocation result confirmation](allocation-result-confirmation.md#rollback).

## Stranded shipments created before automatic dispatch

Before automatic dispatch, the 09:00 run left every shipment at `reserved` and no screen could release it, so stores never saw them on `/receive`. Since store confirmation (0038), a `reserved` shipment is normally just **waiting for the store to accept** its result: those are not stranded, the tool only counts them ("awaiting the store's decision") and never dispatches them. Only legacy results (classified `legacy` by 0038) or already accepted ones are candidates. Release stranded legacy shipments with the audited backfill from the release image, never by hand-editing rows:

```bash
env_file=/etc/khohang-idosi/production.env
sudo ./infra/scripts/backup-db.sh --env-file "$env_file" --output-dir /var/backups/khohang-idosi
docker compose --env-file "$env_file" run --rm --no-deps --pull never migrate \
  node packages/database/dist/dispatch-stranded-outbounds.js            # dry run: lists only
docker compose --env-file "$env_file" run --rm --no-deps --pull never migrate \
  node packages/database/dist/dispatch-stranded-outbounds.js --apply    # releases them
```

Each release goes through the same gated dispatch path as the system (store decision of the shipment and of every carried source re-checked, and enforced again by the 0038 database trigger), takes the per-shipment lock, checks that active reservations still cover every approved line, and writes an `OUTBOUND_REQUEST_DISPATCHED` audit row with `trigger: stranded-outbound-backfill`. A shipment that fails a check is reported as blocked and left untouched (exit code 3). Running it again is safe: released shipments are no longer `reserved`.
