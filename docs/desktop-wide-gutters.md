# Desktop: lề rộng gấp 3 và thanh cuộn danh mục mảnh

Phạm vi: chỉ CSS giao diện web (`apps/web/src/styles.css`) và hợp đồng kiểm thử bố cục. Không đổi
API, quyền, dữ liệu, tính toán kho, migration hay deploy. Áp dụng chung cho mọi vai trò vì cả
hệ thống dùng một khung `.app-main` và một sidebar.

## Yêu cầu → kết quả

| #   | Yêu cầu                                       | Trước                                                   | Sau                                                                                       |
| --- | --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Lề trái/phải vùng làm việc gấp 3 lần hiện tại | 54px mỗi bên từ 1280px                                  | 162px mỗi bên từ ~1600px (1920, 2560…); 1440px: 83px; laptop ≤1366px giữ vùng làm việc cũ |
| 2   | Thanh cuộn danh mục chính mảnh lại            | thanh cuộn cổ điển 15–17px có nút mũi tên (Chrome/Edge) | 6px, bo tròn, không nút mũi tên; Firefox `scrollbar-width: thin`                          |
| 3   | Hộp danh mục chính lớn hơn một chút           | sidebar 224px, nhãn dài xuống 2 dòng                    | sidebar 240px; "Phiếu nhập & giá vốn", "Thống kê nhập hàng" nằm một dòng                  |

## Thiết kế lề

`--content-gutter = max(laptop, wide)`:

- `wide = min((100vw − sidebar − 1034px) / 2, 162px)`: phần dư ngoài vùng làm việc 1034px (bằng
  vùng làm việc cũ ở 1366px) dồn vào lề, tối đa 162px = 3 × 54px.
- `laptop = clamp(18px, 10px + (100vw − 821px) × 0.0785, 46px)`: lề cũ trừ 8px (nửa phần sidebar
  rộng thêm) để vùng làm việc laptop không bị hẹp đi.

Phương án đã loại: lề 162px cố định từ 1280px hoặc tăng tuyến tính tới 1600px — ở 1366/1440px vùng
làm việc còn 716–935px, tên mặt hàng dài trong bảng tồn kho xuống dòng (hàng cao 83–105px thay vì
61px, vi phạm hợp đồng `desktop-table-density.spec.ts`).

| Viewport | Lề mỗi bên trước → sau | Vùng làm việc trước → sau |
| -------- | ---------------------- | ------------------------- |
| 1280     | 54 → 46px              | 948 → 948px               |
| 1366     | 54 → 46px              | 1034 → 1034px             |
| 1440     | 54 → 83px              | 1108 → 1034px             |
| 1920     | 54 → 162px             | 1588 → 1356px             |
| 2560     | 54 → 162px             | 2228 → 1996px             |
| ≤820     | 16/18px (mobile)       | không đổi                 |

## Thanh cuộn

Chromium/Safari dùng `::-webkit-scrollbar` (6px). Không đặt `scrollbar-width` cho Chromium vì từ
Chrome 121 thuộc tính chuẩn vô hiệu hóa `::-webkit-scrollbar`; Firefox nhận `scrollbar-width: thin`
qua `@supports not selector(::-webkit-scrollbar)`. Áp dụng cho `.sidebar__nav` và `.sidebar` (cuộn
cả sidebar khi màn rất thấp/zoom lớn).

## Bằng chứng

Ảnh chụp có thanh cuộn thật (bỏ cờ `--hide-scrollbars` của Playwright), cùng fixture `/inventory`:

| Viewport | Trước                                                             | Sau                                                            |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| 1920     | ![Trước](evidence/desktop-wide-gutters/before-inventory-1920.png) | ![Sau](evidence/desktop-wide-gutters/after-inventory-1920.png) |
| 1366     | ![Trước](evidence/desktop-wide-gutters/before-inventory-1366.png) | ![Sau](evidence/desktop-wide-gutters/after-inventory-1366.png) |

Kiểm thử: `desktop-gutter.ts` là nguồn duy nhất của công thức lề cho `desktop-layout`,
`desktop-login-shell` và `desktop-visual-colors` (ma trận mọi route × ADMIN/HTKD/cửa hàng
lẻ/quầy sỉ ở 1366/1440/1920/2560px). Test mới trong `desktop-login-shell.spec.ts` bật thanh cuộn
thật và khẳng định thanh cuộn danh mục ≤ 6px, sidebar 240px.

Rollback: revert commit; không có migration hay dữ liệu cần hoàn tác.
