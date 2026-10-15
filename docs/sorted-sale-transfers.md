# Điều chuyển hàng Sale và xuất Từ thiện sau lọc

## Lọc & xử lý

Sau khi lọc, mỗi Mã bao chia ra 3 loại: **Sale**, **Từ thiện**, **Hủy**. Cửa hàng chỉ nhập tổng kg, không nhập số bao ở bước này. Cả 3 loại đều là tồn có theo dõi trên `store_sorted_stocks` (`sale_weight_kg`, `charity_weight_kg`, `cancel_weight_kg`) và xử lý tiếp được:

| Loại     | Xử lý tiếp                                                                                                                   | Kết thúc                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Sale     | Xuất bán theo cái / theo kg (tự trừ theo IDOSI, chỉ hiển thị phân loại); Từ thiện; Xử lý hủy; Điều chuyển sang cửa hàng khác | Bán (IDOSI), điều chuyển                   |
| Từ thiện | Chuyển vào lại mục Sale; Xuất từ thiện → chọn _Chuyển sang Sale (xuất bán theo kg)_ hoặc _Hủy luôn_                          | Hủy luôn (phiếu `PTT-…`, kg từng bao)      |
| Hủy      | Chuyển sang Sale (xuất bán theo kg)                                                                                          | Hủy luôn (xác nhận toàn bộ kg Hủy còn lại) |

Mọi lệnh chuyển lấy kg từ các Mã bao lọc sớm nhất trước, có idempotency key, khóa theo cửa hàng, ghi `store_sorting_events` và audit trong cùng transaction:

| API                                | Sự kiện           | Audit                         |
| ---------------------------------- | ----------------- | ----------------------------- |
| `POST /store-sale/move-to-charity` | `sale_to_charity` | `STORE_SALE_MOVED_TO_CHARITY` |
| `POST /store-sale/move-to-cancel`  | `sale_to_cancel`  | `STORE_SALE_MOVED_TO_CANCEL`  |
| `POST /store-cancel/move-to-sale`  | `cancel_to_sale`  | `STORE_CANCEL_MOVED_TO_SALE`  |
| `POST /store-cancel/finalize`      | `cancel_finalize` | `STORE_CANCEL_FINALIZED`      |

`GET /store-sale-breakdown` trả cho mỗi cửa hàng × mặt hàng: tổng kg đã vào Sale = còn lại + bán theo cái + bán theo kg + chuyển Từ thiện + chuyển Hủy + điều chuyển. "Bán theo cái" cộng từ sự kiện `idosi_sale_piece`; "bán theo kg" là phần còn lại để tổng luôn khớp (hấp thụ điều chỉnh IDOSI).

### Thay đổi invariant (migration `0046_store_sorted_cancel_bucket.sql`)

- **Cũ:** lọc vào Hủy là điểm kết ngay — trừ bao, ghi sổ `consume`, không có dòng tồn, không xử lý tiếp được. "Xuất từ thiện" luôn là cho tặng.
- **Mới:** lọc vào Hủy cộng `cancel_weight_kg` (sổ bao ghi `adjust` như Sale/Từ thiện); chỉ **Hủy luôn** mới kết thúc. "Xuất từ thiện" buộc chọn chuyển về Sale theo kg hoặc Hủy luôn; phiếu `PTT-…` giờ là chứng từ Hủy luôn hàng Từ thiện.
- **Dữ liệu cũ:** sự kiện `sort_cancel` và sổ `consume` trước migration giữ nguyên, không backfill (số kg đó đã kết thúc, không có tồn để phục hồi). Phiếu `PTT-…` cũ vẫn đọc được, nhãn lịch sử là "Xuất Từ thiện · kết thúc".
- Migration chỉ mở rộng: thêm cột mặc định `0.000` + check không âm, mở rộng danh sách `store_sorting_events.action`. Image cũ vẫn chạy được; rollback ứng dụng giữ cột mới. Nếu đã có kg trong `cancel_weight_kg` khi rollback, phải đối soát thủ công vì bản cũ không hiển thị/xử lý cột này.

## Điều chuyển Sale

Trong **Điều chuyển**, cửa hàng nguồn chọn:

1. Cửa hàng nhận.
2. Mặt hàng Sale (ví dụ Đồ nam). Số kg khả dụng là tổng Sale của mặt hàng đó ở mọi Mã bao đã lọc.
3. Bấm Thêm mặt hàng, nhập số lượng bao và kg từng bao (Bao 1, Bao 2, …). Lặp lại cho các mặt hàng khác trong cùng phiếu.

Tổng kg các bao phải lớn hơn 0 và không vượt quá kg Sale khả dụng của mặt hàng. Máy chủ kiểm tra lại dưới khóa cửa hàng. Ví dụ: Đồ nam có 100 kg, điều chuyển 2 bao 20 kg và 30 kg (tổng 50 kg) là hợp lệ.

Khi tạo phiếu, Sale nguồn giảm ngay, lấy từ các Mã bao lọc sớm nhất trước (cùng thứ tự với trừ bán IDOSI). Phiếu nhiều mặt hàng lưu các dòng và kg từng bao trong `sorted_sale_transfers.lines`; cột `bag_weights_kg` giữ dòng đầu để tương thích và hiển thị "Bao 1 · Đồ nam · 20 kg". Phiếu ở trạng thái **Đang vận chuyển**. Cửa hàng đích xác nhận nhận hàng thì Sale đích mới tăng. Cửa hàng đích cần có dữ liệu IDOSI tháng hiện tại để xác lập mốc đối soát Sale trước khi nhận.

## Từ thiện

Mục **Hàng Từ thiện** gom theo mặt hàng, có hai thao tác:

- **Quay lại Sale**: nhập kg. Kg được chuyển từ Từ thiện sang Sale của các Mã bao lọc sớm nhất trước.
- **Xuất từ thiện**: nhập số bao và kg từng bao. Tổng không vượt quá kg Từ thiện còn lại; không bắt buộc xuất hết một lần. Mỗi lần xuất tạo phiếu `PTT-…` trong bảng `store_charity_exports`, ghi rõ kg từng bao.

## Migration `0020_weighed_dispatch_bags.sql`

- Thêm cột `sorted_sale_transfers.bag_weights_kg numeric(14,3)[]`. Phiếu cũ giữ `NULL` vì chưa từng ghi kg từng bao; hệ thống không suy đoán lại.
- Tạo bảng `store_charity_exports` (không sửa/xóa sau khi tạo).
- Bỏ ràng buộc `store_sorted_stocks_new_sale_bags_with_weight`: số bao trên tồn đã lọc không còn được ghi, các cột số bao cũ chỉ giữ cho dữ liệu lịch sử.

Migration chỉ mở rộng schema và tương thích với image cũ trong lúc triển khai. API cũ `POST /store-sorted-stocks/:id/move-to-sale` và `/export-charity` vẫn hoạt động; trường `bagQuantity` cũ được chấp nhận và bỏ qua. Trước deploy cần backup PostgreSQL. Rollback ứng dụng giữ lại bảng/cột mới; sau rollback cần đối soát `store_sorting_events`, `sorted_sale_transfers`, `store_charity_exports` và tồn đã lọc trước khi phát hành bản sửa tiếp.

## Migration 0030 và phiếu nhiều dòng

Một mã phiếu có nhiều sản phẩm duy nhất; nhận/hủy toàn phiếu nguyên tử. Xem [thiết kế, compatibility, focus và kiểm chứng](document-history-multiline-transfers.md). Tổng số bao/kg tính trên tất cả dòng; legacy thiếu kg từng bao được ghi rõ, không chia đều tổng kg.
