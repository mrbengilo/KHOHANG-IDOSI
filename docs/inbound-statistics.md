# Thống kê nhập hàng

Trang `/inbound-statistics` và `GET /api/v1/reports/inbound-statistics` chỉ dành cho Admin đang hoạt động. Server kiểm tra session và vai trò trước khi đọc báo cáo; phân quyền giao diện là lớp bổ sung.

## Quy tắc số liệu

- **Kho:** phiếu cửa hàng đã `finalized`, chưa xóa, theo `store_receipts.finalized_at`. Mỗi bao thực nhận đóng góp một bao và khối lượng gốc; số lượng nhận thừa đã được chấp nhận cũng được tính. Không lấy số lượng duyệt hoặc giao làm thực nhận.
- **Đối tác khác:** chứng từ `store_partner_inbounds`, theo `received_at`; số bao từ dòng chứng từ và kg từ từng bao gốc. Command hiện hành tạo chứng từ và bao nguyên tử; nguồn này không có trạng thái nháp/hủy hay command sửa chứng từ sau ghi nhận.
- Không đọc nhập nhà cung cấp vào kho trung tâm, chuyển nội bộ, mở bao, phân loại, bán hàng hoặc tồn khả dụng để tính lượng nhập.
- Đây là **tổng nhập gốc (gross)**. Bao đã bán, mở hoặc trả vẫn nằm trong lượng nhập. Không dùng `current_weight_kg` và không trừ hàng trả khỏi tổng nhập.
- Với bao kho đã có điều chỉnh, lấy lần `APPLIED` có `applied_sequence` lớn nhất để xác định SKU và kg hiệu lực. Điều chỉnh thuộc kỳ nhập ban đầu, kể cả được duyệt tháng sau; phiếu cấp bù thuộc kỳ nhận mới. Pending/rejected không thay đổi kết quả.
- Loại cửa hàng lấy từ `stores.kind` hiện tại (`RETAIL`/`WHOLESALE`), không suy từ `group_id`. Báo cáo vẫn bao gồm lịch sử của cửa hàng/mặt hàng ngừng hoạt động. Nếu đổi loại cửa hàng, lịch sử được phân nhóm theo loại hiện tại.
- Ngày/tháng theo `Asia/Ho_Chi_Minh`, khoảng nửa mở `[00:00 đầu kỳ, 00:00 đầu kỳ kế tiếp)`, quy đổi UTC tại server. Ngày lịch không hợp lệ và storeId không thuộc loại đã chọn trả 400.

## Tổng, bộ lọc và độ chính xác

Phạm vi ngày/tháng, loại cửa hàng và cửa hàng áp dụng cho toàn báo cáo. Thẻ tổng quan luôn gồm cả hai nguồn. Bộ lọc nguồn chỉ áp dụng bảng chi tiết, xếp hạng và biểu đồ. Tìm cửa hàng chỉ lọc bảng cửa hàng; tìm mặt hàng chỉ lọc bảng mặt hàng. Tìm kiếm, sắp xếp và phân trang không thay đổi tổng phạm vi hoặc mẫu số tỷ trọng.

API trả số bao và gram nguyên bằng chuỗi; server và formatter dùng `bigint`. Chỉ tỷ trọng và chiều dài thanh biểu đồ chuyển sang số sau phép chia có giới hạn. Không cộng kg bằng floating point, không cộng các trang ở client. Tổng quan, bảng và biểu đồ được tạo từ cùng một snapshot PostgreSQL `REPEATABLE READ READ ONLY`.

Xếp hạng theo số bao, sau đó kg, SKU và ID; đồng hạng số bao được thông báo. Không có mặt hàng dương thì không có xếp hạng; chỉ một mặt hàng thì cả hai vị trí cùng một mặt hàng. Biểu đồ bao/kg có thứ tự riêng; khi vượt 10 mặt hàng, nhóm “Khác” giữ tổng và tách nguồn tương ứng.

Thiếu chi tiết bao lịch sử: giữ số bao đã biết trên dòng chứng từ, kg chỉ là phần đã biết và trả `weightComplete=false`. Nếu số chi tiết vượt số khai nhận, cũng đánh dấu số bao chưa đầy đủ. Tỷ trọng chưa đủ dữ liệu trả null; UI thông báo tổng chưa đầy đủ và không khẳng định xếp hạng toàn bộ. Không nội suy cân nặng từ tồn hiện tại hoặc tự sửa dữ liệu lịch sử. Chứng từ bị mất toàn bộ dòng cần đối soát nguồn và sửa bằng quy trình quản trị dữ liệu, không thể suy SKU từ header.

## Bộ lọc cửa hàng và “Xem chi tiết”

Hai thao tác có phạm vi khác nhau:

- **Bộ lọc “Cửa hàng”/“Loại cửa hàng”** ở đầu trang thay đổi phạm vi toàn báo cáo: tổng quan, phân nhóm, xếp hạng, biểu đồ, bảng cửa hàng và bảng mặt hàng đều tải lại theo cửa hàng đã chọn.
- **“Xem chi tiết”** trên một dòng của bảng “Theo cửa hàng” chỉ mở một dòng chi tiết ngay bên dưới dòng đó. Không đổi bộ lọc, ô tìm kiếm, sắp xếp, số dòng mỗi trang, trang cửa hàng/mặt hàng, tổng hay biểu đồ của báo cáo cha; không điều hướng và không cuộn lên đầu.

Trước bản sửa, nút “Xem chi tiết” ghi `storeId`/`storeKind` vào query toàn trang, xóa hai ô tìm kiếm và đưa hai trang về 1, nên cả báo cáo tải lại cho một cửa hàng: bảng chỉ còn một dòng và không có cách thu gọn. Cửa hàng đang mở giờ là state giao diện riêng (`expandedStoreId`), tách khỏi query báo cáo.

Quy tắc mở/đóng:

- Bấm “Xem chi tiết” mở cửa hàng; nút đổi thành “Thu gọn”. Bấm lại để đóng. Mỗi lúc mở tối đa một cửa hàng; mở B tự đóng A.
- Nút là `button` thật với `aria-expanded`, `aria-controls` và tên truy cập gồm mã/tên cửa hàng; vùng chi tiết là `region` có nhãn là tiêu đề “Chi tiết cửa hàng …”. Thu gọn giữ focus trên nút; dữ liệu về không giành focus.
- Dòng chi tiết là `tr`/`td colSpan=11` trong bảng cửa hàng. Vùng chi tiết rộng tối đa bằng khung “Theo cửa hàng” và dính cạnh trái khi bảng cha cuộn ngang; bảng mặt hàng bên trong cuộn ngang cục bộ, không gây tràn trang.
- Mọi thay đổi của báo cáo cha (kỳ, ngày/tháng, loại/cửa hàng, nguồn, sắp xếp, thứ tự, số dòng, tìm kiếm, phân trang) đóng chi tiết. Logic cập nhật bộ lọc cha giữ nguyên.
- “Làm mới” tải lại báo cáo cha và chi tiết đang mở (cùng tiền tố query key `inbound-statistics`). Nếu danh sách mới không còn cửa hàng đang mở thì chi tiết tự đóng.

Dữ liệu chi tiết:

- Component `InboundStoreDetails` chỉ mount khi có cửa hàng mở, gọi lại `GET /api/v1/reports/inbound-statistics` với kỳ, nguồn, sắp xếp, số dòng của báo cáo đang hiển thị, `storeId`/`storeKind` của dòng, `storePage=1`, `storeSearch=''`, `productSearch=''` và trang mặt hàng riêng. Không có endpoint, migration hay thay đổi SQL mới; không gọi API cho mọi dòng.
- Query key chi tiết là `['inbound-statistics', 'store-detail', query]`, tách khỏi key báo cáo cha. Dữ liệu trang trước chỉ được giữ khi chuyển trang mặt hàng của **cùng** cửa hàng và phạm vi, kèm thông báo đang tải; không bao giờ hiển thị dữ liệu của cửa hàng/kỳ/nguồn khác dưới tiêu đề mới. Response đến muộn của vùng đã đóng không mở lại vùng đó.
- Tổng, dòng tổng và tỷ trọng trong chi tiết lấy từ chính response của cửa hàng đó, nên mẫu số là tổng của cửa hàng theo nguồn đang chọn, không phải tổng báo cáo cha. Hai request khác nhau có thể là hai snapshot khác thời điểm; mỗi response vẫn nhất quán nội bộ và không trộn trường giữa hai response.
- Có trạng thái đang tải, lỗi kèm “Thử lại” (chỉ tải lại chi tiết), trống (ghi rõ cửa hàng, kỳ, nguồn) và cảnh báo thiếu dữ liệu (giá trị chưa biết hiển thị “Đã biết · thiếu dữ liệu”/“Chưa xác định”, không thành 0). Lỗi chi tiết không khóa bảng cửa hàng.
- Bảng cha hiện chỉ giữ một trang khác 1 tại một thời điểm: đổi trang cửa hàng đưa trang mặt hàng về 1 và ngược lại. Đây là hành vi sẵn có của báo cáo cha, bản sửa không thay đổi.

## Migration 0032

Trigger ban đầu trong migration 0000 vẫn yêu cầu mọi dòng nhận phải gắn dòng xuất và số bao phải bằng `received_quantity`. Command hiện hành đã hỗ trợ hàng ngoài phiếu qua `outbound_request_line_id=NULL` và nhận thừa qua `excess_quantity`, nên trigger cũ từ chối các giao dịch hợp lệ.

`0032_receipt_excess_validation.sql` thay hai function trigger để cho phép dòng ngoài phiếu khớp `unexpected_items`, kiểm số bao bằng `received_quantity + excess_quantity`, và yêu cầu ledger `store_receipt_excess` khớp từng SKU/số lượng. Kiểm giá, chi phí, reservation, phiếu chờ, inventory ledger và bất biến phiếu đã chốt được giữ. Giá bao nhận thừa cùng SKU lấy theo phần khai nhận thừa; giá các bao nhận thường vẫn khớp giá dòng gốc. Từng bao luôn phải có chi phí khớp kg × giá. Không backfill, sửa lịch sử hay ghi lại tồn kho.

Rollback ứng dụng có thể giữ migration mở rộng này. Không tự khôi phục trigger cũ vì sẽ tái phát lỗi chốt hàng thừa. Nếu phát hiện lỗi guard, dừng thao tác chốt bị ảnh hưởng và phát hành migration forward-fix; mọi restore dữ liệu phải theo runbook backup/restore hiện hành.

## Index kỳ báo cáo (0033)

Predicate kho lọc `finalized_at`, trong khi index cũ dùng `created_at`. EXPLAIN trên database test nhỏ cho toàn báo cáo khoảng 6 ms, nhưng benchmark riêng đường truy cập với 200.000 header mô phỏng cho thấy quét tuần tự khoảng 21,078 ms so với bitmap/index scan khoảng 0,714 ms sau index. Đây là số đo mô phỏng, không phải số liệu production hay cam kết latency.

Migration 0033 thêm partial index `(finalized_at, store_id) WHERE status='finalized' AND deleted_at IS NULL`. Date đứng trước để phục vụ cả phạm vi toàn hệ thống, không chỉ một cửa hàng. PostgreSQL vẫn có thể chọn sequential scan cho bảng nhỏ. Không sửa dữ liệu; rollback ứng dụng có thể giữ index này.

## Kiểm thử và đối soát

Fixture tổng chuẩn: A bán lẻ 58 bao/700 kg (kho 50/600, đối tác 8/100), B bán lẻ 17/290 (kho 15/250, đối tác 2/40), C sỉ 30/500. Tổng 105/1490; kho 95/1350; đối tác 10/140. Nam 65/950, Nữ 32/355, Vest 8/185.

Các test nằm ở `packages/database/tests/inbound-statistics*.test.ts`, fixture PostgreSQL dùng chung, hồi quy `receipt-adjustments.integration.test.ts`, API `apps/api/test/inbound-statistics.test.mjs`, model web, browser mocked và browser live cùng tên `inbound-statistics.spec.ts`. Test PostgreSQL yêu cầu `RUN_POSTGRES_TESTS=1` và `DATABASE_URL` của database test. Fixture không được chạy trên production.

Hồi quy “Xem chi tiết”: `apps/web/e2e/inbound-statistics.spec.ts` dùng 12 cửa hàng mock (bán lẻ, sỉ, một cửa hàng không phát sinh; Alpha có 12 mặt hàng để phân trang chi tiết) và kiểm tra giữ danh sách/tổng/bộ lọc/phân trang cha, đóng/mở và chuyển A → B, bàn phím/ARIA/focus, response muộn hoặc lỗi, “Làm mới”, các nguồn/kỳ/loại cửa hàng và responsive 360–2560 px. File này chạy trong cả `npm run e2e` và `npm run e2e:production -w @idosi/web` (bundle production, `VITE_ENABLE_MOCK_FALLBACK=false`). Test model web kiểm tra query/key chi tiết; browser live kiểm tra chi tiết của fixture A/C đối chiếu API trên PostgreSQL test.

Memory adapter tổng hợp từ command nhận kho/đối tác trong bộ nhớ, dùng cho smoke/API tests; điều chỉnh hậu chốt thực tế được xác minh qua PostgreSQL vì adapter memory của hệ thống chưa hỗ trợ các command điều chỉnh đó. Production dùng PostgreSQL.

Sau triển khai, kiểm SHA watcher và health/readiness; đọc API bằng phiên Admin và đối soát chứng từ nguồn trên một phạm vi nhỏ. Với “Xem chi tiết”: mở một cửa hàng, xác nhận danh sách, bộ lọc, tìm kiếm, trang và tổng cha không đổi; thu gọn; mở A rồi B; lặp lại trên mobile. Thay đổi chỉ ở frontend, không có migration, nên rollback là đưa ảnh về release trước theo runbook deploy; không cần thao tác dữ liệu. Kiểm tổng hai nguồn, tổng SKU, tổng cửa hàng, phân nhóm và gram chính xác. Xác minh non-Admin bị từ chối. Các kiểm tra production chỉ đọc, không tạo fixture, không ghi inventory.
