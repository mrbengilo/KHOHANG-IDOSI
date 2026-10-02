# Điều chỉnh tồn kho tổng

Màn **Tồn kho & lịch sử → Kho tổng → Tồn hiện tại**: mỗi mặt hàng có nút “Điều chỉnh tồn”. Tab
**Lịch sử điều chỉnh** liệt kê mọi chứng từ điều chỉnh (mới nhất trước, phân trang/lọc ở server).

## Phạm vi

- Chỉ tồn **kho tổng** (`warehouse_balances`), đơn vị bao như bảng tồn hiện có. Không đổi tổng kg,
  tồn Sale hay tồn cửa hàng; không liên quan phiếu sai lệch nhận hàng (PSL).
- Kho tổng chỉ đếm số bao: luồng nhập/xuất hiện tại không gắn bao vật lý của kho tổng vào phiếu xuất
  (`outbound_bag_picks` chưa được ghi ở luồng nào). Vì vậy tăng tồn không tạo phiếu nhập nhà cung cấp
  giả, không bịa kg/giá; giảm tồn không để lại bao “đã loại” còn xuất được.
- Ghi: chỉ Admin đang hoạt động (kiểm tra ở API và lại trong transaction). Đọc lịch sử: theo quyền
  màn tồn kho tổng hiện hữu — chỉ Admin.

## Lệnh `POST /api/v1/warehouse-adjustments`

Body: `productId`, `direction` (`INCREASE`/`DECREASE`), `quantity` (1…100 000 bao), `reasonCode`,
`reason` (3…500 ký tự), `expectedVersion` (version của dòng tồn vừa xem), tùy chọn
`compensatesAdjustmentId`. Header `Idempotency-Key` bắt buộc.

Trong một transaction serializable: khóa theo khóa idempotency → kiểm tra Admin, mặt hàng (mặt
hàng ngừng kinh doanh chỉ được giảm) → khóa tồn bằng đúng advisory lock + `FOR UPDATE` mà mọi
movement dùng → so `expectedVersion` → kiểm tra giảm không làm `onHand < reserved` → ghi
`warehouse_ledger_entries` (`adjustment`, nguồn `warehouse_stock_adjustment`) → chứng từ
`warehouse_stock_adjustments` (mã `DCK-000001`) → `audit_logs` `WAREHOUSE_STOCK_ADJUSTED`. Lỗi ở bất
kỳ bước nào rollback toàn bộ. Không bao giờ sửa `reserved`.

| Tình huống                                      | Kết quả                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| Cùng khóa, cùng nội dung                        | 201, `idempotency-replayed: true`, chứng từ cũ |
| Cùng khóa, nội dung khác                        | 409 `IDEMPOTENCY_CONFLICT`                     |
| `expectedVersion` cũ (có thay đổi khác xen vào) | 409 `VERSION_CONFLICT`, không ghi đè           |
| Giảm vào phần đang giữ/chờ xuất                 | 409 `INSUFFICIENT_STOCK`                       |
| HTKD/STORE/WHOLESALE, tài khoản bị khóa         | 403 / 401, không side effect                   |

Khóa idempotency được lưu ngay trên chứng từ (unique theo người tạo), nên replay được nhận ra
không giới hạn thời gian. Phía web giữ khóa cho đúng payload + version; mất phản hồi (timeout,
mạng) được hiển thị là “chưa xác định kết quả” và nút “Gửi lại đúng thao tác này” gửi lại cùng
khóa. Sửa nội dung tạo thao tác mới; nếu thao tác cũ đã ghi thì version đã tăng và thao tác mới bị
từ chối thay vì ghi hai lần. 403/400/409 không tự retry.

Sửa sai: tạo điều chỉnh **ngược chiều** mới, cùng mặt hàng, có `compensatesAdjustmentId`; chứng từ
và bút toán cũ bất biến (trigger `prevent_immutable_mutation`).

## Đối soát

- `onHand`/`reserved` của dòng tồn bằng tổng `on_hand_delta`/`reserved_delta` của sổ kho (test
  `warehouse-adjustments.integration.test.ts`).
- Snapshot phiên đã chụp không đổi (`loadWarehouseBalancesAt` đọc theo `occurred_at`); phiên chụp
  sau thấy điều chỉnh; lượt phân bổ luôn lấy `min(snapshot, tồn chưa giữ hiện tại)` nên giảm tồn sau
  snapshot vẫn được tôn trọng.

## Lịch sử `GET /api/v1/warehouse-adjustments`

Lọc `productId`, `direction`, `createdByAccountId`, `from`/`to` (ngày Việt Nam, bao gồm hai đầu);
`page`/`pageSize` ≤ 100. Mỗi dòng: mã, mặt hàng, chênh lệch có dấu, trước/sau (đang có, đang giữ,
khả dụng), version trước/sau, lý do, người thực hiện, request id, bút toán.
