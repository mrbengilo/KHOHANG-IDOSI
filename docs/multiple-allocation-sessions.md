# Nhiều phiên phân bổ độc lập trong một ngày

Admin tạo thêm phiên ở tab **Phân bổ hàng hóa → Tạo phiên mới**. Phiên mặc định của ngày vẫn do
hệ thống tự mở theo cấu hình (mốc chụp tồn/chốt nhận đơn và mốc phân bổ hiện hành, ví dụ 08:00 /
09:00). Không có giới hạn số phiên trong ngày.

## Mô hình

| Khái niệm         | Lưu ở đâu                                                            | Ghi chú                                                                                                     |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Loại phiên        | `order_sessions.kind` (`default` / `manual`)                         | Không suy từ `created_by_user_id` (phiên tự động có thể ghi user đã mở màn đặt hàng).                       |
| Mã phiên          | `order_sessions.code` (`PDH-000123`, trigger `assign_document_code`) | Duy nhất toàn hệ thống, cấp trong cùng transaction, an toàn khi hai Admin tạo đồng thời.                    |
| Một mặc định/ngày | unique `order_sessions_one_default_per_day_uidx`                     | Tính cả phiên mặc định đã hủy: ngày đã hủy không bị tự tạo lại.                                             |
| Lịch phiên        | `opened_at`, `inventory_snapshot_due_at`, `request_deadline_at`      | Hiển thị: mở nhận đơn → chốt nhận đơn/chụp tồn → bắt đầu phân bổ; `completed_at` là lúc hoàn tất thực tế.   |
| Offer ưu tiên     | `daily_priority_offers.order_session_id`                             | Phiên sở hữu offer. NULL chỉ còn ở dòng cũ không chứng minh được chủ; dòng đó giữ phạm vi “một phiên/ngày”. |

Phiên không bao giờ gộp với nhau; kết quả không gộp giữa các phiên. Gộp phiếu chỉ xảy ra trong
`(phiên, cửa hàng)` (`merged_orders`, `merged_order_sources`). Chứng từ là `phiên:cửa hàng`, phiên
bản là run hoàn tất của đúng phiên đó.

## Vòng đời và định tuyến đơn

- Admin tạo phiên → trạng thái `draft` (“Đã lên lịch”). Phiên (mọi loại) tự mở đúng giờ mở nhận
  đơn đã lưu: worker mở ở mỗi lượt quét, màn đặt hàng mở khi cần (`openDueScheduledSessions`). Lịch
  Admin đã đặt không bị ghi đè.
- Không tạo phiên có giờ chốt đã qua (không backdate để sinh kết quả lịch sử). Không tạo phiên có giờ
  chốt trùng đúng một phiên `draft/open` khác, vì phiên đó sẽ không bao giờ nhận được đơn
  (409 `CONFLICT`). Cửa sổ chồng nhau khác vẫn được phép.
- Đơn không chỉ định phiên vào **phiên đang nhận có giờ chốt sớm nhất**, hòa thì phiên tạo trước,
  rồi theo id (`resolveOrderingSession`). Không có phiên đang nhận thì mở phiên mặc định của đợt kế
  tiếp như trước — đặt hàng 24/7, không chờ Admin mở phiên. Màn đặt hàng hiện rõ phiên đích
  (mã · ngày · giờ chốt · giờ phân bổ) và server kiểm tra lại phiên khi gửi.
- Đơn đã gửi giữ nguyên `order_session_id`, kể cả khi sau đó Admin thêm một phiên chốt sớm hơn.
- Hủy chỉ áp dụng cho đúng phiên và các phiếu chưa phân bổ của nó. Phiên đã mở không hủy được sau
  giờ chụp tồn (hàng ưu tiên đang được giữ); phiên `draft` chưa từng mở thì vẫn hủy được vì worker
  chưa chụp tồn cho nó.

## Hạn mức hai phiếu đặt thường

- Invariant cũ: đếm phiếu của phiên đích và mọi phiếu gửi sau lần hoàn tất phân bổ **gần nhất của
  bất kỳ phiên nào**.
- Vấn đề khi nhiều phiên/ngày: S1 (phân bổ 09:00) hoàn tất sau khi cửa hàng đã gửi phiếu cho S2
  (phân bổ 11:00) → phiếu S2 bị coi là đã “reset”, cửa hàng được thêm hai phiếu dù S2 chưa phân bổ.
- Invariant mới (`countOrderingQuota`): một phiếu chưa hủy chiếm lượt khi thuộc phiên đích, hoặc
  phiên của nó chưa hoàn tất và **chưa có phiên nào có giờ phân bổ ≥ giờ phân bổ của nó hoàn tất sau
  khi phiếu được gửi**. Khi các phiên hoàn tất đúng thứ tự lịch, kết quả trùng quy tắc cũ; phiên kẹt
  quá cửa sổ catch-up vẫn được giải phóng bởi phiên sau như trước. Tạo phiên hay đóng phiên không
  reset hạn mức; phiếu ưu tiên không chiếm lượt.

## Worker

- `listDueSessions` lấy mọi phiên đến hạn theo thời điểm lưu trên từng phiên; khóa
  `idosi-allocation-worker:stock-jobs` tuần tự hóa mọi job chụp tồn/phân bổ để phiên sau luôn lập kế
  hoạch trên hold/reservation đã commit của phiên trước. Khả năng cấp vẫn lấy
  `min(snapshot, tồn chưa giữ hiện tại)` nên hai snapshot không cấp hai lần cùng một bao.
- Offer: id xác định `priority-offer:<sessionId>:<ticketId>:1`, ghi `order_session_id`. Một phiếu chờ
  chỉ có tối đa một offer còn hiệu lực (đang chờ trả lời hoặc đã nhận nhưng chưa phân bổ) trên mọi
  phiên; phiên sau chỉ mời lại khi offer đó đã kết thúc.
- Phân bổ chỉ dùng offer đã nhận **của chính phiên** (hoặc dòng cũ NULL cùng ngày) và chưa được phân
  bổ. Trước bản này S2 cùng ngày nhặt lại offer đã nhận/đã phân bổ của S1 và hỏng job
  (`Confirmed priority offer references an unknown wait ticket`).
- Hết hạn offer: offer của chính phiên tới hạn, và offer quá hạn từ trước giờ phân bổ của phiên
  (phiên chủ đang trễ; offer quá hạn không còn được nhận, hết hạn chỉ trả bao đang giữ). Offer của
  phiên khác có hạn cùng lúc hoặc muộn hơn không bị đụng tới.
- Phiếu chờ có thể đi qua nhiều phiên; mỗi lần giữ/cấp là sự kiện riêng gắn phiên/run, chỉ dùng
  phần còn lại. Hàng ưu tiên giao chung chuyến sau vẫn mang run cấp gốc (`carriedAllocations`) và
  không cộng vào lượng cấp mới.

## Đề nghị ưu tiên một phần/toàn bộ và deadline theo phiên (migration 0037)

Chi tiết nghiệp vụ: [phiếu chờ ưu tiên](wait-ticket-cancellation.md).

- Phiên chính và phiên bổ sung dùng cùng luồng. Tại giờ đóng nhận đơn của phiên, mọi phần chia
  được > 0 trở thành đề nghị (kể cả một phần) và ghi `eligible_quantity_at_offer` làm căn cứ.
- Hạn phản hồi của đề nghị là giờ bắt đầu phân bổ **của phiên tạo đề nghị** (ví dụ 09:00 cho phiên
  chính 08:00, 14:30 cho phiên bổ sung 14:00), không lấy phiên tạo phiếu chờ ban đầu.
- Phiên mới bắt buộc giờ phân bổ sau giờ đóng nhận đơn. Snapshot chạy bù tại/sau giờ phân bổ không
  tạo đề nghị.
- Lần chạy phân bổ khóa phiếu → khóa đề nghị, hết hạn đề nghị chưa phản hồi, hủy phiếu có đề nghị
  toàn bộ không được phản hồi (`full_offer_timeout`), trả hold, rồi mới tính phân bổ. Đề nghị một
  phần hết hạn chỉ trả hàng; phiếu tiếp tục được xét ở phiên sau.
- Phiếu còn đề nghị chưa được phiên chủ chốt (kể cả khi worker trễ quá deadline) không được phiên
  khác đề nghị tiếp, nên không có hai đề nghị sống cho cùng nhu cầu.

## Migration `0036_order_sessions_offers_adjustments` (expand-only)

1. `order_sessions.kind` mặc định `default`; backfill `manual` cho phiên có audit
   `ORDER_SESSION_CREATED` (Admin tạo, luôn ghi trong cùng transaction). Nếu một ngày còn hơn một
   phiên mặc định (không thể sinh ra bởi đường tự động), phiên tạo sớm nhất giữ mặc định, phiên khác
   thành `manual` kèm audit `ORDER_SESSION_KIND_BACKFILLED`. Trigger tăng version bị tắt riêng trong
   lúc backfill để version/updated_at của phiên lịch sử không đổi.
2. `daily_priority_offers.order_session_id` (nullable, FK): backfill theo bằng chứng mạnh nhất trước
   — run đã phân bổ offer; lịch chụp tồn/hạn trả lời trùng đúng một phiên có snapshot; phiên duy nhất
   có snapshot của ngày. Không suy ra được thì để NULL (nhánh tương thích). Unique cũ theo ngày được
   giữ cho dòng NULL; dòng có chủ dùng unique theo phiên.
3. Index lịch sử đặt hàng và bảng `warehouse_stock_adjustments` (xem
   [điều chỉnh tồn kho tổng](warehouse-stock-adjustments.md)).

Kiểm tra trước deploy (chỉ đọc):

```sql
select business_date, count(*) from order_sessions
where deleted_at is null and not exists (
  select 1 from audit_logs a where a.entity_id = order_sessions.id and a.action = 'ORDER_SESSION_CREATED')
group by business_date having count(*) > 1;
```

Sau deploy: `select count(*) from daily_priority_offers where order_session_id is null;` là số offer
cũ giữ phạm vi theo ngày.

## Tương thích khi deploy và rollback

- Trong lúc watcher migrate, API/worker cũ vẫn chạy: chúng ghi `kind` mặc định `default` (đúng cho
  đường tự động) và offer `order_session_id = NULL` (được xử lý theo ngày như trước).
- Rollback code cũ **sau khi** đã có nhiều phiên trong một ngày là không an toàn: worker cũ đọc offer
  đã nhận theo ngày và có thể hỏng job phiên thứ hai; API cũ chặn tạo phiên và mở nhầm phiên Admin
  theo ngày. Ưu tiên forward-fix. Nếu buộc phải rollback: dừng worker, hủy (khi còn được phép) các
  phiên bổ sung chưa chụp tồn, không xóa phiên hay restore đè dữ liệu.

## Chính sách được hỗ trợ và khôi phục phiên bị kẹt

Lệnh tạo phiên và cập nhật cấu hình chỉ nhận chính sách mà worker hiện hỗ trợ:
`idosi-round-robin-p0a-p3-v1`. Form hiển thị giá trị này ở chế độ chỉ đọc. Chuỗi chính
sách là mã thuật toán, không phải số thứ tự phiên; không tăng thành v2/v3 khi tạo
phiên bổ sung. Schema đọc vẫn chấp nhận nhãn lịch sử để giữ khả năng kiểm toán.

Nếu phiên cũ báo `Unsupported allocation policy`:

1. Đối chiếu SHA đang chạy, log worker, audit tạo phiên và cấu hình hiện tại. Không
   bỏ kiểm tra trong worker hoặc mặc định coi chính sách lạ là v1.
2. Sao lưu có checksum trước mọi sửa dữ liệu. Xác minh đúng phiên, phiên bản, trạng
   thái và chưa có allocation run; kiểm tra snapshot, đơn gốc và hàng ưu tiên đã giữ.
3. Khi đã được chủ hệ thống yêu cầu khôi phục bằng chính sách được hỗ trợ, sửa đúng
   trường chính sách trong transaction với khóa `idosi-allocation-worker:stock-jobs`,
   khóa dòng và điều kiện version; tăng version và ghi audit before/after, lý do,
   request ID và đường dẫn backup. Nếu điều kiện thay đổi thì dừng và kiểm tra lại.
4. Để worker tự catch-up qua transaction/idempotency hiện có. Đối soát đúng một run,
   số cấp mới/còn chờ, nguồn hàng giao chung, ledger và heartbeat. Không tạo run,
   reservation hay phiếu xuất thủ công, không chạy lại phiên đã hoàn tất.
5. Admin bấm **Tải lại** để cập nhật cả kết quả và trạng thái worker.

Bản vá chặn đầu vào không cần migration hoặc thay thuật toán. Rollback code qua quy
trình phát hành không hoàn tác phiên đã phân bổ; không restore đè database chỉ để
hoàn tác nhãn chính sách của một phiên đã có giao dịch.
