# Mã bao ngắn tại cửa hàng

`0014_store_bag_display_codes.sql` thêm mã hiển thị `MB-00001` theo từng cửa hàng. Mã gốc `bag_code` vẫn được giữ để truy nguồn phiếu nhận, điều chuyển và audit. Hai cửa hàng có thể cùng có `MB-00001`; trong mỗi cửa hàng, mã không được dùng lại.

Migration đánh số bao lịch sử theo `created_at, id`, tạo bộ đếm ở số cao nhất của từng cửa hàng, rồi cài trigger cấp số khi có bao mới. Bộ đếm dùng `INSERT ... ON CONFLICT DO UPDATE`, nên các lượt nhận đồng thời của cùng một cửa hàng được tuần tự hóa trong transaction. UI và API tồn kho trả mã ngắn; bộ lọc mã bao vẫn chấp nhận cả mã ngắn lẫn mã gốc để giữ các liên kết cũ.

Khui kiện chỉ chuyển một bao từ `AVAILABLE` sang `OPEN`: số bao và kg **chưa khui** giảm, số bao và kg **đang bán** tăng tương ứng; tổng kg tồn và giá vốn giữ nguyên. Trừ tổng kg chỉ xảy ra khi duyệt phiếu xuất/bán theo luồng hiện có.

Triển khai migration trước phiên bản API/web mới. Khi cần rollback ứng dụng, giữ nguyên migration cộng thêm này: API cũ tiếp tục dùng `bag_code`, và trigger vẫn cấp mã ngắn cho dữ liệu mới. Nếu cần forward-fix bộ đếm, đối soát `display_code` với `store_inventory_bag_code_counters` trên bản sao lưu trước khi sửa dữ liệu production.
