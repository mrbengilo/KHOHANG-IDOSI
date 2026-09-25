# Báo sai lệch sau khui bao và điều chỉnh phiếu nhận đã chốt

## Bối cảnh

Cửa hàng được duyệt 3 bao đầm, nhận đủ 3 bao, HTKD nhập kg, giá/kg, phí, VAT và chốt phiếu.
Vài ngày sau khui bao, một bao thực tế là jeans. Trước thay đổi này:

- Phiếu chỉ trả về sửa được ở `pending_htkd`; `finalized` là bất biến ở tầng DB (trigger
  `prevent_finalized_store_receipt_line_mutation` / `..._bag_mutation`).
- `finalize` đã ghi tồn, giá vốn, tất toán reservation và trạng thái giao nhận;
  `reconcileReceiptShortageWait` cần reservation `active`, nên không gọi lại được sau chốt.
- `unexpectedItems` chỉ dùng khi khai nhận trước chốt; hàng nhận thiếu vào phiếu chờ P0B lúc
  cửa hàng gửi phiếu.
- Báo cáo tháng đọc trực tiếp số của phiếu nhận gốc.

Vì vậy không có đường nào ghi nhận “đã chốt 3 đầm nhưng thực tế 2 đầm + 1 jeans” mà không sửa
đè chứng từ.

## Nguyên tắc

- Không mở lại, không gọi lại `finalize`, không sửa/xóa phiếu gốc, bao gốc, ledger hay audit.
- Mỗi sai lệch là chứng từ `store_receipt_adjustments` (mã `PSL-xxxxxx`) với từng bao
  `store_receipt_adjustment_lines`, liên kết phiếu nhận, dòng hàng, bao nhận gốc và bao tồn.
- Phân biệt: SKU/số lượng **được duyệt** (dòng lệnh xuất), **ghi nhận lúc chốt** (bao nhận gốc),
  **thực tế xác minh** (dòng điều chỉnh) và **kết quả có hiệu lực** (điều chỉnh đã áp dụng mới
  nhất của bao, hoặc bao gốc).
- Tiền có hiệu lực = số chốt gốc + tổng chênh lệch của các điều chỉnh `applied`
  (`receiptAdjustmentMoneySummary`). Điều chỉnh đã áp dụng không sửa/xóa; sai tiếp thì tạo điều
  chỉnh kế tiếp dựa trên kết quả hiệu lực mới nhất.

## State machine và quyền

`STORE` dưới đây là **phía cửa hàng** của quy trình: tài khoản cửa hàng (cửa hàng của mình) hoặc
tài khoản cửa hàng sỉ `WHOLESALE` (cửa hàng loại sỉ đang hoạt động).

```text
                 RESUBMIT (STORE)
             ┌───────────────────────┐
             ▼                       │
STORE báo ─► PENDING_HTKD ──VERIFY (HTKD được giao | ADMIN)──► PENDING_ADMIN ──APPLY (ADMIN)──► APPLIED
             │   ▲  │                                          │   │
             │   │  └─REQUEST_INFO (HTKD|ADMIN)─► NEEDS_INFO ◄─┘   │ REQUEST_INFO (ADMIN)
             │   └──────────── RETURN_TO_VERIFIER (ADMIN) ─────────┘
             ├─REJECT (HTKD|ADMIN) ─► REJECTED      NEEDS_INFO ─REJECT (ADMIN)─► REJECTED
             └─CANCEL (STORE) ─────► CANCELLED      NEEDS_INFO ─CANCEL (STORE)─► CANCELLED
```

- Mọi command kiểm tra lại trong transaction: vai trò, tài khoản `active`, `store_id` (cửa hàng
  chỉ của mình), phân công HTKD chưa bị gỡ, `expectedVersion`. Tài khoản bị khóa hoặc gỡ phân
  công bị từ chối dù session cũ còn hạn (session cũng bị thu hồi theo cơ chế hiện có).
- Nội dung chỉ đổi qua `RESUBMIT` (quay về `PENDING_HTKD`); `REQUEST_INFO`/`RETURN_TO_VERIFIER`
  xóa kết quả xác minh. Admin chỉ duyệt đúng phiên bản HTKD đã xác minh (`expectedVersion`).
- `APPLY` còn kiểm tra số điều chỉnh đã áp dụng của phiếu bằng `base_applied_count` lúc xác minh;
  nếu phiếu có điều chỉnh khác áp dụng sau đó thì phải xác minh lại.
- Cửa hàng sỉ dùng đúng quy trình này. Tài khoản `WHOLESALE` nhận hàng cho mọi cửa hàng sỉ đang
  hoạt động nên là phía cửa hàng trên chứng từ của các cửa hàng đó: xem ngữ cảnh, báo sai lệch, bổ
  sung/gửi lại, hủy, bàn giao hoặc hủy phiếu trả, theo dõi quyền nhận bù. Không bao giờ xác minh,
  duyệt/áp dụng hay xác nhận kho nhận hàng trả. Phạm vi kiểm tra ở cả API (phạm vi cửa hàng sỉ tính
  lại mỗi request, đọc lại loại cửa hàng của chứng từ) và trong transaction (`resolveActor`: tài
  khoản `active`, cửa hàng `wholesale` đang hoạt động). Cửa hàng bán lẻ luôn ngoài tầm với.
- Audit ghi đúng vai trò thật của người thao tác (`actor_role = wholesale`), không ghi thành
  `store`; phiếu khai nhận (`STORE_RECEIPT_DECLARED`) của quầy sỉ cũng vậy.
- Tài khoản `STORE` cũ gắn với cửa hàng loại sỉ giữ nguyên chính sách hiện hành (không mở thêm
  trang nhận hàng); cửa hàng sỉ nhận hàng qua tài khoản `WHOLESALE`.

## Nhãn trạng thái dùng chung

Mọi màn hình (Admin, HTKD, cửa hàng; danh sách, thẻ, chi tiết, lịch sử) lấy nhãn từ một bảng
duy nhất `adjustmentStatusCopy` (`apps/web/src/features/receipts/adjustments/adjustmentModel.ts`):

| Trạng thái dữ liệu | Nhãn                 |
| ------------------ | -------------------- |
| `PENDING_HTKD`     | Chờ HTKD xác minh    |
| `PENDING_ADMIN`    | Chờ Admin duyệt      |
| `NEEDS_INFO`       | Cần cửa hàng bổ sung |
| `APPLIED`          | Đã xử lý             |
| `REJECTED`         | Bị từ chối           |
| `CANCELLED`        | Đã hủy               |

“Đã xử lý” nghĩa là Admin **đã áp dụng thành công** điều chỉnh (tiền, phân loại bao, quyền chờ
bù có hiệu lực). Không có nghĩa hàng trả đã về kho hay hàng bù đã giao: tiến độ phiếu trả và
quyền chờ bù hiển thị riêng. Từ chối/hủy là kết quả kết thúc khác, không hiển thị như áp dụng.
Nhãn đọc từ trạng thái thật trong database, không có cờ riêng cho từng vai trò; hồ sơ `applied`
cũ tự hiện nhãn mới, không cần backfill.

## Màn hình Admin “Tồn kho & lịch sử”

- Tab cấp một: **Kho tổng** (tab con Tồn hiện tại / Kiểm hàng thiếu / Lịch sử xuất), **Kho cửa
  hàng** (Tồn cửa hàng / Sổ phát sinh), **Phiếu sai lệch**. Chỉ tab đang mở được mount và tải
  dữ liệu; module Kho tổng và Phiếu sai lệch lazy-load. Nút Làm mới chỉ tải lại tab đang mở.
- Tab, tab con, bộ lọc, trang và hồ sơ đang mở nằm trên URL theo namespace (`tab`, `kt.*`,
  `ch.*`, `psl.*`); giá trị sai về mặc định an toàn. Đổi tab/trang/mở hồ sơ tạo mục lịch sử
  (Back/Forward), sửa bộ lọc thì thay mục hiện tại. Đổi cửa hàng bỏ bao/hồ sơ không chắc thuộc
  cửa hàng mới.
- Rời tab hoặc đổi hồ sơ khi biểu mẫu còn nội dung chưa gửi: hỏi “Ở lại / Bỏ nháp và chuyển”;
  tải lại trang thì trình duyệt hỏi xác nhận.
- Tab **Phiếu sai lệch** mặc định lọc **Chờ Admin duyệt**; lọc thêm cửa hàng, trạng thái (gồm
  “Tất cả” và “Đã xử lý (lịch sử)”), mã PSL/mã phiếu nhận, ngày báo hoặc ngày xử lý (ngày Việt Nam,
  khoảng nửa mở `[từ 00:00, đến+1 00:00)`). Phân trang server 20 dòng, sắp `updated_at desc, id
desc`; đổi bộ lọc về trang 1; trang trống sau khi xử lý tự lùi về trang cuối có dữ liệu.
- Mỗi dòng: PSL, phiếu nhận gốc, cửa hàng, người báo/thời điểm, người xác minh gửi Admin/thời
  điểm, lý do, số bao, chênh lệch tiền hàng (tạm tính hay đã hiệu lực), trạng thái, người quyết
  định/thời điểm/ghi chú. Tên lấy bằng join trong cùng truy vấn danh sách, không gọi chi tiết
  từng dòng. Tài khoản/cửa hàng không đọc được hiển thị mã và “Không còn thông tin”.
- Chi tiết tái sử dụng component của màn nhận hàng; nút theo `allowedActions` từ server.

## Lịch sử xử lý

`GET /api/v1/receipt-adjustments/:adjustmentId/history?page&pageSize` đọc audit bất biến của hồ
sơ (`entity_type = store_receipt_adjustment`) và của phiếu trả sinh từ hồ sơ
(`store_receipt_return`), cũ trước mới sau (`created_at, id`), phân trang. Quyền kiểm tra theo cửa
hàng của chứng từ trước khi đọc audit (Admin mọi cửa hàng, HTKD cửa hàng được giao, cửa hàng/quầy
sỉ của mình). DTO chỉ gồm: thời gian, loại sự kiện, tên/mã và **vai trò ghi trên audit lúc thao
tác**, cửa hàng, trạng thái trước/sau, ghi chú và thay đổi nghiệp vụ audit ghi được (nguyên nhân,
chênh lệch, tổng trước/sau, thứ tự áp dụng, số quyền chờ bù/phiếu trả/bao gỡ giữ); không trả IP,
request id hay JSON thô. Trường audit cũ không có thì trả `null` và giao diện ghi “Chưa ghi
nhận”, không suy đoán. Tên người là tên hiện tại của tài khoản (audit không lưu tên tại thời điểm
thao tác). Không đổi schema, không sửa audit cũ.

## Đồng bộ giữa các phiên

- Trình duyệt thực hiện lệnh: sau khi server xác nhận, invalidate hồ sơ, danh sách, ngữ cảnh,
  lịch sử, phiếu nhận, phiếu trả, chờ bù, tồn/sổ phát sinh cửa hàng, tồn kho tổng và kiểm hàng
  thiếu. Query đang hiển thị tải lại; query khác chỉ đánh dấu cũ. Lỗi 409 (người khác thao tác
  trước) cũng tải lại hồ sơ, không tự gửi lại.
- Trình duyệt khác: query sai lệch đang hiển thị (hàng chờ, mục sai lệch của phiếu nhận, chi
  tiết, lịch sử, danh sách Admin) tự tải lại mỗi **15 giây** khi tab hiển thị, và ngay khi quay
  lại tab hoặc có mạng lại; tab ẩn không polling. Mặc định toàn ứng dụng không đổi. Đây là nhất
  quán có độ trễ ngắn (≤ 15 giây + thời gian request), không phải realtime tức thì.
- Biểu mẫu thao tác gắn với phiên bản người dùng bắt đầu nhập. Nếu hồ sơ đổi phiên bản trong lúc
  có bản nháp, màn hình báo “Hồ sơ vừa được cập nhật” và server sẽ từ chối phiên bản cũ; người
  dùng chủ động tải biểu mẫu theo phiên bản mới. Không có bản nháp thì biểu mẫu tự theo bản mới.
- Làm mới nền thất bại (mất mạng, hết quyền): giữ dữ liệu cũ, ghi rõ thời điểm dữ liệu và nút thử
  lại; lỗi lần tải đầu hiển thị trạng thái lỗi, không hiển thị như danh sách rỗng.
- Ngữ cảnh phiếu nhận trả số đếm chính xác bằng SQL (`adjustmentCount`, `openCount`); danh sách
  nhúng chỉ là trang mới nhất (100), phiếu có nhiều hơn thì mục sai lệch chuyển sang danh sách
  phân trang theo `receiptId`.
- Không thêm index/migration: danh sách lọc theo `status`/`store_id` và audit theo
  `(entity_type, entity_id, created_at)` đã có index; bảng hồ sơ nhỏ (vài trăm dòng).

## Ma trận sự kiện

| Sự kiện                | Chứng từ                                                               | Hàng/tồn cửa hàng                                                                                                               | Kho tổng                                                                                                        | Tiền                                                   | Chờ ưu tiên                              |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| STORE báo              | `PSL` `pending_htkd`, dòng từng bao, snapshot giá trị đang hiệu lực    | Bao `available` chưa từng khui → `quarantined` + ledger `quarantine`; bao khác không đổi                                        | Không đổi                                                                                                       | Không đổi                                              | Chưa tạo                                 |
| HTKD xác minh          | `pending_admin`, `verification` (trước/sau do server tính), chênh lệch | Vẫn giữ                                                                                                                         | Không đổi                                                                                                       | Tạm tính, chưa hiệu lực                                | Chưa tạo, hiển thị số sẽ phát sinh       |
| Từ chối/Hủy            | `rejected`/`cancelled` + lý do                                         | Chỉ gỡ giữ bao do chính hồ sơ giữ (ledger `release`)                                                                            | Không đổi                                                                                                       | Không đổi                                              | Không                                    |
| Admin áp dụng – giữ    | `applied`, `applied_sequence`                                          | Cùng bao vật lý đổi SKU/giá trị/kg: ledger `adjust` ra SKU cũ + `adjust` vào SKU thực tế, rồi `release` về trạng thái trước giữ | Nguyên nhân kho giao nhầm: SKU thực tế −1 on-hand; SKU duyệt +1 on-hand +1 reserved trong phiếu kiểm hàng thiếu | Có hiệu lực ngay                                       | Tạo/bổ sung đúng 1 đơn vị SKU duyệt, P0B |
| Admin áp dụng – trả    | Như trên + phiếu trả `PTH` `pending_handover`                          | Như trên nhưng bao vẫn `quarantined` (giữ chờ trả)                                                                              | Như trên                                                                                                        | Có hiệu lực ngay (cửa hàng đã nhận jeans)              | Tạo ngay, độc lập tiến độ trả            |
| Bàn giao trả           | `PTH` `in_transit`                                                     | Bao → `returned`, ledger `consume` hết kg; không còn khả dụng ở cửa hàng                                                        | Không đổi                                                                                                       | Giá trị hàng trả ghi giảm tồn cửa hàng một lần tại đây | Không đổi                                |
| Kho nhận đủ            | `received`                                                             | —                                                                                                                               | +1 on-hand SKU trả (ledger `return`, đúng một lần)                                                              | —                                                      | Không đổi                                |
| Kho nhận thiếu/sai     | `disputed` + ghi chú                                                   | —                                                                                                                               | Không tăng                                                                                                      | —                                                      | Không đổi                                |
| Đối soát xong          | `received` (nhập kho) hoặc `lost`                                      | —                                                                                                                               | +1 chỉ khi tìm thấy                                                                                             | —                                                      | Không đổi                                |
| Hủy trả (đổi sang giữ) | `PTH` `cancelled`                                                      | Gỡ giữ, bao bán được                                                                                                            | Không đổi                                                                                                       | Không đổi                                              | Không đổi                                |
| Giữ → trả sau áp dụng  | `PTH` mới liên kết dòng điều chỉnh                                     | Giữ lại bao                                                                                                                     | Không đổi                                                                                                       | Không đổi                                              | Không đổi                                |

## Tiền

- Theo bao nguồn: giá trị mới = round_half_up(gram × giá/kg ÷ 1000), cùng quy tắc chốt phiếu;
  chênh lệch = giá trị mới − giá trị đang hiệu lực của bao. Không chia đều tổng phiếu.
- Chỉ đổi kg khi HTKD ghi căn cứ cân lại. Phí vận chuyển/bốc xếp/VAT mặc định chênh lệch 0;
  HTKD chỉ nhập khi có thay đổi thật. VAT vẫn nằm ngoài giá vốn; phiếu cũ chưa ghi VAT giữ
  “Chưa ghi nhận”, không cho điều chỉnh VAT thành số.
- Ví dụ đã kiểm thử: gốc 3 × 1.000.000 = 3.000.000; bao jeans 20 kg × 40.000 = 800.000; chênh
  lệch −200.000; hiệu lực 2.800.000; nhận bù 1 đầm 1.000.000 ghi ở phiếu nhận bù; lũy kế
  3.800.000 với 3 đầm + 1 jeans. Không tính hai lần bao đầm thiếu.
- Hệ thống chưa có phân hệ thanh toán/công nợ nên không có khoản thanh toán cần đối soát.

## Quyền chờ ưu tiên và nhận bù

- `receipt_shortage_entitlements` khóa duy nhất theo bao nhận gốc: một bao vật lý chỉ phát sinh
  tối đa một quyền, dù retry, xác minh lại hay điều chỉnh lần sau (jeans → áo khoác không tạo
  thêm). Phân loại ngược về SKU duyệt sau khi đã có quyền bị chặn.
- Dùng đúng cơ chế nhận thiếu P0B hiện có: có phiếu chờ `active` cùng cửa hàng/SKU thì cộng vào
  (ghi `waitMode = merged`), không có thì tạo phiếu chờ mới với nguồn đơn đặt gốc. Không hồi sinh
  reservation đã tất toán, không chiếm lượt đặt thường.
- Nhận bù đi qua chuỗi hiện có: đề nghị ưu tiên → phân bổ P0A → xuất/giao gộp → nhận → HTKD chốt;
  chuyến bù nhận thiếu tiếp tục dùng đối soát phiếu chờ sẵn có. Màn hình hiển thị trạng thái
  quyền: chờ cấp / có đề nghị / đã giữ / đang giao / đã nhận.

## Hàng đã khui, bán, chuyển

Invariant cũ cho phép báo bao đã khui và giữ phần còn lại, chỉ chặn áp dụng khi đã bán/lọc/chuyển.
Invariant mới: **chỉ được tạo báo mới khi bao AVAILABLE, chưa từng xác nhận khui để bán và không
có giao dịch/ràng buộc bán, lọc, chuyển không tương thích**. OPEN còn nguyên kg cũng bị chặn.
Khui vật lý để kiểm tra hàng không phải thao tác xác nhận khui bán trên hệ thống.

Nếu phát hiện sai hàng, hãy báo sai lệch trước khi xác nhận khui kiện để bán.

Server đọc lại trạng thái, openedAt, audit khui và dependencies dưới khóa bao. Payload trộn bao
hợp lệ/không hợp lệ rollback toàn bộ header, line, hold, audit và idempotency. API trả 409 qua
error envelope hiện có, details.blockers theo receiptBagId; BAG_ALREADY_OPENED thống nhất domain,
contract và UI. Context trả canReportDiscrepancy, reportBlockers và openedAt; không nhận client
eligibility làm căn cứ ghi. Dependencies của context được đọc theo tập hợp, không truy vấn từng bao.

Hồ sơ đang giữ hợp lệ từ AVAILABLE tiếp tục RESUBMIT/VERIFY/APPLY; kiểm tra hold của chính hồ sơ,
holdPreviousStatus, timestamp và lịch sử. Legacy pending của bao đã khui bị chặn ba lệnh đó,
giữ CANCEL/REJECT theo quyền để giải phóng hàng. APPLIED/REJECTED/CANCELLED và phiếu trả sau APPLIED
không tính lại hồi tố. Không tự hủy hồ sơ, không sửa phiếu chốt, ledger hay audit.

Khóa CREATE: idempotency → receipt → bag ID tăng dần → row. RESUBMIT/VERIFY/APPLY thêm khóa bao
sau khóa header, cùng thứ tự. Khui: idempotency → store-sorting → bag → row → IDOSI settlement.
Không lấy store-sorting sau bag. Test PostgreSQL dùng barrier khóa advisory và hai request thật
cho cả thứ tự thắng, không dùng sleep ngẫu nhiên. Bên thắng giữ invariant, bên thua trả conflict.

Form giữ nội dung sau 409, tải lại context, khóa bao mất điều kiện và cho bỏ chọn riêng. Khui
invalidate tồn, lịch sử, context và IDOSI pending. Khui refetch mỗi 30 giây khi trang hoạt động
và khi focus; context dùng cơ chế focus của TanStack Query. Không cam kết realtime giữa các tab.

## Kho tổng

- Không tự cộng lại SKU duyệt thành tồn khả dụng khi cửa hàng báo.
- Nguyên nhân `SOURCE_MISCLASSIFICATION`: sổ kho tổng đã đúng về số lượng, không phát sinh.
- Nguyên nhân `WAREHOUSE_MISPICK`: ghi giảm 1 SKU thực tế đã rời kho (từ tồn chưa giữ; không đủ
  thì chặn và yêu cầu kiểm kê) và giữ 1 SKU duyệt trong phiếu kiểm hàng thiếu có sẵn
  (`warehouse_shortage_checks` thêm `store_receipt_adjustment_line_id`); chỉ khi xác nhận “còn ở
  kho” mới thành tồn phân bổ được.
- Hàng trả chỉ tăng tồn khi kho xác nhận thực nhận; sửa phân loại và nhận hàng trả là hai bút
  toán tách biệt nên không cộng jeans hai lần.

## Báo cáo

Số tổng của báo cáo tháng vẫn là chứng từ gốc theo ngày chốt. Mục “Điều chỉnh sau chốt & trả
kho” ghi chênh lệch theo ngày áp dụng (có thể thuộc phiếu tháng trước), giá vốn/VAT sau điều
chỉnh = gốc + chênh lệch, hàng trả theo ngày bàn giao, và chênh lệch kg/tiền theo SKU. CSV xuất
cùng dữ liệu.

## Bằng chứng

Hệ thống chưa có lưu tệp đính kèm; hồ sơ lưu “Bằng chứng” dạng ghi chú (nơi lưu ảnh, người chứng
kiến). Không xây kho tệp mới trong phạm vi này.

## Migration, triển khai, rollback

- `0026_receipt_discrepancy_adjustments`: thêm 4 bảng, 5 enum, cột nullable
  `warehouse_shortage_checks.store_receipt_adjustment_line_id`, đổi unique index phiếu kiểm hàng
  thiếu thành partial (dữ liệu cũ đều có cột mới NULL nên ràng buộc cũ giữ nguyên), trigger mã
  `PSL`/`PTH`. Không backfill, không sửa dữ liệu cũ; app cũ bỏ qua bảng mới.
- Rollback app: triển khai lại image SHA trước. Nếu đã có hồ sơ đang giữ bao (`quarantined`),
  app cũ vẫn chặn bán các bao đó (đúng an toàn) nhưng không có màn hình gỡ giữ; ưu tiên
  forward-fix. Không xóa bảng/cột khi rollback.
- Kiểm tra sau triển khai: `GET /api/v1/receipt-adjustments` trả 200 cho Admin, phiếu nhận đã chốt
  hiển thị mục “Sai lệch sau khui bao”; `/inventory?tab=adjustments` hiển thị tab Phiếu sai lệch và
  `GET /api/v1/receipt-adjustments/:id/history` trả 200 cho hồ sơ trong phạm vi.
- Tab Phiếu sai lệch, lịch sử và nhãn “Đã xử lý” không đổi schema; rollback bằng image trước chỉ
  mất màn hình/endpoint mới, dữ liệu giữ nguyên.
- Mở quyền cho cửa hàng sỉ không đổi schema hay dữ liệu; rollback bằng image trước chỉ làm quầy sỉ
  mất thao tác phía cửa hàng (API trả 403), hồ sơ đã tạo vẫn do HTKD/Admin xử lý tiếp được.
