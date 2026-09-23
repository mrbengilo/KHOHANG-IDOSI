# Điều chuyển hàng Sale và xuất Từ thiện sau lọc

## Lọc & xử lý

Khi lưu khối lượng đã lọc vào **Sale** hoặc **Từ thiện**, cửa hàng chỉ nhập tổng kg. Không nhập số bao ở bước này. Bán theo ký/cái tiếp tục được đối soát từ IDOSI theo kg.

## Điều chuyển Sale

Trong **Điều chuyển**, cửa hàng nguồn chọn:

1. Cửa hàng nhận.
2. Mặt hàng Sale (ví dụ Đồ nam). Số kg khả dụng là tổng Sale của mặt hàng đó ở mọi Mã bao đã lọc.
3. Số lượng bao, rồi nhập kg của từng bao (Bao 1, Bao 2, …).

Tổng kg các bao phải lớn hơn 0 và không vượt quá kg Sale khả dụng của mặt hàng. Máy chủ kiểm tra lại dưới khóa cửa hàng. Ví dụ: Đồ nam có 100 kg, điều chuyển 2 bao 20 kg và 30 kg (tổng 50 kg) là hợp lệ.

Khi tạo phiếu, Sale nguồn giảm ngay, lấy từ các Mã bao lọc sớm nhất trước (cùng thứ tự với trừ bán IDOSI). Phiếu lưu kg từng bao (`sorted_sale_transfers.bag_weights_kg`) và hiển thị "Bao 1 · Đồ nam · 20 kg". Phiếu ở trạng thái **Đang vận chuyển**. Cửa hàng đích xác nhận nhận hàng thì Sale đích mới tăng. Cửa hàng đích cần có dữ liệu IDOSI tháng hiện tại để xác lập mốc đối soát Sale trước khi nhận.

## Từ thiện

Mục **Hàng Từ thiện** gom theo mặt hàng, có hai thao tác:

- **Quay lại Sale**: nhập kg. Kg được chuyển từ Từ thiện sang Sale của các Mã bao lọc sớm nhất trước.
- **Xuất từ thiện**: nhập số bao và kg từng bao. Tổng không vượt quá kg Từ thiện còn lại; không bắt buộc xuất hết một lần. Mỗi lần xuất tạo phiếu `PTT-…` trong bảng `store_charity_exports`, ghi rõ kg từng bao.

## Migration `0020_weighed_dispatch_bags.sql`

- Thêm cột `sorted_sale_transfers.bag_weights_kg numeric(14,3)[]`. Phiếu cũ giữ `NULL` vì chưa từng ghi kg từng bao; hệ thống không suy đoán lại.
- Tạo bảng `store_charity_exports` (không sửa/xóa sau khi tạo).
- Bỏ ràng buộc `store_sorted_stocks_new_sale_bags_with_weight`: số bao trên tồn đã lọc không còn được ghi, các cột số bao cũ chỉ giữ cho dữ liệu lịch sử.

Migration chỉ mở rộng schema và tương thích với image cũ trong lúc triển khai. API cũ `POST /store-sorted-stocks/:id/move-to-sale` và `/export-charity` vẫn hoạt động; trường `bagQuantity` cũ được chấp nhận và bỏ qua. Trước deploy cần backup PostgreSQL. Rollback ứng dụng giữ lại bảng/cột mới; sau rollback cần đối soát `store_sorting_events`, `sorted_sale_transfers`, `store_charity_exports` và tồn đã lọc trước khi phát hành bản sửa tiếp.
