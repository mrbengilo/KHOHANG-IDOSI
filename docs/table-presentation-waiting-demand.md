# Bảng dữ liệu và nhu cầu chờ theo mặt hàng

## Baseline và phạm vi

- Khảo sát ngày 15/10/2026; origin/main và VPS cùng SHA `0874405cff0e084b65a8f53b93f64504cb5d1322`.
- Checkout mới, sạch; nhánh `fix/system-tables-waiting-demand`.
- Phạm vi: mọi bảng dữ liệu, STT, nhu cầu còn chờ, tên cửa hàng và viền vùng nội dung.
- Hai ảnh đầu vào chứng minh bảng Kho tổng/PCT hẹp trong panel, tiêu đề Kho tổng xuống dòng và thiếu STT. Chưa dùng ảnh để kết luận số liệu DB sai.
- Source xác nhận wrapper `fit-content`, table `auto`, cột Kho tổng `7rem` ép wrap. Binding cũ dùng `waitTicketHoldBags` (hold vật lý), khác nhu cầu còn chờ.
- SSH chỉ đọc tại baseline xác nhận watcher `up-to-date`, target/running bằng baseline; còn 11 GB đĩa, khoảng 2 GB RAM available. Backup `idosi-20261015T172307Z.dump` đã xác minh checksum và `pg_restore --list`.
- Trong khi triển khai, main có PR #118 (`ef8762be936f0b39b8a2d2b50888e88686231fec`). Đã merge và giữ sidebar 240px, scrollbar 6px, lề desktop mới và thẻ có nhãn ở màn hẹp ≤1100px. Chạy lại kiểm tra giao diện sau giải quyết conflict.

## Thiết kế đã triển khai

1. Projection `waitingDemandBags = SUM(wait_tickets.remaining_quantity)` cho PC active, chưa xóa và còn số lượng, group theo productId. Giữ nguyên H/R/available/hold/ledger. Contract có phiên bản rõ để tab cũ không hiểu nhầm field hoặc hiển thị số sai; lỗi phiên bản yêu cầu người dùng tải lại, không tự reload lặp.
2. Bảng dùng toàn content box, STT là DOM thực, offset theo pagination thực; bảng con đánh lại từ 1. Loại selector vị trí có ý nghĩa nghiệp vụ. Header chỉ wrap nếu tổng độ rộng cần thiết vượt box; cuộn cục bộ khi cần.
3. Token/class riêng cho tên cửa hàng xanh đậm và border nội dung, giữ trạng thái/focus/accessibility.
4. Kiểm thử, ma trận nguồn/route/role/state, docs và bằng chứng; review rồi commit/push/PR/CI/merge/watcher và smoke chỉ đọc.

Các điểm kiểm chứng chính: strict Zod giữa bundle/API khác phiên bản, pagination theo chứng từ, CSS lazy-load/mobile, rowspan/colspan, invalidation sau thay đổi nhu cầu. EXPLAIN xác nhận index hiện có phù hợp; không migration/backfill hoặc đổi writer.

## Kế hoạch kiểm chứng

- Node 24, npm ci từ lockfile; PostgreSQL 17 cô lập, không dùng DATABASE_URL production.
- Case 3 + 5 = 8, H=R=0; partial/pending/hold/history/cancel/soft-delete/same-name SKU; PCT lineage, idempotency/concurrency và role scope qua harness hiện có.
- Format/lint/typecheck/build, migrations/seed lặp, workspace tests; E2E fixture, production bundle cục bộ và live API/PostgreSQL tách riêng.
- Manifest mọi renderer; viewport 360/390/412/768/819/820/821/1024/1366/1440/1920/2560, đo width/header/overflow/STT/color/border; kiểm chứng zoom thật riêng.
- Trước merge: toàn bộ gate xanh, review, backup/rollback; sau merge: CI đúng SHA và watcher target/running, health/ready, SQL/API/UI chỉ đọc.

## Bằng chứng thực hiện

Môi trường local: Windows, Node 24.19, PostgreSQL 17.6 riêng tại localhost. Không dùng dữ liệu production cho các thao tác ghi. Kết quả trước phát hành:

| Gate                            | Kết quả và phạm vi                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck, lint                 | PASS sau tích hợp main mới                                                                                                           |
| Unit/integration toàn workspace | 1.226 PASS, 1 SKIPPED (benchmark opt-in); PostgreSQL được bật                                                                        |
| Migration, seed                 | PASS chạy hai lần trên PostgreSQL riêng; wrapper migration Linux được kiểm tra riêng ở CI                                            |
| API waiting demand              | 5 PASS: 3+5=8/H=R=0, bốn vai trò, SKU trùng tên, partial/history/cancel, snapshot/concurrency, version contract và index/query count |
| Production bundle E2E cục bộ    | 193 PASS, 11 SKIPPED theo project; gồm 12 viewport, zoom thật 100/125/150%, STT, header geometry, tên cửa hàng, border và navigation |
| Smoke E2E cục bộ                | 47 PASS, 13 SKIPPED theo project                                                                                                     |
| Live API/PostgreSQL E2E         | 33 ca đạt: full run 32 PASS + 1 selector sai; sửa selector và chạy lại ca đó PASS, không đổi nghiệp vụ                               |
| CI, merge, watcher, production  | Chưa hoàn tất ở thời điểm commit tài liệu; bằng chứng theo đúng SHA được ghi trong PR và báo cáo phát hành                           |

Lượt workspace cuối đạt 1.225 ca và phát hiện assert ép tên index; sau khi chuyển sang kiểm tra index scan theo product_id, số dòng và query count, toàn bộ API đã chạy lại đạt 109/109. Các workspace còn lại đạt 414 + 46 + 154 + 368 + 135, một benchmark opt-in SKIPPED. Ảnh trong repository chỉ chứa fixture tổng hợp. Baseline trước task đã có ở [ảnh kho tổng của PR #118](evidence/desktop-wide-gutters/after-inventory-1920.png). Sau thay đổi:

| Màn hình  | Desktop                                                | Mobile                                               |
| --------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Kho tổng  | [1920px](evidence/system-tables/inventory-desktop.png) | [390px](evidence/system-tables/inventory-mobile.png) |
| Phiếu chờ | [2560px](evidence/system-tables/pct-desktop.png)       | [390px](evidence/system-tables/pct-mobile.png)       |

Các hồi quy phát hiện khi kiểm thử đã được xử lý: bảng chi tiết phân bổ đang mở được phép co lại khi chuyển desktop sang mobile (`min-width: 0`); phản hồi xem trước Reshare về muộn giữ focus và vị trí ô người dùng đang nhập; khôi phục vị trí Back/Forward chờ các layout effect cùng commit hoàn tất; phép đo border ở zoom thật dùng pixel vật lý (border 1px có thể bằng 0,8 CSS px ở zoom 125%). Không giảm cỡ chữ hoặc bỏ kiểm tra border để đạt gate.

## Manifest renderer (51 bảng / 40 file)

STT theo thứ tự dữ liệu hiển thị; bảng con bắt đầu 1. Các bảng phân trang dùng metadata server; lịch sử IDOSI dùng pageSize của slice. Lịch sử nhập, đặt hàng, xuất, điều chuyển Sale và RE đánh số chứng từ với rowspan, giữ nguyên số dòng sản phẩm. Dòng tổng/chi tiết mở rộng/empty không đánh số.

| Source                                                                       | Số bảng | Cột đầu / kiểm tra                           |
| ---------------------------------------------------------------------------- | ------: | -------------------------------------------- |
| `apps/web/src/features/allocations/AllocationResultCard.tsx`                 |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/transfers/TransferOperations.tsx`                     |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/dashboard/WholesaleOverview.tsx`                      |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/allocations/AllocationDecisionPanel.tsx`              |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/idosi/IdosiStatisticsPanel.tsx`                       |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/transfers/SortedSaleTransferWorkspace.tsx`            |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/allocations/WaitDocumentDetail.tsx`                   |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/idosi/IdosiSalesSummary.tsx`                          |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/allocations/WaitDocumentList.tsx`                     |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `packages/ui/src/Table.tsx`                                                  |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/InboundReceiptDetails.tsx`                               |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/DashboardPage.tsx`                                       |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/allocations/WaitTicketTable.tsx`                      |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/CatalogPage.tsx`                                         |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/AllocationPage.tsx`                                      |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/ReportsPage.tsx`                                         |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/ReceivePage.tsx`                                         |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/admin/AdminStoresPage.tsx`                            |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/WarehouseInboundPage.tsx`                                |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/RequestsPage.tsx`                                        |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/PartnerInboundPage.tsx`                                  |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/OperationsPages.tsx`                                     |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/admin/AdminUsersPage.tsx`                             |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/pages/InboundStatisticsPage.tsx`                               |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inbound-statistics/InboundTables.tsx`                 |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inventory/BagOpeningHistoryTable.tsx`                 |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/orders/StoreOrderHistory.tsx`                         |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/receipts/HeldAllocationsPanel.tsx`                    |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inventory/InventoryOperations.tsx`                    |       3 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/ReconciliationWorkspace.tsx`  |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/ObservationForm.tsx`          |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/ObservationHistory.tsx`       |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/ReshareStatusHistory.tsx`     |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/CommitmentTable.tsx`          |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/supplier-reconciliation/ReshareOrderHistoryTable.tsx` |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inventory/ShortageChecksPanel.tsx`                    |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/receipts/adjustments/AdminAdjustmentWorkspace.tsx`    |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inventory/WarehouseInventory.tsx`                     |       2 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/inventory/WarehouseAdjustmentHistory.tsx`             |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |
| `apps/web/src/features/receipts/adjustments/ReceiptAdjustments.tsx`          |       1 | STT trong DOM; kiểm kê tbody/rowspan/colspan |

## Ma trận chạy trình duyệt

| Vai trò / route                                                            | Tab, trạng thái, renderer                                                        | Test                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ADMIN/HTKD/STORE retail/STORE sỉ/WHOLESALE, mọi route được policy cho phép | Mỗi route và tab tìm thấy, denied routes riêng, desktop/mobile                   | `e2e-live/responsive-table-layout.spec.ts`, `system-route-audit.spec.ts`, `e2e/desktop-route-matrix.ts`      |
| ADMIN/HTKD/STORE/WHOLESALE `/inventory`                                    | Kho tổng, trang 2 → filter về 1; dữ liệu 8 khác physical hold 0; API cũ          | `e2e/table-presentation.spec.ts`                                                                             |
| ADMIN `/allocations?tab=wait-tickets`                                      | PCT list/detail, tên dài, ít dòng, full width/color/border, 12 viewport          | `e2e/table-presentation.spec.ts`                                                                             |
| STORE `/allocations`                                                       | kết quả/history/PCT, B → C → D, ACCEPT/hủy, dialog, SQL/API/live UI              | `e2e-live/store-wait-documents.spec.ts`                                                                      |
| ADMIN `/inventory`, `/allocations`                                         | H=R=0, 2 cửa hàng remaining 3/5, SQL=API=UI=8                                    | `e2e-live/store-wait-documents.spec.ts`                                                                      |
| ADMIN `/warehouse-inbound`, `/inventory`                                   | header text range, chiều rộng, overflow, bàn phím, real browser zoom 100/125/150 | `e2e/responsive-table-layout.spec.ts`, `desktop-zoom.spec.ts`, `desktop-table-density.spec.ts`               |
| Mọi vai trò theo route policy                                              | loading/empty/error, tabs, focus, menu, dialog; input cũ không mất               | `e2e/prominent-tabs.spec.ts`, `content-navigation.spec.ts`, `desktop-layout.spec.ts`; live operational specs |

Ma trận live API/PostgreSQL cuối: 996 phép đo = 83 tổ hợp vai trò/route/state × 12 viewport, 492 trạng thái có dòng dữ liệu, 0 page overflow và 0 presentation issues. Năm identity: ADMIN, HTKD, STORE_RETAIL, STORE_WHOLESALE_KIND, WHOLESALE.

`e2e:production` là bundle cục bộ, `e2e:live` là API/PG test, không phải website VPS. Artifact JSON đo từng bảng, line count, content width, overflow và từng route/state được giữ trong `test-results` và CI browser-evidence; kiểm kê source không thay thế kết quả runtime.

## Query, rollout và rollback

Count + page dùng cùng transaction READ ONLY REPEATABLE READ. Tổng remaining nằm trong một subquery có index trong SELECT của trang sản phẩm, không query theo từng dòng từ application và không phụ thuộc pagination PCT. Không join bảng lineage. Dùng partial index có sẵn (`wait_tickets_active_priority_idx` hoặc `wait_tickets_one_active_store_product_uidx` tùy thống kê planner), không migration/backfill. Test thêm 10.000 fulfilled rows vẫn Index Scan theo product_id, đọc đúng 2 dòng sống, 2 SELECT cho pageSize 1 và 100; lần cuối lookup 0,016ms và 2 buffer hits ở PG17 cô lập. Benchmark projection riêng cùng kết nối (10 mẫu sau warmup): không demand 0,535–0,993ms, có demand 0,626–1,005ms; đây không phải end-to-end production latency.

Client gửi `projection=waiting-demand-v2`; server validate response và trả 409 CONFLICT nếu thiếu phiên bản. Bundle cũ nhận lỗi thay vì dữ liệu sai; bundle mới gặp API cũ/thiếu field báo cần tải lại, không fallback 0, không reload tự động. Trường vật lý `waitTicketHoldBags` giữ nguyên. React Query invalidation ở kết quả phân bổ/ưu tiên/hủy/điều chỉnh đã bao phủ inventory; bổ sung invalidation sau chốt nhận thiếu.

Rollback: bản đang chạy trước release là `ef8762be936f0b39b8a2d2b50888e88686231fec` (PR #118), đã đối chiếu watcher với release thực tế. Nếu cần, dùng runbook `deployment-khoidosi.io.vn.md`: pause watcher theo cơ chế hiện có trước rollback đồng bộ image, hoặc revert trên main qua CI; không restore database. API/web khác phiên bản hiển thị lỗi rõ, tải lại tab sau khi service đồng bộ. Backup trước merge `idosi-20261015T172307Z.dump` đã kiểm tra sha256 và pg_restore --list. Watcher tự backup lại trước deploy.
