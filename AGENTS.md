# AGENTS.md — KHOHANG-IDOSI

## 1. Phạm vi và mục tiêu

Các chỉ dẫn trong file này áp dụng cho toàn bộ repository `mrbengilo/KHOHANG-IDOSI`.

Mục tiêu của hệ thống là quản lý nhu cầu, phân bổ, nhập, xuất và tồn kho IDOSI một cách chính xác, công bằng, có thể kiểm toán, vận hành ổn định trên desktop và mobile.

Mọi agent/kỹ sư làm việc trong repository phải ưu tiên theo thứ tự:

1. Đúng nghiệp vụ và không làm sai dữ liệu.
2. Bảo mật, phân quyền và khả năng kiểm toán.
3. Tính nhất quán khi có nhiều thao tác đồng thời.
4. Hiệu năng thực tế và trải nghiệm người dùng.
5. Clean code, ít lặp, dễ đọc, dễ kiểm thử và dễ bảo trì.
6. Thay đổi tối thiểu nhưng giải quyết đầy đủ nguyên nhân gốc.
7. Triển khai an toàn, có backup, kiểm tra và rollback.

Không đánh đổi tính đúng đắn của tồn kho để lấy cảm giác giao diện nhanh hơn.

## 2. Nguyên tắc làm việc bắt buộc

- Đọc toàn bộ task và các chỉ dẫn trong repository trước khi sửa code.
- Kiểm tra `git status`, nhánh hiện tại, thay đổi chưa commit, tài liệu, cấu trúc source, schema, migration, scripts và CI.
- Không ghi đè hoặc xóa thay đổi không thuộc task.
- Không tự mở rộng phạm vi ngoài yêu cầu nếu chưa chứng minh cần thiết.
- Không sửa triệu chứng khi chưa xác định nguyên nhân gốc.
- Không đoán tên lệnh test, build hoặc deploy; phải đọc scripts thực tế trong repository.
- Không báo “đã sửa”, “đã kiểm thử”, “đã merge” hoặc “đã deploy” khi chưa có bằng chứng.
- Không bỏ qua lỗi cũ nếu lỗi đó nằm trên đường chạy bị task tác động.
- Không hard-code cửa hàng, SKU, tài khoản, vai trò, ngày nghiệp vụ hoặc chính sách phân bổ.
- Không commit secret, token, mật khẩu, khóa SSH, file `.env`, dữ liệu production hoặc bản backup.
- Không lưu mật khẩu gốc. Mật khẩu phải được băm; Admin chỉ được đặt lại mật khẩu.
- Mọi thao tác nhạy cảm phải được kiểm tra quyền tại server, không chỉ ẩn nút ở frontend.
- Mọi thay đổi database phải có migration xác định, có thể kiểm thử và có kế hoạch rollback hoặc forward-fix.
- Ưu tiên giải pháp đơn giản nhất đáp ứng đầy đủ invariant và acceptance criteria; tránh abstraction, cache, queue hoặc microservice không có số liệu chứng minh cần thiết.

## 3. Ràng buộc nghiệp vụ kho IDOSI

Các invariant sau là bắt buộc, trừ khi task mới thay đổi rõ ràng yêu cầu:

- Hệ thống có ba phạm vi vai trò chính: Admin, HTKD và Tài khoản cửa hàng.
- Admin xem và quản lý toàn hệ thống.
- HTKD chỉ xem/thao tác các cửa hàng được phân công; một HTKD có thể quản lý nhiều cửa hàng.
- Tài khoản cửa hàng chỉ xem/thao tác dữ liệu của chính cửa hàng đó.
- Phân quyền phải kiểm tra server-side theo vai trò, `store_id` và trạng thái tài khoản.
- Khóa tài khoản hoặc gỡ quyền phải có hiệu lực ngay và thu hồi session liên quan.
- Hiện có 14 cửa hàng nhưng cửa hàng và SKU phải quản lý động, tuyệt đối không hard-code số lượng.
- Mỗi cửa hàng được gửi tối đa hai yêu cầu trong một phiên theo quy trình hiện hành.
- 08:00 là mốc chụp tồn và xử lý ưu tiên; 09:00 là mốc chốt phản hồi/phân bổ theo quy trình hiện hành.
- Phân bổ theo thứ tự chính sách P0A đến P3 và theo vòng.
- Khi hàng khan hiếm, mỗi cửa hàng nhận tối đa một đơn vị trong một vòng trước khi sang vòng tiếp theo.
- Phần chưa được cấp phải chuyển đúng vào phiếu chờ.
- Không cấp trùng, không trừ tồn trùng và không tăng tồn khi chưa xác nhận thực nhận.
- Cửa hàng phải khai nhận đủ hoặc nhận thiếu theo số lượng thực tế.
- Luồng nhập có thể gồm số kg từng bao, giá/kg, phí vận chuyển và phí bốc vác.
- Mọi thay đổi nhập, xuất, giữ hàng, phân bổ, hoàn trả và điều chỉnh tồn phải nguyên tử.
- Mọi command ghi dữ liệu phải idempotent hoặc có idempotency key phù hợp.
- Lịch sử phân bổ, lý do, lượt/vòng, người thao tác và dữ liệu trước/sau phải truy xuất được.
- Audit quan trọng phải bất biến; không xóa cứng chứng từ đã phát sinh giao dịch.
- Tiền VND không dùng floating point. Khối lượng phải dùng kiểu decimal có độ chính xác xác định.
- Số tồn hiện tại phải đối soát được với sổ phát sinh kho.

Nếu task thay đổi một invariant, phải:
1. Nêu rõ invariant cũ và mới.
2. Phân tích dữ liệu lịch sử bị ảnh hưởng.
3. Bổ sung migration/backfill nếu cần.
4. Bổ sung test hồi quy cho cả dữ liệu mới và legacy.
5. Ghi rõ thay đổi trong PR.

## 4. Kiến trúc mục tiêu

Trừ khi repository thực tế hoặc task chỉ định khác, định hướng kỹ thuật là:

- TypeScript end-to-end.
- Frontend: React 19, Vite, React Router, TanStack Query.
- Backend: Node.js 24 LTS và Fastify.
- Database production: PostgreSQL; truy cập dữ liệu bằng Drizzle và SQL có kiểm soát.
- Background processing: worker riêng; trạng thái nghiệp vụ vẫn nằm trong PostgreSQL.
- API: REST + OpenAPI, schema validation tại runtime.
- Deploy: Docker Compose, Caddy/Cloudflare, image bất biến gắn với commit SHA.
- File/ảnh: object storage khi phù hợp; không tải ảnh gốc nặng qua API nếu không cần.

Kiến trúc mặc định là modular monolith. Không tách microservice nếu chưa có ranh giới domain, nhu cầu scale hoặc yêu cầu vận hành đủ rõ.

Cấu trúc tham chiếu:

```text
apps/
  web/
  api/
  worker/

packages/
  contracts/
  domain/
  database/
  ui/
  observability/
  test-utils/
```

- `domain` không phụ thuộc React, Fastify hoặc database adapter.
- `contracts` định nghĩa request/response, schema và mã lỗi.
- `database` chứa schema, migration, query và transaction helper.
- `web` không truy cập trực tiếp database.
- `worker` dùng lại application/domain use case nhưng chạy bằng entrypoint riêng.
- Không tạo `BaseService`, `GenericRepository<T>` hoặc abstraction chỉ có một implementation nếu không đem lại giá trị kiểm thử hoặc thay thế rõ ràng.

## 5. Quy trình xử lý một task

### Bước 1 — Đọc, phân tích và chia phạm vi

Trước khi chỉnh sửa:

1. Viết lại mục tiêu task bằng ngôn ngữ kỹ thuật rõ ràng.
2. Liệt kê hành vi hiện tại, hành vi mong muốn và acceptance criteria.
3. Gom các vấn đề có cùng nguyên nhân; tách các vấn đề độc lập.
4. Xác định vai trò, màn hình, API, bảng dữ liệu, worker và luồng deploy bị ảnh hưởng.
5. Kiểm tra dữ liệu legacy, khả năng tương thích ngược và rủi ro migration.
6. Lập kế hoạch triển khai và kế hoạch kiểm thử.
7. Chia thay đổi thành các commit nguyên tử trước khi code.

Không bắt đầu sửa khi yêu cầu còn mâu thuẫn làm thay đổi đáng kể kết quả. Nếu có thể tiếp tục bằng giả định an toàn, nêu rõ giả định và tiếp tục.

### Bước 2 — Tìm nguyên nhân gốc và nguyên nhân liên quan

Phải tái hiện lỗi hoặc thu thập bằng chứng trước khi sửa:

- Lần theo đầy đủ luồng UI → state/query → API → application/domain → SQL/database → worker.
- Kiểm tra log, request ID, network timing, query timing, execution plan và dữ liệu liên quan.
- So sánh working path với failing path.
- Xác định nguyên nhân gốc, điều kiện kích hoạt và phạm vi ảnh hưởng.
- Kiểm tra các màn hình/use case dùng chung code hoặc cùng dữ liệu để tìm lỗi liên quan.
- Phân biệt rõ nguyên nhân, triệu chứng và yếu tố làm lỗi nghiêm trọng hơn.
- Với lỗi concurrency, phải tạo test chạy song song; không kết luận chỉ từ test tuần tự.
- Với lỗi hiệu năng, phải có baseline trước và số đo sau; không tối ưu theo cảm giác.

Không dùng delay, retry vô hạn, reload trang hoặc tăng timeout để che nguyên nhân gốc.

### Bước 3 — Thiết kế giải pháp tối ưu

Giải pháp phải:

- Giải quyết nguyên nhân gốc và các đường chạy liên quan.
- Duy trì invariant nghiệp vụ và tính tương thích dữ liệu.
- Giới hạn thay đổi trong phạm vi nhỏ nhất hợp lý.
- Có transaction boundary rõ ràng.
- Có idempotency, unique constraint hoặc locking khi nghiệp vụ cần.
- Trả lỗi có cấu trúc, không nuốt exception.
- Không tạo N+1 query, quét toàn bảng hoặc tải toàn bộ dataset khi chỉ cần một phần.
- Có index phù hợp với predicate và sort thực tế.
- Tách công việc nặng khỏi HTTP request nếu gây block.
- Không cache trước khi xác định dữ liệu, thời gian sống và cơ chế invalidation.
- Không optimistic update đối với nhập, xuất, phân bổ hoặc điều chỉnh tồn trước khi server xác nhận.
- Cho phép quan sát bằng structured log, metric hoặc trace phù hợp.
- Ghi chú “vì sao” với phần logic khó; không viết comment lặp lại code.

Thuật toán phân bổ nên là pure function nhận snapshot, yêu cầu, phiếu chờ và phiên bản chính sách, sau đó trả kết quả xác định. Việc ghi kết quả phải được bảo vệ bằng transaction, lock phù hợp và idempotency.

### Bước 4 — Thiết kế UI/UX

Mọi thay đổi UI phải được đánh giá trên desktop và mobile.

Yêu cầu bắt buộc:

- Bố cục rõ ràng, phân cấp thị giác tốt, màu sắc nhất quán với design system.
- Không có nội dung, bảng, modal, card hoặc button tràn màn hình.
- Button phải nổi bật đúng mức độ hành động, có label rõ ràng và nội dung luôn nằm gọn.
- Không để chữ/icon đè nhau, bị cắt, che thông tin hoặc xuống dòng ngoài chủ đích.
- Button có trạng thái hover, focus-visible, active, loading, disabled, success và error phù hợp.
- Khi loading, giữ kích thước button để bố cục không giật.
- Vùng bấm trên mobile đủ lớn; icon-only button phải có accessible name/tooltip.
- Hành động chính và nguy hiểm phải phân biệt rõ; thao tác xóa cần xác nhận và mô tả đúng đối tượng.
- Sử dụng CSS Grid/Flex với `minmax()`, `min-width: 0` và breakpoint hợp lý; tránh fixed width không cần thiết.
- Mobile ưu tiên nội dung quan trọng, có thể chuyển bảng thành card hoặc dùng scroll có chủ đích.
- Không làm giảm font đến mức khó đọc chỉ để nhét nội dung.
- Có đầy đủ empty state, loading state, error state, permission-denied state và retry state.
- Không xóa nội dung cũ khỏi màn hình trong khi refetch nếu có thể giữ dữ liệu an toàn.
- Route và module phải lazy-load; không tải dữ liệu của màn hình chưa mở.
- Danh sách lớn phải phân trang/filter/sort phía server và virtualize khi cần.
- Thông báo thành công/thất bại phải cụ thể, không dùng thông báo chung chung.

Kiểm tra tối thiểu tại các viewport đại diện:

- Mobile nhỏ: 360 px.
- Mobile phổ biến: 390/412 px.
- Tablet: 768 px.
- Desktop: 1366 px.
- Desktop rộng: 1440 px trở lên.

Đối với thay đổi giao diện, PR phải có ảnh hoặc video trước/sau ở desktop và mobile nếu công cụ cho phép.

### Bước 5 — Triển khai và kiểm thử toàn bộ

Triển khai code theo từng lát dọc có thể kiểm chứng. Sau mỗi phần:

1. Chạy formatter/lint liên quan.
2. Chạy typecheck.
3. Chạy unit test gần nhất.
4. Chạy integration test nếu chạm API/database.
5. Chạy UI/E2E nếu thay đổi hành vi người dùng.
6. Review diff trước khi commit.

Trước khi hoàn tất task, phải chạy các quality gate thực tế có trong repository, thường gồm:

- Format check.
- Lint.
- Typecheck.
- Unit test.
- Integration test.
- Build production.
- E2E/smoke test.
- Migration test.
- Security/authorization regression.
- Performance test khi task liên quan hiệu năng.
- Responsive/visual verification khi task liên quan UI.

Không được bỏ test chỉ vì thay đổi nhỏ. Nếu không thể chạy một kiểm thử, phải ghi chính xác kiểm thử nào chưa chạy, lý do và rủi ro còn lại.

Các test bắt buộc cho nghiệp vụ tồn kho/phân bổ liên quan:

- Tổng lượng phân bổ không vượt snapshot tồn.
- Không cấp trùng một yêu cầu/SKU.
- Chạy lại cùng idempotency key không tạo thêm giao dịch.
- Hai request đồng thời không làm âm tồn hoặc double allocation.
- Balance khớp tổng ledger.
- Nhận thiếu không tự cộng đủ vào tồn.
- Phạm vi Admin/HTKD/Cửa hàng được kiểm tra server-side.
- Tài khoản bị khóa hoặc gỡ quyền không tiếp tục dùng session cũ.
- Job 08:00/09:00 retry/catch-up không tạo kết quả trùng.
- Dữ liệu legacy vẫn đọc và xử lý đúng theo chính sách đã xác định.

Ưu tiên:

- Unit/domain: Vitest.
- Property-based test cho thuật toán phân bổ: fast-check.
- Integration với PostgreSQL thật: Testcontainers.
- UI/E2E: Playwright.
- Load/concurrency: k6 hoặc công cụ hiện có trong repository.

### Bước 6 — Git, GitHub, review và merge

Quy tắc Git:

- Tạo branch theo loại task: `feat/*`, `fix/*`, `perf/*`, `refactor/*`, `docs/*`, `chore/*`.
- Không làm việc trực tiếp trên `main`, trừ commit khởi tạo repository hoặc khi người sở hữu yêu cầu rõ ràng.
- Một commit chỉ giải quyết một concern có thể review.
- Không trộn format toàn repository vào commit sửa nghiệp vụ.
- Không commit code dở, log debug hoặc test bị skip không có lý do.
- Dùng Conventional Commits, ví dụ:
  - `fix(allocation): prevent duplicate reservation on retry`
  - `perf(inventory): add indexed store and sku query`
  - `feat(ui): add responsive allocation summary`
  - `test(allocation): cover concurrent scarce-stock rounds`

Trước khi push:

1. Review `git diff` và danh sách file thay đổi.
2. Xác nhận không có secret/dữ liệu production.
3. Chạy lại quality gate cần thiết.
4. Rebase hoặc cập nhật branch an toàn nếu base đã thay đổi.
5. Push đúng branch.

Pull request phải có:

- Bối cảnh và vấn đề.
- Cách tái hiện.
- Nguyên nhân gốc và nguyên nhân liên quan.
- Giải pháp và lý do chọn giải pháp.
- Danh sách commit.
- Database/migration/index bị ảnh hưởng.
- Tác động phân quyền và bảo mật.
- Kết quả kiểm thử kèm lệnh đã chạy.
- Số đo trước/sau nếu liên quan hiệu năng.
- Ảnh/video desktop và mobile nếu liên quan UI.
- Rủi ro còn lại.
- Kế hoạch deploy và rollback.
- Checklist acceptance criteria.

Chỉ merge khi:

- CI GitHub xanh.
- Build production thành công.
- Không còn review thread chưa xử lý.
- Migration đã được kiểm tra.
- Không có lỗi severity cao.
- Branch không chứa thay đổi ngoài phạm vi.
- Kết quả cuối cùng đáp ứng acceptance criteria.

Không rerun CI liên tục để tìm một lần xanh. Phải tìm nguyên nhân flaky test hoặc lỗi môi trường. Không force-push `main`. Ưu tiên squash merge nếu repository chưa quy định chiến lược khác.

### Bước 7 — Deploy VPS

Chỉ deploy commit đã merge và xác định bằng SHA. Không build/deploy từ working tree chưa commit.

Pre-deploy:

1. Xác nhận đúng VPS, môi trường và domain.
2. Ghi lại SHA/image hiện đang chạy.
3. Kiểm tra disk, memory, CPU, container và database health.
4. Backup database và file cần thiết ra vị trí không bị deployment ghi đè.
5. Xác minh backup đọc được và không làm đầy ổ đĩa.
6. Kiểm tra environment variables mà không in secret.
7. Xác nhận migration tương thích với phiên bản ứng dụng cũ và mới.
8. Chuẩn bị lệnh rollback/image SHA trước đó.

Deploy:

- Build image bất biến từ đúng merged commit SHA.
- Pull/deploy bằng quy trình có sẵn trong repository.
- Chạy migration một lần, có lock, timeout và log rõ ràng.
- Dùng expand/contract migration với thay đổi không tương thích.
- Khởi động service theo thứ tự phụ thuộc.
- Chờ readiness trước khi chuyển traffic.
- Không xóa volume database hoặc backup.

Post-deploy:

1. Kiểm tra health/readiness.
2. Kiểm tra log lỗi và migration.
3. Smoke test đăng nhập và phân quyền ba vai trò.
4. Smoke test màn hình/API bị thay đổi.
5. Với task kho: kiểm tra đọc tồn, tạo yêu cầu, phân bổ thử an toàn, nhận đủ/thiếu và audit phù hợp phạm vi task.
6. Kiểm tra desktop và mobile nếu thay đổi UI.
7. Theo dõi error rate, latency và tài nguyên.
8. Đối chiếu SHA đang chạy với SHA đã merge.

Rollback ngay khi có lỗi dữ liệu, lỗi phân quyền, migration không an toàn, error rate tăng mạnh hoặc luồng chính không hoạt động. Sau rollback phải xác nhận health và dữ liệu.

Không tuyên bố deploy thành công chỉ dựa trên việc container “running”.

## 6. Chiến lược chia commit

Lập danh sách commit trước khi code. Ví dụ với một task có backend, UI và test:

1. `test(...): reproduce current failure`
2. `fix(...): correct domain and transaction behavior`
3. `feat(ui): update responsive interaction`
4. `test(e2e): cover user workflow and regression`
5. `docs(...): document migration or operation changes`

Có thể gộp commit test với code khi test không có giá trị độc lập, nhưng không tạo nhiều commit hình thức. Mỗi commit phải build/test được trong phạm vi hợp lý và dễ revert.

## 7. Performance và observability

- Đo từ trình duyệt đến database, không chỉ đo thời gian handler.
- Không tải toàn bộ dữ liệu lúc đăng nhập.
- Mỗi màn hình chỉ gọi projection/endpoint cần thiết.
- Sử dụng server-side pagination, filtering và sorting.
- Chọn index theo query thực tế và kiểm tra bằng execution plan.
- Đặt slow-query logging và request ID.
- Theo dõi p50/p95/p99, error rate, event-loop lag, connection pool và worker backlog.
- Với tối ưu hiệu năng, ghi baseline, môi trường đo, dữ liệu mẫu và kết quả sau thay đổi.
- Không chấp nhận tối ưu làm thay đổi kết quả nghiệp vụ.
- Thiết lập performance budget theo baseline; mọi regression đáng kể phải được giải thích.

## 8. Definition of Done

Một task chỉ hoàn thành khi:

- Yêu cầu và acceptance criteria đã được đáp ứng.
- Nguyên nhân gốc được ghi nhận.
- Code đúng scope, dễ đọc và không có duplicate logic không cần thiết.
- Invariant nghiệp vụ, security và authorization vẫn đúng.
- Migration/backfill/index đã được kiểm thử nếu có.
- Unit, integration, build, E2E và responsive checks liên quan đã chạy thành công.
- Diff đã được tự review.
- Commit được chia hợp lý và push lên branch.
- PR mô tả đầy đủ và CI GitHub xanh.
- PR đã merge theo quyền hạn được giao.
- Commit đã merge được deploy lên VPS nếu task yêu cầu production deployment.
- Health check, smoke test và log sau deploy đạt.
- SHA production, kết quả test và rủi ro còn lại được báo cáo rõ ràng.

## 9. Định dạng báo cáo bắt buộc

### Trước khi code

- Tóm tắt task.
- Hành vi hiện tại và hành vi mong muốn.
- Nguyên nhân đã biết/giả thuyết cần kiểm tra.
- Phạm vi file/module/database.
- Rủi ro.
- Acceptance criteria.
- Kế hoạch commit.
- Kế hoạch test.

### Sau khi xác định nguyên nhân

- Bằng chứng tái hiện.
- Nguyên nhân gốc.
- Nguyên nhân liên quan.
- Giải pháp được chọn.
- Phương án đã loại và lý do.

### Khi hoàn thành

- Nội dung đã thay đổi.
- Danh sách commit và SHA.
- PR URL.
- Lệnh kiểm thử và kết quả.
- Migration/backup nếu có.
- CI/merge status.
- Production SHA và trạng thái deploy.
- Smoke test sau deploy.
- Rủi ro hoặc việc còn lại.

## 10. Mẫu prompt giao task

Sử dụng mẫu sau khi giao một task mới:

```text
Bạn đang làm việc trong repository:
https://github.com/mrbengilo/KHOHANG-IDOSI

TASK:
[Mô tả đầy đủ vấn đề, ảnh hưởng và hành vi mong muốn]

DỮ LIỆU/CÁCH TÁI HIỆN:
[Tài khoản test, vai trò, cửa hàng, SKU, thời gian nghiệp vụ, các bước tái hiện, ảnh/video/log liên quan]

ACCEPTANCE CRITERIA:
1. [...]
2. [...]
3. [...]

RÀNG BUỘC:
- Giữ nguyên các nghiệp vụ và dữ liệu không thuộc task.
- Không hard-code cửa hàng, SKU hoặc tài khoản.
- Phân quyền phải kiểm tra server-side.
- Mọi cập nhật tồn kho phải nguyên tử, idempotent và có audit.
- UI phải cân đối, rõ ràng, responsive desktop/mobile.
- Button phải nổi bật đúng vai trò, nội dung nằm gọn, không đè, tràn hoặc che thông tin.
- Không báo hoàn thành nếu chưa có bằng chứng kiểm thử.

Hãy thực hiện toàn bộ quy trình sau:
1. Đọc và phân tích kỹ task; gom vấn đề liên quan, xác định acceptance criteria và chia commit nguyên tử.
2. Tái hiện lỗi; tìm nguyên nhân gốc và các nguyên nhân liên quan bằng bằng chứng.
3. Đề xuất và triển khai giải pháp tối ưu, chính xác, ít rủi ro, clean code và dễ bảo trì.
4. Thiết kế/điều chỉnh UI/UX đẹp, rõ ràng, nhất quán, đầy đủ trạng thái và không lỗi ở desktop/mobile.
5. Chạy toàn bộ test liên quan: lint, typecheck, unit, integration, build, E2E, responsive, authorization, concurrency và migration tùy phạm vi.
6. Push branch, mở PR, tự review diff, xử lý CI/review và chỉ merge khi toàn bộ quality gate xanh.
7. Deploy đúng merged commit SHA lên VPS theo quy trình repository; backup trước deploy, kiểm tra migration, health, smoke test và chuẩn bị rollback.
8. Báo cáo nguyên nhân, giải pháp, file thay đổi, commit SHA, PR, lệnh/kết quả test, production SHA và trạng thái sau deploy.

Trong quá trình thực hiện:
- Không sửa triệu chứng hoặc che lỗi bằng timeout/retry/reload.
- Không bỏ qua lỗi liên quan trên cùng đường chạy.
- Không thay đổi dữ liệu production thủ công nếu chưa có kế hoạch backup và đối soát.
- Nếu bị chặn bởi quyền truy cập, secret, CI hoặc VPS, dừng tại điểm an toàn và báo chính xác blocker.
- Tiếp tục đến khi task hoàn thành hoặc gặp blocker cần quyền/quyết định của chủ repository.
```
