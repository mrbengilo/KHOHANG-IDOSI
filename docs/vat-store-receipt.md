# VAT tự tính trên phiếu nhận hàng cửa hàng

## Cấu hình và độ chính xác

Admin sửa Thuế suất VAT trong Cấu hình vận hành. Dùng bảng phiên bản hiện có
`operational_settings_versions`, mặc định 8%, hỗ trợ số nguyên 0–100% (độ chính xác
1 điểm phần trăm). Từ chối phần thập phân, NaN, Infinity, số âm và trên 100.
Mỗi thay đổi tạo phiên bản bất biến dưới khóa `operational-settings:current`, kiểm tra
`expectedVersion`, audit lưu trước/sau, người sửa, thời điểm và request id. Quyền sửa
được kiểm tra server-side; HTKD/cửa hàng chỉ đọc thuế suất theo quyền đọc phiếu.

## Công thức dùng chung

`calculateReceiptVat` trong domain được server và preview UI dùng chung, tính bằng bigint:

```text
goods = tổng roundHalfUp(grams × pricePerKgVnd / 1000) của từng bao
taxable = goods + freight + handling
vat = (taxable × ratePercent + 50) / 100   // chia nguyên, làm tròn nửa lên
totalCostVnd = taxable
totalAmountVnd = taxable + vat
```

VAT làm tròn một lần trên cả cơ sở, không tính từng bao rồi cộng. Các thành phần hiệu lực
không âm. Giới hạn serialize tiền là số nguyên an toàn 9.007.199.254.740.991 VND, kể cả tổng.

Ví dụ 5.000.000 hàng + 200.000 vận chuyển + 100.000 bốc xếp: VAT 8% là 424.000,
tổng 5.724.000. KEEP giảm 500.000: VAT 384.000, tổng 5.184.000. RETURN độc lập bao
1.000.000: VAT 344.000, tổng 4.644.000. Trả hết hàng còn phí vẫn tính VAT trên phí.

## Finalize và preview cũ

`GET /api/v1/store-receipts/:receiptId/vat-configuration` trả `{ratePercent, version}`,
kiểm tra quyền đọc chính phiếu và không cache. Form không có ô nhập tiền VAT.
`POST /api/v1/store-receipts/:receiptId/finalize` nhận `expectedVatSettingsVersion`,
không nhận `vat`. Trong transaction, server kiểm tra version dưới cùng khóa với sửa
cấu hình, tính lại chi phí, lưu VAT và snapshot `vat_rate_percent`, `vat_settings_version`.
Retry cùng idempotency key trả lại kết quả cũ. Audit truy được cấu hình đã dùng.

Form đọc lại cấu hình trước khi chốt. Nếu version đổi, hiện preview mới và yêu cầu bấm
chốt lại. Thay đổi sau lần đọc này bị server chặn bằng 409, rollback toàn bộ. Không âm thầm
lưu tổng tiền khác preview. Tab cũ gửi `vat` hoặc thiếu version bị 400, cần tải lại trang.
Admin đổi cấu hình không sửa thuế suất hoặc tiền của phiếu đã chốt.

## KEEP, RETURN và legacy

VERIFY dùng transaction và khóa cấp phiếu hiện có. Kiểm tra role, tài khoản active,
phân công HTKD, expectedVersion, idempotency, hold và các giao dịch phụ thuộc của bao.

- KEEP cần kg và giá/kg; goods delta = giá trị mới − giá trị hiệu lực đã lưu.
- RETURN không cần giá. Giá client gửi không chi phối khoản giảm trừ hoặc giá vốn hàng
  hoàn; server dùng giá trị hiệu lực đã lưu, bảo toàn giá vốn và SKU thực tế trên phiếu trả.
  Disposition client gửi phải khớp hồ sơ đã lưu, không thể giả RETURN để bỏ giá của KEEP.
- Tái sử dụng tự hoàn tất trả kho tại VERIFY của migration 0031. Khoản phân loại và nhập
  trả vẫn có ledger riêng; trừ giá trị hàng trả đúng một lần. Sửa giao nhầm trước nhập trả,
  không dùng hàng vừa trả để che thiếu tồn. Không thêm bước Admin duyệt.
- Phí không có delta được giữ nguyên; delta phí có ghi chú xác minh và audit.
- VAT sau điều chỉnh tính từ toàn bộ hàng/phí hiệu lực còn lại, bằng snapshot của phiếu.
  `vatDelta = vatAfter - vatBefore`, không dùng round(goodsDelta × rate).
- APPLY legacy được xác minh lại trong transaction. Lỗi rollback trạng thái, tiền, tồn,
  ledger, hold, quyền chờ bù và audit. Phiếu trả legacy vẫn theo luồng lịch sử, không tự
  hoàn tất hàng loạt.

Phiếu gốc bất biến. Không backfill VAT hoặc snapshot theo cấu hình mới. Phiếu VAT thủ công
có thuế suất được tính VAT hiệu lực khi duyệt điều chỉnh mới, giữ số gốc và ghi delta.
Ví dụ VAT gốc 500.000, cơ sở mới 4.800.000, thuế suất 8%: VAT mới 384.000, delta −116.000.
Phiếu chưa ghi nhận VAT giữ NULL / “Chưa ghi nhận”, không gán 0 hoặc 8%. Audit ghi vatStatus,
thuế suất và version nullable cho legacy.

## Báo cáo

`totals` giữ chứng từ gốc. `adjustments` ghi chênh lệch theo ngày hiệu lực, gồm hàng trả
trong goods/cost/total delta. Giá trị hàng trả riêng dùng đối soát, không trừ thêm lần nữa.
Giá vốn sau điều chỉnh và VAT sau điều chỉnh tách riêng; thiếu VAT báo `VAT_NOT_CAPTURED`.
Điều chỉnh phiếu tháng trước thuộc kỳ áp dụng, vì vậy giá trị thuần của kỳ có thể âm;
đây không phải ảnh chụp lại tất cả phiếu được tạo trong kỳ.

Nhập kho tổng tiếp tục không nhận VAT mới. Giữ nguyên VAT legacy và constraint riêng của
kho tổng, không đưa thuế trở lại luồng này.

## Migration và rollback

Migration `0034_configurable_receipt_vat` thêm thuế suất cấu hình default 8, version snapshot
nullable trên phiếu, FK tới phiên bản cấu hình và nới constraint VAT cửa hàng. Seed không
reset cấu hình Admin. Snapshot Drizzle 0034 bao gồm thay đổi schema 0031. Không sửa migration
đã áp dụng hoặc cập nhật hàng loạt chứng từ.

Schema mới cho phép app cũ chạy trong giai đoạn chuyển phiên bản trước khi ghi dữ liệu mới.
Sau khi có thuế suất khác 8% hoặc điều chỉnh theo chính sách mới, ưu tiên forward-fix:
app cũ gán cứng 8%, nhận VAT từ client và không tính lại VAT. Rollback image đơn thuần có
thể đọc/ghi sai. Giữ backup trước deploy; không xóa cột, đảo ledger hay restore đè dữ liệu.
Nếu cần rollback, phải dùng app tương thích snapshot/công thức mới và đối soát chứng từ đã
phát sinh. Watcher triển khai merged SHA có CI xanh; xác minh running SHA, health/readiness,
log và đối soát theo runbook.
