# Trả hàng ngay trong lần HTKD duyệt sai lệch

## Phạm vi và đối chiếu file

| File                                                                                            | Vấn đề / thay đổi                                                                                                              | Kiểm chứng                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/database/src/store-receipt-adjustments.ts`                                            | `apply` hoàn tất PTH, consume đúng bao và nhập kho trong transaction; khóa theo thứ tự; tính giá trị giữ lại; audit đúng actor | PostgreSQL sai lệch, rollback ép lỗi, concurrency, legacy, nhận bù |
| `packages/database/src/schema.ts`, migration `0031_receipt_immediate_returns.sql`, journal      | Provenance tự hoàn tất nullable, constraint tách khỏi bàn giao/nhận vật lý; không backfill                                     | Upgrade constraint, schema cũ/nâng cấp, migrate lặp                |
| `packages/database/src/monthly-report.ts`                                                       | Ngày hiệu lực trả tự động/legacy, loại giá trị hàng trả đúng một lần                                                           | Unit báo cáo, integration cả giữ và trả                            |
| `packages/contracts/src/receipt-adjustments.ts`, `apps/api/src/postgres-receipt-adjustments.ts` | Sự kiện lịch sử `RETURN_AUTO_COMPLETED`                                                                                        | API PostgreSQL, contract/typecheck                                 |
| `ReceiptAdjustments.tsx`, `adjustmentModel.ts`                                                  | Nội dung tác động duyệt, preview tổng giữ lại, nhãn audit tự động                                                              | Unit preview phí/VAT, E2E và ảnh                                   |
| `ReportsPage.tsx`                                                                               | Nhãn màn hình/CSV bao gồm hàng trả có hiệu lực                                                                                 | Test CSV                                                           |
| Test database/API/web và `e2e-live/receipt-adjustment.spec.ts`                                  | Kỳ vọng trả ngay; giữ kiểm thử luồng trả độc lập cũ                                                                            | Các gate ghi bên dưới                                              |
| `docs/receipt-discrepancy-adjustments.md`                                                       | Chính sách mới, chuỗi ledger, legacy, rollback/forward-fix                                                                     | Đối chiếu code và test                                             |

Domain, API routes, cache invalidation, P0B, gộp giao hàng và điều kiện chỉ báo trước khui bán
đã có trên main; giữ nguyên vì không cần luồng nghiệp vụ khác.

## Kết quả nghiệp vụ đã kiểm chứng

- Trả một bao: 3 đầm → đúng bao nguồn thành jeans rồi returned/kg=0; hai bao đầm khác không đổi.
  PTH received ngay, kho tăng một jeans, quyền chờ một đầm; gốc 3 triệu, hiệu lực 2 triệu.
- Giữ: 2 đầm + 1 jeans, giá jeans 800 nghìn, hiệu lực 2,8 triệu. Không PTH/nhập trả.
- Nhận bù: chứng từ riêng +1 triệu; tổng giữ 3,8 triệu hoặc tổng trả 3 triệu. Quyền đã nhận được tất toán.
- Giao nhầm: jeans −1 điều chỉnh +1 nhập trả; đầm +1 on-hand/+1 reserved, không tăng khả dụng đầm.
- Retry đồng thời không ghi lại; endpoint trả cũ bị chặn với phiếu đã tự hoàn tất. Audit là người duyệt thật.
- Ép lỗi tại quyền bù, nhập kho và cập nhật cuối transaction rollback trạng thái, bao, ledger, tiền và PTH.
- PENDING_ADMIN được xác minh lại. APPLY legacy cũng tái tạo snapshot tiền giữ lại.
- Phí vận chuyển 100.000, bốc xếp 30.000, VAT 50.000 không bị tự hoàn ở cả hai nhánh.

## Evidence giao diện

Các ảnh lấy từ E2E live trên PostgreSQL kiểm thử riêng, không phải production.
Kiểm tra không tràn ở 360, 390, 412, 768, 1366 và 1440 px. E2E dùng cùng phiếu: giữ bao 1
rồi trả bao 2, nên tổng cuối là 1,8 triệu (một đầm + một jeans); test PostgreSQL riêng chứng minh
ví dụ chuẩn trả một bao còn hai đầm/2 triệu.

- [Trước duyệt trả – desktop](htkd-return-before-1440.png)
- [Sau duyệt trả – desktop](htkd-return-after-1440.png)
- [Trước duyệt trả – mobile](htkd-return-before-390.png)
- [Sau duyệt trả – mobile](htkd-return-after-390.png)
- [Giữ bán sau duyệt – desktop](htkd-applied-1440.png)
- [Giữ bán sau duyệt – mobile](htkd-applied-390.png)

Ảnh “trước/sau” là trước/sau thao tác duyệt trên bản sửa, không phải ảnh so sánh hai phiên bản code.

## Chuyển tiếp

Không backfill phiếu trả cũ. Chưa bàn giao tiếp tục luồng cũ; đang vận chuyển/đối soát chỉ nhập
kho phần chưa ghi; đã received không ghi lại. Chưa mở rộng trả phần bao đã khui bán/bán/chuyển.
Migration tương thích đọc với app cũ nhưng rollback image sẽ tái lập luật chờ nhận cho phiếu mới
và cách đọc tiền cũ; ưu tiên forward-fix, không đảo ledger hoặc restore production.

## Kiểm thử local ngày 27/09/2026

PostgreSQL 17.6 riêng, `RUN_POSTGRES_TESTS=1`; không dùng database production.

| Lệnh                                                                                                                      | Kết quả                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run quality`                                                                                                         | Exit 0: format, lint, typecheck, test, build; 806 test pass, 0 fail/skip |
| `npm run test -w @idosi/web -- ReceiptAdjustments.test.ts`                                                                | Sau bổ sung nhãn bao legacy: toàn bộ web 291 pass, 0 fail/skip           |
| `npm run test -w @idosi/database -- receipt-adjustments.integration.test.ts receipt-return-migration.integration.test.ts` | 40 pass: 39 nghiệp vụ + 1 migration, 0 fail/skip                         |
| `node --test apps/api/test/receipt-adjustments.postgres.test.mjs`                                                         | 9 pass, 0 fail/skip; cũng được chạy trong quality                        |
| `npm run e2e:live`                                                                                                        | Database sạch: 18 pass, 0 fail/skip                                      |
| `npm run e2e`                                                                                                             | 24 pass, 6 skip có chủ đích theo project desktop/mobile, 0 fail          |
| `npm run format:check`, `npm run lint`                                                                                    | Chạy lại sau cập nhật nhãn: pass                                         |
| `npm run db:migrate`                                                                                                      | Schema mới và chạy lặp đều pass                                          |
| `node infra/scripts/check-migration-safety.mjs`                                                                           | Expand-only pass; đường wrapper Linux tiếp tục được CI kiểm tra          |

Quality gồm API 81, web 290, worker 31, contracts 127, database 212, domain 65.
Web có thêm một test nhãn sau lần quality trên, được chạy lại đủ 291 test.
Sáu skip smoke là 4 assertion chỉ desktop bị skip ở mobile và 2 assertion chỉ mobile bị skip ở desktop.
Không tính chúng là pass. Không có integration/live test bị skip vì thiếu hạ tầng.

Các lỗi trong quá trình phát triển đã được xác định và khắc phục: database mới chưa seed danh mục;
assertion CSV/journal còn kỳ vọng cũ; expectation tồn sau trả còn chứa SKU có 0 kg trong khi query
chỉ trả SKU còn giữ; E2E khởi động trước build worker; chạy lại full E2E trên dữ liệu cũ gây trùng
ngày cố định của fixture. Full E2E cuối chạy trên database mới, không xóa assertion hoặc nới timeout.

E2E sai lệch chạy lại sau sửa nhãn legacy: `npm run e2e:live -w @idosi/web -- receipt-adjustment.spec.ts` — 2 pass, 0 fail/skip.
