# Nhập theo số bao, cân khi cửa hàng thực nhận

- Admin chọn mặt hàng và số bao ở nhập kho tổng; không có trường nhập kg.
- Chủ hệ thống đã chọn chốt tiền hàng theo hóa đơn: nhập tổng tiền hàng chưa gồm VAT, vận chuyển và bốc vác tại lịch sử phiếu. Không cần kg; không phân bổ tùy ý tiền hóa đơn xuống SKU/bao. `receipt_costs` lưu dòng goods cấp phiếu, audit ghi INVOICE; giá/kg để null. Tiền hàng bằng 0 hợp lệ, bỏ trống không hợp lệ. VAT không còn nhập ở nhập kho tổng; HTKD nhập VAT theo phiếu nhận hàng thực tế (xem `vat-store-receipt.md`). Phiếu lịch sử và API tính theo kg tiếp tục được hỗ trợ; không cho trộn hai phương pháp trong một lệnh.
- Server sinh mã `PN00001-dd/MM/yyyy` theo ngày tạo tại Việt Nam. Số thứ tự toàn hệ thống, không reset theo ngày; sequence PostgreSQL tránh trùng khi đồng thời. Rollback có thể để khoảng trống số, không tái sử dụng số đã cấp. Mã phiếu lịch sử giữ nguyên; API vẫn nhận mã tham chiếu từ client cũ để tương thích.
- Khối lượng bao chưa cân và tổng chưa đủ bằng `null`, không phải `0`. Không tính giá vốn/kg khi chưa có đủ dữ liệu. Không suy ngược kg nhập kho tổng từ kg cửa hàng khi chưa có đối chiếu nguồn bao.
- Cửa hàng khai nhận và gửi số bao thực nhận. HTKD chỉ xử lý phiếu đã gửi, đúng phạm vi cửa hàng; không được sửa số bao cửa hàng đã khai trong bước chốt.
- HTKD nhập đúng một khối lượng dương cho mỗi bao thực nhận. Ba bao 30 + 50 + 60 kg hiển thị tổng 140 kg. Nhận thiếu chỉ cân số bao thực nhận. Tổng form dùng số nguyên gram, không cộng floating point.
- Nhập dấu phẩy được chuẩn hóa thành dấu chấm khi gửi API. Hiển thị dùng dấu phẩy, tối đa ba số thập phân, không có số 0 dư (`2 kg`, `2,33 kg`, `4,778 kg`).

## Migration và triển khai

Migration 0008 cho phép cặp gross/net kg cùng null, giữ kiểm tra số dương khi có kg; thêm sequence mã phiếu và khởi tạo sau số PN lớn nhất hiện có. Chạy migration trước app mới. Không rollback app về phiên bản không hiểu null sau khi đã nhận bao chưa cân; dùng forward-fix hoặc bản tương thích null. Không khôi phục backup đè lên giao dịch mới.

Kiểm thử: contracts nhập không kg/mã phiếu và chốt đủ/thiếu kg; API nhận/replay không trùng; PostgreSQL số phiếu đồng thời, tồn kho, audit, chặn giá vốn chưa đủ kg; UI tổng 140 kg và định dạng tối đa 3 chữ số.
