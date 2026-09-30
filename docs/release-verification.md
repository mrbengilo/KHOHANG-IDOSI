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
