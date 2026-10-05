# Xác nhận kết quả phân bổ (Chấp nhận / Từ chối)

Khi phiên phân bổ hoàn tất, mỗi cửa hàng được cấp hàng nhận một **phiếu kết quả** cần xác nhận
trong ứng dụng. Cửa hàng phản hồi **một lần cho toàn phiếu** bằng đúng hai nút **Chấp nhận** hoặc
**Từ chối**. Chỉ sau khi chấp nhận, hàng mới được xuất kho; chấp nhận không phải là khai nhận thực tế.

## Invariant thay đổi

| Trước (≤ 0037)                                                               | Sau (0038)                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lượt 09:00 tạo phiếu xuất và **tự dispatch** ngay trong transaction phân bổ. | Lượt 09:00 tạo quyết định `PENDING` và phiếu xuất ở `reserved`; **chỉ khi cửa hàng chấp nhận** phiếu xuất mới được dispatch.                           |
| Hàng ưu tiên đã cấp mặc nhiên được giao chung với đơn thường kế tiếp.        | Chỉ hàng của kết quả `ACCEPTED`/`NOT_REQUIRED`/`LEGACY` được gắn vào chuyến sau; kết quả `PENDING`/`REJECTED` không bao giờ đi cùng chuyến.            |
| Không có khái niệm từ chối kết quả.                                          | `REJECT` giải phóng đúng reservation của phiếu (tồn đặt giữ giảm, tồn thực không đổi), hủy chuyến `reserved` của phiếu, giữ phiếu và audit để tra cứu. |

Hoàn tất phân bổ vẫn hoàn tất phiên và reset hạn mức như cũ; phiên không bị giữ ở `allocating` vì
cửa hàng chưa phản hồi. Không có hết hạn hay tự chấp nhận/từ chối: phiếu im lặng giữ `PENDING` và
reservation còn hiệu lực, hiển thị trong thông báo và bộ lọc “Chờ xác nhận”.

## Mô hình dữ liệu

`allocation_result_decisions` — một dòng cho mỗi `(allocation_run_id, store_id)`, kèm
`order_session_id`. Tách khỏi trạng thái thuật toán (`allocation_runs/lines`) và tiến độ giao nhận
(`outbound_requests`, `store_receipts`).

| Cột                                                       | Ý nghĩa                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `status`                                                  | `pending`, `accepted`, `rejected`, `not_required` (không cấp mới), `legacy` (trước 0038). |
| `version`                                                 | Version lệnh cho `expectedVersion` (1 khi công bố, 2 sau phản hồi). Khác `runNumber`.     |
| `granted_quantity`                                        | Ảnh chụp tổng lượng cấp mới của phiếu lúc công bố (bất biến).                             |
| `origin`                                                  | `allocation_run` (worker ghi) hoặc `legacy_backfill` (migration phân loại).               |
| `responded_at`, `responded_by_user_id`, `response_reason` | Chỉ có với `accepted`/`rejected`; lý do chỉ cho `rejected` (tùy chọn, ≤ 500 ký tự).       |

Ràng buộc: unique `(run, store)`; tối đa một `pending` cho mỗi `(session, store)`; check nhất quán
trạng thái/actor/lý do; trigger chặn xóa và chặn đổi danh tính/ảnh chụp; câu trả lời là cuối cùng
(`pending` → `accepted|rejected` đúng một lần, version +1).

Chi tiết dòng hàng lấy từ `allocation_lines` (bất biến); nguồn hàng mang sang lấy từ
`reservations` liên kết với phiếu xuất của phiếu kết quả. Không có bảng thông báo riêng: danh sách
`PENDING` chính là nguồn thông báo bền vững.

## Vòng đời

```text
Lượt 09:00 commit ─┬─ có cấp mới ─────► PENDING ─┬─ Chấp nhận ─► ACCEPTED ─► (có chuyến) dispatch ─► khai nhận ─► HTKD duyệt
                   │                             │                          (không chuyến) giữ hàng chờ đơn thường kế tiếp
                   │                             └─ Từ chối ───► REJECTED ─► giải phóng reservation của phiếu, hủy chuyến reserved
                   └─ không cấp mới ───► NOT_REQUIRED (chuyến chỉ chở hàng đã chấp nhận trước đó được xuất ngay)
Dữ liệu trước 0038 ──────────────────► LEGACY (quy trình cũ, không có người/giờ chấp nhận)
```

### Chấp nhận

Trong một transaction: kiểm tra quyền → khóa → kiểm tra `PENDING` và `expectedVersion` → ghi
`accepted` + audit `ALLOCATION_RESULT_ACCEPTED`. Nếu phiếu có chuyến `reserved`, chuyến được
dispatch qua đường dispatch chuẩn với tác nhân nội bộ `allocation-decision` (chỉ hợp lệ cho đúng
chuyến của đúng phiếu đã chấp nhận; không mở quyền dispatch cho STORE). Tồn thực không đổi, đặt giữ
không tăng, tồn cửa hàng không tăng; số thực nhận vẫn do cửa hàng khai và HTKD duyệt như cũ.

### Từ chối

Trong một transaction: kiểm tra quyền/version/trạng thái → `rejected` → giải phóng mọi reservation
`active` thuộc lines của phiếu (đối soát bằng `granted_quantity`) bằng
`applyWarehouseMovement(reservation_release, onHandDelta = 0, reservedDelta = -n)` theo từng mặt hàng
→ hủy chuyến `reserved` của phiếu → audit `ALLOCATION_RESULT_REJECTED` và
`OUTBOUND_REQUEST_CANCELLED`. Không tạo phiếu nhận, không tạo kiểm tra thiếu, không đưa lượng bị
từ chối lại phiếu chờ, không chạy lại phân bổ, không đụng cửa hàng/phiếu khác.

Ví dụ đối soát: tồn 100, phiếu A giữ 10, phiếu B giữ 7 → từ chối A: tồn 100, đặt giữ 7, khả dụng 93.

### Hàng mang sang từ phiên trước

Chuyến của một phiếu có thể chở hàng đã được chấp nhận ở phiên trước. Khi phiếu mới bị từ chối,
hàng cũ **không** bị giải phóng: dòng reservation cũ chuyển `cancelled`
(`release_reason = detached_from_rejected_shipment`) và vẫn liên kết với chuyến bị hủy (lịch sử);
một dòng reservation `active` mới cùng allocation line, cùng số lượng, cùng thời điểm giữ là phần
đang giữ chờ đơn thường kế tiếp. Tổng đặt giữ không đổi nên không có bút toán kho. Con trỏ đại diện
`outbound_request_lines.allocation_line_id` của chuyến bị hủy được xóa để chuyến sau có thể ghi
nguồn đó; nguồn đầy đủ vẫn nằm trên reservation và audit.

## Chặn giao/nhận ở server

| Lớp               | Kiểm tra                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ứng dụng          | `dispatchWarehouseOutboundInTransaction` (mọi caller: HTTP, worker, chấp nhận, backfill) gọi `assertShipmentMayDispatch`.                                                          |
| Database (0038)   | Trigger `outbound_requests_allocation_dispatch_guard`: chuyến phân bổ chỉ thành `dispatched` khi phiếu của nó và mọi nguồn đang giữ trên chuyến là `accepted/not_required/legacy`. |
| Database (0038)   | Trigger `allocation_runs_completion_guard`: lượt phân bổ không thể `completed` khi thiếu quyết định cho một cửa hàng có dòng phân bổ.                                              |
| Khai nhận         | `declareStoreReceipt` từ chối phiếu `pending/rejected`; danh sách nguồn nhận hàng loại phiếu `pending/rejected`.                                                                   |
| Hàng đang giữ     | `GET /held-allocations` chỉ tính hàng của phiếu đã được chấp nhận (hoặc không cần/legacy).                                                                                         |
| Backfill stranded | Chuyến chờ cửa hàng xác nhận không phải “stranded”: chỉ đếm, không liệt kê, không dispatch; thiếu quyết định là lỗi integrity (blocked).                                           |

Mọi từ chối của gate trả `409 INVALID_STATE_TRANSITION`. Danh sách nguồn nhận, command khai nhận
và command HTKD duyệt thực nhận đều yêu cầu quyết định `accepted/not_required/legacy` cho phiếu
phân bổ; thiếu quyết định bị chặn, không suy ra legacy. Migration phân loại cả phiếu xuất cũ chỉ
chở hàng mang sang và không có allocation line của chính lượt đó.

Trang nhận hàng tra quyết định theo `outboundRequestId` của phiếu đang chọn, có phân trang và
phạm vi cửa hàng phía server. Liên kết mở đúng `?decision=` và hiển thị quyết định riêng với thực nhận.
Reservation mang sang đã `consumed` hiển thị đã xử lý theo thực nhận; chỉ `cancelled` do tách khỏi
chuyến bị từ chối mới được mô tả là tiếp tục giữ cho cửa hàng.

## API

| Method & path                                           | Mô tả                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/allocation-decisions`                      | Phân trang theo phiếu; lọc `status`, `storeId`, `sessionId`. `status=PENDING` là nguồn thông báo.             |
| `GET /api/v1/allocation-decisions/:decisionId`          | Chi tiết: dòng hàng, nguồn, hàng mang sang (nguồn/phiên/trạng thái), chuyến và phiếu nhận. 404 ngoài phạm vi. |
| `POST /api/v1/allocation-decisions/:decisionId/respond` | Body `{ action: 'ACCEPT'\|'REJECT', expectedVersion, reason? }`, header `Idempotency-Key`.                    |
| `GET /api/v1/session-documents?includeDecision=true`    | Thêm `decision` cho từng chứng từ (opt-in để bundle cũ không vỡ); lọc thêm `decisionStatus`.                  |

Mã trả về của `respond`: 200 (thành công hoặc replay, header `idempotency-replayed`), 400 body sai
(gồm số lượng/cửa hàng do client gửi), 401, 403 sai vai trò, 404 không có/ngoài phạm vi,
409 `INVALID_STATE_TRANSITION` (đã trả lời / không cần trả lời), `VERSION_CONFLICT`,
`IDEMPOTENCY_CONFLICT` (cùng khóa khác nội dung). `details` chứa `currentStatus`, `currentVersion`.

## Ma trận quyền

| Vai trò   | Xem                       | Chấp nhận / Từ chối                                   |
| --------- | ------------------------- | ----------------------------------------------------- |
| ADMIN     | Toàn hệ thống             | Không                                                 |
| HTKD      | Cửa hàng được phân công   | Không                                                 |
| STORE     | Cửa hàng của mình         | Có, cho cửa hàng bán lẻ đang hoạt động của mình       |
| WHOLESALE | Cửa hàng sỉ trong phạm vi | Có, cho cửa hàng sỉ đang hoạt động (bên nhận hàng sỉ) |

Quầy sỉ là bên khai nhận của cửa hàng sỉ (cùng ma trận với khai nhận), nên cũng là bên xác nhận
kết quả; nếu không, phiếu của cửa hàng sỉ sẽ không ai trả lời được. Quyền được kiểm tra ở route,
trước replay idempotency (khóa tài khoản/gỡ quyền có hiệu lực ngay cả khi gửi lại khóa cũ) và lại
trong transaction. Khóa idempotency có phạm vi theo phiếu và tài khoản.

## Khóa và đồng thời

Thứ tự khóa: khóa idempotency → `STOCK_JOBS_LOCK` (`idosi-allocation-worker:stock-jobs`, dùng chung
với chụp tồn 08:00 và phân bổ 09:00) → khóa advisory `warehouse-outbound:<id>` của chuyến → dòng
quyết định `FOR UPDATE` → dòng chuyến/line → reservation `FOR UPDATE` → `warehouse-balance` theo mặt
hàng. Dispatch thủ công giữ khóa chuyến trước khi đọc quyết định nên không deadlock với phản hồi.
Hai tab ACCEPT/REJECT đồng thời: đúng một thành công, tab còn lại nhận 409 với trạng thái hiện tại.

## Giao diện

- Thông báo bền vững “Có kết quả phân bổ cần xác nhận” trên mọi trang cho STORE/WHOLESALE: đếm
  phía server, 5 phiếu mới nhất, mã phiếu, phiên/ngày, mặt hàng và số được cấp, nút “Mở phiếu”
  tới `/allocations?decision=<id>`; polling 15 s, tải lại khi focus/reconnect; cache theo tài khoản.
- Phiếu kết quả: “Phân bổ phiên này” và “Hàng đã giữ từ phiên trước” tách nhóm; trạng thái quyết
  định (tag chính xác “đã từ chối nhận”) tách khỏi tiến độ giao nhận (“Đã xuất kho, chờ cửa hàng
  khai nhận” — không bao giờ ghi “Đã nhận hàng” khi chưa có thực nhận).
- Từ chối có hộp xác nhận ghi mã phiếu, số bao trả kho và ghi chú hàng cũ vẫn được giữ; lý do tùy
  chọn. Trạng thái chính thức chỉ đổi sau khi server xác nhận. Mất kết nối/timeout: giữ nguyên khóa
  và nội dung để gửi lại an toàn; 409/403: làm mới trạng thái thật.

## Dữ liệu cũ, cutover và rollout

- Migration 0038 additive: tạo bảng/enum/index/check, phân loại **mọi** kết quả đã có thành
  `legacy` (không gán người/giờ chấp nhận), tạo trigger. Không đổi tồn, reservation, chuyến hay
  phiếu nhận; chạy lại không tạo trùng (`ON CONFLICT DO NOTHING`, migrator chỉ chạy một lần).
- Ranh giới cutover bền vững là chính các dòng `legacy`: sau 0038, kết quả thiếu dòng quyết định là
  lỗi integrity và hàng của nó không bao giờ được giao (fail closed).
- Hàng giữ và chuyến `reserved` từ trước 0038 tiếp tục theo quy trình cũ: được gắn vào chuyến sau
  hoặc phát hành bằng backfill stranded. Không phát thông báo hồi tố cho lịch sử.
- Trong lúc deploy, migration chạy khi worker cũ còn chạy. Worker cũ không ghi quyết định nên trigger
  0038 làm transaction phân bổ của nó thất bại và được thử lại cho tới khi worker mới thay thế; không
  có phân bổ nào được công bố hay xuất kho mà bỏ qua bước xác nhận.

## Rollback

Không có down migration và không restore đè để rollback tính năng. Nếu phải chạy lại ảnh trước
0038: API/web cũ vẫn đọc được dữ liệu, nhưng **worker cũ sẽ không hoàn tất được phân bổ** (trigger
chặn hoàn tất và dispatch không có quyết định) và dispatch thủ công cho phiếu `pending` bị chặn — đây
là hành vi an toàn có chủ đích. Ưu tiên forward-fix; nếu cần giữ bản cũ lâu, tạm dừng worker
(`docker compose stop worker`), giữ nguyên dữ liệu quyết định/audit, rồi bật lại worker mới và kiểm tra
catch-up (lượt 09:00 idempotent theo khóa phiên).

## Runbook đối soát (chỉ đọc)

```sql
-- Phiếu chờ xác nhận và chuyến của chúng (không được dispatch).
SELECT d.id, d.store_id, d.granted_quantity, o.status
FROM allocation_result_decisions d
LEFT JOIN outbound_requests o ON o.allocation_run_id = d.allocation_run_id AND o.store_id = d.store_id
WHERE d.status = 'pending';
-- Phải rỗng: phiếu đã từ chối còn reservation active của chính nó.
SELECT d.id FROM allocation_result_decisions d
JOIN allocation_lines l ON l.allocation_run_id = d.allocation_run_id AND l.store_id = d.store_id
JOIN reservations r ON r.allocation_line_id = l.id AND r.status = 'active'
WHERE d.status = 'rejected';
-- Phải rỗng: lượt hoàn tất thiếu quyết định cho một cửa hàng.
SELECT DISTINCT l.allocation_run_id, l.store_id FROM allocation_lines l
JOIN allocation_runs r ON r.id = l.allocation_run_id AND r.status = 'completed'
LEFT JOIN allocation_result_decisions d ON d.allocation_run_id = l.allocation_run_id AND d.store_id = l.store_id
WHERE d.id IS NULL;
-- Đặt giữ kho tổng = reservation active + hàng ưu tiên đang giữ (stock_held_quantity).
```

## Bằng chứng kiểm thử

- `packages/domain/tests/allocation-decisions.test.ts` — chuyển trạng thái (property-based), phạm vi
  từ chối, lý do.
- `packages/contracts/tests/allocation-decisions.test.ts` — schema strict, không nhận số lượng/cửa
  hàng từ client, opt-in `includeDecision`.
- `packages/database/tests/allocation-decisions.integration.test.ts` — công bố một lần, bảo toàn tồn
  (100/10/7), idempotency/replay/xung đột, hai tab song song, quyền (store khác, HTKD, Admin, quầy sỉ,
  khóa tài khoản + replay), hàng mang sang, priority-only, zero grant/legacy, trigger bất biến, phân
  trang/lọc.
- `packages/database/tests/allocation-decisions-migration.integration.test.ts` — nâng cấp 0037→0038 có
  dữ liệu lịch sử, không đổi tồn, lặp lại an toàn, chặn lượt mới thiếu quyết định.
- `packages/database/tests/stranded-outbounds.integration.test.ts` — backfill không vượt gate; dispatch
  chuẩn và update SQL trực tiếp đều bị chặn.
- `apps/worker/tests/allocation-decisions.integration.test.ts`, `combined-shipment.test.ts`,
  `fresh-database-pipeline.test.ts` — materialize chỉ mang hàng đã chấp nhận, chuyến chỉ có hàng cũ
  được xuất ngay, race từ chối/chấp nhận với lượt 09:00 song song.
- `apps/api/test/allocation-decisions.postgres.test.mjs`, `app.test.mjs` — route thật + PostgreSQL và
  adapter memory.
- `apps/web/e2e-live/allocation-result-confirmation.spec.ts`, `workflow-order-to-receipt.spec.ts` —
  web → API → PostgreSQL: chấp nhận/từ chối, tải lại, mất phản hồi giữ khóa, tab khác thắng (409),
  360/390/412/768/1366/1440 px, Admin chỉ đọc, worker thật → chấp nhận → nhận hàng (bán lẻ và sỉ).
