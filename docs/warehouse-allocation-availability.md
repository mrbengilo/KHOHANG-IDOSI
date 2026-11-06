# Tồn sổ kho và số có thể phân bổ

Mặt hàng Reshare có thể còn số dư `H − R` trên sổ nhưng không được cấp mới khi nguồn
ở trạng thái `pending_baseline`, `needs_reconciliation`, thiếu nguồn, sự kiện chưa rõ
coverage hoặc có lỗi liên kết cam kết. Nhận dư/nhận nhầm có thể đưa nguồn vào trạng thái
cần đối chiếu. Đây là chốt bảo vệ chống cấp vượt nguồn, không được tự bỏ qua.

Trước đây bảng kho tổng và đặt hàng chỉ đọc `H − R`, trong khi worker còn áp trần
`loadSupplierAllocationCaps`. Vì vậy bảng ghi 28 bao có thể cấp nhưng worker thực tế
chỉ được cấp 0; đơn mới tiếp tục được nhận rồi chuyển chờ.

Từ projection `allocatable-stock-v3`:

- `availableBags` giữ nghĩa số dư chưa giữ trên sổ: `H − R`.
- `allocatableBags` là `max(0, min(H − R, trần nguồn))`; mặt hàng không đối chiếu nguồn
  giữ quy tắc `H − R`.
- `allocationBlockedReason` nêu lý do nguồn chưa cho cấp mới. Bảng kho hiển thị số có
  thể phân bổ, tồn thực riêng và cảnh báo chặn cho mọi vai trò được đọc kho tổng.
- Màn đặt thường và kiểm tra trong transaction gửi đơn dùng cùng giới hạn nguồn.
  Gửi đơn không giữ hàng. Các đơn đã gửi và phiếu chờ cũ không bị sửa.
- Tab cũ dùng projection v2 nhận 409 kèm hướng dẫn tải lại; không trả thêm trường cho
  bundle cũ có schema strict. Không đổi bảng dữ liệu hoặc migration.

Khi cửa hàng gửi phiếu **nhận dư, nhận thiếu hoặc nhận sai mặt hàng**, các SKU Reshare
liên quan chuyển sang cần đối chiếu trong cùng transaction. Sai mặt hàng đánh dấu cả
mặt hàng bị thiếu theo phiếu và mặt hàng nhận dư thực tế. Chốt phiếu vẫn bảo vệ trường
hợp legacy chưa được đánh dấu; quy tắc xuất/nhập, kiểm thiếu và tạo nhu cầu chờ không đổi.
Audit gửi phiếu ghi các SKU đã đánh dấu theo đúng version phiếu. Chốt chính phiên bản
đó không đánh dấu lại nếu người quản lý đã đối chiếu trong thời gian chờ HTKD chốt;
phiếu legacy không có bằng chứng này vẫn được kiểm tra/đánh dấu lúc chốt. Bằng chứng
ghi nhận hàng dư cho trigger finalization luôn được giữ dù nguồn đã được đối chiếu.

Admin/HTKD đang mở hệ thống nhận hộp cảnh báo lớn ở giữa màn hình trong vòng khoảng
5 giây, hoặc khi quay lại tab. Endpoint chú ý chỉ đọc mapping, tên sản phẩm và revision
(hai truy vấn, tối đa 50 dòng và tổng số), không tính lại toàn bộ cam kết mỗi lần poll.
Cửa hàng/quầy sỉ bị từ chối tại server. Bấm tên mặt hàng mở biểu mẫu bằng ID mặt hàng,
không suy ra đối tượng từ tên. **Tắt thông báo** chỉ ghi nhớ revision đã xem theo tài
khoản/vai trò trong tab; không bỏ chặn nguồn. Sai lệch mới tăng revision và hiện lại.
Mở biểu mẫu chưa tắt cảnh báo: khi đang đối chiếu, các SKU chưa được tắt còn được nhắc
riêng và có nút tắt; ra khỏi màn đối chiếu vẫn hiện lại. Hủy chuyển mặt hàng để giữ bản
nháp không đánh dấu cảnh báo đã tắt. Phần vượt giới hạn 50 dòng
không bị coi là đã xem và có nút mở đầy đủ. Mặt hàng chưa có baseline mà đã phát sinh
sai lệch cũng nằm trong hàng đợi (guard tăng revision nhưng giữ `pending_baseline`).
Cấu hình nguồn mới ở revision 1 không bị coi là một sai lệch nhận hàng.
Các tham số mở biểu mẫu được xóa sau khi nhận, không tự mở lại khi chuyển tab rồi quay lại.
Cảnh báo mới cũng hiện khi đang ở màn đối chiếu; tắt cảnh báo không làm mất số đang
nhập trong biểu mẫu. Đối chiếu xong làm mất mặt hàng khỏi hàng đợi chú ý. Lỗi tải không
được hiểu là nguồn đã mở lại.

Khôi phục vận hành: kiểm tra tổng Reshare hiện cho đặt, mở **Cập nhật tồn Reshare**,
xem trước và xác nhận đúng các RE đã được trừ trong tổng vừa kiểm tra. Chỉ đối chiếu
mới được mở lại nguồn. Không suy ra tổng Reshare từ số dư IDOSI, không tự đánh dấu RE
đã trừ và không sửa trạng thái nguồn trực tiếp trong SQL.

Phiên đã hoàn tất giữ nguyên lịch sử. Phiếu chờ còn sống tiếp tục theo luồng ưu tiên
ở phiên hợp lệ tiếp theo; không chạy lại phiên cũ, tạo đơn thường trùng hoặc tự trả lời
ưu tiên thay cửa hàng.

Rollback: đưa API và web về cùng bản trước. Worker và các chốt nguồn không đổi; việc
rollback chỉ phục hồi cách hiển thị/gate cũ, không hoàn lại quan sát nguồn đã xác nhận.

Kiểm chứng hồi quy: API phân biệt 28 bao trên sổ và 0 có thể cấp cho Admin/HTKD/STORE,
đối chiếu mới mở lại 28; worker chặn rồi cấp đúng sau đối chiếu; gửi đơn bị chặn không
ghi phiếu; giao diện cảnh báo và số tồn hoạt động ở 360/390/768/1366/1440 px.
