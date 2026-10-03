# Thanh tab nổi bật: Phân bổ hàng hóa và Tồn kho (Admin)

Base: `7c42a6dfeeb973d66638b05719a4d8e77b6cb0ed` (main, 03/10/2026). Phạm vi: chỉ giao diện web —
không đổi API, contracts, quyền, dữ liệu, tính toán kho, migration hay hạ tầng deploy. Không đổi
tên tab, sidebar, page header, font toàn ứng dụng, bảng, form hay nút nghiệp vụ.

## Phạm vi theo vai trò

| Vai trò / route                   | Thanh tab                                                                | Kiểu    |
| --------------------------------- | ------------------------------------------------------------------------ | ------- |
| Admin `/allocations`              | Phiên và kết quả · Lịch sử đặt hàng · Tạo phiên mới (chính)              | nổi bật |
| HTKD `/allocations`               | Phiên và kết quả · Lịch sử đặt hàng (chính)                              | nổi bật |
| Admin `/inventory`                | Kho tổng · Kho cửa hàng · Phiếu sai lệch (chính)                         | nổi bật |
| Admin `/inventory` › Kho tổng     | Tồn hiện tại · Kiểm hàng thiếu · Lịch sử xuất · Lịch sử điều chỉnh (phụ) | nổi bật |
| Admin `/inventory` › Kho cửa hàng | Tồn cửa hàng · Sổ phát sinh (phụ)                                        | nổi bật |
| HTKD / cửa hàng `/inventory`      | Tồn cửa hàng · Sổ phát sinh                                              | giữ cũ  |
| Cửa hàng `/allocations`           | Phiên và kết quả                                                         | giữ cũ  |

Quyền không đổi: `allocationTabs(role)`/`readAllocationTab` giữ nguyên, HTKD không có Tạo phiên mới
và deep link `?tab=create` của HTKD vẫn rơi về Phiên và kết quả.

## Trước / sau (computed style + DOMRect, Chromium 141 headless, DPR 1, zoom 100%)

| Cấp tab         | Viewport | Trước: font / weight (chưa chọn–đang chọn) / cao / padding | Sau: font / weight / cao / padding       |
| --------------- | -------- | ---------------------------------------------------------- | ---------------------------------------- |
| Chính (phạm vi) | > 620px  | 15px / 400–700 / 44px / 8px 14px                           | 18px (1.125rem) / 700 / 56px / 12px 20px |
| Phụ (phạm vi)   | > 620px  | 14px / 400–700 / 40px / 6px 12px                           | 16px (1rem) / 700 / 48px / 10px 16px     |
| Chính + phụ     | ≤ 620px  | 15 hoặc 14px / 400–700 / 44 hoặc 40px / 8px 12px           | 16px / 700 / 48px / 10px 14px            |
| Ngoài phạm vi   | mọi      | 15/14px / 400–700 / 44/40px                                | không đổi                                |

line-height thanh nổi bật: 1.4. Ví dụ chiều rộng @1440 (sau): Phiên và kết quả 169px, Lịch sử đặt
hàng 169px, Tạo phiên mới 152px; trước đây tab đổi rộng 128 → 135px khi được chọn vì chỉ tab chọn in
đậm — nay mọi nhãn đã đậm nên chọn tab không làm nhảy chiều rộng (spec so sánh từng lần chọn).

Ma trận đủ (360, 390, 412, 620, 621, 768, 819, 820, 821, 1366, 1440, 1920, 2560px; kèm
`innerWidth`, `innerHeight`, DPR, browser) ở `docs/evidence/prominent-tabs/after-matrix.json`. Thanh
cuộn ngang cục bộ khi nội dung rộng hơn: `/allocations` ở 360–412px, Kho tổng phụ ở 360–412px, Kho
chính ở 360px; tài liệu không bao giờ cuộn ngang (`scrollWidth ≤ clientWidth + 1`).

Ảnh trước/sau: `docs/evidence/prominent-tabs/{before,after}-{admin-allocations,htkd-allocations,
admin-inventory,admin-inventory-store}-{desktop-1440,mobile-390}.png`. Spec ghi thêm ảnh 390/1440/
2560, 360 (bàn phím) và zoom 100%/200% vào `test-results/production/**` (artifact
`browser-evidence` trên CI).

## Nguyên nhân và các lỗi liên quan tìm thấy

- **Yêu cầu chính**: `.tabs__tab` dùng chung 15/14px, chỉ `.tabs__tab--active` đậm. Không có cách
  bật kiểu lớn hơn cho riêng các màn hình yêu cầu mà không ảnh hưởng vai trò khác.
- **Thanh cuộn dọc 1px** (tái hiện: `scrollHeight` 57 > `clientHeight` 56): gạch chân tab đang chọn
  đặt `bottom: -1px` trong thanh có `overflow-x: auto` (kéo theo `overflow-y: auto`) nên 1px tràn tạo
  vùng cuộn dọc — trên trình duyệt dùng scrollbar cổ điển (Windows) hiện thanh cuộn dọc vô nghĩa. Thanh
  nổi bật đặt gạch chân `bottom: 0`. Thanh mặc định (ngoài phạm vi) vẫn còn lỗi này.
- **Deep link tab cuối bị che trên màn hẹp** (tái hiện @360px: `/inventory?tab=warehouse&kt=adjustments`
  — tab Lịch sử điều chỉnh có cạnh phải 465px, ngoài vùng thanh 345px). `Tabs` nay chỉnh
  `scrollLeft` của chính thanh khi tab chọn nằm ngoài vùng nhìn; không dùng `scrollIntoView` để trang
  không cuộn. Hiệu ứng này áp dụng cho mọi thanh tab (chỉ khi tab chọn bị khuất, không đổi giao diện).

## Thiết kế đã chọn

- `Tabs` thêm prop `emphasis?: 'default' | 'prominent'` (mặc định `default`, giữ nguyên giao diện cũ),
  render class `tabs--prominent`. `size` vẫn phân biệt cấp chính/phụ. Component không biết vai trò;
  call site quyết định: `AllocationPage` bật cho ADMIN/HTKD, `AdminInventoryWorkspace` và
  `WarehouseInventory` bật luôn (chỉ Admin tới được), `StoreInventoryPage` chỉ bật khi `embedded`
  (trong workspace Admin) nên trang tồn kho HTKD/cửa hàng giữ kiểu cũ.
- Kích thước thật bằng font-size/padding/min-height (rem cho cỡ chữ), không `transform`/`zoom`;
  chiều rộng theo nội dung (`flex: 0 0 auto`, `white-space: nowrap`), không ép đều.
- Tab đang chọn vẫn nổi bật bằng màu `--brand-dark` + gạch chân 3px `--brand`; chưa chọn
  `--text-secondary` (#475569 trên nền #f4f8fc ≈ 7.2:1). Focus ring `outline-offset: -2px` vẽ bên
  trong tab nên `overflow` của thanh không cắt.
- Đã loại: tăng `.tabs__tab` toàn cục (ảnh hưởng vai trò ngoài phạm vi); truyền `role` vào `Tabs`
  (trộn logic quyền vào component dùng chung); `overflow-y: hidden` cho thanh (vẫn cắt 1px gạch chân).

## File thay đổi

| File                                                               | Thay đổi                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `apps/web/src/components/Tabs.tsx`                                 | prop `emphasis`, class `tabs--prominent`; giữ tab chọn trong vùng cuộn của thanh |
| `apps/web/src/components/tabs.css`                                 | modifier `.tabs--prominent` chính/phụ, ≤620px, gạch chân `bottom: 0`             |
| `apps/web/src/pages/AllocationPage.tsx`                            | bật nổi bật cho ADMIN/HTKD                                                       |
| `apps/web/src/features/inventory/InventoryOperations.tsx`          | tab chính Admin; tab Kho cửa hàng khi `embedded`                                 |
| `apps/web/src/features/inventory/WarehouseInventory.tsx`           | tab phụ Kho tổng                                                                 |
| `apps/web/e2e/prominent-tabs.spec.ts`                              | spec mới (production bundle + API fixture)                                       |
| `apps/web/e2e/browser-zoom.ts`, `desktop-zoom.spec.ts`             | tách harness zoom thật dùng chung, không đổi kỳ vọng cũ                          |
| `apps/web/playwright.production.config.ts`, `playwright.config.ts` | thêm spec vào allowlist / ignore                                                 |

## Kiểm thử (`apps/web/e2e/prominent-tabs.spec.ts`)

Fixture chỉ trả các endpoint màn hình đọc, đúng schema; endpoint lạ → 404 và bị ghi nhận
(`unexpected` phải rỗng); mọi request không phải GET → 405 và bị ghi nhận (`mutations` phải rỗng).

- Admin `/allocations`: đủ 3 tab, click từng tab → `aria-selected`, tabpanel, `?tab=` đúng; mở Tạo
  phiên mới không gửi gì; Back/Forward/reload; tab Lịch sử lazy (không gọi `/order-history` trước).
- HTKD `/allocations`: 2 tab, `?tab=create` rơi về Phiên và kết quả, không có nội dung tạo phiên.
- Admin `/inventory`: đo 3 tab chính, 4 tab Kho tổng, 2 tab Kho cửa hàng ở cả trạng thái chọn/chưa
  chọn; deep link `kt=history`, `kt=adjustments`, `ch=ledger`, `tab=adjustments`; chỉ tab mở tải dữ liệu.
- Cảnh báo bản nháp (Kiểm hàng thiếu → Kho cửa hàng): Ở lại giữ nội dung, Bỏ nháp và chuyển đổi tab.
- HTKD/cửa hàng `/inventory`, cửa hàng `/allocations`: giữ kiểu cũ.
- Đang tải / rỗng / lỗi / Làm mới: thanh tab giữ nguyên kích thước.
- Bàn phím @360px: End, Home, ArrowLeft/Right quay vòng, Enter/Space; tab focus nằm trong vùng thanh,
  `:focus-visible`, trang không cuộn; roving tabindex.
- Ma trận viewport (desktop project) và zoom trình duyệt thật 200% (`chrome.tabs.setZoom`).

Spec thất bại trên base (đã chạy với mã nguồn gốc: 6/8 test desktop đỏ, gồm lỗi deep link @360px),
xanh sau sửa. Phân quyền server không đổi; mock UI chỉ chứng minh giao diện — quyền backend được
các test API/live hiện có trong CI kiểm.

## Phát hành và rollback

Không migration, không đổi cấu hình. Deploy theo watcher (`docs/deployment-khoidosi.io.vn.md`).
Rollback: revert commit qua PR/CI để watcher phát hành SHA revert; không đụng database/volume.
