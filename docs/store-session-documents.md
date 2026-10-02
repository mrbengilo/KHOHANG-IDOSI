# Store/session documents and receipt navigation

## Official documents

`GET /api/v1/session-documents` is a read-only projection of completed worker runs.
It does not allocate stock, create orders, or change the two-request quota.
The existing merged orders/items/sources remain the ordinary-order merge model.
Ordinary result sources retain their merged order, original request/item IDs,
code, submission time and priority. P0A retains its wait-ticket and accepted-offer
IDs instead of being inserted as an ordinary order.

The logical document ID is `sessionId:storeId`. Order and result references have
separate `TH-` and `KQ-` prefixes. The effective version is the greatest completed,
non-deleted allocation run number containing that store. Pending or failed runs
cannot replace it. Previous immutable runs remain available through the existing
allocation audit API. The selected run ID and version are explicit in the response.

Pagination counts headers. Product/status/priority filters select matching
documents, then all their sources are returned. Count, headers, sources and carried
allocations are read in one read-only repeatable-read transaction. A page boundary
cannot split a document. Consolidated demand and result tables use these complete
sources, grouped by product ID and integer bag quantity, including zero grants.

`carriedAllocations` follows persisted reservation-to-shipment links for goods
allocated earlier and shipped with this run. They are shown separately and never
added to newly requested, allocated or waitlisted totals. The priority tag derives
from actual wait-ticket sources, including carried allocations. Source and applied
priorities remain distinct.

ADMIN can view all stores; HTKD/WHOLESALE are restricted to assigned stores and
STORE to its own store. An explicit unauthorized store filter returns 403 before
headers are selected. The memory adapter has no persisted worker documents and
returns an empty collection.

Completed-session navigation has one row per store. Original submissions remain
in order history, and open-session navigation still shows individual submissions.
Product spelling is preserved; product cells explicitly use regular typography.

## Receipt navigation

`GET /api/v1/store-receipt-summaries` accepts existing receipt filters and pagination
parameters, returning only identity, store, status, timestamps and received-bag
count. It queries selected headers and line totals without constructing
each receipt detail. Full pricing, weights and history use the existing detail
endpoint when the user selects a receipt. The full receipt-list API is unchanged.

ADMIN starts with a store-selection prompt, can explicitly choose all stores, and
can search store names/codes. Session storage restores the prior scope only while
accessible. Lists use server pages of 20 or 50 headers. Store/status/page-size
changes reset the page and clear the selected receipt. Query keys include role,
store, status, page and page size. Statistics are labelled as current-page counts;
the server total is shown separately. The open-or-recent filter retains old
unfinished receipts. Discrepancy links still open older receipts in the right scope.

## Sale transfers

History shows Vietnam HH:mm above dd/MM/yyyy, store names without codes, compact
quantity columns and existing exact kg totals. The last column contains only
`Đã điều chuyển` or `Đã hủy`. Receive/cancel controls are in native keyboard-accessible
document details. The label does not confirm receipt: creation reduces source
Sale, receipt increases destination Sale, and cancellation returns source Sale.

## Compatibility and rollback

No migration, backfill or historical rewrite is introduced. Existing allocation
v1/v2 and receipt list/detail contracts remain intact. Deploy API and web from the
same release using the watcher. Rollback restores the prior application SHA without
data rollback. Old tabs retain their endpoints; the new UI requires the new API.

Regression coverage includes X=6/Y=1/Z=2, complete header pages, effective versions,
source scope, prior-run priority holdings, real Sale receipt, three-line history
computed styles and a 121-receipt pagination measurement against isolated PostgreSQL.

## Lịch sử đặt hàng (phiếu gốc)

Tab **Phân bổ hàng hóa → Lịch sử đặt hàng** (Admin: mọi cửa hàng; HTKD: cửa hàng được phân công)
đọc `GET /api/v1/order-history`: phân trang theo phiếu gốc ở server, mỗi phiếu trả đủ dòng hàng nên
không bị cắt ở ranh giới trang. Lọc cửa hàng, phiên, trạng thái, mặt hàng (giữ cả phiếu và đánh dấu
dòng khớp), mã phiếu và khoảng **ngày gửi** (giờ Việt Nam — khác ngày nghiệp vụ của phiên). Số lượng
luôn là số đã đặt; phiếu đã gộp có liên kết tới chứng từ `phiên:cửa hàng` của đúng phiên. Không dùng
cửa sổ “phiên gần đây” để quyết định phiếu nào tồn tại. Bộ lọc nằm trong URL (`ls.*`) nên back/reload
giữ nguyên phạm vi; HTKD chỉ định cửa hàng ngoài phân công nhận 403.
