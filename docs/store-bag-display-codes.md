# Mã bao ngắn tại cửa hàng

`0014_store_bag_display_codes.sql` thêm mã hiển thị `MB-00001` theo từng cửa hàng. Mã gốc `bag_code` vẫn được giữ để truy nguồn phiếu nhận, điều chuyển và audit. Hai cửa hàng có thể cùng có `MB-00001`; trong mỗi cửa hàng, mã không được dùng lại.

Migration đánh số bao lịch sử theo `created_at, id`, tạo bộ đếm ở số cao nhất của từng cửa hàng, rồi cài trigger cấp số khi có bao mới. Bộ đếm dùng `INSERT ... ON CONFLICT DO UPDATE`, nên các lượt nhận đồng thời của cùng một cửa hàng được tuần tự hóa trong transaction. UI và API tồn kho trả mã ngắn; bộ lọc mã bao vẫn chấp nhận cả mã ngắn lẫn mã gốc để giữ các liên kết cũ.

Khui thuần giữ tổng kg và giá vốn. Nếu IDOSI đang có bán thường chờ trừ, khui áp dụng phần chờ
trong cùng transaction: bao có thể thành OPEN hoặc EMPTY ngay. Không xác nhận lại bao có openedAt
hoặc lịch sử khui. Danh sách chưa khui dùng unopenedOnly=true, phân trang server; helper tải mọi
trang của màn tồn cũ giữ nguyên. Nguồn nhận kho, chuyển cửa hàng và nhập đối tác đều dùng left join.

GET /api/v1/store-bag-openings phân trang, lọc storeId/productId/bagCode/from/to, thứ tự thời gian
giảm dần rồi event ID. from bao gồm, to loại trừ; UI chuyển ngày Việt Nam sang UTC và hiển thị
ngày giờ tới giây theo Asia/Ho_Chi_Minh. Phạm vi STORE/HTKD/ADMIN được lọc tại repository.
WHOLESALE không được cấp quyền khui hoặc đọc endpoint lịch sử bán lẻ.

Mỗi bao có một dòng lịch sử, độc lập trạng thái hiện tại. Ưu tiên audit STORE_INVENTORY_BAG_OPENED:
trước/sau kg, productId và storeId từ snapshot; actor từ audit. Audit mới thêm displayCode và openedAt
vào JSON snapshot hiện hữu. Với khui do lọc/xuất chuyển/duyệt xuất/IDOSI cũ, dùng ledger cùng thời điểm
openedAt để xác định nguồn và dữ liệu đã có. Không tạo ledger event open, không thêm isOpened/bảng
trùng. Legacy chỉ có openedAt vẫn hiện với source LEGACY và các trường thiếu là null. Tên danh mục
hiện tại được ghi nhãn riêng, không giả là tên lịch sử. Không dùng updatedAt làm thời điểm khui. Bao legacy có status opened nhưng thiếu thời gian vẫn hiện với openedAt null, xếp cuối; UI ghi “Chưa ghi nhận”, không suy đoán thời điểm.

Không cần migration/backfill dữ liệu nghiệp vụ cho projection này. Dùng index entity/time của audit
và bag/time của ledger hiện có; xem báo cáo kiểm chứng query plan. Rollback app giữ nguyên audit
JSON bổ sung; rollback về invariant cũ sẽ cho báo sau khui trở lại, nên ưu tiên forward-fix.

Triển khai migration trước phiên bản API/web mới. Khi cần rollback ứng dụng, giữ nguyên migration cộng thêm này: API cũ tiếp tục dùng `bag_code`, và trigger vẫn cấp mã ngắn cho dữ liệu mới. Nếu cần forward-fix bộ đếm, đối soát `display_code` với `store_inventory_bag_code_counters` trên bản sao lưu trước khi sửa dữ liệu production.
