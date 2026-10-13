# Admin cập nhật trạng thái đặt Reshare

Admin mở **Đơn đặt và tồn Reshare → Đơn đặt Reshare**, tại mỗi kết quả phân bổ bấm
**Đánh dấu đã đặt** hoặc **Đánh dấu chưa đặt**. Trạng thái được lưu vào PostgreSQL,
đọc lại sau khi lưu và dùng cho bộ lọc phía server. HTKD, cửa hàng và quầy sỉ chỉ xem.
Dòng chưa có mã RE vẫn đổi được; mã RE không được tạo giả.

## Quy tắc nghiệp vụ

- Trước đây lịch sử suy ra trạng thái chỉ từ chứng từ RE. Nay xác nhận của Admin được ưu tiên;
  chưa từng được Admin sửa thì giữ cách hiển thị cũ. Không tự đánh dấu dữ liệu lịch sử đã đặt.
- Trạng thái đặt hàng độc lập với cửa hàng chấp nhận/từ chối kết quả, chứng từ RE đã xuất hàng,
  giao hàng, thực nhận và coverage đối chiếu tồn Reshare. Đánh dấu chưa đặt không hủy chứng từ,
  không trả hàng, không hoàn nguồn; đánh dấu đã đặt không phát sinh xuất kho lần hai hay cộng tồn.
- Chỉ kết quả PENDING/ACCEPTED có hàng được cấp và đơn RE chưa hủy được đổi trạng thái.
  Kết quả còn PENDING vẫn phải được cửa hàng/HTKD xác nhận để chạy quy trình xuất hàng.
- Xác nhận được gắn vào kết quả phân bổ (decision ID), gồm cả lịch sử đã nhận hàng mà không có RE.
  Việc chấp nhận/cutover tạo RE về sau không ghi đè xác nhận đã lưu của Admin.
- Khi xem phiếu phân bổ, nhãn chứng từ là **Đã lập đơn Reshare**; trạng thái đặt thực tế được xem
  trong lịch sử đơn, tránh nhầm chứng từ đã lập với xác nhận đặt hàng của Admin.

## API, lưu trữ và đồng thời

`PUT /api/v1/reshare-orders/{decisionId}/status`, chỉ Admin đang hoạt động:

```json
{
  "status": "ORDERED",
  "expectedStatus": "NOT_ORDERED",
  "expectedVersion": 0
}
```

Bắt buộc `Idempotency-Key`. Backend xác thực lại quyền trong transaction kể cả replay,
khóa kết quả và chứng từ, kiểm tra trạng thái/phiên bản rồi cập nhật bốn cột
`reshare_status`, `reshare_status_version`, `reshare_status_updated_at`,
`reshare_status_updated_by` trên `allocation_result_decisions`. Cùng transaction ghi audit
`RESHARE_ORDER_STATUS_UPDATED` với giá trị trước/sau, Admin và cửa hàng liên quan.
Hai lệnh cùng phiên bản chỉ một lệnh thành công; lệnh còn lại nhận `VERSION_CONFLICT`.
Retry cùng khóa/nội dung không ghi thêm audit; dùng lại khóa với nội dung khác bị từ chối.

`GET /reshare-orders?includeStatusControl=true` trả thêm phiên bản và người/thời điểm sửa.
Tham số opt-in giữ response cũ tương thích với các trình duyệt đang mở bundle cũ.
Phân trang, phạm vi cửa hàng và bộ lọc được xử lý tại server theo trạng thái đã lưu.

## Migration, deploy và rollback

Migration `0043_admin_reshare_status` chỉ thêm cột, FK và CHECK; không cập nhật trạng thái,
chứng từ, tồn kho hoặc lịch sử cũ. Chạy migration lại không tạo thay đổi trùng. Catalog hash
công cụ reset được cập nhật theo PostgreSQL 17 riêng; task này không chạy reset production.

Deploy theo watcher sau CI của merged main. Kiểm tra migration, SHA, health/readiness,
các cột mới, API và dữ liệu chỉ đọc; không dùng đơn thật để thử chuyển trạng thái.
Ưu tiên forward-fix. Nếu rollback ứng dụng, giữ schema và audit; bundle cũ không có nút sửa
và backend cũ không đọc xác nhận mới nên có thể hiển thị lại trạng thái suy từ RE.
Không drop cột/restore database để rollback tính năng.

## Kiểm thử

- Contract: chỉ ORDERED/NOT_ORDERED, bắt buộc trạng thái cũ và phiên bản, từ chối trường lạ.
- PostgreSQL: hai chiều, legacy, RE hiện hữu, acceptance về sau, audit, replay, xung đột,
  Admin bị khóa, HTKD/store, cancelled/rejected, giữ nguyên sổ kho.
- Migration: nâng database cũ với legacy đã thực nhận, xác nhận trạng thái sau nâng cấp,
  không tạo RE hoặc thay đổi kho; migration lặp lại.
- API PostgreSQL: bốn vai trò, validation, scope, bộ lọc, phiên bản và tương thích response cũ.
- Playwright: retry mất phản hồi, reload, bộ lọc, quyền nút; live UI → API → PostgreSQL xác nhận
  hai chiều/audit và chiều cao nút tối thiểu 44px ở 360/390/768/1366/1440px.
