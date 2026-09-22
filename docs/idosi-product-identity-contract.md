# Hợp đồng định danh mặt hàng IDOSI — yêu cầu thay đổi phía idosi.io.vn

Tài liệu này mô tả nguyên nhân gốc của việc lệch số lượng bán giữa `idosi.io.vn` và
kho `khoidosi.io.vn`, và các thay đổi cần thực hiện **phía idosi** để việc đồng bộ
đúng và ổn định lâu dài. Phần cuối nêu phần kho sẽ tự xử lý.

## 1. Bằng chứng

Danh mục hiện hành của idosi (màn hình "Danh mục lựa chọn đơn hàng"):

| Mã | Tên hiện tại | Cập nhật |
| --- | --- | --- |
| `PRD-003` | Áo Nữ | 18/09/26 14:16:18 |
| `PRD-004` | Áo khoác | 12/09/26 22:38:50 |

Bảng "Chi tiết mặt hàng theo loại bán" của cửa hàng DOSII NVT, tháng 09/2026:

| Mặt hàng | Mã | Loại doanh thu | Số lượng |
| --- | --- | --- | ---: |
| Áo nữ | `PRD-004` | Bán thường | 742 |
| Áo khoác | `PRD-004` | Bán thường | 55 |
| Áo nữ | `PRD-003` | Sale theo cái | 26 |

Hai mặt hàng khác tên dùng chung một mã `PRD-004`. Đây là điều không thể xảy ra nếu
mã là định danh ổn định.

Chú thích của chính idosi xác nhận cơ chế:

> Đơn cũ được đối chiếu tên mặt hàng với bảng hiện hành; tên cũ hiển thị theo tên
> đang sử dụng. Snapshot gốc trên đơn vẫn được giữ để đối soát.

## 2. Nguyên nhân gốc

Một dòng thống kê hiện chứa hai trường thuộc hai mốc thời gian khác nhau:

- `productId` / `productCode`: giá trị **tại thời điểm phát sinh đơn** (snapshot).
- `productName`: giá trị **của danh mục hiện hành** (đã ánh xạ lại).

Khi một mặt hàng bị đổi tên, hoặc khi một mã được dùng lại cho mặt hàng khác:

- Gộp theo `productId` → một mặt hàng bị tách thành nhiều rổ, và rổ dùng mã tái sử
  dụng còn trộn lẫn hai mặt hàng khác nhau.
- Gộp theo `productName` → đúng với báo cáo của idosi, nhưng phụ thuộc vào chuỗi ký
  tự có thể đổi bất cứ lúc nào và không phát hiện được khi hai mặt hàng trùng tên.

Kho không có cách nào gộp đúng từ dữ liệu hiện tại. Đây không phải lỗi thuật toán
phía kho.

Hệ quả đã thấy: tổng "Áo nữ" tháng 09/2026 cộng từ 10 trang cửa hàng của idosi là
5.472 cái, kho hiển thị 4.704 cái.

Ngoài ra, phía kho đã từng phải hard-code một ngoại lệ đổi tên
(`Đồ nam` → `Quần áo nam`, xem `canonicalIdosiProductName` trong
`packages/contracts/src/idosi-statistics.ts`). Đây là bằng chứng sự cố này đã xảy ra
trước đó và mỗi lần đổi tên lại phải vá tay — không thể duy trì.

## 3. Các thay đổi cần thực hiện phía idosi

### 3.1. Không bao giờ dùng lại một mã/id cho mặt hàng khác — BẮT BUỘC

Đây là thay đổi quan trọng nhất; một mình nó đã xử lý nguyên nhân gốc.

- Đổi **tên** một mặt hàng: **giữ nguyên** `id` và `code`, chỉ đổi tên hiển thị.
- Mặt hàng **thật sự khác**: cấp `id`/`code` **mới**, và cho mã cũ trạng thái
  `RETIRED` thay vì gán lại cho mặt hàng khác.

`PRD-004` đi từ "Áo nữ" sang "Áo khoác" là trường hợp dùng lại định danh cho một
mặt hàng khác. Đây chính là điều cần chấm dứt.

### 3.2. Bổ sung `canonicalProductId` vào từng dòng thống kê

Mỗi dòng trong `products.items[]` và `products.weightByProduct[]` cần thêm:

| Trường | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `canonicalProductId` | string, bắt buộc | Id của mặt hàng trong **danh mục hiện hành** mà dòng này thuộc về. Luôn nhất quán với `productName`. |
| `canonicalProductCode` | string, tuỳ chọn | Mã hiện hành tương ứng. |
| `sourceProductId` | string, bắt buộc | Id **tại thời điểm đơn** (chính là `productId` hiện nay). Chỉ dùng để đối soát, không dùng để gộp. |
| `sourceProductCode` | string, tuỳ chọn | Mã tại thời điểm đơn. |

Quy tắc: `canonicalProductId` và `productName` phải luôn trỏ về **cùng một bản ghi**
trong danh mục hiện hành. Nếu hai dòng có cùng `productName` thì bắt buộc cùng
`canonicalProductId`, và ngược lại.

Ví dụ dữ liệu đúng cho DOSII NVT ở mục 1:

```json
{
  "items": [
    {
      "canonicalProductId": "PRD-003",
      "canonicalProductCode": "PRD-003",
      "sourceProductId": "PRD-004",
      "sourceProductCode": "PRD-004",
      "productName": "Áo nữ",
      "revenueType": "NORMAL",
      "quantity": 742,
      "unit": "PIECE"
    },
    {
      "canonicalProductId": "PRD-003",
      "canonicalProductCode": "PRD-003",
      "sourceProductId": "PRD-003",
      "sourceProductCode": "PRD-003",
      "productName": "Áo nữ",
      "revenueType": "SALE_PIECE",
      "quantity": 26,
      "unit": "PIECE"
    },
    {
      "canonicalProductId": "PRD-004",
      "canonicalProductCode": "PRD-004",
      "sourceProductId": "PRD-004",
      "sourceProductCode": "PRD-004",
      "productName": "Áo khoác",
      "revenueType": "NORMAL",
      "quantity": 55,
      "unit": "PIECE"
    }
  ]
}
```

Gộp theo `canonicalProductId` cho đúng 768 cái "Áo nữ" và 55 cái "Áo khoác", khớp
bảng tháng của idosi, không cần đoán theo tên.

### 3.3. Cung cấp endpoint danh mục kèm lịch sử định danh

`GET /api/products` (cùng cơ chế xác thực với endpoint thống kê hiện tại):

```json
{
  "catalogVersion": "IDOSI-2026-09-21-v4",
  "products": [
    {
      "id": "PRD-003",
      "code": "PRD-003",
      "name": "Áo Nữ",
      "status": "ACTIVE",
      "previousIds": ["PRD-004"],
      "previousNames": ["Đồ nữ"],
      "renamedAt": "2026-09-18T07:16:18Z"
    },
    {
      "id": "PRD-004",
      "code": "PRD-004",
      "name": "Áo khoác",
      "status": "ACTIVE",
      "previousIds": [],
      "previousNames": []
    }
  ]
}
```

Có endpoint này, kho tự phân giải được mọi id lịch sử về id hiện hành, và khi danh
mục đổi thì đối soát lại được dữ liệu cũ mà không cần kéo lại toàn bộ đơn.

### 3.4. Gắn `catalogVersion` vào mọi payload thống kê

Payload hiện đã có `tableVersion` cho bảng quy đổi kg. Cần thêm tương tự cho danh mục
mặt hàng, ở cấp payload:

```json
{ "ok": true, "apiVersion": 1, "catalogVersion": "IDOSI-2026-09-21-v4", "...": "..." }
```

Khi danh mục đổi, `catalogVersion` phải đổi. Kho dùng giá trị này để biết snapshot cũ
đã lỗi thời và cần đồng bộ lại, thay vì âm thầm cộng lẫn dữ liệu của hai phiên bản
danh mục khác nhau.

### 3.5. Thống nhất khoá gộp giữa các bảng báo cáo

Bảng "Thống kê mặt hàng" (theo tháng) và bảng "Chi tiết mặt hàng theo loại bán" đang
gộp theo hai khoá khác nhau, nên bảng chi tiết mới hiện được hai tên dưới cùng một mã.
Cả hai bảng phải gộp theo `canonicalProductId`.

Liên quan: dashboard tổng của idosi ghi "Áo nữ 5.446 cái" trong khi cộng 10 trang
cửa hàng ra 5.472 cái — lệch 26, đúng bằng phần "Sale theo cái" của DOSII NVT. Nhiều
khả năng dashboard tổng đang bỏ sót dòng `SALE_PIECE`. Đề nghị kiểm tra luôn.

### 3.6. Bảo đảm tính xác định khi đồng bộ lại

- Với một kỳ đã đóng, cùng một `scope` phải luôn trả về cùng kết quả.
- Thêm `generatedAt` (ISO-8601, UTC) vào payload.
- Khi số liệu quá khứ bị thay đổi (sửa đơn, đổi danh mục), đổi `catalogVersion`
  hoặc bổ sung `revision` để kho biết phải kéo lại.

## 4. Thứ tự ưu tiên

| Ưu tiên | Hạng mục | Lý do |
| --- | --- | --- |
| 1 | 3.1 — không dùng lại mã | Chặn nguyên nhân gốc, không phát sinh thêm dữ liệu sai |
| 2 | 3.2 — `canonicalProductId` | Cho phép kho gộp đúng ngay, kể cả dữ liệu lịch sử |
| 3 | 3.4 — `catalogVersion` | Phát hiện snapshot lỗi thời |
| 4 | 3.3 — endpoint danh mục | Đối soát lại dữ liệu cũ, bỏ hard-code phía kho |
| 5 | 3.5, 3.6 | Nhất quán báo cáo và đồng bộ lại |

## 5. Phần kho tự xử lý

Không chờ idosi, kho sẽ:

1. Gộp theo `canonicalProductId` khi có; nếu không có thì lùi về tên hiển thị đã
   chuẩn hoá — vì idosi đã ánh xạ tên về danh mục hiện hành, đây là khoá đúng duy
   nhất hiện dùng được.
2. Bổ sung test hồi quy cho hai tình huống: một tên có nhiều `productId`, và một
   `productId` mang nhiều tên.
3. Gỡ ngoại lệ hard-code `Đồ nam` → `Quần áo nam` ngay khi mục 3.2 hoặc 3.3 sẵn sàng.
4. Hiển thị cảnh báo trên màn hình doanh số khi phát hiện một `productId` xuất hiện
   dưới nhiều tên trong cùng kỳ, thay vì lặng lẽ cộng sai.
