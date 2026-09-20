# Đối chiếu giao diện Figma V1.4

## Phạm vi và tiêu chí nghiệm thu

Nguồn: `IDOSI_Toan_bo_giao_dien_Figma_V1.4.pdf`, 129 trang, 115 màn hình/trạng thái:
55 desktop và 60 mobile. Không xem việc đổi màu chung là hoàn thành đối chiếu.

Mỗi nhóm cần đối chiếu ảnh thực tế, bố cục, nội dung, dữ liệu API và trạng thái thao tác.
Kiểm tra 360, 390, 412, 768, 1366 và 1440 px; không tràn ngang toàn trang,
không che nút, không dùng số liệu minh họa thay dữ liệu thật. Loading, empty, error,
không đủ quyền và thao tác lặp phải được kiểm tra riêng.

Yêu cầu người dùng chốt sau thiết kế được ưu tiên:

- VAT nhập số tiền thuế trực tiếp, thuế suất hiển thị 8% (PDF minh họa 10%).
- Đặt hàng 24/7; hai phiếu thường mỗi chu kỳ, reset sau hoàn tất phân bổ.
- Phiếu ưu tiên không chiếm lượt, giữ hàng đến khi có đơn thường tiếp theo để giao chung.
- Admin không hiện mục Đặt hàng, Nhận hàng, Khui kiện; có Nhập kho tổng.
- Khối lượng nhập kho tổng không bắt buộc; chưa biết khác với 0 kg.
- Checkbox, tên hàng và số bao trên một hàng, nút tăng/giảm đủ vùng bấm.
- Kg tối đa ba chữ số thập phân, bỏ số 0 dư, định dạng Việt Nam.
- Logo thật, đăng nhập một cột cùng slogan đã yêu cầu; viền sáng, icon màu,
  mục chọn nổi bật và dấu sao đỏ cho trường bắt buộc.

## Ma trận kiểm tra đang thực hiện

`Đã đọc mẫu` chỉ nghĩa là đã xem hình trong PDF, không có nghĩa UI thực tế đã đạt.
Chưa nhóm nào được nghiệm thu toàn bộ desktop/mobile ở thời điểm lập ma trận này.

| Vai trò / nhóm                 | Trang PDF                            | Trạng thái đối chiếu                                                                                                            |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Admin tổng quan                | 9 / 68                               | Đã đọc mẫu desktop; dashboard hiện tại thiếu bố cục tổng hợp, biểu đồ và drill-down tương ứng                                   |
| Admin duyệt đơn / phân bổ      | 10, 12 / 69, 71                      | Đã đọc mẫu desktop; cần kiểm tra từng trạng thái và nguồn số liệu                                                               |
| Admin danh mục / modal         | 11, 19–20 / 70, 78–81                | Đã đọc mẫu desktop; cần đối chiếu modal, trạng thái vô hiệu hóa và mobile                                                       |
| Admin cửa hàng                 | 13 / 72                              | Đã đọc mẫu desktop; cần đối chiếu bộ lọc, chi tiết và chỉ số cửa hàng                                                           |
| Admin luồng hàng               | 14 / 73                              | Đã đọc mẫu desktop; cần đối chiếu sơ đồ trạng thái, tổng và nguồn sổ kho                                                        |
| Admin phiếu nhập / giá vốn     | 15 / 74                              | Đã đọc mẫu desktop; phát hiện `/costs` có route nhưng thiếu mục điều hướng                                                      |
| Admin xử lý                    | 16 / 75                              | Đã đọc mẫu desktop; cần đối chiếu phân nhánh và xác nhận tồn                                                                    |
| Admin báo cáo / audit          | 17 / 76                              | Đã đọc mẫu desktop; cần kiểm tra chỉ số khả dụng, xuất file và audit                                                            |
| Admin tài khoản                | 18 / 77                              | Đã đọc mẫu desktop; cần đối chiếu chi tiết và phân quyền mobile                                                                 |
| HTKD tổng quan / báo cáo       | 23, 28 / 83, 89                      | Đã đọc mẫu desktop; cần đối chiếu tổng hợp theo toàn bộ cửa hàng được giao                                                      |
| HTKD đặt hàng                  | 24 / 84                              | Đã đọc mẫu desktop; áp dụng chính sách đặt 24/7 thay nội dung cutoff cũ                                                         |
| HTKD nhận / đối soát / chi phí | 22, 25 / 85–86                       | Đã đọc mẫu desktop; cần kiểm tra khóa, sai SKU, trả chỉnh sửa và chi phí                                                        |
| HTKD kho / xử lý / chuyển      | 26–27 / 87–88                        | Đã đọc mẫu desktop; cần đối chiếu sổ bao, hai đầu điều chuyển và phân nhánh                                                     |
| HTKD ưu tiên                   | 29–37 / 90–97                        | Đã đọc đủ mẫu desktop: thông báo, chi tiết, xác nhận, hủy lượt, đóng phiếu chờ, sắp hết hạn và hết hạn; chưa nghiệm thu thực tế |
| HTKD danh mục                  | 38–40 / 98–107                       | Đã đọc mẫu desktop; quyền tạo/sửa/ngừng đã có, còn kiểm tra thực tế và mobile                                                   |
| Cửa hàng tổng quan / vận hành  | 42–51, 63–65 / 109–117, 120–124, 129 | Đã đọc mẫu desktop; còn thiếu các bước xem trước, phân nhánh xử lý và bộ lọc tương ứng; chưa nghiệm thu mobile                  |
| Cửa hàng ưu tiên               | 52–60 / 125–128                      | Chờ đọc đủ trạng thái mẫu và đối chiếu thực tế                                                                                  |
| Cửa hàng chênh lệch nhận       | 61–62 / 118–119                      | Đã đọc mẫu desktop; cần kiểm tra khai thực nhận độc lập, cách ly sai SKU và khóa chứng từ sau gửi                               |

Trang 1–8, 21, 41, 66–67, 82 và 108 là phần giới thiệu/phân nhóm, không phải màn hình ứng dụng.

## Thứ tự sửa / commit

1. Nguồn IDOSI và hiển thị doanh thu/số cái/kg, tách khỏi phiếu xuất nội bộ.
2. Khối lượng nhập kho tùy chọn xuyên UI → API → database; chặn tính giá vốn khi chưa đủ kg.
3. Điều hướng theo vai trò, đăng nhập, viền/icon, dấu bắt buộc và responsive dùng chung.
4. Tổng quan theo mẫu với nguồn dữ liệu thật và bộ lọc có tác dụng.
5. Các nhóm nghiệp vụ còn lại, từng nhóm có bằng chứng E2E/ảnh desktop/mobile.
6. Chỉ merge/deploy sau CI, kiểm tra migration, backup và nghiệm thu các nhóm liên quan.

## Bằng chứng hiện có

- Đã xem 46/115 mẫu: Admin desktop 9–20, HTKD desktop 22–40, cửa hàng
  desktop 42–51 và 61–65. Còn 9 mẫu desktop 52–60 và toàn bộ 60 mẫu mobile.
  Con số này là tiến độ đọc thiết kế, không phải số màn hình thực tế đã đạt.
- Phần bán hàng IDOSI đã tách khỏi nhánh loading/error của chứng từ kho và dùng chung
  kỳ thống kê giữa tổng hợp/chi tiết. Sáu test hồi quy kiểm tra phạm vi cửa hàng,
  kỳ lịch sử, loading, lỗi catalog và không tải IDOSI ở màn hình lọc/xử lý.
  Web có 136/136 unit test đạt, typecheck/lint đạt và production build đạt.
  Đây là kiểm tra code/static render, chưa thay thế kiểm thử thao tác trình duyệt.
- Các khoảng thiếu đã xác định từ mẫu cửa hàng: khui kiện thiếu bước xem trước
  trước/sau; xử lý hàng còn dùng biểu mẫu lý do chung thay vì các nhánh nghiệp vụ;
  thống kê theo mặt hàng chưa có nguồn doanh thu/giá vốn tương đương mẫu.
  Không dùng số minh họa hoặc suy diễn nguồn còn thiếu để làm dashboard giống mẫu.

- `f81ead1`: endpoint tổng hợp snapshot IDOSI có kiểm tra phạm vi; UI tổng hợp và chi tiết
  từng sản phẩm/cửa hàng. Đã push nhánh `feat/idosi-sales-dashboard-refresh`.
- Thay đổi còn trong working tree không được coi là đã triển khai production.
- Lượt kiểm tra 20/09/2026: typecheck, lint, production build và 130/130 web unit test đạt.
  Lệnh khởi động API kiểm thử bị chính sách thực thi của môi trường chặn; chưa có
  bằng chứng trình duyệt cho bản sửa hiện tại. Không merge/deploy dựa trên unit test alone.
- Dữ liệu trong ảnh PDF chỉ là ví dụ. Thiếu nguồn phải hiển thị chưa có dữ liệu,
  không gán 0, không suy diễn lợi nhuận/giá vốn/khối lượng từ nguồn không tương đương.
