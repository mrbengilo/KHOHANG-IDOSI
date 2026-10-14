# Bằng chứng giao diện — HTKD Reshare, lịch sử trạng thái, tiêu đề bảng

Cùng dữ liệu giả lập theo contract (`apps/web/e2e/supplier-reconciliation.spec.ts`), Chromium,
zoom 100%, bề rộng 1440 và 390px.

- `before-*`: bundle production build từ `main` `d24e507`.
- `after-*`: bundle production build từ nhánh `claude/htkd-reshare-permissions-ui-pskv3b`.
- `orders`: Đơn đặt Reshare; `reconcile`: Cập nhật tồn Reshare đang xem trước đối chiếu;
  `holds`: bảng số liệu theo mặt hàng mở chi tiết giữ hàng; `history-dialog` (chỉ có sau):
  hộp thoại Lịch sử thay đổi sau khi đổi trạng thái.
