# HTKD: tồn kho tổng, phiếu ưu tiên và danh sách phiếu chờ

## Phạm vi và quyền

| Chức năng                                                              | ADMIN                               | HTKD                                            | STORE / WHOLESALE |
| ---------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- | ----------------- |
| Đọc tồn kho tổng                                                       | Có                                  | Có, số tổng trung tâm                           | Có, chỉ xem¹      |
| Điều chỉnh kho tổng, lịch sử xuất/điều chỉnh, kiểm thiếu toàn hệ thống | Quyền hiện có                       | Không mở thêm                                   | Không mở thêm     |
| Đọc/phản hồi ưu tiên                                                   | Đọc, không nhận thay                | Cửa hàng đang hoạt động được phân công hiện tại | Phạm vi hiện có   |
| Hủy phần còn chờ                                                       | Mọi cửa hàng, kể cả ngừng hoạt động | Cửa hàng đang hoạt động được phân công hiện tại | Phạm vi hiện có   |
| Tab chính Danh sách phiếu chờ                                          | Có                                  | Không                                           | Không             |

¹ Mở rộng sau bản này: xem `warehouse-stock-read-access.md`.

Trước thay đổi, notice và phản hồi HTKD đã có nhưng kho tổng và hủy phiếu bị chặn có chủ đích. Bản này dùng lại notice 15 giây, transaction/state machine và dialog chung. HTKD không có phiếu riêng, không giả actor STORE. Nhận ưu tiên không phải thực nhận, không cộng tồn cửa hàng.

## Đường dữ liệu và file

- `InventoryOperations`, `inventoryNavigation`, `WarehouseInventory`: workspace Kho tổng/Kho cửa hàng cho HTKD; deep link đặc quyền bị thu về tồn hiện tại; không mount query/dialog Admin. API và repository cùng chặn quyền ghi.
- `PriorityOfferNotice`, `WaitlistPanel`: notice nhiều cửa hàng, mở đúng lịch sử, hủy chung, tải lại sau conflict/thu hồi quyền, không render dữ liệu cache khi query lỗi. Query tồn và phiếu có account scope.
- `AllocationPage`, `WaitTicketList`, `WaitTicketTable`, `waitTicketListNavigation`: tab Admin lazy mount, URL `tab=wait-tickets&wt.*`, 9 cột và cuộn ngang cục bộ. Bộ lọc độc lập với lịch sử đặt hàng. Ngày là ngày tạo phiếu tại Việt Nam.
- `contracts/waitlist`, API routes/OpenAPI/repositories: thêm q/ngày và projection TABLE, metadata tên/mã/lượt/actor. Helper `listWaitTicketsPage` chỉ lấy một trang; caller cũ vẫn dùng helper cũ.
- `database/wait-ticket-operations`, `idempotency`: kiểm tra actor/phân công/cửa hàng trong transaction trước cả replay. Hủy giữ lượng đã cấp và reservation; chỉ trả hold của offer chưa phân bổ. Audit `WAIT_TICKET_HTKD_CANCELLED` ghi tài khoản HTKD thật và cửa hàng đích.
- Schema/migrations và reset schema fingerprint: mở rộng check, thêm index phân trang, cập nhật fingerprint từ catalog PostgreSQL 17 đã kiểm chứng. Không bỏ/giảm guard reset.

## Quy tắc bảng

Server đếm/lọc/phân trang trên phiếu chờ, sắp `created_at DESC, id DESC`. Mỗi phiếu một dòng. Sau khi lấy trang mới lấy tên, một offer và actor hủy bằng batch; không JOIN mọi offer vào trang/count. Offer được chọn ưu tiên lượt còn sống chưa tiêu thụ theo predicate nghiệp vụ hiện có, rồi mới lượt lịch sử mới nhất theo thời gian/ID. Tìm PUT dùng EXISTS trên tất cả lượt nên tìm mã cũ vẫn ra đúng phiếu, trong khi cột mã hiển thị lượt được quy tắc chọn. Chi tiết tải đủ các trang offer; nhật ký ghi rõ giới hạn 100 sự kiện gần nhất.

Ngày từ bao gồm 00:00:00 +07; ngày đến dùng biên độc quyền 00:00:00 +07 của ngày kế tiếp. Không phụ thuộc timezone máy chủ. Mặc định mọi trạng thái, gồm phiếu không offer và đã hủy. Số lượng là remaining, kể cả lượng đã hủy; không lấy offeredQuantity. Legacy KG giữ đơn vị gốc, không đoán số bao. Legacy thiếu lý do/actor ghi trung thực, không backfill suy đoán.

Lượt qua deadline nhưng worker chưa xử lý chỉ có chú thích chờ hệ thống; trình duyệt không ghi CANCELLED. FULL/PARTIAL và phiên/deadline không đổi. Xem `wait-ticket-cancellation.md`.

## Migration, tương thích và xử lý sự cố

- `0039_htkd_wait_ticket_access`: mở rộng CHECK để nhận `htkd_cancelled`, không thay đổi bản ghi cũ.
- `0040_wait_ticket_page_index`: index `(created_at,id)` cho các dòng chưa xóa. Index thường được tạo trong giao dịch migration; theo dõi thời gian lock nếu dữ liệu tương lai lớn hơn đáng kể.
- Không có backfill; không sửa migration đã deploy. Migration chạy lại không tạo tác dụng thêm qua journal.
- `projection=TABLE` là opt-in: response list không có projection giữ nguyên các trường legacy, được kiểm thử qua API PostgreSQL. Client mới đọc được các loại hủy cũ và HTKD; tab đang mở từ phiên bản cũ cần tải lại khi có `HTKD_CANCELLED`.
- Sau khi có loại hủy HTKD, **không rollback thẳng về image 242c611**: contract cũ không đọc được enum mới. Không thu hẹp CHECK, không đổi loại hủy, không restore đè DB để ép image cũ chạy.
- Nền tương thích `ddb23c1d2cb75f867ba63c164ca6a5b0592e7836` tách riêng schema/contracts/parser với chính sách quyền/UI cũ. Đã kiểm thử độc lập typecheck, production build, 139 contract tests, 377 web tests và đọc bản ghi HTKD_CANCELLED thật từ PostgreSQL fixture qua repository + runtime schema. Nếu cần khôi phục chức năng cũ, tạo PR forward-fix trên main chỉ đảo phần feature phía sau nền này; giữ nguyên migration/enum/parser. Chạy lại toàn CI và để watcher deploy SHA main mới. Đây là source khôi phục đã kiểm chứng, chưa phải một image production đã phát hành.
- Phương án khắc phục là forward-fix từ SHA release: giữ parser/label `HTKD_CANCELLED`, CHECK và migrations 0039/0040; nếu cần ngăn phát sinh mới thì đưa allowlist route cancel/repository về ADMIN/STORE/WHOLESALE và ẩn nút hủy HTKD, giữ khả năng đọc lịch sử. Lỗi bảng có thể tạm ẩn tab mới và giữ bảng giám sát cũ, nhưng vẫn giữ parser mới. PR khắc phục phải chạy contract/API/PG cancellation, build và CI đầy đủ trước khi watcher triển khai. Đây là phương án cần kiểm thử tại thời điểm tạo bản khắc phục, không phải tuyên bố đã có image rollback được phát hành.
- Nếu có lỗi dữ liệu/quyền, dừng thao tác bị ảnh hưởng và xử lý theo runbook; không chỉnh ledger/audit hay volume để che lỗi. Backup/checksum và khả năng đọc dump phải kiểm tra trước release. Watcher là đường deploy chuẩn.

## Kiểm chứng

Các suite mới/mở rộng:

- API PostgreSQL: hủy HTKD, actor audit, thu hồi session và replay, response projection cũ/mới.
- Database cancellation (13 ca): scope/khóa/ngừng cửa hàng, hai HTKD, accept/accept, accept/decline, hủy/accept, hủy/expire, thu hồi phân công, replay/conflict, FULL/PARTIAL/legacy, quantity/hold, nhiều lượt không trùng dòng và ngày biên Việt Nam.
- Contracts/component/navigation: enum, thời gian, 9 cột, legacy, URL và HTKD deep link.
- `e2e/prominent-tabs.spec.ts`: truy cập trực tiếp, lazy query, server paging, hủy/tra cứu lại, reload/URL, viewport 360/390/412/768/1366/1440/1920 và local scroll.
- `e2e-live/htkd-priority-waitlist.spec.ts`: ba browser context với API/PG thật, HTKD hai cửa hàng + cửa hàng ngoài scope, notice mới trong 20 giây, STORE phản hồi/HTKD cập nhật, HTKD hủy, audit, tồn đối chiếu DB, thu hồi quyền, HTKD không phân công và STORE đọc kho tổng (chỉ xem, không điều chỉnh).

Lệnh chính: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e`, `npm run e2e:production -w @idosi/web`, `npm run e2e:live`, cùng migration/infra/container gates trong CI.

PG tests phải dùng database cô lập mới, seed và bootstrap trước toàn suite như CI. Chạy lại toàn suite trên DB đã có fixtures có thể chọn Admin đã bị khóa của test khác (một số test cũ dùng role+LIMIT 1); không được coi lỗi fixture đó là PASS. Không chạy E2E ghi dữ liệu trên production.

Thử index tại PostgreSQL 17 cô lập với 20.214 phiếu (20.000 thêm trong transaction rồi ROLLBACK): truy vấn trang đầu chỉ id/createdAt dùng Index Only Scan Backward, 0,075 ms, 7 shared buffer hits; count 3,044 ms. Đây là phép đo truy vấn cơ sở trên fixture, không phải SLA cho toàn API/search trên production.

Ảnh/trace và kết quả CI là artifact của run, không commit dữ liệu test vào source. `e2e:production` port 4175 và `e2e:live` port 4174/3100 là local, không phải bằng chứng VPS. Chỉ xác nhận production khi watcher target/running cùng full SHA và health/readiness/container/migration cùng kiểm tra đọc theo role đạt.

Kết quả local tại thời điểm mở PR: Linux Node 24/PostgreSQL 17 trên DB mới đạt 1.050 tests (API 95, web 380, worker 43, contracts 139, database 311, domain 82), không skip; migrate 2 lần và build đạt. Production-preview Windows đạt 68/68 ca áp dụng, 10 skip do project mobile; chạy tuần tự để tránh Edge extension zoom treo khi tranh tài nguyên. Live E2E mới đạt 1/1 với PostgreSQL thật. Format/lint/typecheck và kiểm thử UI cuối đạt; CI/main/watcher phải xác minh riêng sau PR.
