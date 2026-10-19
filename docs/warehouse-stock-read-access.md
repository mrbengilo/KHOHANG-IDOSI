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
(xem “Cột của bảng tồn hiện tại” bên dưới). Bảng không chứa giữ hàng theo từng cửa
hàng, giá vốn hay chứng từ, nên không lộ dữ liệu cửa hàng khác.

## Cột của bảng tồn hiện tại

| Cột                     | Trường API                                          | Ý nghĩa                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mặt hàng                | `productName`                                       | Chỉ tên, không hiện mã (SKU vẫn có trong API và ô tìm kiếm).                                                                                                                                |
| Đang có tại kho         | `availableBags` (số chính), `onHandBags` (dòng phụ) | Khả dụng để cấp phân bổ `H − R`; dòng phụ là tồn thực `H`.                                                                                                                                  |
| Đang giữ chờ giao chung | `sharedDeliveryHoldBags`                            | Phần `R` giữ cho dòng phân bổ đã cấp còn trong kho: kết quả chờ xác nhận, hàng cấp một phần/ưu tiên giữ để giao cùng đơn thường kế tiếp.                                                    |
| Đang giữ phiếu chờ      | `waitingDemandBags`                                 | Tổng `remaining_quantity` của PC active, chưa xóa, còn số lượng, theo productId trên mọi cửa hàng. Đây là nhu cầu chưa được cấp, độc lập với H/R và không cộng thêm hold hoặc hàng pending. |
| Tổng đã xuất            | `dispatchedBags`                                    | Lũy kế bút toán `outbound` của sổ kho tổng (xuất theo RE, quyết toán phiếu nhận legacy, nhận dư). Chuyến giao không đổi `H` nên không đếm lại.                                              |
| Thao tác (chỉ Admin)    | `reshareReconciled`                                 | Mặt hàng nguồn Reshare: nút “Cập nhật tồn Reshare” mở đối chiếu tồn Reshare; mặt hàng khác: “Điều chỉnh tồn”.                                                                               |

Tham số tùy chọn `productId` trả đúng một dòng (màn đặt hàng đọc lại tồn khi tick, xem `order-warehouse-stock-gate.md`). Bảng có STT đầu tiên theo pagination mặt hàng thực. API yêu cầu `projection=waiting-demand-v2`;
tab cũ nhận 409 yêu cầu tải lại. Bundle mới kiểm tra response nghiêm ngặt và báo lỗi phiên bản
khi rollback về API cũ, không biến trường thiếu thành 0. Xem `table-presentation-waiting-demand.md`.

Bất biến vật lý: `onHandBags = availableBags + sharedDeliveryHoldBags + waitTicketHoldBags` và
`reservedBags = sharedDeliveryHoldBags + waitTicketHoldBags`. Trước đây `dispatchedBags` cộng
`dispatched_quantity` của phiếu xuất (chuyến giao); từ khi có đơn RE hàng rời kho lúc xác nhận nên
số đó chậm hơn sổ kho. `waitTicketHoldBags` vẫn giữ nguyên nghĩa vật lý trong API, nhưng không
còn là binding của cột nhu cầu chờ. Không lấy ba cột hiển thị cộng lại thành tồn thực.
Không đổi schema database, không migration; chỉ thêm trường đọc.

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

Không đổi schema, không migration, không backfill. Rollback đồng bộ API/web bằng image trước;
quyền đọc kho tổng vẫn giữ nguyên. Tab đang mở cần tải lại khi nhận lỗi phiên bản.

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
