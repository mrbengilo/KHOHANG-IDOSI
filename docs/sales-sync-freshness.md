# Source sales refresh and warehouse layout

The dashboard previously read persisted IDOSI snapshots when the user pressed
“Cập nhật hiển thị”. Scheduled synchronization runs every 15 or 30 minutes, so new
source orders could appear on IDOSI before appearing in the warehouse dashboard.
Successful coverage does not mean the source and warehouse were read at the same instant.

“Đồng bộ từ IDOSI” now resolves the authorized stores for the selected month and
store filter and invokes the existing authenticated synchronization endpoint once
per store. Requests are sequential to bound source load. The server continues to
enforce store access and atomically replace snapshots. No credentials reach the browser.
Failures retain previous snapshots and are reported individually; expired or revoked
authorization stops the operation. Related summary and store queries are invalidated
when the refresh settles. The visible summary also rereads saved data every 30 seconds
while the page is active, without increasing background source synchronization frequency.

Source generation timestamps are shown alongside totals. Since stores are read sequentially,
orders recorded during or after refresh may still cause a small time-based difference.
The 2,771 legacy unclassified orders observed during investigation remain unclassified;
their weights cannot be inferred from the synchronization fix.

Warehouse inventory panels are capped at 1120px, with 14px data and 12px headings.
The inbound picker uses two compact columns on wide screens and one on smaller screens.
Checkbox, product name and quantity controls remain on the same row. The confirmation
button fits its label instead of stretching across the form.

No migration or source calculation change is required. Deploy only the merged SHA
using the existing VPS procedure and back up first. Rollback can use the previous
image tag without a database restore. Verify source refresh at month/store scope,
partial failure handling and responsive inventory/inbound layouts before release.
