# VAT nhập theo phiếu nhận hàng thực tế — 24/09/2026

## Thay đổi nghiệp vụ

- **Cũ:** Admin nhập VAT (8%) khi tạo phiếu nhập kho tổng hoặc sửa ở lịch sử phiếu
  (`PATCH /api/v1/inbound-receipts/{id}/vat`). Tổng chi phí phiếu nhập kho tổng chờ VAT
  (`totalCostVnd = null`, "Chờ nhập VAT") và báo cáo tháng phạm vi toàn hệ thống không tính
  được tổng giá vốn nhập khi thiếu VAT.
- **Mới:** HTKD nhập VAT ở bước "Chốt giá & nhập kho" của phiếu nhận hàng cửa hàng, cùng với
  kg từng bao, giá/kg, phí vận chuyển và phí bốc xếp, theo phiếu nhận hàng thực tế. Ô VAT bắt
  buộc (nhập 0 nếu phiếu không có VAT), thuế suất 8%, lưu nguyên số tiền đã nhập.
- Nhập kho tổng không còn mục VAT: API tạo phiếu từ chối trường `vat`, endpoint sửa VAT đã
  gỡ (404). Tổng chi phí phiếu nhập kho tổng = tiền hàng + vận chuyển + bốc vác, biết ngay khi
  chốt chi phí.

## Lưu trữ và giá vốn

- Migration `0025_store_receipt_vat` thêm `store_receipts.vat_amount_vnd` (bigint) và
  `vat_rate_percent` (integer), cùng ràng buộc `store_receipts_vat_valid` giống `receipts`.
  Chỉ thêm cột nullable; không backfill.
- VAT là VAT đầu vào khấu trừ, **không** cộng vào `total_cost_vnd` (giá vốn = hàng + vận
  chuyển + bốc xếp, ràng buộc `store_receipts_total_cost_consistent` giữ nguyên). Audit
  `STORE_RECEIPT_FINALIZED` ghi `vatAmountVnd` và `vatRatePercent`.
- **Tổng tiền phiếu** (`totalAmountVnd` trong API, ghi trong audit) = giá vốn + VAT, tức tiền
  hàng + vận chuyển + bốc xếp + VAT. Ví dụ: tiền hàng 5.000.000 + vận chuyển 200.000 + bốc vác
  100.000 = giá vốn 5.300.000; VAT 500.000 → tổng tiền phiếu 5.800.000. Giá trị được tính từ
  cột đã lưu nên không cần migration; phiếu cũ chưa có VAT thì tổng tiền phiếu là null.
- Form HTKD có bảng tạm tính theo đúng cách làm tròn của máy chủ (mỗi bao làm tròn nửa lên);
  máy chủ vẫn tính lại khi chốt.
- Phiếu gửi lại sau khi bị trả về reset VAT về null cùng các chi phí khác.

## Dữ liệu cũ

- Phiếu nhận hàng đã chốt trước thay đổi: VAT = null, hiển thị "Chưa ghi nhận".
- Phiếu nhập kho tổng đã có VAT: giữ nguyên số liệu, dòng `receipt_costs` loại `vat` và tổng
  chi phí đã ghi; lịch sử hiển thị "VAT ghi nhận trước đây". Phiếu cũ chưa chốt mà có VAT vẫn
  cộng VAT đó vào tổng khi chốt.
- Phiếu nhập kho tổng cũ chưa có VAT: tổng chi phí nay hiển thị số đã biết thay cho
  "Chờ nhập VAT".

## Báo cáo tháng

- `vatCostVnd` lấy từ phiếu nhận hàng cửa hàng đã chốt trong kỳ và phạm vi (kể cả phạm vi
  toàn hệ thống). Có phiếu chốt trước thay đổi (VAT null) thì báo `VAT_NOT_CAPTURED`.
- `landedInboundCostVnd` = tổng các chi phí đã ghi của chứng từ nguồn, không còn bị chặn bởi
  VAT kho tổng. Với kho tổng, VAT cũ đã nằm trong tổng phiếu vẫn được giữ nên số tháng cũ
  không đổi; với phiếu cửa hàng, VAT không nằm trong giá vốn. VAT kho tổng cũ không cộng vào
  `vatCostVnd` để tránh tính trùng với VAT HTKD nhập cho cùng lô hàng.

## Triển khai và rollback

Chạy migration trước app mới (cột nullable, tương thích app cũ). Rollback app: triển khai lại
image SHA trước; cột mới được app cũ bỏ qua, không mất dữ liệu. Không xóa cột khi rollback;
nếu cần sửa tiếp thì forward-fix. Client cũ còn mở tab sẽ bị từ chối khi gửi `vat` ở nhập kho
tổng hoặc chốt phiếu nhận hàng thiếu `vat`; tải lại trang để dùng bản mới.
