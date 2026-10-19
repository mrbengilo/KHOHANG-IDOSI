# Chặn đặt mặt hàng kho tổng hết hàng (tồn = 0)

## Invariant

- **Cũ:** phiếu đặt thường nhận mọi mặt hàng đang hoạt động, không xét tồn kho tổng; phần chưa cấp
  vào phiếu chờ khi phân bổ.
- **Mới:** một mặt hàng chỉ được đặt khi tồn kho tổng khả dụng của nó **> 0**. Tồn khả dụng là đúng
  số “Đang có tại kho” mọi vai trò đọc ở bảng kho tổng: `H − R` (on-hand − reserved; với mặt hàng
  đối chiếu Reshare chính là `F`). Còn ≥ 1 bao thì đặt bình thường, không thông báo, không giới hạn
  số bao đặt (phần vượt tồn vẫn vào phiếu chờ như cũ). Đặt hàng **không giữ hàng**.

Áp dụng cho mọi người gửi phiếu đặt thường (STORE, quầy sỉ, HTKD được phân công, Admin).
Phản hồi ưu tiên, phiếu chờ, phân bổ, hạn mức hai phiếu và các luồng khác không đổi.

## Thực thi

| Lớp      | Hành vi                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `createOrderRequest` (`packages/database/src/order-requests.ts`) đọc `warehouse_balances` trong cùng transaction gửi phiếu, sau kiểm tra mặt hàng đang hoạt động; mặt hàng không có dòng balance tính là 0. Có mặt hàng ≤ 0 thì ném `ProductOutOfStockError` và rollback toàn phiếu (không ghi phiếu, audit, idempotency). Không khóa dòng balance để không chặn worker phân bổ/nhập kho.                           |
| API      | `POST /api/v1/order-requests` trả **409 `INSUFFICIENT_STOCK`** (mã sẵn có, bundle cũ vẫn đọc được), `details.productIds` và thông điệp nêu tên mặt hàng. Memory repository trả cùng lỗi. Khóa idempotency bị từ chối dùng lại được khi kho có hàng.                                                                                                                                                                 |
| Đọc tồn  | `GET /api/v1/warehouse-inventory` nhận thêm `productId` (tùy chọn) để đọc đúng một mặt hàng; cùng quyền đọc `WAREHOUSE_INVENTORY_READ_ROLES`.                                                                                                                                                                                                                                                                       |
| Web      | Màn “Đặt hàng” tải tồn khả dụng của toàn danh mục (làm mới 30 s, sau khi gửi và khi bị từ chối). Mặt hàng tồn = 0 **hiển thị mờ, không tick được**, phụ chú bên dưới “Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.”. Khi tick một mặt hàng còn hàng, web đọc lại tồn của riêng mặt hàng đó; nếu vừa về 0 thì bỏ tick và hiện phụ chú. Mặt hàng đã chọn rồi mới hết hàng vẫn bỏ chọn được; nút gửi báo lỗi nêu tên. |

Server là chốt chặn cuối: giao diện chỉ phản ánh số đọc gần nhất.

## Dữ liệu, migration, rollback

Không đổi schema, không migration, không backfill. Phiếu đã gửi trước thay đổi giữ nguyên và vẫn
được phân bổ/chuyển chờ như cũ. Rollback: deploy lại image trước cho cả API và web
cùng lúc. Nếu chỉ API bị rollback, query `strict` của API cũ trả 400 cho `productId` nên bước đọc lại
lúc tick báo “Không kiểm tra được tồn kho tổng” và không chọn được; vì vậy luôn rollback đồng bộ
bằng cùng image SHA.

## Kiểm chứng

- `packages/database/tests/continuous-ordering.integration.test.ts`: chưa từng có tồn, còn tồn nhưng
  đã giữ hết (`H = R`) đều bị từ chối, không ghi phiếu; cùng khóa thành công khi có hàng.
- `apps/api/test/app.test.mjs`: STORE và HTKD nhận 409 `INSUFFICIENT_STOCK` nêu tên mặt hàng; đọc
  tồn một mặt hàng theo `productId`; mặt hàng còn hàng đặt bình thường.
- `apps/web/src/features/orders/orderStock.test.ts`, `ProductBagPicker.test.tsx`: quyết định chặn,
  trạng thái mờ/khóa, phụ chú, mặt hàng đã chọn vẫn bỏ được.
- `apps/web/e2e-live/continuous-ordering.spec.ts`: HTKD thấy mặt hàng tồn = 0 mờ, không tick được,
  phụ chú đúng, không tràn ngang ở 360–1440 px; mặt hàng còn hàng đặt bình thường.
