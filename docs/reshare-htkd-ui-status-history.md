# HTKD quản lý mục Reshare, lịch sử trạng thái đơn, giao diện Reshare và tiêu đề bảng

Ngày 14/10/2026, baseline `d24e507` (#110). Bốn thay đổi độc lập về nguyên nhân, cùng một PR.

## 1. Quyền HTKD trong mục “Đơn & tồn Reshare”

**Trước:** chỉ Admin có tab Cập nhật tồn / Lịch sử cập nhật tồn / Cấu hình nguồn và nút đổi trạng
thái; HTKD chỉ đọc đơn của cửa hàng được phân công, ghi đơn thủ công chỉ cho cửa hàng đó. Lệnh đổi
trạng thái gán cố định `actorRole: 'admin'` trong audit.

**Sau:** mọi HTKD **đang hoạt động** có cùng quyền như Admin trong riêng mục này, trên **mọi cửa
hàng**, không phụ thuộc phân công. Điều kiện nghiệp vụ, version, idempotency và chứng từ áp dụng như
Admin. Audit lưu đúng tài khoản, vai trò thật (`htkd`) và tên lúc thao tác (`metadata.actorName`).

| Endpoint                                                 | Admin    | HTKD (mới) | STORE / WHOLESALE |
| -------------------------------------------------------- | -------- | ---------- | ----------------- |
| GET `/reshare-orders`                                    | mọi CH   | mọi CH     | CH của mình       |
| PUT `/reshare-orders/:decisionId/status`                 | ✓        | ✓          | 403               |
| GET `/reshare-orders/:decisionId/status-history` (mới)   | mọi đơn  | mọi đơn    | đơn CH mình, 404  |
| GET `/reshare-orders/stores` (mới, bộ lọc riêng Reshare) | mọi CH   | mọi CH     | CH của mình       |
| GET/POST `/supplier-sources`, POST `.../products`        | ✓        | ✓          | 403               |
| GET `/supplier-reconciliation`, `/history`               | ✓        | ✓          | 403               |
| POST `/supplier-stock-observations/preview`, confirm     | ✓        | ✓          | 403               |
| GET `/supplier-commitments`, GET `/supplier-orders`      | mọi CH   | mọi CH     | CH của mình       |
| POST `/supplier-orders`, `.../:eventId/cancellations`    | ✓ mọi CH | ✓ mọi CH   | 403               |
| POST `/supplier-source-returns`                          | ✓        | ✓          | 403               |

- Server: `isReshareManager`/`reshareStoreScope` (`apps/api/src/repository.ts`) chỉ dùng trong mục
  Reshare; `canAccessStore`, `decisionStoreScope`, `/stores` **không đổi**. Trong database mọi lệnh
  Reshare gọi `loadReshareManager` đọc lại tài khoản (trạng thái + vai trò) trong transaction, kể cả
  replay idempotency.
- Khóa tài khoản / đổi vai trò: từ chối ngay (session `ACCOUNT_INACTIVE`/`403`; lệnh DB `FORBIDDEN`).
  Bỏ phân công cửa hàng thu hồi session theo chính sách hiện hành; đăng nhập lại vẫn quản lý Reshare.
- Không đổi: Chấp nhận/Từ chối kết quả phân bổ (HTKD vẫn chỉ Chấp nhận, theo phân công), nhập kho,
  điều chỉnh kho, quản trị tài khoản, cấu hình, audit tổng và mọi mục khác.
- UI: `isReshareManager(role)` (`model.ts`) mở đủ 4 tab + deep link `legacy`; query key Reshare mang
  `role:accountId`; bộ lọc cửa hàng lấy từ `/reshare-orders/stores` (khóa `reshare-stores`), không
  dùng cache `/stores` của màn hình khác.

## 2. Lịch sử thay đổi trạng thái đơn Reshare

Đường ghi trạng thái đã khảo sát:

| Đường ghi                                       | Sự kiện                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| Chấp nhận kết quả (STORE/WHOLESALE/HTKD) tạo RE | `RESHARE_ORDER_CREATED` (entity `reshare_order`) |
| Cutover backfill RE (CLI, Admin)                | như trên, `trigger: reshare-cutover-backfill`    |
| Admin/HTKD đổi đã đặt ↔ chưa đặt                | `RESHARE_ORDER_STATUS_UPDATED` (entity decision) |
| Hủy đơn RE                                      | N/A: chưa có đường ghi nào đặt `cancelled`       |
| Worker / cập nhật tự động                       | N/A: worker không đổi trạng thái đặt Reshare     |

- **Một nguồn sự thật:** `audit_logs` (đã bất biến, đã có chỉ mục
  `audit_logs_entity_created_idx (entity_type, entity_id, created_at)`), không tạo bảng lịch sử thứ
  hai. Sự kiện mới lưu thêm trong `metadata`: `actorName` (tên lúc thao tác),
  `reshareStatusBefore/After` (trạng thái hiển thị trước/sau khi tạo RE; xác nhận Admin/HTKD đã lưu
  vẫn được ưu tiên), `reshareOrderCode`, `idempotencyKey`. `actor_role` là vai trò thật. Trạng thái,
  phiên bản và audit ghi trong **một transaction**; audit lỗi ⇒ rollback cả lệnh (có test).
- Thời điểm sự kiện lấy sau khi khóa dòng kết quả nên các sự kiện của một đơn theo đúng thứ tự commit.
- Đổi sang đúng trạng thái hiện có: trả 200 với **phiên bản không đổi**, không ghi sự kiện X → X.
  Sai phiên bản ⇒ `VERSION_CONFLICT`, khóa cũ + nội dung khác ⇒ `IDEMPOTENCY_CONFLICT`, không ghi lịch sử.
- **Migration: N/A.** Không cần cột/chỉ mục mới; không sửa migration 0043; không backfill.
- **Legacy:** sự kiện trước thay đổi này không có `actorName`/`reshareStatusBefore`: API trả `null`,
  UI ghi “Chưa ghi nhận” hoặc “Tên (tên hiện tại)”, không đoán, không viết lại audit cũ. Trước sự kiện
  đầu tiên, UI ghi rõ “Không có dữ liệu lịch sử nào trước các dòng trên”.
- API `GET /api/v1/reshare-orders/{decisionId}/status-history?page&pageSize≤100`: mới nhất trước,
  thứ tự ổn định `(created_at desc, id desc)`, phân trang server, chỉ hai loại audit trên.
- Danh sách thêm opt-in `includeStatusActor=true` ⇒ `statusControl.updatedByRole`; bundle cũ không
  gửi tham số nên vẫn nhận đúng shape strict cũ.
- UI: nút **Lịch sử thay đổi** ở mỗi đơn mở hộp thoại (focus trap, Esc, trả focus), chỉ gọi API khi mở
  (không N+1); cột Thời gian (giờ Việt Nam), Trạng thái trước, Trạng thái sau, Người thay đổi, Vai
  trò, Nội dung. Đổi trạng thái làm mới danh sách và lịch sử. Ghi chú trạng thái hiển thị “Cập nhật
  lần cuối bởi {tên} ({vai trò})” thay cho chữ “Admin” cố định.

## 3. Giao diện Reshare

- Tiêu đề khối 21px/700, tên mặt hàng (preview) 19px/700, ô nhập 16–17px cao ≥ 48px, nhãn ≥ 14px,
  bảy ô chỉ số: nhãn 15px/600, giá trị 24px/700 `tabular-nums`, lưới tự xuống hàng (≥ 176px/ô).
  “Khả dụng hiện tại → sau” có viền/nền nhấn, số sau 26px đậm, số trước 20px nhạt; “Thiếu nguồn” > 0
  có nền đỏ + chữ “⚠ Chặn cấp mới”.
- Bảng nhập tổng tồn chiếm hết chiều rộng khối (ngoại lệ scope riêng `.supplier-observation-table-wrap`).
- Checkbox/radio 22px, vùng bấm ≥ 44px, focus-visible; badge và lỗi trong mục Reshare 13–15px.
- Mặt hàng chỉ hiện tên ở bảng, preview, lịch sử, cấu hình nguồn, thông báo và aria-label. SKU/ID vẫn
  trong dữ liệu/payload/khóa; `externalLineRef` mặc định (giá trị ô nhập) giữ nguyên nghiệp vụ.
- Giữ nguyên hành vi #110 (ô số bao đã trừ xóa được, trừ một phần, đổi dữ liệu buộc xem trước lại).

## 4. Tiêu đề bảng toàn hệ thống

`th` toàn cục, `td::before` (nhãn thẻ mobile), `.admin-table`, `.idosi-table`: `font-weight: 700`,
`text-transform: none`, `letter-spacing: normal`; nội dung con trong `thead th` kế thừa độ đậm. Nhãn
nguồn đã ở dạng chữ đầu câu (rà 153 nhãn tĩnh + mảng nhãn). Không đổi menu/nhãn ngoài bảng.
Kiểm thử thực chất: `e2e-live/table-heading-typography.ts` gắn vào `system-route-audit.spec.ts`
(4 vai trò × mọi route × mọi tab, 360/1440px) và spec Reshare production.

## 5. Kiểm thử, deploy, rollback

- PostgreSQL: `packages/database/tests/reshare-status.integration.test.ts`,
  `supplier-reconciliation.integration.test.ts`; API: `apps/api/test/allocation-decisions.postgres.test.mjs`,
  `supplier-reconciliation.postgres.test.mjs`, `app.test.mjs` (memory parity).
- Deploy theo watcher. Không có migration. Rollback ứng dụng về SHA trước an toàn (schema không đổi;
  audit mới vẫn đọc được bởi bản cũ, bản cũ chỉ không hiển thị lịch sử và HTKD trở lại chỉ đọc).
