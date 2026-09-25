# Lịch sử chứng từ và điều chuyển nhiều mặt hàng

## Mô hình và compatibility

Một sorted_sale_transfers là một header có ID/mã/version/trạng thái duy nhất. Cột JSONB lines chứa mỗi productId đúng một lần, kg từng bao và sourceLots (stockId/kg) giữ provenance FIFO. Các cột scalar cũ giữ dòng đầu để đọc phiếu cũ; consumer mới phải đọc lines, fallback scalar chỉ khi lines null. Tổng là tổng các dòng, cộng bằng gram nguyên.

Migration 0030 mở rộng schema, không sửa/mất ID, mã, thời gian, cân hoặc chi phí cũ; không gộp các phiếu độc lập. Không backfill cân chưa từng ghi nhận. Unique nguồn nhận chuyển từ source_transfer_id sang (source_transfer_id, product_id). Trigger settlement kiểm tra đủ credit tất cả dòng trước khi đổi trạng thái: binary cũ cố nhận/hủy phiếu mới chỉ một dòng sẽ rollback, không làm lệch tồn. Dữ liệu mới không được xử lý bằng UI cũ vì chỉ hiển thị dòng đầu: cần phát hành đồng bộ frontend/API. Rollback giữ migration, tạm dừng xử lý phiếu nhiều dòng và dùng forward-fix. Không restore backup đè giao dịch mới.

Tạo chạy trong transaction serializable/idempotency, cùng khóa store-sorting với nguồn Sale; khóa sản phẩm/lô theo thứ tự ổn định. Một dòng lỗi rollback toàn bộ stock/event/header/audit. Nhận và hủy cùng khóa header/version và credit toàn bộ dòng trong một transaction. Sale nguồn giảm khi tạo; đích tăng khi nhận; hủy trả nguồn. Luồng StoreTransfer legacy không đổi quy tắc tồn, giá vốn hay dispatch.

List Sale phân trang header (page/pageSize), lấy dư một header để trả hasMore, thứ tự createdAt/id giảm dần. UI không cắt dòng của một phiếu. Tên người tạo và người nhập là tên hiện tại của tài khoản, truy vấn theo lô, không lọc mất người đã vô hiệu hóa. Không trả credential. Chi phí/ledger Sale giữ semantics cũ; monthly report và worker dùng stock/events, không cộng các cột scalar của header điều chuyển.

## Điểm vào và focus

| Điểm vào                   | Đích                                   | Hành vi                                                                         |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Bao chưa khui → Khui bao   | Form đúng bag.id trong /open-bag       | Mount/đổi ID cuộn tức thời, focus heading; không cuộn theo refetch              |
| Bỏ chọn khui               | Nút nguồn hoặc heading danh sách       | Trả focus nếu nút còn tồn tại                                                   |
| Mã bao lịch sử             | Dialog audit đúng record               | Dùng cơ chế trap/restore focus sẵn có                                           |
| Hủy yêu cầu                | Form lý do trong ô thao tác của header | Focus textarea; chỉ một hành động cho phiếu                                     |
| Mã phiếu nhập              | details ngay tại ô mã                  | Native details bàn phím, trạng thái hủy hiển thị cả khi đóng                    |
| Chọn phiếu nhận            | Chi tiết đúng receipt.id               | Chờ dữ liệu ID đó, cuộn/focus panel một lần; ID không còn không chọn phiếu khác |
| Mã điều chuyển Sale/legacy | details của đúng header                | Native details giữ ngữ cảnh bảng; thao tác nhận/hủy còn theo quyền cũ           |
| Sidebar/dashboard/reports  | Routes hiện có                         | Không thêm query parameter hoặc thay bộ lọc/refresh thành điều hướng            |

Không có effect cuộn đầu trang trong AppShell xung đột. Instant scrolling tôn trọng reduced motion; form dùng scroll-margin-top cho header. Không thay đổi draft guard/route contract. /receive và /costs vẫn dùng luồng chốt thực nhận hiện hành.

## Kiểm chứng

Có test PostgreSQL cho rollback, replay, tranh tồn, nhận đồng thời, nhận/hủy cạnh tranh, guard binary cũ và tên tài khoản vô hiệu hóa. Test live tạo Đầm 2 bao (30,50), Jeans 1 bao (50), xác minh một header/tổng 3 bao,130kg, nhận và reload. E2E khui kiểm tra viewport/focus và computed style canh trái/viền. Test nhập kho không có editor hóa đơn. Chạy quality, E2E mock/production và live trên PostgreSQL 17 trước phát hành; kết quả thực tế ghi trong PR.
