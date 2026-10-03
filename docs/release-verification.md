# Hồ sơ release — rà soát toàn hệ thống 2026-10-03

Baseline main `527f42640791d9f1451cfef91c6260736136ec9c` (CI run 617 xanh). Nhánh `claude/intelligent-cannon-mcjw7a`, PR #99.

## Kiểm tra local có bằng chứng

Môi trường: Node 24.21.0, PostgreSQL 16.14 (CI: 17.6), Chromium 1194 (headless shell và bản đầy đủ) liên kết cho Playwright 1.63.

| Lớp                                       | Lệnh                                                                        | SHA                | Kết quả                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| Quality baseline                          | `format:check`, `lint`, `typecheck`, `build`                                | 527f426            | exit 0                                                                              |
| Migration/seed/bootstrap                  | `run-migrations.mjs` ×2, `seed:production` ×2, `bootstrap-admin:production` | 527f426            | exit 0                                                                              |
| Workspace tests baseline                  | `npm run test` (RUN_POSTGRES_TESTS=1)                                       | 527f426            | API 88, web 333, worker 33, contracts 129, database 275, domain 77 — 0 fail, 0 skip |
| Workspace tests sau sửa (DB mới)          | quality + migrate×2 + seed×2 + bootstrap + `npm run test`                   | 36a91d5            | API 89, web 358, worker 33, contracts 129, database 281, domain 77 — 0 fail, 0 skip |
| Browser mock                              | `npm run e2e`                                                               | 9b36563            | 46 pass, 12 skip theo project, 0 fail                                               |
| Browser mock (lại)                        | `npm run e2e`                                                               | b1710e9            | 47 pass, 13 skip theo project, 0 flaky, 0 fail                                      |
| Browser live (API 3100 → PostgreSQL test) | `npm run e2e:live`                                                          | 61067db            | 27 pass, 0 fail                                                                     |
| Browser production bundle                 | `npm run e2e:production -w @idosi/web`                                      | ca14489 + sửa test | 60 pass, 10 skip theo project, 0 flaky, 0 fail                                      |

Lượt `e2e:production` đầu tiên không dùng làm bằng chứng: một build mock chạy song song đã ghi đè `dist` mà preview 4175 đang phục vụ. Lượt thứ hai có 2 fail do thiếu Chromium đầy đủ cho persistent context (môi trường) và 1 flaky ở `desktop-login-shell.spec.ts`: test đọc `box-shadow` ngay khi focus trong lúc transition 140ms còn chạy — đã sửa bằng `expect.poll`, không đổi giá trị kỳ vọng.

CI lượt đầu của PR (ca14489) đỏ ở `compact-ui.spec.ts` project mobile-390: test truy vấn link menu khi drawer đang đóng — giả định cũ trái với A11Y-NAV-01. Test giờ mở menu trước (b1710e9); lượt local trước đó chỉ chạy lại một phần suite mock sau 61067db nên không bắt được.

## Điều kiện triển khai

Không có migration. CI đúng HEAD phải xanh trước merge. Sau merge, watcher VPS tự triển khai merge SHA; xác minh `running=<merge SHA>`, `state=deployed|up-to-date`, `/health`, `/ready`, `/openapi.json`, asset và smoke chỉ đọc. Rollback: image SHA trước theo runbook (thay đổi không đụng dữ liệu).

Giới hạn: môi trường agent bị chặn egress tới `khoidosi.io.vn` và không có SSH, nên phần xác minh production phải do người có quyền thực hiện hoặc sau khi mở quyền mạng/SSH.

---

# Hồ sơ release desktop tables / workflow audit

Baseline khảo sát: 1991069f4f0542edec45ec3fd3fb79f46941db17. Nhánh: fix/desktop-tables-workflow-audit.

Hồ sơ này ghi phạm vi kiểm tra trước release. Commit/PR/CI/merge/running SHA cuối cùng cần đối chiếu với báo cáo bàn giao và watcher; không được suy ra deploy chỉ từ main hoặc HTTP 200.

## Kiểm tra local đã có bằng chứng

- Node 24.19.0; dependencies cài theo lockfile bằng npm 11.9.0; PostgreSQL 17.6 trong container test riêng.
- Migration trực tiếp chạy hai lần thành công; seed/bootstrap thành công. Wrapper run-migrations.mjs không chạy được trên Windows do spawn npm ENOENT; đường wrapper chính thức phải được xác minh bằng CI Linux.
- Bộ workspace: API 85, web 310, worker 31, contracts 129, database 243, domain 77: 875 pass, không bỏ qua PostgreSQL.
- Ba bài transaction-recovery nằm trong 243 bài database: deadlock retry, pool saturation recovery, lock timeout rollback.
- Browser production build: 17 pass, một zoom mobile N/A.
- Lượt mock từng chạy đồng thời với live gây mất trace do chung test-results; lượt đó không dùng làm gate. Chạy lại các suite browser tuần tự.

## Điều kiện triển khai

CI đúng SHA phải đạt quality, migration fresh/repeat, seed repeat, PostgreSQL, browser mock/production/live và kiểm tra infra. Sau merge để watcher tự triển khai theo runbook; không tạo đường deploy cạnh tranh. Xác minh backup/checksum của watcher, running=<merge SHA>, state=deployed hoặc up-to-date, health/ready, container health, asset đang phục vụ và smoke/đối soát liên quan. Không chạy test phá hủy hoặc tạo giao dịch thử trên production.

Không có migration mới. Rollback bằng cơ chế runbook về image/SHA trước; không rollback dữ liệu hoặc xóa ledger. Production baseline đã được kiểm tra qua SSH: watcher up-to-date và running đúng baseline trước sửa. Trạng thái release của nhánh này chưa được chứng nhận trong bản ghi trước merge này.

- Ngày 30/09: production build 17 pass/1 N/A; live PostgreSQL 23 pass; mock 26 pass/6 skip. Browser chạy tuần tự, output riêng; chi tiết test/annotation lưu trong JSON artifact.
- Quality chạy trước live trên DB test mới. Chạy lại toàn bộ suite trên DB đã chứa các phiên hiện tại do live tạo không tương đương CI fresh DB; từng gây xung đột fixture lịch/quota và được tách khỏi kết quả gate.
- Trước release 30/09: watcher baseline up-to-date, 5 container healthy, đĩa 63% (11GB trống), RAM available1732MB.

- Kiểm tra cuối: format:check, lint, typecheck exit0. Sau nới cột diễn giải nhập kho, route/tab88PASS và production17pass/1N/A được chạy lại.
- Đối soát production chỉ đọc trước release: 0 lệch balance–ledger, 0 tồn âm/giữ vượt tồn, 0 outbound thiếu nguồn, 0 sai lượng xuất/nhận, 0 sai bảo toàn phiếu chờ, 0 reservation consumed vượt quantity. Không đối chiếu toàn bộ báo cáo tiền/kg trong câu SQL này.
