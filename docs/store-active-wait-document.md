# Phiếu chờ tổng theo cửa hàng (một phiếu hiện hành, nhiều mặt hàng)

Trạng thái: migration `0045_store_wait_documents` (expand-only). Tài liệu này bổ sung
`allocation-waitlist-workflow.md` và `wait-ticket-cancellation.md`; các quy tắc phân bổ, xác nhận,
chuyển phiếu chờ, hủy và thu hồi trong hai tài liệu đó giữ nguyên.

## 1. Invariant thay đổi

| Trước (≤ 0044)                                                                                     | Sau (0045)                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Người dùng thấy nhiều “phiếu chờ” PC, mỗi phiếu một mặt hàng (một PC `active` mỗi cửa hàng × SKU). | Người dùng thấy **phiếu chờ tổng** `PCT-xxxxxx`: **tối đa một phiếu hiện hành mỗi cửa hàng**, gồm mọi mặt hàng còn mở. Có nhu cầu mở thì có đúng một phiếu; hết nhu cầu thì không có phiếu (không tạo phiếu rỗng).                 |
| Không có chứng từ cấp cửa hàng; gộp/xử lý chỉ thấy qua từng PC.                                    | Mỗi sự kiện làm thay đổi nhu cầu mở **đóng** phiếu hiện hành (bất biến) và **mở** phiếu kế tiếp; chuỗi B → C → D truy vết được, phiếu cũ giữ snapshot lúc mở và lúc chuyển.                                                        |
| STORE/quầy sỉ không xem được lịch sử đặt hàng; tab “Phiếu chờ ưu tiên”.                            | STORE/quầy sỉ có ba mục: **Kết quả phân bổ**, **Lịch sử đặt hàng** (cửa hàng của mình), **Phiếu chờ**. `/api/v1/order-history` mở cho STORE (cửa hàng của mình) và WHOLESALE (các cửa hàng sỉ); chỉ định cửa hàng khác vẫn bị 403. |

Không thay đổi: PC (`wait_tickets`) vẫn là **dòng vận hành theo mặt hàng** mà worker đọc; ID, mã PC,
`queuedAt`, thứ tự ưu tiên P0A–P3, chính sách vòng, đề nghị ưu tiên, giới hạn hai phiếu đặt thường,
lịch 08:00/09:00, RE, xuất/nhận và tồn kho. Phiếu tổng **không** đổi tồn, giữ hàng, kết quả hay RE và
không phải nhu cầu thứ hai: worker không đọc phiếu tổng, nên không bao giờ cộng nhu cầu hai lần.

## 2. Mô hình dữ liệu

| Bảng                          | Vai trò                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store_wait_documents`        | Header: mã `PCT-xxxxxx` (bộ đếm `document_code_counters`, không trùng mã PC, không tái sử dụng), cửa hàng, trạng thái, version (1 khi hiện hành, 2 khi đóng), `chain_id` + `chain_sequence`, `predecessor_id` (unique), sự kiện mở/đóng, thời điểm mở/đóng, `waiting_since` (chờ từ, không reset). |
| `store_wait_document_lines`   | Một dòng mỗi mặt hàng. Snapshot **mở**: `carried_in` (từ phiếu trước), `added` (bổ sung mới), tách `opening_remaining` (còn chờ phân bổ) / `opening_pending` (đã cấp chờ xác nhận). Snapshot **đóng** (NULL khi hiện hành): `confirmed`, `cancelled`, `adjusted`, `carried_out`.                   |
| `store_wait_document_events`  | Sự kiện bất biến làm đổi phiếu: loại, `source_key` (unique theo cửa hàng), actor + vai trò + tên **lúc thao tác**, request id, phiên, run, kết quả, PC, lượt ưu tiên, phiếu nhận, lý do, metadata.                                                                                                 |
| `store_wait_document_members` | Các PC thuộc phiếu (insert-only). Không có FK tới `wait_tickets` có chủ đích (xem §5); trigger kiểm tra PC cùng cửa hàng và mặt hàng.                                                                                                                                                              |

Ràng buộc trong database:

- `UNIQUE (store_id) WHERE status = 'current'` — không thể có hai phiếu hiện hành của một cửa hàng.
- `UNIQUE (predecessor_id)`, `UNIQUE (chain_id, chain_sequence)`, không tự trỏ; trigger chèn kiểm tra
  phiếu trước cùng cửa hàng, cùng chuỗi, đã đóng (`merged`/`rolled_over`) bởi đúng sự kiện mở phiếu
  sau → không có chu trình, không chuyển khác cửa hàng.
- Trigger bảo vệ: phiếu chỉ đóng một lần (`current → merged|rolled_over|completed|cancelled`, version
  +1), dòng chỉ ghi snapshot đóng một lần, không xóa; sự kiện và thành viên append-only.
- Check bảo toàn từng dòng: `carried_in + added = opening_remaining + opening_pending > 0` và khi đóng
  `carried_in + added = confirmed + cancelled + adjusted + carried_out`.
- Trigger deferred lúc commit: phiếu hiện hành có dòng chưa đóng; phiếu đóng có mọi dòng đã đóng;
  `merged`/`rolled_over` có phiếu sau và **`carried_out` từng mặt hàng = `carried_in` cùng mặt hàng
  của phiếu sau**; `completed`/`cancelled` không chuyển gì và không có phiếu sau.

## 3. Số lượng

**Nhu cầu mở** của cửa hàng × mặt hàng = còn chờ phân bổ (`remaining` của PC `active`) + đã cấp chờ
xác nhận (hold `active` của dòng P0A từ PC của cửa hàng trong kết quả `PENDING`, kể cả PC đã
`fulfilled` hoặc đã hủy tự động do lượt ưu tiên đủ hàng). Hàng đã xác nhận (RE, `issued`), đã chuyển
phiếu chờ/thu hồi (`released`) và hàng legacy không phải nhu cầu mở. Lượt ưu tiên đang giữ hàng là tập
con của nhu cầu chưa hoàn tất nên không cộng thêm.

Đối soát (pure function `planStoreWaitReconciliation`, `packages/domain`): với `open` của phiếu hiện
hành và `next` hiện tại theo từng mặt hàng, phần **sự kiện khai báo** đã giải quyết (xác nhận / hủy /
điều chỉnh, kẹp tối đa `open`) được ghi vào phiếu cũ; phần còn lại là chuyển sang (`carried`); nếu
`next < carried` thì phần giảm không khai báo được ghi theo loại sự kiện (bảng §4) và lưu trong
metadata `undeclared`; phần `next` vượt `carried` là bổ sung mới. Không đổi gì (và không khai báo gì)
→ không làm gì (idempotent: retry, refetch, qua ngày, đồng bộ đều không sinh phiếu).

Nhãn đóng: có phiếu sau và có bổ sung mới → **“Đã xử lý · Gộp vào phiếu [mã]”** (`merged`); có phiếu
sau, không bổ sung → **“Đã xử lý · Chuyển phần còn lại sang phiếu [mã]”** (`rolled_over`); không còn gì
mở → **“Đã xử lý xong”** (`completed`) hoặc **“Đã hủy”** (`cancelled`, khi chỉ có hủy). “Đã xử lý xong”
không có nghĩa là đã nhận hàng.

## 4. Writer và sự kiện

Đối soát là **bước ghi cuối** của transaction gốc, một lần cho mọi cửa hàng bị tác động
(`reconcileStoreWaitDocumentsInTransaction`).

| Writer                                            | Sự kiện (`kind`, `source_key`)                                           | Khai báo                                                | Phần giảm không khai báo |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------ |
| Worker 09:00 (phần dư, P0A, hết hạn lượt đủ hàng) | `allocation_run`, `allocation-run:<run>`                                 | `cancelled` = phần còn chờ của PC bị hủy do hết hạn     | `adjusted`               |
| Xác nhận phân bổ                                  | `result_accepted`, `allocation-decision:<id>`                            | `confirmed` = hold P0A còn hiệu lực của kết quả         | `confirmed`              |
| Chuyển phiếu chờ                                  | `result_waitlisted`, `allocation-decision:<id>`                          | —                                                       | `cancelled` (nguồn hủy)  |
| Hủy một dòng PC                                   | `wait_ticket_cancelled`, `wait-ticket-cancel:<pc>`                       | `cancelled` = còn chờ + thu hồi                         | `cancelled`              |
| Hủy cả phiếu tổng                                 | `wait_document_cancelled`, `wait-document-cancel:<pct>`                  | `cancelled` từng mặt hàng                               | `cancelled`              |
| Phản hồi lượt ưu tiên                             | `priority_offer_response`, `priority-offer:<put>`                        | `cancelled` khi từ chối/hết hạn lượt đủ hàng hủy phiếu  | `cancelled`              |
| Khai nhận / hoàn tất phiếu nhận                   | `receipt_shortage` (không key, phiếu nhận đổi nhiều lần)                 | — (thiếu hàng là bổ sung; sửa giảm thiếu là điều chỉnh) | `adjusted`               |
| Duyệt sai lệch nhận hàng                          | `receipt_adjustment` (không key)                                         | —                                                       | `adjusted`               |
| Worker khởi động (cầu nối deploy)                 | `system_sync` (không key) — “Đồng bộ hệ thống”                           | —                                                       | `adjusted`               |
| Migration 0045                                    | `migration_backfill`, `migration:0045` — “Khởi tạo từ phiếu chờ đang có” | —                                                       | —                        |

Ví dụ nghiệm thu (đã có test domain, PostgreSQL, worker và E2E):

- **A**: B = 2 nam + 2 nữ; phát sinh 1 nam + 3 trẻ em → C = 3 nam + 2 nữ + 3 trẻ em (`carried` 2/2/0,
  `added` 1/0/3); B “Gộp vào phiếu C”; retry không tạo C2.
- **B**: C được cấp 1 nam + 2 nữ (PENDING) → vẫn là C (còn chờ 2/0/3, chờ xác nhận 1/2/0). Xác nhận →
  C `rolled_over` (`confirmed` 1/2/0) và D = 2 nam + 3 trẻ em; xác nhận hết D → D `completed`, không
  phiếu rỗng.
- **C**: B có 1 nam PENDING, phát sinh nhu cầu mới → C mang theo 1 nam chờ xác nhận; xác nhận cập nhật
  C (phiếu mới nhất), B giữ nguyên `merged`. Toàn bộ nhu cầu đang PENDING → phiếu vẫn hiện hành với
  nhãn “Chờ xác nhận kết quả”.
- **D (10/6/4)**: xác nhận 6 bao của đơn thường → phiếu không đổi (vẫn 4); chuyển phiếu chờ → phiếu
  mới `carried` 4 + `added` 6 = 10.

## 5. Khóa, đồng thời, idempotency

Thứ tự khóa: khóa riêng của lệnh (`STOCK_JOBS_LOCK`, `wait-ticket`, `store-product-wait`, chuyến,
kết quả, số dư) → **tất cả** khóa `store-wait-document:<store>` theo thứ tự store id, lấy **trước**
khi ghi bất kỳ dòng phiếu nào → bộ đếm mã `PCT` (do trigger chèn). Transaction đang giữ khóa phiếu
không bao giờ chờ gì ngoài khóa phiếu khác hoặc bộ đếm `PCT`, nên không tạo chu trình với khóa cũ.
`store_wait_document_members` không có FK tới `wait_tickets`: kiểm tra FK sẽ lấy KEY SHARE trên PC mà
một lệnh khác cùng cửa hàng có thể đang giữ FOR UPDATE trong lúc chờ khóa phiếu (deadlock).

- Dữ liệu sống được đọc bằng **một câu lệnh** (một snapshot kể cả read committed).
- Transaction serializable (mọi lệnh có idempotency, worker): hai lệnh cùng cửa hàng → bên sau gặp
  40001 khi đóng phiếu bên trước đã đóng và được thử lại; kết quả cuối luôn đúng một phiếu hiện hành
  chứa cả hai thay đổi (test song song PostgreSQL).
- Idempotency: lệnh gốc replay bằng bản ghi idempotency (không chạy lại); đối soát theo trạng thái
  (không đổi → không ghi); `source_key` unique theo cửa hàng chặn một lệnh ghi hai sự kiện.
- Hủy phiếu tổng: xem trước (serializable, chỉ đọc) trả vân tay sha256 gồm (phiếu, version, vân tay
  từng PC, phần chỉ chờ xác nhận). Lệnh hủy bắt buộc `expectedFingerprint`, tính lại trong transaction
  rồi hủy từng PC với vân tay riêng của PC (mỗi PC kiểm lại dưới khóa của nó). Phiếu không còn hiện
  hành → 409 `WAIT_DOCUMENT_SUPERSEDED` (kèm phiếu hiện hành), **không** tự đổi mục tiêu sang phiếu
  sau. Hàng có RE/đã xuất/đã nhận được bảo vệ như hủy PC.

## 6. API và phân quyền (server-side)

| Method & path                                   | Ghi chú                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/wait-documents`                    | `view=ACTIVE` (mặc định, một phiếu hiện hành mỗi cửa hàng theo mã cửa hàng) / `HISTORY` / `ALL`; `status`, `storeId`, `productId` (chọn phiếu, trả đủ dòng), `q` (PCT, PC, PUT, mặt hàng, SKU), `openedFrom/To` (ngày Việt Nam). Đếm và trang cùng snapshot. |
| `GET /api/v1/wait-documents/:id`                | Header, snapshot, PC thành viên, kết quả `PENDING` đang giữ hàng (phiếu hiện hành), cả chuỗi, phiếu hiện hành của cửa hàng. Ngoài phạm vi → 404.                                                                                                             |
| `GET /api/v1/wait-documents/:id/cancel-preview` | Xem trước hủy cả phiếu.                                                                                                                                                                                                                                      |
| `POST /api/v1/wait-documents/:id/cancel`        | `{ reason, expectedFingerprint }`, header `idempotency-key`.                                                                                                                                                                                                 |
| `GET /api/v1/order-history`                     | Thêm STORE (cửa hàng của mình) và WHOLESALE (cửa hàng sỉ).                                                                                                                                                                                                   |

Phạm vi đọc: Admin toàn hệ thống; HTKD cửa hàng đang hoạt động được phân công (đọc lại từ database mỗi
request); STORE cửa hàng của mình; quầy sỉ các cửa hàng sỉ. Hủy theo đúng quyền hủy PC (Admin cả cửa
hàng ngừng hoạt động; HTKD cần phân công còn hiệu lực). Ngoại lệ “HTKD như Admin ở mục Reshare” **không**
áp dụng. Bundle cũ không gọi endpoint mới; DTO PC và `/wait-tickets` không đổi.

## 7. Giao diện

- Trang “Phân bổ hàng hóa”: STORE/quầy sỉ có **Kết quả phân bổ**, **Lịch sử đặt hàng**, **Phiếu chờ**;
  Admin/HTKD có “Phiên và kết quả”, “Lịch sử đặt hàng”, “Phiếu chờ” (+ “Tạo phiên mới” cho Admin).
- “Phiếu chờ”: mặc định **Đang hoạt động**; chuyển “Lịch sử đã xử lý” với bộ lọc kết quả xử lý. Thẻ
  phiếu: mã, cửa hàng (vai trò nhiều cửa hàng), tạo lúc, chờ từ, nhãn, tổng; bảng còn chờ / chờ xác
  nhận (không giữ dòng 0); lịch sử giữ đủ mặt hàng với mở / xác nhận / hủy / chuyển tiếp.
- Chi tiết: nguồn tạo phiếu, từ phiếu trước / bổ sung mới, kết quả chờ xác nhận với nút **Mở kết quả**,
  dòng thời gian B → C → D, PC vận hành, nút **Hủy phiếu chờ** (hộp thoại xem trước).
- Thẻ kết quả phân bổ (“Phiếu chờ cũ ⇒ Phiếu chờ mới”) đọc phiếu tổng **tại đúng lượt phân bổ**
  và chỉ liệt kê hàng **còn chờ phân bổ**: phiếu mới = phiếu cũ − phần cấp cho phiếu chờ cũ + hàng
  chờ mới của phiên (− phần hủy do hết hạn). Hàng đã cấp chờ xác nhận ghi chú riêng (“Không gồm N
  bao đã cấp, chờ xác nhận phân bổ”, phiếu cũ: “Ngoài ra N bao đã cấp ở phiên trước…”). Vì cấp từ
  PC chỉ chuyển bao từ còn chờ sang chờ xác nhận (không đổi nhu cầu mở, không đóng phiếu), số tách
  không đọc từ snapshot lúc mở phiếu mà suy ra từ lịch sử bất biến: sau lượt có sự kiện = snapshot
  mở của phiếu mới; sau lượt không đổi phiếu = snapshot mở + các lượt cấp PC của cửa hàng từ khi
  phiếu mở (kể cả lượt này) − kết quả PC đã chuyển phiếu chờ trong khoảng đó; trước lượt = sau lượt
  − phần cấp PC của chính lượt đó. Ví dụ DS TH: 15/10 phiếu cũ 3 nam + 1 short + 2 nữ, cấp 1 nữ →
  phiếu mới 3 nam + 1 short + 1 nữ; 16/10 phiếu cũ 3 nam + 1 short + 1 nữ, cấp 1 nam + 1 short +
  1 nữ, chờ mới 1 đồ bộ → phiếu mới 2 nam + 1 đồ bộ.
- Hàng **bị bỏ khỏi phiếu cũ mà không được cấp** trong lượt phân bổ hiện thành dòng riêng giữa phiếu
  cũ và phiếu mới, nên phiếu mới = phiếu cũ − cấp cho phiếu chờ cũ − **hàng bị bỏ** + hàng chờ mới.
  Lượt 09:00 chỉ tự bỏ một loại: PC có **đề nghị nhận đủ** (lượt ưu tiên FULL) không được phản hồi
  trước giờ chốt bị hủy (`full_offer_timeout`, khai báo `cancelled` của sự kiện `allocation_run`) —
  dòng “Hủy khỏi phiếu chờ”; phần giảm không khai báo (`adjusted`) hiện “Điều chỉnh phiếu chờ”. Số
  đọc từ snapshot đóng (bất biến) của phiếu cũ do chính lượt đó đóng; API trả `waitDocuments.removed`
  khi có thêm opt-in `includeWaitRemovals=true` (bundle cũ giữ shape). Ví dụ DS CT: phiếu cũ
  PCT-000017 = 1 Quần áo nam + 1 Sản phẩm tiện ích (đề nghị nhận đủ quá hạn), đặt 1 Áo dài + 1 Đồ bộ,
  cấp 1 Áo dài → hủy 1 Sản phẩm tiện ích, phiếu mới PCT-000021 = 1 Quần áo nam + 1 Đồ bộ.
- “Dòng theo mặt hàng (mã PC)” giữ danh sách PC cũ (tìm PC/PUT, lý do hủy, lịch sử ưu tiên); liên kết
  cũ có `wt.*` vẫn mở danh sách này. URL giữ bộ lọc/phiếu đang mở (`wd*`, `wdOpen`).
- Responsive 360–1440 px (bảng thành thẻ trên mobile, nút 44 px), ảnh E2E trong CI artifact.

## 8. Migration, cutover, rollback

- `0045` expand-only: bảng mới, trigger, backfill một phiếu hiện hành mỗi cửa hàng có nhu cầu mở
  (`migration_backfill`). Không sửa PC, đề nghị, dòng phân bổ, hold, kết quả, RE, sổ kho. Backfill lặp
  lại không tạo trùng (`NOT EXISTS`), test nâng cấp 0044 → 0045 có dữ liệu.
- Mixed-version: watcher migrate khi API/worker cũ còn chạy; lệnh cũ đổi PC không đối soát phiếu. Worker
  mới chạy **đồng bộ hệ thống một lần khi khởi động** (`syncAllStoreWaitDocuments`): cửa hàng nào lệch
  được ghi sự kiện `system_sync` (log `store wait document catch-up changed documents`); cửa hàng khớp
  không đổi. Lệnh mới đến trước lần đồng bộ vẫn đúng tổng; phần lệch được ghi `undeclared`/`overDeclared`
  trong metadata sự kiện để đối soát, không chặn nghiệp vụ.
- Rollback: không có down migration, không xóa phiếu/sự kiện. Image trước 0045 chạy được trên schema
  0045 (bảng mới không bắt buộc với code cũ); quay image cũ chỉ làm phiếu tổng không được cập nhật cho
  tới khi image mới chạy lại và đồng bộ. Ưu tiên forward-fix trên `main`.

## 9. Đối soát (chỉ đọc)

```sql
-- Phải rỗng: cửa hàng có hơn một phiếu hiện hành (unique index cũng chặn).
SELECT store_id FROM store_wait_documents WHERE status = 'current' GROUP BY 1 HAVING count(*) > 1;
-- Phải rỗng: nhu cầu mở không nằm trong phiếu hiện hành (lệch → chờ đồng bộ hoặc lỗi writer).
WITH live AS (
  SELECT w.store_id, w.product_id, w.remaining_quantity AS q FROM wait_tickets w
  WHERE w.status = 'active' AND w.deleted_at IS NULL AND w.remaining_quantity > 0
  UNION ALL
  SELECT al.store_id, al.product_id, r.quantity FROM allocation_result_decisions d
  JOIN allocation_lines al ON al.allocation_run_id = d.allocation_run_id AND al.store_id = d.store_id
    AND al.wait_ticket_id IS NOT NULL
  JOIN reservations r ON r.allocation_line_id = al.id AND r.status = 'active' AND r.deleted_at IS NULL
  WHERE d.status = 'pending'
), open AS (SELECT store_id, product_id, sum(q) AS q FROM live GROUP BY 1, 2),
doc AS (
  SELECT d.store_id, l.product_id, l.carried_in_quantity + l.added_quantity AS q
  FROM store_wait_documents d JOIN store_wait_document_lines l ON l.document_id = d.id
  WHERE d.status = 'current'
)
SELECT coalesce(o.store_id, c.store_id), coalesce(o.product_id, c.product_id), o.q, c.q
FROM open o FULL JOIN doc c ON c.store_id = o.store_id AND c.product_id = o.product_id
WHERE o.q IS DISTINCT FROM c.q;
-- Phải rỗng: dòng vi phạm bảo toàn khi đóng.
SELECT id FROM store_wait_document_lines WHERE confirmed_quantity IS NOT NULL
  AND carried_in_quantity + added_quantity
    <> confirmed_quantity + cancelled_quantity + adjusted_quantity + carried_out_quantity;
-- Phải rỗng: phiếu chuyển sang phiếu sau khác cửa hàng.
SELECT s.id FROM store_wait_documents s JOIN store_wait_documents p ON p.id = s.predecessor_id
WHERE p.store_id <> s.store_id;
-- Theo dõi: sự kiện có phần giảm không khai báo (cần xem lại nguồn).
SELECT id, store_id, kind, occurred_at, metadata FROM store_wait_document_events
WHERE metadata ? 'undeclared' OR metadata ? 'overDeclared' ORDER BY occurred_at DESC;
```

## 10. Kiểm thử

- Domain: `packages/domain/tests/store-wait-documents.test.ts` (A/B/C/D, hủy, giảm không khai báo,
  khai báo vượt, property-based: bảo toàn, không âm, chuyển = nhận, replay = NOOP).
- PostgreSQL: `packages/database/tests/store-wait-documents.integration.test.ts` (A–D qua lệnh thật,
  hủy dòng/hủy phiếu có thu hồi, phạm vi STORE/HTKD/Admin, trigger bất biến và một phiếu hiện hành,
  hai lệnh song song cùng cửa hàng, đồng bộ hệ thống), `store-wait-documents-migration.integration.test.ts`
  (nâng cấp 0044 → 0045), reset manifest/hash.
- Worker: `wait-ticket-offer-policy.integration.test.ts` (từ chối và hết hạn lượt đủ hàng đóng phiếu
  `cancelled`, lượt được nhận giữ phiếu).
- API: `apps/api/test/store-wait-documents.postgres.test.mjs`, `order-history-adjustments.postgres.test.mjs`.
- Web: `WaitDocumentList.test.tsx`, `AllocationPage.test.ts`; live E2E
  `store-wait-documents.spec.ts`, `allocation-result-confirmation.spec.ts`.
