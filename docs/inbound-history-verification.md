# Lịch sử nhập kho tổng — 21/09/2026

## Phạm vi và nguyên nhân

API đã trả đầy đủ `bags[].productId` và `receivedAt`, nhưng giao diện chỉ hiện tổng số bao.
Giao diện nay nhóm theo ID mặt hàng (không nhóm theo tên), dùng toàn bộ danh mục kể cả
mặt hàng ngừng hoạt động và hiển thị giờ Việt Nam. Lỗi tải tên không được biến thành
"không có hàng": vẫn hiện ID và đúng số bao. Không thêm truy vấn theo từng phiếu.

Các dấu bắt buộc của nhà cung cấp, nhóm chọn mặt hàng, số bao được chọn, cập nhật VAT
và chốt chi phí được hiển thị đỏ. VAT lúc tạo phiếu vẫn tùy chọn. Checkbox từng mặt hàng
không có `required`, vì yêu cầu là chọn ít nhất một mặt hàng, không phải chọn tất cả.

Không sửa backend, schema, tồn kho, chính sách phân bổ hay quyền. Không cần migration.
Giữ nhập kho không có ô kg; tiền VAT nhập trực tiếp, thuế suất 8%.

## Nguồn thiết kế

File Figma `mAXV3fs7qOY66vcfbPcpM4`, frame `217:1633` (Admin/07 Phiếu nhập & giá vốn)
đã đọc bằng design context. Đây là luồng nhận tại cửa hàng, không phải nhập kho tổng:
chỉ kế thừa bảng chi tiết gọn, typography/token hiện có, không sao chép số liệu minh họa
hay đưa VAT 10% từ bản mẫu vào nghiệp vụ. Không tuyên bố màn hình này khớp toàn bộ frame.

## Kiểm thử

- Web unit: 146/146 đạt; nhóm nhiều mặt hàng, trùng tên, thiếu danh mục, múi giờ và required.
- Web production build và lint toàn repo đạt.
- `npm run e2e -w @idosi/web -- inbound-history.spec.ts compact-ui.spec.ts --project=desktop-1440`:
  3/3 đạt. Kiểm tra 360, 375, 390, 412, 768, 1366, 1440 px; tên dài, hàng ngừng hoạt động,
  trạng thái trống, tăng/giảm, disabled, dấu bắt buộc; không tràn ngang.
- `LIVE_E2E_API_STORAGE=memory LIVE_E2E_ADMIN_USERNAME=admin npm run e2e:live -w @idosi/web -- inbound-count-first.spec.ts`:
  đạt với API thật và adapter kiểm thử memory, không phải bằng chứng PostgreSQL production.
  CI chạy lại workflow này với PostgreSQL thật trước khi merge.
- Đã xem ảnh 375/1440 và sửa lỗi CSS bảng toàn cục tách tên/số bao, font quá nhỏ trên mobile.

Rollback: triển khai lại image web của SHA trước đó; không có thay đổi dữ liệu cần đảo.
Toàn bộ 115 màn hình vẫn cần nghiệm thu riêng theo ma trận `figma-v1.4-ui-audit.md`.
