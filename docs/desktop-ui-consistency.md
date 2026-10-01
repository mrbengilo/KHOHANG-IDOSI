# Đồng bộ giao diện desktop — khoảng cách, box, chữ, ô nhập và bảng (01/10/2026)

Base: `291fc857f6950516d2f75286579c4e565a5412d6`. Nhánh: `fix/desktop-ui-consistency`.

## 1. Yêu cầu

- Box và bảng phải cùng một cỡ: không còn box to hết màn hình mà bảng bên trong lại thu nhỏ ở giữa.
- Bố cục cân đối, khoảng cách và kích thước đồng bộ như các trang quản trị lớn; dễ nhìn, dễ thao tác.
- Chữ to/nhỏ thống nhất giữa các màn.
- Không đổi dữ liệu, quyền, API, payload, bộ lọc, phân trang hay nghiệp vụ.

## 2. Nguyên nhân (đo trên 28 màn của Admin/HTKD/Cửa hàng, 1440×900)

| Triệu chứng                                              | Nguyên nhân                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Box rộng hết màn hình, bảng bên trong nhỏ và nằm giữa    | `styles.css` (PR #90) đặt mọi vùng cuộn bảng `width: fit-content; margin-inline: auto` và `table-density.css` đặt bảng `width: auto`, trong khi box chứa vẫn rộng hết vùng làm việc.                                                                          |
| Khoảng cách giữa các box lúc dính sát (0px), lúc hở 36px | Khoảng cách do từng khối tự đặt margin (0/12/14/16/18/20/24px) rải trong 10+ file. Trang dùng lưới có `gap: 18px` lại cộng thêm `margin-bottom: 18px` của tiêu đề trang (36px); trang không có lưới thì các box liền nhau (Điều chuyển, Báo cáo, Khui kiện…). |
| Chữ to nhỏ không đồng bộ                                 | 33 cỡ chữ khác nhau (8–28px và các giá trị rem lẻ), nhiều chú thích 9–10px khó đọc với font serif; nhãn ô nhập 11px.                                                                                                                                          |
| Ô nhập cùng hàng cao thấp, đậm nhạt khác nhau            | Nhiều feature đặt `font: inherit` cho ô nhập nên ô nhập ăn theo nhãn (12px, đậm 760); chiều cao 38/40/42/44/51px tùy file.                                                                                                                                    |
| Box khác kiểu nhau                                       | Bo góc 10/11/12/13/14/16/18px, padding 14/15/16/20px, có box có bóng có box không.                                                                                                                                                                            |
| Tiêu đề cột hai kiểu                                     | Bảng thường: nền tím, chữ tím 12px, viền dưới 2px; bảng quản trị: nền xám, chữ xám 11px.                                                                                                                                                                      |
| Nút thao tác trong bảng xếp chồng làm dòng cao           | Ô thao tác co theo chữ, các nút xuống dòng từng nút.                                                                                                                                                                                                          |
| Ô "Số phiếu mỗi trang" kéo dài hết màn hình              | `.button-row` không có CSS nên `select { width: 100% }` áp dụng.                                                                                                                                                                                              |
| Thanh menu bị che mục cuối ở màn cao 900px               | Mỗi mục 46px; 15 mục của Admin không vừa.                                                                                                                                                                                                                     |
| Lịch sử cấu hình tràn ngang ở 821px                      | `.settings-history-list small { flex: 0 0 auto }` không cho dòng có mã người sửa (UUID) co lại.                                                                                                                                                               |

## 3. Giải pháp

- **Thang chữ** (`:root` trong `styles.css`): `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 14, `--fs-base` 15, `--fs-lg` 17, `--fs-xl` 20, `--fs-2xl` 24px. Mọi `font-size` cố định ngoài media mobile và màn đăng nhập được quy về các bậc này (chữ nhỏ nhất 12px). Font serif theo thiết kế Figma V1.4 giữ nguyên.
- **`styles/design-system.css`** (nạp sau `styles.css`, chỉ áp dụng từ 821px, tiền tố `.app-main` để thắng CSS feature lazy-load):
  1. Nhịp dọc: `.app-main` và các vùng chứa cấp trang (`.admin-feature`, `.dashboard-page`, `.inbound-statistics`, `.inbound-results`, `.tab-panel`, `.idosi-sales-workspace`, `.settings-form`) là lưới một cột `gap: 16px`; khối con không tự đặt margin.
  2. Box: bo góc 12px, padding 16×18px, cùng bóng; box lồng (bộ lọc, trạng thái rỗng) bo 10px, không bóng.
  3. Bảng: vùng cuộn rộng bằng box chứa, có viền và bo 10px; bảng rộng 100% vùng cuộn; tiêu đề cột một kiểu (nền xám nhạt, chữ 12px in hoa); ô 14px, padding 10×12px; nút trong bảng 32px; cột số vẫn căn trái. Bảng cần rộng hơn box thì cuộn ngang cục bộ như trước.
  4. Ô nhập/nhãn/nút: ô nhập 38px, chữ 14px thường; nhãn 13px đậm; nút 38px chữ 13px.
  5. Danh sách chọn mặt hàng: lưới tự chia cột theo chiều rộng (tối thiểu 320px/cột), ô số bao nằm ngay sau tên, giữ vùng chạm 44px.
  6. Thanh menu gọn 36px/mục (đủ 15 mục ở 1440×900), phân trang trên một hàng, nút gửi không kéo giãn hết box.
- `stores.css`: nút Lọc/Xóa lọc cùng hàng với ô lọc (như màn Tài khoản); dưới 1250px vẫn xuống hàng.
- `settings.css`, `AdminSettingsPage.tsx`: box Thuế suất VAT dùng cùng kiểu tiêu đề có icon như các box cấu hình khác; dòng lịch sử co và xuống dòng khi có mã dài.
- Mobile (≤820px) giữ bố cục thẻ và vùng chạm 44px; chỉ chữ chú thích nhỏ được nâng lên tối thiểu 12px.

## 4. Kiểm thử

- `e2e/desktop-consistency.spec.ts` (mới, bộ mặc định): mọi vai trò × mọi route × 1366/1920px — khoảng cách giữa các khối đúng 16px, box cùng bo góc 12px, ô nhập cao 36–40px và cùng cỡ chữ 14px, không bảng nào hẹp hơn vùng cuộn của nó. Đã xác nhận test này thất bại trên CSS cũ.
- `e2e/table-layout-metrics.ts`: thêm quy tắc "bảng trong vùng cuộn dùng chung phải rộng bằng box" cho desktop; áp dụng cho cả `e2e-live/responsive-table-layout.spec.ts` (dữ liệu PostgreSQL thật, 12 viewport).
- `e2e/responsive-table-layout.spec.ts`, `e2e/desktop-table-density.spec.ts`: chuyển từ hợp đồng "bảng rộng theo nội dung, nằm giữa" sang "bảng rộng bằng box, cuộn cục bộ khi thiếu chỗ".

## 5. Ảnh trước/sau

| Màn                    | Trước                                                                        | Sau                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Cửa hàng & nhóm 1440   | ![](evidence/desktop-ui-consistency/before-admin_stores-1440.png)            | ![](evidence/desktop-ui-consistency/after-admin_stores-1440.png)            |
| Cửa hàng & nhóm 1920   | ![](evidence/desktop-ui-consistency/before-admin_stores-1920.png)            | ![](evidence/desktop-ui-consistency/after-admin_stores-1920.png)            |
| Tồn kho 1440           | ![](evidence/desktop-ui-consistency/before-admin_inventory-1440.png)         | ![](evidence/desktop-ui-consistency/after-admin_inventory-1440.png)         |
| Tồn kho 1920           | ![](evidence/desktop-ui-consistency/before-admin_inventory-1920.png)         | ![](evidence/desktop-ui-consistency/after-admin_inventory-1920.png)         |
| Nhập kho tổng 1440     | ![](evidence/desktop-ui-consistency/before-admin_warehouse-inbound-1440.png) | ![](evidence/desktop-ui-consistency/after-admin_warehouse-inbound-1440.png) |
| Danh mục 1440          | ![](evidence/desktop-ui-consistency/before-admin_catalog-1440.png)           | ![](evidence/desktop-ui-consistency/after-admin_catalog-1440.png)           |
| Cấu hình 1440          | ![](evidence/desktop-ui-consistency/before-admin_settings-1440.png)          | ![](evidence/desktop-ui-consistency/after-admin_settings-1440.png)          |
| Tài khoản 1440         | ![](evidence/desktop-ui-consistency/before-admin_users-1440.png)             | ![](evidence/desktop-ui-consistency/after-admin_users-1440.png)             |
| Nhận hàng (HTKD) 1440  | ![](evidence/desktop-ui-consistency/before-htkd_receive-1440.png)            | ![](evidence/desktop-ui-consistency/after-htkd_receive-1440.png)            |
| Đặt hàng (cửa hàng)    | ![](evidence/desktop-ui-consistency/before-ds_nvt_requests-1440.png)         | ![](evidence/desktop-ui-consistency/after-ds_nvt_requests-1440.png)         |
| Cửa hàng & nhóm mobile | ![](evidence/desktop-ui-consistency/before-admin_stores-390.png)             | ![](evidence/desktop-ui-consistency/after-admin_stores-390.png)             |
| Tồn kho mobile         | ![](evidence/desktop-ui-consistency/before-admin_inventory-390.png)          | ![](evidence/desktop-ui-consistency/after-admin_inventory-390.png)          |

Ảnh chụp bằng API bộ nhớ (`API_STORAGE=memory`) với cùng dữ liệu mẫu cho cả hai phiên bản.

## 6. Rollback

Revert squash commit qua PR; không có migration hay thay đổi dữ liệu.
