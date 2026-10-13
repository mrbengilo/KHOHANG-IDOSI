# Bằng chứng phát hành — Đối chiếu tồn Reshare

Thiết kế: `docs/supplier-stock-reconciliation.md`. Tài liệu này chỉ ghi điều đã chạy và kết quả
thật; mục chưa chạy được ghi rõ lý do. Không chứa secret.

## Môi trường kiểm thử cục bộ

- Node 24.21.0, npm 11 (lockfile), PostgreSQL **16** cô lập (CI dùng 17.6), `TZ=Asia/Ho_Chi_Minh`,
  `RUN_POSTGRES_TESTS=1`, database test riêng `idosi_ci` (tạo mới trước khi chạy gate).
- Chromium cài sẵn trong sandbox (build 1194) được dùng qua config cục bộ không commit vì bản
  Chromium khớp Playwright 1.63 không tải được; CI dùng `playwright install` chuẩn.
- Docker daemon không có trong sandbox.

## Lệnh và kết quả (cục bộ)

| Gate                                                           | Kết quả                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run format:check`                                         | PASS                                                                                                                                                                                                                                                                                 |
| `npm run lint`                                                 | PASS                                                                                                                                                                                                                                                                                 |
| `npm run typecheck`                                            | PASS                                                                                                                                                                                                                                                                                 |
| `npm run build`                                                | PASS                                                                                                                                                                                                                                                                                 |
| `node infra/scripts/check-migration-safety.mjs`                | PASS (expand-only)                                                                                                                                                                                                                                                                   |
| `node infra/scripts/run-migrations.mjs` ×2 (DB mới)            | PASS / PASS (lần 2 không đổi)                                                                                                                                                                                                                                                        |
| `npm run seed:production -w @idosi/database` ×2                | PASS / PASS                                                                                                                                                                                                                                                                          |
| `npm run bootstrap-admin:production -w @idosi/api`             | PASS                                                                                                                                                                                                                                                                                 |
| `npm run test` (mọi workspace, PostgreSQL thật)                | PASS sau sửa: web 394/394, database 39 file, worker 17 file, domain 12 file, API 96/96                                                                                                                                                                                               |
| `npm run e2e` (smoke, mock)                                    | PASS 47, SKIPPED 13 (skip theo thiết kế của suite hiện có)                                                                                                                                                                                                                           |
| `npm run e2e:production -w @idosi/web`                         | 97 PASS, 1 FAIL do timeout tải máy (`prominent-tabs` viewport matrix) — chạy riêng PASS; spec mới 36/36 PASS                                                                                                                                                                         |
| `npm run e2e:live`                                             | 28 PASS, 2 FAIL ở lần đầu (tràn trang 821 px trên tab Chờ đặt Reshare) → đã sửa (`c7de00a`), chạy lại 2 audit PASS; spec Reshare PASS                                                                                                                                                |
| `npm run test` lần 2 (DB tái dùng sau live E2E)                | 4 file cũ FAIL (continuous-ordering, multiple-order-sessions, combined-shipment, multiple-sessions): fixture có sẵn lấy `role='admin' limit 1` không lọc trạng thái, trúng Admin khóa khi dòng `ci.admin` bị ghi lại; không do thay đổi này. DB mới: PASS toàn bộ (rc=0)             |
| `node --test infra/scripts/reset-cli.integration.test.mjs`     | BLOCKED cục bộ: cần Docker; CI chạy                                                                                                                                                                                                                                                  |
| `node --test infra/scripts/reset-accumulated-fixture.test.mjs` | Lần đầu không chạy cục bộ (chuỗi `&&` dừng ở reset-cli). CI PR lần 1 FAIL: audit `supplier_event_batch` bị giữ chờ review vì tên bảng `supplier_event_batches` không bỏ được "s" → sửa `d22c743`; chạy lại cục bộ PASS (VERIFIED). Các lệnh còn lại của bước infra (trừ Docker) PASS |
| `git diff --check`                                             | PASS                                                                                                                                                                                                                                                                                 |

## Test mới

| File                                                                | Nội dung                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| packages/domain/tests/supplier-reconciliation.test.ts               | T01–T11, T18–T20, T24, T29, T39: kỳ vọng số độc lập                                                                                                                                  |
| packages/domain/tests/supplier-reconciliation.property.test.ts      | 400 chuỗi ngẫu nhiên cấp/giải phóng/đặt/giao/hủy/bán ngoài/quan sát: không cấp vượt B, quan sát lặp không cộng kép, H − R = F sau quan sát                                           |
| packages/database/tests/supplier-reconciliation.integration.test.ts | 14 ca PostgreSQL thật: T01–T11, T17–T21, T23–T32, replay/khóa tài khoản/gỡ phân công, coverage, cạnh tranh song song thật, nhận hàng thiếu + kiểm thiếu, audit bất biến, ledger khớp |
| apps/worker/tests/supplier-reconciliation.integration.test.ts       | AC01 qua worker 08:00/09:00 thật: hôm sau đối chiếu lại 3 → cấp 0; B=7, U=3 → cấp 4; SKU chờ baseline → 0 đề nghị, 0 cấp                                                             |
| packages/contracts/tests/supplier-reconciliation.test.ts            | Validation, không nhận số derived từ client, mã lỗi                                                                                                                                  |
| apps/api/test/supplier-reconciliation.postgres.test.mjs             | Quyền 4 vai trò, replay/conflict/stale, phạm vi đọc, OpenAPI                                                                                                                         |
| apps/web/src/features/supplier-reconciliation/*.test.ts(x)          | Model, bảng cam kết (tổng toàn trang, phạm vi, nhãn truy cập)                                                                                                                        |
| apps/web/e2e/supplier-reconciliation.spec.ts (production bundle)    | Admin/HTKD/cửa hàng, gửi lại giữ Idempotency-Key, 12 bề rộng gồm tương đương zoom 125/150/200% của 1366 px, 360–1920 px cho hàng chờ đặt                                             |
| apps/web/e2e-live/supplier-reconciliation.spec.ts                   | UI → API → PostgreSQL: cấu hình, chặn phiếu nhập, AC01, chi tiết, ghi đơn B                                                                                                          |

## Hiệu năng (opt-in `RUN_PERF_TESTS=1`)

Fixture: 100 SKU × 20 cửa hàng = 2.000 lượng giữ, 10.000 sự kiện + liên kết đơn B, PostgreSQL 16
cục bộ, 15 lần đo. Số "trước" là phiên bản tổng hợp liên kết theo sản phẩm (quét toàn lịch sử SKU),
đo trên DB đã tích lũy 2 bộ fixture; số "sau" đo trên DB có 1 và 3 bộ fixture — dữ liệu không hoàn
toàn đồng nhất, chỉ dùng để thấy xu hướng.

| Truy vấn                     | Trước (p50/p95) | Sau, 1 bộ (p50/p95) | Sau, 3 bộ (p50/p95) |
| ---------------------------- | --------------- | ------------------- | ------------------- |
| Tổng hợp 100 SKU             | 106 / 154 ms    | 112 / 173 ms        | 151 / 222 ms        |
| Trang cam kết (ORDERABLE)    | 169 / 228 ms    | 86 / 148 ms         | 69 / 120 ms         |
| Trần worker (mọi SKU đã bật) | 216 / 243 ms    | 122 / 181 ms        | 348 / 475 ms        |

Trần worker tăng theo số SKU đã bật và lượng giữ đang hiệu lực (3 bộ = 300 SKU, 6.000 giữ), không
theo lịch sử đơn B. Số lượng truy vấn cố định theo tập (không N+1): nạp dữ kiện = 1 mapping + 5 truy
vấn tập + 1 liên kết.

## CI, merge, deploy

Cập nhật trong PR và báo cáo cuối: PR, CI PR, merge SHA, CI main, trạng thái watcher, health/ready,
đối soát read-only production. Kích hoạt nghiệp vụ (bật SKU, baseline) là bước vận hành riêng theo
mục 8 của ADR; chưa SKU nào được bật khi phát hành.
