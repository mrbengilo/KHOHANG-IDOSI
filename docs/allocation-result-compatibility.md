# Allocation result compatibility

`GET /api/v1/allocations` retains its original response shape by default, including
the source request's `priority` and persistence coordinates. Existing clients use
strict response validation, so adding fields to that shape would break open tabs.

Clients opt into the expanded projection with
`Accept: application/vnd.idosi.allocations.v2+json`. The response adds `rounds` and
`appliedPriority`. The latter records the planner priority of the merged demand;
it can differ from the original source request priority. The UI labels these
separately. Missing legacy priority metadata remains unknown and is never inferred
from the source request.

The new client accepts an old server response by defaulting missing `rounds` to an
empty array and treating missing `appliedPriority` as unknown. `Accept` is a standard
CORS-safelisted header, so the new client can also call an old API's CORS policy.
No API write, historical row rewrite, or new migration is required for this change.

Regression checks cover both wire formats, a new client parsing an old response,
and a P3 source projected with the P1 priority actually applied by the planner.
CI additionally exercises migrations and the worker against PostgreSQL.

The v2 response uses `Content-Type: application/vnd.idosi.allocations.v2+json`.
List details are limited to 100 grant entries per line. Larger audit arrays stay
in PostgreSQL: for new writer-validated, versioned metadata the projection returns
`rounds: []` and `roundsOmitted: true`, while
preserving the actual requested/allocated/waitlisted totals and applied priority.
The UI labels omitted detail separately from missing legacy metadata. No partial
round list is presented as a complete audit.

The writer validates round values once and records `policyRoundsVersion: 1` in the
immutable metadata. Large unversioned legacy arrays remain unavailable, even if
their length matches; GET never expands them to revalidate every entry. Small
legacy arrays still receive full validation. No historical audit is rewritten.
Pagination orders newest runs first, then round, sequence and line ID within each
run; UUIDs are only a final tie-breaker, not the business execution order.

The proposed 0007 filtered-index migration was removed before merge/deployment.
Existing indexes remain unchanged. Any additional index rollout needs measured
query plans and a separately tested concurrent-index migration, not a blocking
index build in the transactional application migration. No deployed migration is
rewritten or rolled back by this PR.
