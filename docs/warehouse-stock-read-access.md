# Cửa hàng và quầy sỉ xem tồn kho tổng

## Quyền

| Chức năng                                            | ADMIN | HTKD      | STORE (bán lẻ)               | WHOLESALE / STORE sỉ      |
| ---------------------------------------------------- | ----- | --------- | ---------------------------- | ------------------------- |
| Đọc tồn kho tổng (`GET /api/v1/warehouse-inventory`) | Có    | Chỉ xem   | Chỉ xem                      | Chỉ xem                   |
| Điều chỉnh, lịch sử xuất/điều chỉnh, kiểm thiếu      | Có    | Không     | Không                        | Không                     |
| Tab “Kho cửa hàng” trên `/inventory`                 | Có    | Phân công | Cửa hàng của mình (mặc định) | Không (không giữ tồn sàn) |
| Tab “Phiếu sai lệch” trên `/inventory`               | Có    | Không     | Không                        | Không                     |

Invariant cũ: tài khoản cửa hàng/quầy sỉ không đọc được tồn kho tổng (API trả 403, route
`/inventory` đóng với quầy sỉ). Invariant mới: mọi vai trò đọc cùng một bảng tổng theo mặt hàng
(đang có, đang giữ/chờ xuất, có thể xuất, đã xuất lũy kế). Bảng không chứa giữ hàng theo từng cửa
hàng, giá vốn hay chứng từ, nên không lộ dữ liệu cửa hàng khác.

## Thực thi

- API: `WAREHOUSE_INVENTORY_READ_ROLES` (`apps/api/src/repository.ts`) dùng chung cho route và cả
  hai repository; route điều chỉnh/lịch sử/kiểm thiếu giữ `ADMIN`. Session bị thu hồi hoặc tài khoản
  bị khóa bị chặn ở `resolveSession` như mọi request.
- Web: `inventoryTabsFor`/`defaultInventoryTab` (`inventoryNavigation.ts`) quyết định tab theo vai
  trò và loại cửa hàng; deep link tới phạm vi Admin bị thu về tồn hiện tại. STORE bán lẻ vẫn mở
  `/inventory` ở “Kho cửa hàng”; “Kho tổng” giữ `tab=warehouse` trên URL để tải lại/chia sẻ đúng.
  Kho tổng ngoài Admin dùng `WarehouseInventory readOnly`: không cột “Thao tác”, không dialog điều
  chỉnh, không mount query lịch sử/kiểm thiếu.

## Dữ liệu, migration, rollback

Không đổi schema, không migration, không backfill. Rollback bằng image trước chỉ đóng lại quyền
đọc; không có dữ liệu mới cần chuyển đổi.

## Kiểm chứng

- `apps/api/test/app.test.mjs`: HTKD/STORE/WHOLESALE đọc cùng dữ liệu với Admin; điều chỉnh, lịch sử
  điều chỉnh, kiểm thiếu trả 403; khóa quầy sỉ chặn session cũ.
- `apps/api/test/order-history-adjustments.postgres.test.mjs`: cùng phép đọc trên PostgreSQL thật,
  STORE/WHOLESALE không tạo được phiếu điều chỉnh.
- `access.test.ts`, `inventoryNavigation.test.ts`, `InventoryWorkspace.test.tsx`: bảng route × vai
  trò, tab/mặc định/deep link, query chỉ mount theo tab đang mở.
- `e2e/prominent-tabs.spec.ts`: STORE mặc định kho cửa hàng, chuyển/tải lại/Back kho tổng, không
  nút điều chỉnh, deep link Admin bị thu về; quầy sỉ chỉ thấy kho tổng tại 360–1920 px không tràn.
- `e2e-live/htkd-priority-waitlist.spec.ts`: STORE đọc kho tổng khớp DB, lịch sử điều chỉnh 403.
