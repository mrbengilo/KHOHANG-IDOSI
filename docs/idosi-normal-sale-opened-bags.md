# Bán thường IDOSI trừ vào bao đã khui

## Quy tắc

Doanh số **bán thường** (`revenueType = NORMAL`) của IDOSI được quy ra kg và trừ vào **bao đã khui**
của đúng mặt hàng tại cửa hàng đó. Hàng bán thường là hàng lấy ra bán trên kệ, tức là từ bao cửa hàng
đã khui. Phần kg còn lại trong các bao đã khui là tồn để tiếp tục bán hoặc đem lọc.

Ví dụ: IDOSI báo bán thường 300 áo nữ, quy ra 60 kg. Cửa hàng đã khui 2 bao áo nữ, tổng 100 kg.
Hệ thống trừ 60 kg vào hai bao đó, bao khui trước bị trừ trước. Còn 40 kg áo nữ để lọc. Bao áo nữ
còn nguyên (chưa khui) không bị đụng tới.

- Bao **chưa khui** không bao giờ bị trừ và không bị đồng bộ tự chuyển sang "đã khui". Khui bao vẫn
  là thao tác của cửa hàng; bao nguyên vẫn báo sai lệch sau khui bình thường.
- Nếu IDOSI bán nhiều hơn số kg đang có trong các bao đã khui, phần dư được **giữ chờ**. Khi cửa hàng
  khui bao kế tiếp của mặt hàng đó, phần chờ bị trừ ngay trong cùng giao dịch khui. Màn hình Khui
  kiện hiển thị "Bán thường IDOSI chưa trừ" của mặt hàng đang chọn. Sau khi khui, thông báo nói rõ
  đã trừ bao nhiêu kg và còn bao nhiêu kg để bán hoặc lọc.
- IDOSI điều chỉnh giảm thì kg được trả lại vào các bao đã bị trừ, bao bị trừ gần nhất được trả trước.
- Mỗi lần đồng bộ (15/30 phút) đều đối soát lại theo số lũy kế của tháng. Phần chờ vì thế cũng được
  trừ ở lần đồng bộ sau khi cửa hàng khui bao bằng cách khác, ví dụ lọc thẳng từ bao nguyên.

## Dữ liệu và API

- `store_normal_sale_progress` giữ mốc lũy kế từng tháng. Phần chờ bằng
  `max(observed − baseline, 0) − applied`.
- `GET /api/v1/store-normal-sale-pending?storeId=` trả phần chờ theo cửa hàng và mặt hàng, trong
  phạm vi quyền của người gọi.
- `POST /api/v1/store-inventory-bags/{bagId}/open` khóa `store-sorting` của cửa hàng, giống đồng
  bộ IDOSI và lọc, rồi mới khóa bao. Sau đó nó trừ phần chờ vào bao vừa khui. Nếu phần chờ lớn hơn
  cả bao thì bao chuyển thẳng sang "hết" (`depleted`).

## Dữ liệu cũ

Trước thay đổi này, đồng bộ có thể đã trừ vào bao nguyên và tự đánh dấu bao đó "đã khui". Không có
cách biết chắc những bao đó thực tế đã khui hay chưa, nên dữ liệu cũ được giữ nguyên, không backfill.

## Khui bán và báo sai lệch

Xác nhận khui bán khóa quyền báo sai lệch mới ngay cả khi chưa bán gram nào. Báo thắng trước giữ
bao QUARANTINED nên khui bị từ chối; khui thắng trước thì báo bị 409. Không đổi thuật toán IDOSI,
khóa store-sorting, optimistic version hay idempotency hiện hữu. Lịch sử khui lưu kg trước khui,
kg bù bán và kg còn ngay sau thao tác từ audit, kể cả khi bao EMPTY; retry không thêm audit hay trừ lại.
