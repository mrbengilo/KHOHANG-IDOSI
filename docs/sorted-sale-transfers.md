# Điều chuyển hàng Sale sau lọc

Trong **Lọc & xử lý**, khi chọn lý do **Sale**, cửa hàng nhập cả số bao sau lọc và khối lượng kg. Tồn Sale hiện có lưu hai số này trên cùng dòng nguồn gốc Mã bao. Bán theo ký/cái tiếp tục được đối soát từ IDOSI; khi IDOSI trừ hết kg của một dòng, số bao còn lại về 0. Điều chỉnh bán từ IDOSI chỉ được phục hồi tối đa lượng kg chưa điều chuyển.

Trong **Điều chuyển**, cửa hàng nguồn chọn cửa hàng nhận, dòng mặt hàng Sale, số bao và kg nếu biết. Nếu bỏ trống kg, hệ thống tính theo tỷ lệ số bao. Khi tạo phiếu, tồn Sale nguồn giảm ngay. Phiếu ở trạng thái **Đang vận chuyển** và không xuất hiện trong tồn Sale đích. Cửa hàng đích phải xác nhận nhận hàng, sau đó một dòng tồn Sale mới với nguồn gốc phiếu điều chuyển được ghi nhận. Cửa hàng đích cần có dữ liệu IDOSI tháng hiện tại để xác lập mốc đối soát Sale trước khi nhận, tương tự khi đưa hàng mới vào Sale.

Hàng mới nhập vào cửa hàng không còn được tạo/xuất phiếu điều chuyển. Phiếu kiểu cũ đã tồn tại vẫn được xem, nhận hoặc hủy theo trạng thái cũ. Migration `0019_sorted_sale_transfers.sql` không tự suy đoán số bao của tồn Sale lịch sử; dòng chưa có số bao được giữ nguyên kg nhưng không thể điều chuyển cho tới khi có dữ liệu bao chính xác. Tại thời điểm chuẩn bị phát hành, production chưa có dòng tồn Sale lịch sử.

Trước deploy cần backup PostgreSQL. Migration chỉ mở rộng schema và tương thích với image cũ trong lúc triển khai. Rollback ứng dụng giữ lại bảng/cột mới, không xóa dữ liệu phiếu đã tạo; sau rollback cần dừng tạo phiếu mới và đối soát sổ `store_sorting_events`, `sorted_sale_transfers` và tồn Sale trước khi phát hành bản sửa tiếp.
