# Continuous ordering and combined shipments

## Business rules

- Ordering is available at any time. Server configuration determines the next snapshot/allocation date; the submission window may start on the preceding date.
- The worker prepares today's cycle on every poll using the same business-date lock as the ordering API. Quiet days do not depend on page visits; restarting after 08:00 still prepares today's due cycle. Existing custom schedules and explicit cancellations are respected; historical dates are not invented.
- Two ordinary requests per store; closing a session does not reset the quota. Completed allocation is the reset boundary. Requests already queued for the next session still occupy its slots. Cancelling a request does not refund its slot.
- The completion boundary is global, including when a cancelled cycle is replaced by a completed allocation with no requests from that store.
- Priority acceptance is not an ordinary request and consumes no ordinary slot.
- Allocated priority goods remain actively reserved without an outbound until that store has an ordinary request in a later allocation (or the same allocation). They are excluded from stock available to other allocations.
- A normal order still triggers shipment of the held priority goods if the new normal demand is entirely waitlisted.
- One outbound per allocation run and store, one line per product. Prior priority allocations and current ordinary allocations of the same product are summed on that line.
- The allocation run releases each shipment it creates: the outbound is dispatched in the same serializable transaction that materializes it, so the store sees it on `/receive` as soon as the allocation is published. Dispatch only changes the shipment state; warehouse on-hand stock leaves once, when HTKD finalizes the store receipt, and store inventory grows only then.
- Held priority goods are visible, not silent: `GET /api/v1/held-allocations` lists them by store and product (Admin: all stores; HTKD and the wholesale desk: their stores; a store account: its own store), and the allocation page and the store's `/receive` page show them as "Hàng ưu tiên đang giữ chờ giao chung".
- Receiving acknowledges physical delivery separately from accepting a priority offer. Only actual received bags enter store inventory. Shortages release unused reservations and restore demand to the corresponding source waits.

## Persistence and compatibility

No new table or destructive backfill is required. Existing `reservations` retain each allocation source, quantity and outbound-line link, including after consumption/release. The outbound line's legacy `allocationLineId` is a representative source, **not the complete list**. The complete provenance is its linked reservations and the immutable `OUTBOUND_REQUEST_MATERIALIZED` audit `sources` array. The outbound header's allocation run is the shipping-trigger run, not necessarily every source run.

Existing dispatched/received outbounds are not regrouped. Already-linked reservations are not picked again. Materialization runs inside the worker's serializable transaction, locks unlinked active reservations, and uses deterministic shipment/line identifiers. Concurrent retry must create exactly one shipment.

An active allocation reservation with `outboundRequestLineId = NULL` is an intentional hold waiting for the store's next ordinary order; do not release it merely because its allocation session is completed.

## Verification and release

PostgreSQL integration tests cover concurrent ordering context preparation, unauthorized store scope, quota at close/completion, concurrent third-request rejection, held priority stock, same-product grouping, concurrent materialization, dispatch replay, and full/partial/zero receipt finalization replay with balance and active-wait conservation. Live browser tests use isolated HTKD accounts and assigned stores, verify inline quantity controls at 360/390/412/768/1366/1440 px, and verify persisted quotas after reload.

Deploy API/web/worker from one merged SHA after backup and green CI. Existing receipt/VAT migration is additive. If application rollback is needed after creating held priority reservations, pause allocation processing first: the older worker does not implement deferred shipment pickup. Preserve reservations, inventory and audit data; prefer a forward fix, then verify all held reservations are accounted for before resuming the worker.

## Stranded shipments created before automatic dispatch

Before automatic dispatch, the 09:00 run left every shipment at `reserved` and no screen could release it, so stores never saw them on `/receive`. Release them with the audited backfill from the release image, never by hand-editing rows:

```bash
env_file=/etc/khohang-idosi/production.env
sudo ./infra/scripts/backup-db.sh --env-file "$env_file" --output-dir /var/backups/khohang-idosi
docker compose --env-file "$env_file" run --rm --no-deps --pull never migrate \
  node packages/database/dist/dispatch-stranded-outbounds.js            # dry run: lists only
docker compose --env-file "$env_file" run --rm --no-deps --pull never migrate \
  node packages/database/dist/dispatch-stranded-outbounds.js --apply    # releases them
```

Each release goes through the same dispatch path as the worker, takes the per-shipment lock, checks that active reservations still cover every approved line, and writes an `OUTBOUND_REQUEST_DISPATCHED` audit row with `trigger: stranded-outbound-backfill`. A shipment that fails a check is reported as blocked and left untouched (exit code 3). Running it again is safe: released shipments are no longer `reserved`.
