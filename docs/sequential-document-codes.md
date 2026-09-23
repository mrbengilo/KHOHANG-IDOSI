# Mã chứng từ tăng dần

Migration `0015_sequential_document_codes` cấp mã hiển thị theo từng loại chứng từ. UUID vẫn là khóa nội bộ và giữ nguyên trong API để tham chiếu, phân quyền, idempotency và audit.

| Chứng từ            | Mã mới       |
| ------------------- | ------------ |
| Phiên đặt hàng      | `PDH-000001` |
| Phiếu đặt hàng      | `PDT-000001` |
| Phiếu chờ           | `PC-0000001` |
| Phiếu ưu tiên       | `PUT-000001` |
| Phiếu xuất kho tổng | `PXK-000001` |
| Phiếu nhận cửa hàng | `PNH-000001` |
| Phiếu lọc và xử lý  | `PXL-000001` |
| Phiếu bán theo kg   | `PBL-000001` |
| Phiếu điều chuyển   | `PDC-000001` |

Mỗi tiền tố có bộ đếm riêng. Bộ đếm được cập nhật trong cùng giao dịch tạo phiếu, nên hai giao dịch đồng thời nhận số khác nhau và giao dịch rollback không tiêu số. Tiền tố ba chữ dùng sáu chữ số, tiền tố hai chữ dùng bảy chữ số. Khi hết khoảng số, việc tạo chứng từ báo lỗi; cần chọn quy tắc mở rộng mã trước ngưỡng này để không vượt 10 ký tự.

Migration cấp lại mã cho chứng từ cũ theo `created_at, id`; UUID, quan hệ khóa ngoại và thứ tự nghiệp vụ không đổi. Audit cũ vẫn giữ nguyên nội dung ban đầu, kể cả mã cũ đã ghi trong JSON. Các mã đã có quy tắc riêng như mã nhập nhà cung cấp, mã nhập đối tác và mã bao hiển thị `MB-...` được giữ nguyên. `request_number` của phiếu đặt hàng vẫn là số lượt 1 hoặc 2 trong phiên, khác với `code` mới.

Trước khi triển khai, sao lưu cơ sở dữ liệu và kiểm tra số lượng chứng từ theo loại dưới một triệu. Chạy migration trước khi khởi động phiên bản API/worker mới vì các đường tạo chứng từ mới dùng trigger trong migration. Nếu migration thất bại, giao dịch migration rollback toàn bộ; nếu đã chạy thành công thì phục hồi từ bản sao lưu hoặc forward-fix sau khi đánh giá các mã đã cấp, không chạy ngược migration bằng cách xóa bộ đếm.
