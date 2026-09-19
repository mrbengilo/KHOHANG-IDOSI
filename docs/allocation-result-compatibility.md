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
