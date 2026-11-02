# Đơn ưu tiên khẩn cấp

ADMIN/HTKD chọn cửa hàng đang hoạt động, chọn nguồn đã xác nhận và đã cấp đang giữ chờ giao và/hoặc thêm SKU theo tồn khả dụng rồi gửi. HTKD được chọn mọi cửa hàng trong riêng chức năng này. Quyền nhận hàng, xác nhận phân bổ và quản lý cửa hàng ở các chức năng khác giữ nguyên.

Cửa hàng không có phiếu chờ và không có hàng đã cấp chờ giao vẫn tạo được đơn chỉ gồm hàng đặt mới (`sources: []`). Cũng có thể chỉ chọn hàng đã cấp để tạo chuyến giao khẩn cấp (`additionalLines: []`), không bắt buộc đặt thêm. Hai mảng không được đồng thời rỗng. Chỉ những nguồn người dùng chủ động chọn mới được đưa vào đơn. Ví dụ cửa hàng có 2 bao nam và 2 bao nữ, chọn riêng nguồn 2 bao nam thì đơn giao đúng 2 bao nam, 2 bao nữ vẫn giữ chờ giao. Không tạo/sửa phiếu chờ để đáp ứng điều kiện tạo đơn.

Ô “Chọn mặt hàng” có tìm kiếm và hiển thị duy nhất con số bao có thể đặt bên cạnh từng mặt hàng. Khi di chuột hoặc đưa tiêu điểm bàn phím vào dòng hàng, tooltip chỉ hiện con số này (ví dụ `3` = tối đa 3 bao, `0` = không thể chọn). Số này là `maxAdditionalBags` từ server: khả dụng kho tổng H−R sau giới hạn đối chiếu nguồn và giới hạn mỗi đơn; không phải tồn tại cửa hàng, tồn vật lý chưa trừ giữ hàng hoặc tổng hàng đã cấp. Mặt hàng có số 0 bị khóa chọn. Danh mục được kiểm lại mỗi 15 giây/khi trở lại cửa sổ; chọn hàng và gửi vẫn kiểm tồn lại. Bàn phím: mở danh sách bằng Enter/Space hoặc mũi tên, gõ để tìm, lên/xuống để chọn dòng, Enter để chọn và Escape để đóng. Mobile xem được số ngay trên dòng mà không cần hover.

Màn hình `/priority-orders` hiển thị tồn ngay khi chọn SKU, kiểm lại mỗi 15 giây và khi trở lại cửa sổ. Số bao phải nguyên dương, không vượt giới hạn của SKU. Một SKU chỉ có một dòng đặt thêm. Tồn 0 hoặc lỗi kiểm tồn khóa thao tác thêm. Server vẫn kiểm lại trong transaction; không tự giảm lượng khách đã nhập. Nguồn được phân trang 50 dòng; tối đa 100 nguồn và 100 SKU mỗi đơn, tổng tối đa 10.000 bao.

Ví dụ 1 nam đã cấp đang giữ + 1 nữ đặt thêm = đơn 2 bao. Nếu nữ chỉ còn 1, nhập 2 phải báo “Kho chỉ còn 1 bao khả dụng, chỉ được đặt tối đa 1 bao.” Gửi thành công đã duyệt, xuất kho, lập RE nội bộ và có phiếu xuất đủ cả hai bao. RE là chứng từ nội bộ hiện hành; chức năng không gọi API đặt hàng bên ngoài Reshare.

## Dữ liệu và tồn kho

- `emergency_priority_orders`: mã UK do DB cấp, cửa hàng, người tạo, snapshot tên, phiếu xuất, tổng bao, trạng thái đặt Reshare và version.
- `emergency_priority_sources`: sở hữu độc quyền reservation đã chọn hoặc tạo thêm; khóa unique chặn hai đơn dùng một nguồn.
- `reshare_orders.origin=emergency`: liên kết đơn UK; không cần session/run/decision giả. Nhánh allocation cũ vẫn bắt buộc đủ các liên kết cũ.
- Nguồn issued cũ: không ghi xuất lại, không tạo RE lần hai. Đơn UK giữ liên kết về RE cũ.
- Nếu toàn bộ nguồn chọn đã issued và không đặt thêm, không tạo RE mới/RE rỗng. DTO trả `reshareId=null`, `reshareCode=null`, `reshareQuantity=0`; `sources[].reshareCode` vẫn chỉ đúng chứng từ cũ. Giao diện ghi rõ sử dụng RE nguồn và không lập RE mới. Audit duyệt/chuyến giao vẫn có; không ghi sự kiện tạo RE giả.
- Nguồn legacy active: xuất một lần, H và R cùng giảm đúng lượng đó.
- Đặt thêm q: reserve R+q, sau đó issue H−q và R−q trong cùng transaction; sau commit lượng mới không còn nằm ở R.
- Khả dụng là H−R cùng giới hạn supplier reconciliation. Nguồn cũ không được cộng trở lại khả dụng.
- Chỉ trả 201 sau commit. Khóa stock-jobs dùng chung worker, khóa reservation, serializable retry và idempotency bảo vệ tranh chấp. Mất phản hồi phải thử lại cùng key/nội dung; không được tự tạo intent mới.
- Trạng thái đã/chưa đặt Reshare là trạng thái nghiệp vụ đặt, không hoàn tồn, hủy shipment hay xóa chứng từ.

Không tạo hoặc sửa phiên phân bổ, quyết định phân bổ, đơn thường, hạn mức, PC/PCT hoặc priority offer. Phiếu chờ chỉ đọc tham khảo. Nguồn đã có chuyến giao bị loại; không tự tháo chuyến cũ.

## Nhận hàng và nhận thiếu

Phiếu xuất được dispatch ngay bằng danh tính đơn UK. Cửa hàng khai nhận và HTKD chốt theo workflow hiện hành. Nguồn đã issued được settle qua RE, không trừ H lần nữa. Nhận thiếu vẫn lưu discrepancy, kiểm tra thiếu và lượng thực nhận; riêng đơn khẩn cấp không tự phát sinh nhu cầu phiếu chờ. Trigger finalization giữ các invariant cũ và chỉ đổi yêu cầu wait cho shipment có đơn UK hợp lệ.

Đọc đơn: ADMIN/HTKD mọi cửa hàng; STORE đúng cửa hàng; WHOLESALE các cửa hàng sỉ đang hoạt động. Tài khoản bị khóa bị từ chối cả replay. Giao diện chế độ demo báo không khả dụng, không giả vờ cấp hàng trong memory adapter.

Danh mục chọn trả đủ cửa hàng và SKU hoạt động, không cắt ngầm ở 1.000 mục. Danh sách đơn/nguồn vẫn phân trang; lịch sử trả 100 sự kiện gần nhất mỗi đơn, giới hạn ngay trong SQL. Cập nhật trạng thái Reshare về đúng trạng thái hiện tại không tăng version và không tạo lịch sử thay đổi giả. Phiếu nhận đã chốt thiếu hiển thị “Đã nhận thiếu”.

## API và file chính

API `/api/v1/priority-orders`: context, availability, preview, POST submit, GET list/detail, PUT `:id/reshare-status`; mô tả tại `/openapi.json`. Contracts ở `packages/contracts/src/priority-orders.ts`, transaction ở `packages/database/src/priority-orders.ts`, routing/adapters ở `apps/api/src`, UI ở `apps/web/src/pages/PriorityOrdersPage.tsx` và `features/priority-orders`. Trang Reshare dẫn tới danh sách RE của đơn UK; trang nhận hàng có tag UK.

Migration `0048_emergency_priority_orders.sql` thêm bảng/index, nới liên kết allocation cho RE emergency có constraint thay thế, bổ sung guard bất biến và sửa deferred issuance để kiểm trạng thái cuối transaction. Không backfill đoán nguồn cũ. Reset tooling phân loại hai bảng mới là dữ liệu nghiệp vụ; sequence UK không reset để tránh tái dùng mã.

Migration `0049_emergency_held_only.sql` thay deferred completion guard: mỗi nguồn phải có RE issued chưa settle, đúng cửa hàng/mặt hàng/số lượng/chuyến giao; nguồn `additional` phải thuộc RE mới của chính đơn. Cho phép đơn không có RE mới khi toàn bộ nguồn đã có RE hợp lệ. Không thay bảng, không backfill, không cập nhật dữ liệu lịch sử. Writes của bản cũ vẫn hợp lệ trên guard mới. Sau khi có đơn chỉ dùng RE cũ, không rollback về code dùng inner join RE mới (sẽ bỏ sót đơn và báo tổng phân trang sai); ưu tiên forward-fix. Các tab mở từ bản trước cần tải lại để đọc DTO mới cho đơn không có RE mới.

Structural fingerprint của công cụ reset được cập nhật từ catalog PostgreSQL 17 mới có đủ 50 migrations, vì fingerprint bao gồm định nghĩa trigger. Phạm vi purge/keep và quy trình reset giữ nguyên; deploy không chạy reset.

## Kiểm thử và phát hành

Chạy format/lint/typecheck/build, toàn workspace với `RUN_POSTGRES_TESTS=1`, migrations hai lần trên PG17 mới, API auth regressions, và `npm run e2e:live -w @idosi/web -- priority-orders.spec.ts`. Bài PG kiểm issued/legacy, nhận đủ/thiếu, tồn 0, vượt tồn, cùng SKU, stale source, pending decision, rollback sau xuất, replay/changed payload/khóa tài khoản, hai người cùng nguồn, worker lock và hai cửa hàng tranh bao cuối. Live E2E desktop/mobile kiểm tồn sát input, UI/API thật, tag STORE, quyền và hình học responsive. Không dùng worker hoặc ACCEPT để hoàn tất đơn sau khi bấm Gửi.

Deploy theo watcher sau merge main và CI xanh. Trước merge ghi nhận runtime/backup/nguồn lực; sau deploy đối chiếu full merged SHA với target/running, state deployed/up-to-date, health/ready, log và smoke chỉ đọc. Không tạo đơn thật để smoke.

Migration tương thích luồng cũ trước khi có đơn UK; sau khi đã có đơn UK, **không rollback về image thiếu hỗ trợ nhận thiếu/source độc lập**. Ưu tiên forward-fix; khi cần dừng tạo mới, chặn POST emergency ở tầng vận hành trong khi giữ đọc/nhận. Không restore DB tự động hoặc chạy down migration. Watcher tự rollback image khi lỗi khởi động xảy ra trước traffic; nếu đã nhận đơn UK cần giữ image hỗ trợ feature và xử lý theo runbook sự cố.
