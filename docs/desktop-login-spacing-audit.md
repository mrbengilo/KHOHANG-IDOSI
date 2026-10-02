# Desktop login, workspace gutters and navigation readability

Base: `ed206dbbf128770b52ca613510630c1762efcc97` (main khi bắt đầu, 02/10/2026). Nhánh:
`fix/desktop-login-spacing-typography`. Phạm vi: chỉ giao diện web — không đổi API, quyền, dữ liệu,
tính toán kho, migration hay hạ tầng deploy. Font toàn ứng dụng giữ Times New Roman/serif.

## Yêu cầu → kết quả

| #   | Yêu cầu                                 | Trước (đo)                                                                    | Sau (đo)                                                                            |
| --- | --------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Slogan lớn hơn, căn giữa, nền mềm       | 43.7px @1366 / 46px @≥1440, căn trái, chữ trắng 78% alpha, line-height 1.7    | 54.6 / 57.6 / 64px (+25%), căn giữa cả hai chiều (lệch 0px), chữ trắng đặc, lh 1.18 |
| 2   | Cụm đăng nhập căn giữa, lớn hơn, chữ rõ | form 460px; h1 32px; label 11px; input 15px/46px; nút 15px/50px; ghi chú 11px | form 560px; h1 35.5–40px; label 16px; input 17px/54px; nút 17px/56px; ghi chú 14px  |
| 3   | Lề vùng nội dung desktop × 3            | 18px mỗi bên ở mọi độ rộng desktop                                            | 54px mỗi bên từ 1280px; 821–1279px tăng tuyến tính 18 → 54px                        |
| 4   | Tên danh mục chính lớn hơn              | tiêu đề trang 26px; nhóm menu 11px; mục menu 13px                             | tiêu đề trang 30.7px @1366, 32px @≥1440; nhóm 14px; mục 15px                        |
| 5   | Nút Đăng xuất lớn, dễ bấm               | chữ 11px, cao 17px, icon 16px, không nền                                      | chữ 16px, cao 44px, icon 20px, nền đỏ nhạt + viền, rộng hết thẻ                     |

Số đo lấy bằng Playwright (Chromium headless, DPR 1, 100%) trên cùng fixture `layout-fixtures.ts`,
route `/login` và `/inventory`, trước/sau cùng viewport. Ảnh/JSON gốc do spec
`apps/web/e2e/desktop-login-shell.spec.ts` ghi vào `test-results/production/**` và được CI tải lên
artifact `browser-evidence`.

## Bằng chứng nguyên nhân (đã tái hiện bằng trình duyệt)

- **Biểu mẫu thực ra đã căn giữa** trong cột phải (lệch 0px cả hai chiều ở 1366–2560px). Cảm giác
  "lệch, nhỏ" đến từ form 460px với chữ 11px giữa cột rộng 647–1212px — cần tăng kích thước thật,
  không cần đổi cơ chế căn.
- **Slogan nhạt và giãn dòng**: `.login-visual p` (độ ưu tiên 0,1,1) thắng `.login-visual__title`
  (0,1,0) nên tiêu đề nhận màu trắng 78% và line-height 1.7 (74px cho chữ 44px). Ở 621–900px cùng
  lỗi làm slogan chỉ còn 13px thay vì 22px. Sửa bằng class `.login-visual__lead` cho đoạn mô tả.
- **Dòng "QUẢN LÝ & PHÂN BỔ…" và nhãn "Chào mừng trở lại"**: `.login-panel p` (11px) thắng
  `.login-slogan`; selector `form > div:first-child span` không bao giờ khớp vì phần tử đầu là ảnh
  logo. Thay bằng class `.login-panel__intro`/`.login-panel__eyebrow`.
- **Lề 18px** là token `--content-pad` từ PR fluid layout; nút đăng xuất 11px/padding 0 nằm trong
  selector chung `.sidebar__profile button`.

## Thiết kế đã chọn

- `--content-gutter = clamp(18px, 18px + (100vw − 821px) × 0.0785, 54px)`; `.app-main` dùng nó cho
  padding trái/phải. Một token duy nhất, không cộng margin ở tầng khác. `--content-pad` (18px) giữ
  nguyên cho mobile — rule full-bleed `.page-header` ≤820px vẫn tham chiếu đúng nó.
  - Lý do vùng chuyển 821–1279px: tại 1024px lề 54px sẽ lấy thêm 72px của vùng chỉ còn 800px; lề
    tăng dần (34px @1024, 40px @1100) giữ bảng và lưới hai cột không bị bóp.
  - Đo theo `100vw` nên trình duyệt có thanh cuộn cổ điển vẫn đạt 54px tại cửa sổ 1280px.
- Đăng nhập ≥901px: `.login-visual` thành lưới `1fr auto 1fr` (logo trên, slogan giữa, chân trang
  dưới) để slogan nằm đúng tâm cột; `grid-template-columns: minmax(0, 1fr)` và
  `justify-content: normal` (bỏ space-between của bố cục flex gốc — trước khi bỏ, slogan lệch 6.4px
  ở 2560px). Biểu mẫu/kiểu chữ áp dụng từ 621px; điện thoại ≤620px giữ nguyên.
- Nền: dải `#4338ca → #4f46e5 → #4256e6 → #2f5fe0` (160°) + hai quầng radial mờ; điểm sáng nhất
  vẫn ≥ 4.5:1 với chữ trắng.
- Sidebar giữ 224px; nhãn dài xuống dòng (line-height 1.3). Sidebar `overflow-y: auto` và nav
  `min-height: 132px` để ở màn rất thấp/zoom lớn vẫn cuộn tới mục cuối và nút Đăng xuất.
- Nút Đăng xuất có class riêng `.sidebar__logout` (không phóng mọi button trong thẻ tài khoản);
  rộng 100% thẻ nên "Đang đăng xuất…" không làm giật kích thước. Nút đăng xuất ở màn
  `AccessLoadError` (`.button--secondary`) không đổi.

## File thay đổi

| File                                             | Thay đổi                                                                                                           | Kiểm chứng                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `apps/web/src/styles.css`                        | token gutter; slogan/nền/form đăng nhập; typography tiêu đề/menu/thẻ tài khoản; nút đăng xuất                      | các spec bên dưới                         |
| `apps/web/src/pages/LoginPage.tsx`               | wrapper/class `login-visual__content`, `__lead`, `login-panel__intro`, `__eyebrow`, `__note`; không đổi logic auth | `desktop-login-shell`, `login-layout`     |
| `apps/web/src/components/AppShell.tsx`           | class `sidebar__profile-name/-scope`, `sidebar__logout`; icon 20px; không đổi signOut/quyền                        | `desktop-login-shell`, `AppShell.test.ts` |
| `apps/web/e2e/desktop-login-shell.spec.ts` (mới) | đăng nhập desktop, tương phản, trạng thái form, lề, typography, đăng xuất (bundle production)                      | —                                         |
| `apps/web/e2e/desktop-gutter.ts` (mới)           | công thức lề kỳ vọng dùng chung                                                                                    | —                                         |
| `apps/web/e2e/desktop-layout.spec.ts`            | thay khoảng 16–24px bằng công thức lề; thêm 1279/1280/1281/1100px; kiểm tra bề rộng panel                          | —                                         |
| `apps/web/e2e/desktop-visual-colors.spec.ts`     | ma trận vai trò × route kiểm tra lề, cỡ tiêu đề, cỡ menu, chiều cao nút đăng xuất                                  | —                                         |
| `apps/web/e2e/layout-fixtures.ts`                | tách `layoutAdminSession()`, cho phép tên hiển thị dài                                                             | —                                         |
| `apps/web/playwright*.config.ts`                 | spec mới chỉ chạy trong cấu hình production (cần API client thật, không mock fallback)                             | `--list`: 12 test được phát hiện          |

Đã rà soát, không cần sửa: `PageHeader.tsx`, `Button.tsx`, `PasswordInput.tsx`, `main.tsx` (thứ tự
CSS), `router.tsx`/`access.ts`, các CSS feature (`table-density`, `document-history`,
`warehouse-*`, `inventory-*`, `dashboard`, `catalog`, `admin/*`, `transfers`, `inbound-statistics`)
— không có margin âm/độ rộng phụ thuộc `--content-pad`; các bảng/zoom/density đều xanh với vùng
làm việc hẹp hơn. CI workflow không cần sửa.

## Số đo lề (sau)

| Viewport  | Lề trái / phải | Bề rộng panel full-width |
| --------- | -------------- | ------------------------ |
| 2560×1200 | 54 / 54        | 2228                     |
| 1920×1080 | 54 / 54        | 1588                     |
| 1440×900  | 54 / 54        | 1108                     |
| 1366×768  | 54 / 54        | 1034                     |
| 1280×800  | 54 / 54        | 948                      |
| 1279×800  | 53.9 / 53.9    | 947.1                    |
| 1100×800  | 39.9 / 39.9    | 796.2                    |
| 1024×768  | 33.9 / 33.9    | 732.2                    |
| 821×900   | 18 / 18        | 561                      |
| ≤820      | 18 (16 ≤620)   | không đổi                |

Tương phản nền đăng nhập (pixel tối/sáng nhất sau composite, chữ ẩn khi chụp): slogan 5.72–5.89:1,
mô tả 4.82–5.15:1 trên 8 viewport 901–2560px.

## Ma trận kiểm thử

| Nhóm                                                                | Viewport / zoom                                                                                           | Vai trò                                                  | Nguồn                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Đăng nhập desktop: căn giữa, cỡ chữ, tương phản                     | 2560×1440, 2560×1200, 1920×1080, 1440×900, 1366×768, 1100×800, 1024×768, 901×900; 1366×540 thấp           | chưa đăng nhập                                           | `desktop-login-shell` (production)                                                                           |
| Trạng thái đăng nhập                                                | 1440×900: Tab order, hiện/ẩn mật khẩu, username trắng, lỗi server dài, pending/chống gửi lặp, return path | chưa đăng nhập → ADMIN fixture                           | `desktop-login-shell`                                                                                        |
| Đăng nhập mobile/tablet                                             | 375×667, 768×900, 1440×900 (hồi quy cũ); 360/390/768 đo trước-sau giống hệt ở ≤620px                      | —                                                        | `login-layout` (smoke)                                                                                       |
| Lề + typography + nút đăng xuất                                     | 2560…821px (10 mốc)                                                                                       | ADMIN fixture                                            | `desktop-login-shell`                                                                                        |
| Đăng xuất: focus bàn phím, busy, lỗi 503, thành công + route bảo vệ | 1440×900, tên tài khoản dài                                                                               | ADMIN fixture                                            | `desktop-login-shell`                                                                                        |
| Sidebar thấp / mobile drawer                                        | 1366×520, 1280×400; 390×844, 360×640                                                                      | ADMIN fixture                                            | `desktop-login-shell`                                                                                        |
| Ma trận route                                                       | 1366, 1440, 1920, 2560                                                                                    | ADMIN, HTKD, STORE_RETAIL, STORE_WHOLESALE (chế độ demo) | `desktop-visual-colors` (smoke)                                                                              |
| Workspace/bảng/zoom                                                 | 360–2560px; zoom thật 100/125/150% (chrome.tabs.setZoom)                                                  | theo spec hiện có                                        | `desktop-layout`, `workspace-responsive`, `desktop-table-density`, `responsive-table-layout`, `desktop-zoom` |
| Phiên thật                                                          | 1440×900, đăng nhập/đăng xuất qua API + PostgreSQL                                                        | ADMIN bootstrap                                          | `e2e-live` (25 test)                                                                                         |

Giới hạn: vai trò trong ma trận smoke dùng chế độ demo (localStorage) — là bằng chứng bố cục, không
phải phân quyền server. Zoom thật chỉ phủ `/inventory` và `/warehouse-inbound`. Chromium cục bộ là
bản 140 (Playwright 1.63 mong đợi 153; môi trường không tải được bản mới) — CI dùng đúng bản.

## Lệnh đã chạy (cục bộ, Linux, Node 24.21.0, PostgreSQL 16 cục bộ)

| Lệnh                                                           | Kết quả                   |
| -------------------------------------------------------------- | ------------------------- |
| `npm run format:check` / `npm run lint` / `npm run typecheck`  | PASS                      |
| `npm run build`                                                | PASS                      |
| `run-migrations.mjs` ×2, `seed:production` ×2, bootstrap admin | PASS (không có migration) |
| `npm run test` (`RUN_POSTGRES_TESTS=1`)                        | PASS (tất cả workspace)   |
| `npm run e2e`                                                  | PASS 43, skip 11          |
| `npm run e2e:production -w @idosi/web`                         | PASS 44, skip 8           |
| `npm run e2e:live`                                             | PASS 25                   |
| `git diff --check`                                             | sạch                      |

Kết quả CI GitHub (Node 24 / PostgreSQL 17), merge SHA và trạng thái deploy ghi trong PR.

## Deploy và rollback

Không có migration. Watcher `khohang-autodeploy` deploy merge SHA sau khi check CI xanh (backup có
checksum, build ảnh, health/ready/openapi). Trước release: `running=ed206dbbf128770b52ca613510630c1762efcc97`,
`state=up-to-date`, 5 container healthy, đĩa 66%. Rollback: revert squash commit qua PR để watcher
đưa main xanh mới lên; hoặc `infra/scripts/rollback.sh` về ảnh `ed206dbb…` theo runbook. Không cần
đảo dữ liệu.
