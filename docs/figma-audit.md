# Đối chiếu giao diện Figma

Ngày đối chiếu: 17/09/2026

Tệp thiết kế: [KHOHANG-IDOSI](https://www.figma.com/design/mAXV3fs7qOY66vcfbPcpM4)

## Phạm vi đã kiểm tra

| Nhóm     | Frame Figma               | Phạm vi triển khai                                                        |
| -------- | ------------------------- | ------------------------------------------------------------------------- |
| Admin    | `108:2`, `108:3`, `108:4` | Tổng quan, phân bổ, danh mục/quy đổi, báo cáo, tài khoản, audit, cấu hình |
| HTKD     | `112:807`                 | Tổng quan, yêu cầu, phân bổ, danh mục/quy đổi, báo cáo                    |
| Cửa hàng | `113:745`–`113:749`       | Đặt/nhận hàng, tồn kho, khui bao, bán hàng, lọc và điều chuyển            |
| Mobile   | `100:7`, `129:2`          | Điều hướng 390 px, menu cảm ứng và màn khách sỉ                           |

## Quyết định nghiệp vụ đã đồng bộ

- Quyền tài khoản chỉ gồm `ADMIN`, `HTKD`, `STORE`. “Khách sỉ” là loại cửa hàng
  `WHOLESALE`, không phải một quyền đăng nhập thứ tư.
- Cửa hàng bán lẻ có đầy đủ quy trình nhận hàng, tồn kho, khui bao, bán hàng, lọc và điều
  chuyển. Khách sỉ chỉ dùng tổng quan và đặt hàng.
- Danh mục chuẩn có đúng 25 mặt hàng. Admin và HTKD có quyền quản lý danh mục/quy đổi.
- Tỷ lệ quy đổi được lưu chính xác dưới dạng “số cái tương ứng khối lượng kg”; không lưu số
  thập phân tuần hoàn bằng số thực. Riêng `Chăn, ga, bao gối, nệm gòn` là `1 cái = 3.000 kg`.
- Thuật ngữ giao diện dùng “Mã bao”, “Khách sỉ” và “Đang bán tại CH” thống nhất với nghiệp vụ.

## Kiểm tra responsive và khả dụng

- Desktop đã kiểm tra ở `1440 × 900`; không tràn ngang, không có lỗi console hoặc lớp phủ lỗi.
- Mobile đã kiểm tra ở `390 × 844`; menu mở/đóng và chuyển route đúng, không tràn ngang.
- Các nút và liên kết hiển thị trên mobile có vùng bấm tối thiểu `44 × 44 px`.
- Bảng danh mục hiển thị đủ 25 dòng và tỷ lệ đặc biệt `1 cái = 3 kg`.

## Liên kết với mã nguồn

- Token, bố cục responsive và màn hình: `apps/web/src/styles.css`, `apps/web/src/pages`.
- Phân quyền điều hướng: `apps/web/src/components/AppShell.tsx`.
- Tỷ lệ quy đổi chính xác: `apps/web/src/lib/conversions.ts`.
- Kiểm tra trình duyệt tự động: `apps/web/e2e/smoke.spec.ts`.
