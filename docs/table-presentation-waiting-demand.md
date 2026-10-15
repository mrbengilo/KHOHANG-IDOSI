# Bảng dữ liệu và nhu cầu chờ theo mặt hàng

## Baseline và phạm vi

- Khảo sát ngày 15/10/2026; origin/main và VPS cùng SHA `0874405cff0e084b65a8f53b93f64504cb5d1322`.
- Checkout mới, sạch; nhánh `fix/system-tables-waiting-demand`.
- Phạm vi: mọi bảng dữ liệu, STT, nhu cầu còn chờ, tên cửa hàng và viền vùng nội dung.
- Hai ảnh đầu vào chứng minh bảng Kho tổng/PCT hẹp trong panel, tiêu đề Kho tổng xuống dòng và thiếu STT. Chưa dùng ảnh để kết luận số liệu DB sai.
- Source xác nhận wrapper `fit-content`, table `auto`, cột Kho tổng `7rem` ép wrap. Binding cũ dùng `waitTicketHoldBags` (hold vật lý), khác nhu cầu còn chờ.
- SSH chỉ đọc xác nhận watcher `up-to-date`, target/running bằng baseline; còn 11 GB đĩa, khoảng 2 GB RAM available. Chưa xác minh backup/release mới.

## Thiết kế và kế hoạch commit

1. Projection `waitingDemandBags = SUM(wait_tickets.remaining_quantity)` cho PC active, chưa xóa và còn số lượng, group theo productId. Giữ nguyên H/R/available/hold/ledger. Contract có phiên bản rõ để tab cũ không hiểu nhầm field hoặc hiển thị số sai; lỗi phiên bản yêu cầu người dùng tải lại, không tự reload lặp.
2. Bảng dùng toàn content box, STT là DOM thực, offset theo pagination thực; bảng con đánh lại từ 1. Loại selector vị trí có ý nghĩa nghiệp vụ. Header chỉ wrap nếu tổng độ rộng cần thiết vượt box; cuộn cục bộ khi cần.
3. Token/class riêng cho tên cửa hàng xanh đậm và border nội dung, giữ trạng thái/focus/accessibility.
4. Kiểm thử, ma trận nguồn/route/role/state, docs và bằng chứng; review rồi commit/push/PR/CI/merge/watcher và smoke chỉ đọc.

Rủi ro cần chứng minh: strict Zod giữa bundle/API khác phiên bản, pagination theo chứng từ, CSS lazy-load/mobile, rowspan/colspan, invalidation sau thay đổi nhu cầu. Dự kiến không migration/backfill hoặc writer change; quyết định index sau EXPLAIN.

## Kế hoạch kiểm chứng

- Node 24, npm ci từ lockfile; PostgreSQL 17 cô lập, không dùng DATABASE_URL production.
- Case 3 + 5 = 8, H=R=0; partial/pending/hold/history/cancel/soft-delete/same-name SKU; PCT lineage, idempotency/concurrency và role scope qua harness hiện có.
- Format/lint/typecheck/build, migrations/seed lặp, workspace tests; E2E fixture, production bundle cục bộ và live API/PostgreSQL tách riêng.
- Manifest mọi renderer; viewport 360/390/412/768/819/820/821/1024/1366/1440/1920/2560, đo width/header/overflow/STT/color/border; kiểm chứng zoom thật riêng.
- Trước merge: toàn bộ gate xanh, review, backup/rollback; sau merge: CI đúng SHA và watcher target/running, health/ready, SQL/API/UI chỉ đọc.

## Bằng chứng thực hiện

Đang triển khai. Không có kết quả PASS/merge/deploy mới tại thời điểm ghi baseline.

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

`e2e:production` là bundle cục bộ, `e2e:live` là API/PG test, không phải website VPS. Artifact JSON đo từng bảng, line count, content width, overflow và từng route/state được giữ trong `test-results` và CI browser-evidence; kiểm kê source không thay thế kết quả runtime.

## Query, rollout và rollback

Count + page dùng cùng transaction READ ONLY REPEATABLE READ. Tổng remaining nằm trong một subquery có index trong SELECT của trang sản phẩm, không query theo từng dòng từ application và không phụ thuộc pagination PCT. Không join bảng lineage. Dùng index có sẵn `wait_tickets_active_priority_idx`, không migration/backfill. Test thêm 10.000 fulfilled rows vẫn Index Scan, 2 SELECT cho pageSize 1 và 100; execution time lookup 0,040ms ở PG17 cô lập. Benchmark projection riêng cùng kết nối (10 mẫu sau warmup): không demand 0,645–1,376ms, có demand 0,766–1,191ms; đây không phải end-to-end production latency.

Client gửi `projection=waiting-demand-v2`; server validate response và trả 409 CONFLICT nếu thiếu phiên bản. Bundle cũ nhận lỗi thay vì dữ liệu sai; bundle mới gặp API cũ/thiếu field báo cần tải lại, không fallback 0, không reload tự động. Trường vật lý `waitTicketHoldBags` giữ nguyên. React Query invalidation ở kết quả phân bổ/ưu tiên/hủy/điều chỉnh đã bao phủ inventory; bổ sung invalidation sau chốt nhận thiếu.

Rollback: image API/worker/web trước là `0874405cff0e084b65a8f53b93f64504cb5d1322`. Nếu cần, dùng runbook `deployment-khoidosi.io.vn.md`: pause watcher theo cơ chế hiện có trước rollback đồng bộ image, hoặc revert trên main qua CI; không restore database. API/web khác phiên bản hiển thị lỗi rõ, tải lại tab sau khi service đồng bộ. Backup trước merge `idosi-20261015T140904Z.dump` đã kiểm tra sha256 và pg_restore --list. Watcher tự backup lại trước deploy.
