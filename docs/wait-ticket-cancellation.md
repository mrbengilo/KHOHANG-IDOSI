# Phiếu chờ ưu tiên: đề nghị một phần/toàn bộ, quyền hủy và deadline

Tài liệu nghiệp vụ cho chính sách phiếu chờ (migration `0037_priority_wait_policy`).

## Đối tượng

| Đối tượng                 | Bảng / trạng thái                                                                   | Ý nghĩa                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phiếu chờ                 | `wait_tickets` (`active`, `fulfilled`, `cancelled`, `expired`)                      | Nhu cầu chưa đáp ứng của một cửa hàng cho **một sản phẩm**. Tồn tại qua nhiều phiên. Không xóa cứng.                                             |
| Đề nghị nhận hàng ưu tiên | `daily_priority_offers` (`offered`, `accepted`, `declined`, `expired`, `cancelled`) | Lượng hàng một phiên dành cho phiếu. Có `order_session_id`, `offered_quantity`, `eligible_quantity_at_offer` (căn cứ) và `response_deadline_at`. |
| Hàng ưu tiên đã cấp       | `allocation_lines.priority_offer_id` + `reservations` đang `active`                 | Đã thuộc phân bổ. Giữ trong kho tới đơn thường kế tiếp của cửa hàng rồi giao chung (`materializeOutboundRequests`). Không xuất riêng.            |

Giao diện nhóm phiếu theo cửa hàng nhưng dữ liệu lưu **theo cửa hàng × sản phẩm**. Mọi quyết định
một phần/toàn bộ, hủy hay giữ đều tính trên từng dòng; một dòng đủ hàng không bao giờ làm hủy
dòng khác. Mỗi đề nghị được phản hồi riêng, không có lệnh nhận/từ chối cả nhóm.

## Căn cứ một phần / toàn bộ

- Khi worker tạo đề nghị ở mốc đóng nhận đơn, nó ghi `eligible_quantity_at_offer` = nhu cầu
  còn đủ điều kiện được mời của phiếu tại thời điểm đó (phần chưa phân bổ, trừ cam kết sống khác).
- **Toàn bộ (FULL)** khi `offered_quantity >= eligible_quantity_at_offer` **và** tại thời điểm
  quyết định phiếu vẫn không chờ nhiều hơn `offered_quantity` **và** không có đề nghị sống khác.
- Mọi trường hợp còn lại là **một phần (PARTIAL)**: offer legacy (`NULL`), nhu cầu tăng sau khi
  tạo offer, hoặc không chứng minh được bao phủ toàn bộ.
- Không dùng tồn kho lúc deadline hay `stock_held_quantity` đã release để suy luận.
- Hàm dùng chung: `priorityOfferCoverage` và `cancelWaitTicketForFullOfferInTransaction`
  (`packages/database/src/wait-ticket-operations.ts`), dùng cho cả API và worker.

## Bảng nghiệp vụ đã chốt

| #   | Đề nghị                        | Phản hồi                    | Offer      | Phiếu chờ                                            | Hold                                     |
| --- | ------------------------------ | --------------------------- | ---------- | ---------------------------------------------------- | ---------------------------------------- |
| 1   | Một phần                       | Nhận hàng                   | `accepted` | Giữ; phần chưa cấp tiếp tục chờ                      | Chuyển thành reservation phân bổ một lần |
| 2   | Một phần                       | Không nhận                  | `declined` | **Giữ nguyên** nhu cầu, không gắn tag hủy            | Trả ngay                                 |
| 3   | Một phần                       | Không phản hồi tới deadline | `expired`  | **Giữ nguyên**, xét ở phiên sau                      | Trả tại lần chạy phân bổ                 |
| 4   | Toàn bộ                        | Nhận trước deadline         | `accepted` | Phân bổ/giữ giao chung, không hủy                    | Chuyển thành reservation                 |
| 5   | Toàn bộ                        | Không nhận                  | `declined` | `cancelled`, `cancellation_kind=full_offer_declined` | Trả trong cùng transaction phản hồi      |
| 6   | Toàn bộ                        | Không phản hồi tới deadline | `expired`  | `cancelled`, `cancellation_kind=full_offer_timeout`  | Trả, **trước** khi tính phân bổ          |
| 7   | Không có hàng / không có offer | —                           | —          | Giữ phiếu; không hủy chỉ vì phiên đóng               | —                                        |

Đọc thông báo, đóng popup, tải lại trang hoặc đồng hồ đếm ngược trên trình duyệt **không** phải
phản hồi và không ghi gì. Trình duyệt chỉ refetch; deadline do server quyết định.

Ví dụ: cửa hàng A chờ 3 nam + 2 nữ, phiên chia được 1 nam + 1 nữ → hai đề nghị một phần.

- Nhận: giữ 1 nam + 1 nữ cho A; sau lần chạy phân bổ còn chờ 2 nam + 1 nữ; chưa có đơn thường
  thì reservation vẫn `active`, `outbound_request_line_id IS NULL`.
- Không nhận hoặc để hết hạn: vẫn chờ 3 nam + 2 nữ; không được đề nghị lại trong phiên đã kết thúc
  phản hồi; phiên sau xét lại.

## Phiên chính và phiên bổ sung

Cùng một luồng, giờ lấy từ chính phiên (`Asia/Ho_Chi_Minh`, không hard-code):

- Đóng nhận đơn (`inventory_snapshot_due_at`): chụp tồn, chia ưu tiên theo vòng, tạo đề nghị
  khi lượng > 0 (kể cả một phần), giữ hàng tạm. Deadline của đề nghị = giờ bắt đầu phân bổ của
  **phiên tạo đề nghị** (`request_deadline_at`).
- Bắt đầu phân bổ: khóa phiếu → khóa đề nghị (cùng thứ tự với API), hết hạn đề nghị chưa phản
  hồi, hủy phiếu đủ điều kiện (dòng 6), trả hold, rồi mới tính phân bổ trên các phiếu còn `active`.
- Ví dụ: phiên chính đóng 08:00/phân bổ 09:00; phiên bổ sung đóng 14:00/phân bổ 14:30.
- Phiên mới phải có giờ phân bổ **sau** giờ đóng (validate API, contract và form Admin). Phiên
  legacy có khoảng 0 vẫn đọc được nhưng worker không tạo đề nghị cho nó.
- Snapshot chạy bù tại/ sau giờ phân bổ của phiên **không tạo đề nghị** (không có đề nghị quá
  hạn rồi hủy phiếu ngay).
- Một phiếu còn đề nghị chưa được phiên của nó chốt (kể cả đã quá deadline do worker trễ) không
  được phiên khác đề nghị tiếp: một nhu cầu không bao giờ có hai đề nghị sống.
- Không có lệnh sửa lịch phiên; deadline đã lưu trên đề nghị không bị rút ngắn.

## Quyền hủy thủ công

`POST /api/v1/wait-tickets/:waitTicketId/cancel` (idempotency key bắt buộc, lý do ≥ 3 ký tự).

| Vai trò   | Quyền                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| STORE     | Phiếu `active` của chính cửa hàng (đang hoạt động), mọi thời điểm còn nhu cầu.                       |
| WHOLESALE | Giữ nguyên quyền hiện có với cửa hàng sỉ.                                                            |
| ADMIN     | Mọi phiếu `active` của mọi cửa hàng, kể cả cửa hàng inactive. Admin phải còn active.                 |
| HTKD      | Được hủy phiếu active của cửa hàng đang hoạt động và đang được phân công; kiểm tra lại trước replay. |

Khi hủy:

- Đề nghị `offered` và `accepted` chưa phân bổ của phiếu → `cancelled`, trả hold nguyên tử.
- Phần đã phân bổ (reservation) giữ nguyên và vẫn giao chung với đơn thường kế tiếp.
- `remaining_quantity` giữ nguyên làm số lượng bị hủy; không cộng vào `fulfilled_quantity`
  (`remaining + fulfilled = original` luôn đúng).
- Phiếu `fulfilled`/`cancelled` không bị sửa ngược; gọi lại với key khác trả 409, cùng key cùng
  payload trả replay, cùng key khác payload trả conflict.

### Phiếu sinh từ nhận thiếu chưa hoàn tất

Guard cũ chặn hủy khi phiếu nhận thiếu còn chờ HTKD đã được bỏ, thay bằng xử lý an toàn:

- Hủy không chạm tồn kho; HTKD hoàn tất phiếu nhận như thường (tồn chỉ tính theo số thực nhận).
- Nếu phiếu bị trả về và cửa hàng khai lại **giảm** số thiếu sau khi đã hủy, phần nhu cầu đã hủy
  không bị trừ lại, không tạo lại, không chặn việc khai lại (audit
  `STORE_RECEIPT_SHORTAGE_REDUCED_AFTER_WAIT_CANCELLED`).
- Nếu số thiếu **tăng** hoặc phát sinh thiếu mới trên hàng đã cấp từ phiếu đã hủy, phần thiếu
  mới được xếp vào phiếu đang chờ hoặc phiếu mới; phiếu đã hủy không bao giờ được mở lại.

## Audit

| Hành động (`audit_logs.action`)             | Entity         | Khi nào                                     |
| ------------------------------------------- | -------------- | ------------------------------------------- |
| `WAIT_TICKET_STORE_CANCELLED`               | wait_ticket    | Cửa hàng/sỉ hủy                             |
| `WAIT_TICKET_HTKD_CANCELLED`                | wait_ticket    | HTKD hủy phiếu cửa hàng được phân công      |
| `WAIT_TICKET_ADMIN_CANCELLED`               | wait_ticket    | Admin hủy                                   |
| `PRIORITY_OFFER_DECLINED`                   | priority_offer | Từ chối lượt (một phần hoặc toàn bộ)        |
| `PRIORITY_OFFER_EXPIRED`                    | priority_offer | Lượt hết hạn (API trả lời muộn hoặc worker) |
| `WAIT_TICKET_STORE_DECLINED_FULL_PRIORITY`  | wait_ticket    | Hủy do từ chối đề nghị đủ hàng              |
| `WAIT_TICKET_PRIORITY_RESPONSE_TIMEOUT`     | wait_ticket    | Hủy do không phản hồi đề nghị đủ hàng       |
| `PRIORITY_OFFER_CANCELLED_WITH_WAIT_TICKET` | priority_offer | Lượt bị hủy cùng phiếu                      |

Metadata gồm actor (hoặc SYSTEM = `NULL`), `offerId`, `orderSessionId`, deadline, căn cứ
`{offeredQuantity, eligibleQuantityAtOffer, ticketRemainingQuantity}` và snapshot trước/sau.

## Kiểm thử

- `packages/database/tests/wait-ticket-cancellation.integration.test.ts`: quyền, admin + cửa
  hàng inactive, trả hold đã nhận, một phần/toàn bộ/legacy, phiếu đã hoàn tất, idempotency.
- `apps/worker/tests/wait-ticket-offer-policy.integration.test.ts`: ví dụ 3 nam + 2 nữ, đủ hàng
  nhận/từ chối/im lặng, phiên chính 08:00–09:00 và bổ sung 14:00–14:30, chạy bù, nhu cầu tăng,
  legacy, đua hủy–nhận; số dư khớp sổ phát sinh ở mọi bước.
- `apps/api/test/wait-ticket-cancellation.postgres.test.mjs`, `apps/api/test/app.test.mjs`,
  `packages/database/tests/stranded-outbounds.integration.test.ts`, component tests web.
