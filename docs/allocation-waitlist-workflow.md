# Xác nhận phân bổ, chuyển phiếu chờ và hủy phiếu chờ có thu hồi hàng

Trạng thái: migration `0044_allocation_waitlist_response` (expand-only). Tài liệu này thay phần
“Từ chối” của `allocation-result-confirmation.md` và phần “Khi hủy” của
`wait-ticket-cancellation.md`; các mục khác của hai tài liệu đó vẫn hiệu lực.

## 1. Invariant thay đổi

| Trước (≤ 0043)                                                                        | Sau (0044)                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kết quả `PENDING` có hai câu trả lời **Chấp nhận** / **Từ chối**; HTKD chỉ Chấp nhận. | Hai câu trả lời **Xác nhận phân bổ** (`ACCEPT`) / **Chuyển phiếu chờ** (`WAITLIST`) cho STORE, quầy sỉ và HTKD được phân công. `REJECT` bị thu hồi (409 `ALLOCATION_DECISION_ACTION_RETIRED`). |
| Từ chối trả hàng về kho, **không** đưa nhu cầu trở lại phiếu chờ.                     | Chuyển phiếu chờ trả hàng đang giữ về kho (`ΔH = 0`, `ΔR = −q`) **và** đưa đúng số bao được cấp trở lại nhu cầu chờ của cửa hàng × mặt hàng, không đếm trùng.                                  |
| Hủy phiếu chờ chỉ hủy phần còn chờ; hàng đã phân bổ vẫn giao chung với đơn kế tiếp.   | Hủy phiếu chờ còn **thu hồi** hàng của phiếu đang nằm trong kết quả `PENDING` (chưa có RE, chưa xuất). Hàng đã có RE, đã xuất/nhận hoặc đã chấp nhận theo quy trình cũ được giữ nguyên.        |
| Không có lineage của nhu cầu chờ.                                                     | `wait_ticket_sources` ghi từng nguồn góp vào phiếu chờ (phần dư của đơn, kết quả chuyển về, phần khôi phục); phiếu cũ có `legacy_unsourced_quantity`.                                          |
| Thông báo vàng chỉ cho STORE/WHOLESALE, một nút “Mở phiếu”.                           | Khung **xanh** bền vững cho STORE, quầy sỉ và HTKD, có cả hai thao tác ngay trên khung, không có nút bỏ qua.                                                                                   |

Không thay đổi: phiếu RE chỉ được tạo khi xác nhận; xuất kho tổng ghi tại thời điểm xác nhận;
xác nhận không phải thực nhận; tồn cửa hàng chỉ tăng theo thực nhận; Admin chỉ xem kết quả.

## 2. Trạng thái và chuyển trạng thái

```text
                       ┌── Xác nhận phân bổ ──► ACCEPTED ─► RE-xxxxxx + xuất kho tổng (H −q, R −q)
Lượt 09:00 ─► PENDING ─┼── Chuyển phiếu chờ ──► WAITLISTED ─► trả giữ hàng (R −q), nhu cầu về phiếu chờ
                       └── Hủy phiếu chờ thu hồi toàn bộ hàng còn lại ──► CANCELLED
                           (thu hồi một phần: vẫn PENDING, revoked_quantity tăng)
REJECTED (lịch sử ≤ 0043) chỉ đọc; NOT_REQUIRED, LEGACY không đổi.
```

- `granted_quantity` là ảnh chụp bất biến lúc công bố. `revoked_quantity` = tổng
  `allocation_line_dispositions` của kết quả (trigger deferred kiểm tra), phần **có thể xử lý**
  = `granted − revoked`. Xác nhận lập RE đúng phần có thể xử lý, theo từng mặt hàng.
- Mỗi dòng phân bổ (và mỗi reservation) chỉ có tối đa một disposition (`unique`), nên một bao
  không bao giờ bị thu hồi hai lần.
- `WAITLISTED`, `CANCELLED`, `ACCEPTED` là cuối cùng. Trigger `allocation_result_decisions_protect_history`
  chặn `pending → rejected` mới và mọi thay đổi sau câu trả lời.

## 3. Ví dụ số lượng

### 10 / 6 / 4 — không cộng trùng

Cửa hàng đặt 10 bao X, phiên cấp 6, worker đã đưa 4 bao còn thiếu vào phiếu chờ PC.

| Bước                          | Kho H | Giữ R | PC còn chờ | Kết quả                       |
| ----------------------------- | ----: | ----: | ---------: | ----------------------------- |
| Sau phân bổ                   |   100 |     6 |          4 | PENDING, cấp 6                |
| Chuyển phiếu chờ              |   100 |     0 |         10 | WAITLISTED; PC +6 (không +10) |
| (nhánh khác) Xác nhận phân bổ |    94 |     0 |          4 | ACCEPTED; RE 6 bao            |

Chỉ số bao **được cấp** được đưa lại; phần dư 4 bao đã có trên PC từ worker nên không cộng lại.

### Gộp và tạo phiếu theo cửa hàng × mặt hàng

Kết quả cấp X = 2 và Y = 4; cửa hàng đang có PC X chờ 3, chưa có PC Y.
Chuyển phiếu chờ → PC X = 3 + 2 = 5 (nguồn `result_waitlisted`), tạo một PC Y mới = 4. Mỗi cửa
hàng × mặt hàng chỉ có một phiếu `active` (khóa `store-product-wait` và trigger hiện có).

### Khôi phục từ phiếu nguồn

Nếu dòng được cấp lấy từ chính PC đang `active` (dòng P0A), lượt phân bổ đã chuyển các bao đó từ
`remaining` sang `fulfilled`; chuyển phiếu chờ **khôi phục** chúng (`fulfilled −q`, `remaining +q`,
nguồn `result_restored`), nhu cầu gốc không đổi. Nguồn là phiếu đã `fulfilled` thì cộng thành nhu
cầu mới vào PC đang chờ (hoặc PC mới), không mở lại phiếu cũ. Nguồn đã `cancelled` thì chỉ trả
hàng về kho, không đưa nhu cầu trở lại (`WAIT_TICKET_REQUEUE_SKIPPED_CANCELLED_SOURCE`).

### Hủy phiếu chờ có thu hồi một phần

PC chờ 5 bao X. Kết quả phiên A cấp 2 bao từ PC (chưa xác nhận); kết quả phiên B đã xác nhận 3
bao (RE). Hủy PC: hủy 0 bao còn chờ + thu hồi 2 bao của phiên A (`R −2`, kết quả A chuyển
`CANCELLED` nếu không còn hàng khác); 3 bao của RE được bảo vệ, PC giữ `fulfilled = 3`. Nếu kết quả
A còn mặt hàng khác thì A vẫn `PENDING` với phần còn lại, chuyến `reserved` được thu nhỏ đúng phần
thu hồi.

## 4. Phân quyền (server-side)

| Thao tác                                   | ADMIN         | HTKD                                       | STORE / WHOLESALE               |
| ------------------------------------------ | ------------- | ------------------------------------------ | ------------------------------- |
| Xem kết quả, phiếu chờ, lineage            | Toàn hệ thống | Cửa hàng đang hoạt động được phân công     | Cửa hàng của mình / cửa hàng sỉ |
| Xác nhận phân bổ / Chuyển phiếu chờ        | Không         | Có, cửa hàng đang hoạt động được phân công | Có                              |
| Xem trước và hủy phiếu chờ (kể cả thu hồi) | Có            | Có, cửa hàng đang hoạt động được phân công | Có                              |

- Ngoại lệ “HTKD như Admin ở mục Reshare” **không** áp dụng cho các thao tác trên.
- Quyền được kiểm tra ở route, trước replay idempotency, và lại trong transaction (actor còn hoạt
  động, phân công còn hiệu lực, cửa hàng còn hoạt động). Audit ghi actor và vai trò thật.

## 5. API

| Method & path                                                 | Thay đổi                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/allocation-decisions[/:id]?includeWaitlist=true` | Opt-in trả `WAITLISTED`/`CANCELLED`, `actionableQuantity`, `revokedQuantity`, `actionableLines`, `revocations`, `requeued`, `allowedActions` mới.  |
| `POST /api/v1/allocation-decisions/:id/respond`               | `action: 'ACCEPT' \| 'WAITLIST'`; `REJECT` → 409 `ALLOCATION_DECISION_ACTION_RETIRED`.                                                             |
| `GET /api/v1/wait-tickets?includeLineage=true&displayStatus=` | Thêm `lineage` (nhãn hiển thị, chờ từ, phiên, nguồn, phần chờ xác nhận/thu hồi, `canCancel`) và lọc theo 3 nhãn.                                   |
| `GET /api/v1/wait-tickets/:id/cancel-preview`                 | Xem trước chỉ đọc: phần còn chờ, lượt ưu tiên, dòng thu hồi, dòng được bảo vệ, `fingerprint`.                                                      |
| `POST /api/v1/wait-tickets/:id/cancel`                        | Thêm `expectedFingerprint`. Bắt buộc khi có hàng thu hồi được (409 `WAIT_TICKET_PREVIEW_REQUIRED`); phạm vi đổi → 409 `WAIT_TICKET_PREVIEW_STALE`. |

Tương thích bundle cũ (tab đang mở trong lúc deploy): không có `includeWaitlist`, `WAITLISTED` và
`CANCELLED` được trả dưới dạng `REJECTED`, `allowedActions` chỉ còn `ACCEPT` (rỗng nếu kết quả đã bị
thu hồi một phần). Client cũ gửi `REJECT` nhận 409 `ALLOCATION_DECISION_ACTION_RETIRED`; gửi
`ACCEPT` cho kết quả đã thu hồi một phần (hoặc gửi `WAITLIST` mà không opt-in) nhận 409
`CLIENT_UPGRADE_REQUIRED`, vì client cũ không hiển thị được số thực sẽ xuất. `includeLineage` và
`expectedFingerprint` đều là opt-in; danh sách phiếu chờ không opt-in giữ nguyên định dạng cũ.

## 6. Nhãn hiển thị phiếu chờ

| Nhãn       | Điều kiện                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Chưa xử lý | `active` (đang chờ, đang có lượt ưu tiên, đã cấp một phần) hoặc `fulfilled` còn hàng nằm trong kết quả `PENDING`. |
| Đã xử lý   | `fulfilled` và không còn hàng chờ xác nhận. Không có nghĩa là đã nhận hàng.                                       |
| Đã hủy     | `cancelled`; `expired` (dữ liệu cũ) hiển thị “Đã hủy · hết hạn (dữ liệu cũ)”.                                     |

“Chờ từ” = thời điểm tạo phiếu (giờ Việt Nam). Phiên phân bổ lấy từ `wait_ticket_sources`, các
dòng phân bổ của phiếu và lượt ưu tiên; phiếu cũ hiển thị phần không xác định nguồn
(`legacyUnsourcedQuantity`) thay vì đoán phiên.

## 7. Khóa và đồng thời

Thứ tự khóa chung cho xác nhận/chuyển phiếu chờ, hủy phiếu chờ và worker:

1. `STOCK_JOBS_LOCK` (`idosi-allocation-worker:stock-jobs`).
2. Hủy phiếu: `wait-ticket:<id>` → `store-product-wait:<store>:<product>` → dòng phiếu `FOR UPDATE`.
3. `warehouse-outbound:<id>` của chuyến kết quả → dòng quyết định `FOR UPDATE` → chuyến `FOR UPDATE`
   → reservation `FOR UPDATE` → `warehouse-balance:<product>` theo thứ tự product id.
4. Chuyển phiếu chờ: `store-product-wait` của từng nhóm (thứ tự khóa nhóm) trước khi gộp/tạo PC.

Vì mọi luồng lấy `STOCK_JOBS_LOCK` trước, hủy phiếu và xác nhận cùng kết quả được tuần tự hóa: bên
đến sau đọc trạng thái mới (đã RE → được bảo vệ; đã thu hồi → `actionable` giảm hoặc 409). Bản xem
trước dùng `REPEATABLE READ`; vân tay sha256 của phạm vi (dòng, số lượng, trạng thái, version) được
so lại trong transaction ghi. Idempotency theo phiếu + tài khoản: cùng khóa cùng nội dung → replay,
khác nội dung → `IDEMPOTENCY_CONFLICT`.

## 8. Migration và cutover

- `0044` chỉ mở rộng: thêm giá trị enum `waitlisted`, `cancelled`; bảng `allocation_line_dispositions`,
  `wait_ticket_sources`; cột `revoked_quantity` (mặc định 0), `legacy_unsourced_quantity` (backfill
  = `original_quantity` cho phiếu đã có). Không sửa tồn, reservation, kết quả, RE hay audit cũ.
- Check mới so sánh `status::text` để không dùng giá trị enum mới trong cùng transaction migration.
- Kết quả `PENDING` đã công bố trước deploy được trả lời bằng hai thao tác mới như bình thường.
- Trong cửa sổ deploy, API cũ gửi `REJECT` sẽ bị trigger chặn (fail closed), không tạo dữ liệu sai.

## 9. Đối soát (chỉ đọc)

```sql
-- Phải rỗng: revoked_quantity khác tổng disposition.
SELECT d.id FROM allocation_result_decisions d
LEFT JOIN allocation_line_dispositions x ON x.allocation_decision_id = d.id
GROUP BY d.id HAVING d.revoked_quantity <> COALESCE(SUM(x.quantity), 0);
-- Phải rỗng: disposition mà reservation vẫn active/issued.
SELECT x.id FROM allocation_line_dispositions x
JOIN reservations r ON r.id = x.reservation_id WHERE r.status IN ('active', 'issued');
-- Phải rỗng: kết quả waitlisted/cancelled còn hàng đang giữ của chính nó.
SELECT d.id FROM allocation_result_decisions d
JOIN allocation_lines l ON l.allocation_run_id = d.allocation_run_id AND l.store_id = d.store_id
JOIN reservations r ON r.allocation_line_id = l.id AND r.status = 'active'
WHERE d.status::text IN ('waitlisted', 'cancelled');
-- Phải rỗng: RE khác phần có thể xử lý.
SELECT o.id FROM reshare_orders o JOIN allocation_result_decisions d ON d.id = o.allocation_decision_id
WHERE o.total_quantity <> d.granted_quantity - d.revoked_quantity;
-- Phải rỗng: phiếu chờ vi phạm bảo toàn.
SELECT id FROM wait_tickets WHERE remaining_quantity + fulfilled_quantity <> original_quantity;
-- Một dòng phân bổ chỉ góp vào phiếu chờ một lần (unique allocation_line_id).
SELECT allocation_line_id FROM wait_ticket_sources
WHERE allocation_line_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
```

Bút toán trả giữ hàng: `warehouse_ledger_entries.source_type = 'allocation_line_disposition'`,
`source_id` = id disposition, `on_hand_delta = 0`, `reserved_delta = −q`.

## 10. Rollback

Không có down migration; không restore đè database, không xóa disposition/lineage, không hủy RE để
“rollback”. Image trước 0044 **không** đọc được trạng thái `waitlisted`/`cancelled` (map trạng
thái không có hai giá trị này) nên sau khi phát sinh dữ liệu mới, quay image cũ sẽ làm lỗi đọc các
kết quả đó. Phương án là forward-fix trên `main`: nếu cần ngừng thao tác mới, ẩn hai nút/route
`WAITLIST` và cancel-preview (giữ parser, nhãn và schema), chạy lại CI và để watcher deploy SHA mới.
Trước khi có dữ liệu mới (ngay sau deploy), image cũ vẫn chạy được trên schema 0044 trừ lệnh
`REJECT` (bị chặn, fail closed).

## 11. Kiểm thử

- Domain: `allocation-waitlist.test.ts` (10/6/4, gộp X/Y, khôi phục, nguồn đã hủy, property-based
  bảo toàn), `allocation-decisions.test.ts` (chuyển trạng thái, actionable).
- Database PostgreSQL: `allocation-decisions.integration.test.ts` (chuyển phiếu chờ, gộp, khôi phục,
  hủy thu hồi một phần A+B với RE 6, đóng kết quả, đua hủy–xác nhận, HTKD, REJECT bị chặn), các
  test Reshare/migration/reset.
- API: `allocation-decisions.postgres.test.mjs`, `wait-ticket-cancellation.postgres.test.mjs`
  (preview + fingerprint), `app.test.mjs` (tương thích bundle cũ, mã lỗi).
- Worker: lineage phần dư đơn, chính sách lượt ưu tiên, nhiều phiên.
- Web: panel hai thao tác, khung xanh, bảng phiếu chờ theo phạm vi; live E2E
  `allocation-result-confirmation.spec.ts`, `reshare-auto-orders.spec.ts`.
