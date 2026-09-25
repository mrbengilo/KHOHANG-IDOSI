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

## Ma trận sự kiện

| Sự kiện                | Chứng từ                                                               | Hàng/tồn cửa hàng                                                                                                               | Kho tổng                                                                                                        | Tiền                                                   | Chờ ưu tiên                              |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| STORE báo              | `PSL` `pending_htkd`, dòng từng bao, snapshot giá trị đang hiệu lực    | Bao `available/opened` → `quarantined` + ledger `quarantine`; bao khác không đổi                                                | Không đổi                                                                                                       | Không đổi                                              | Chưa tạo                                 |
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

Áp dụng chỉ khi toàn bộ kg của bao còn trên kệ: chưa bán/xuất (kể cả bán IDOSI), chưa lọc phân
loại, chưa chuyển, không có phiếu xuất chờ duyệt hay phiếu chuyển nháp. Bao đã khui nhưng chưa
phát sinh giao dịch được hỗ trợ đầy đủ. Các trường hợp còn lại **vẫn được báo và giữ phần còn
lại**, nhưng Admin bị chặn áp dụng với lý do cụ thể (`BAG_PARTIALLY_CONSUMED`, `BAG_SOLD`,
`BAG_SORTED`, `BAG_TRANSFERRED`, `BAG_DEPLETED`, `BAG_PENDING_OUTBOUND`, ...). Tách giá vốn đã
xuất khỏi giá trị tồn còn lại **chưa được hỗ trợ**; các hồ sơ này cần đối soát thủ công rồi từ
chối/hủy để gỡ giữ.

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
  hiển thị mục “Sai lệch sau khui bao”.
- Mở quyền cho cửa hàng sỉ không đổi schema hay dữ liệu; rollback bằng image trước chỉ làm quầy sỉ
  mất thao tác phía cửa hàng (API trả 403), hồ sơ đã tạo vẫn do HTKD/Admin xử lý tiếp được.
