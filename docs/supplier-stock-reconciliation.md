# Đối chiếu tồn Reshare (kho B) — ADR và hướng dẫn vận hành

Trạng thái: đã triển khai trong migration `0041_supplier_reconciliation`. Tài liệu này mô tả
thiết kế, công thức, quyền, chuyển đổi (cutover) và rollback. Bằng chứng kiểm thử/phát hành:
`docs/supplier-reconciliation-release-evidence.md`.

## 1. Bối cảnh và lỗi gốc

- **A** = kho tổng IDOSI (quản lý nguồn, phân bổ). **B** = kho Reshare; hàng thực giao từ B tới
  cửa hàng. **C** = người cập nhật số liệu kho tổng.
- Số C thấy ở B là **tồn có thể đặt**: B trừ/giữ ngay khi nhận đơn thành công.
- Lỗi: B còn 3 bao, A cấp hết 3; HTKD chưa đặt bên B nên B vẫn hiện 3; hôm sau C "nhập thêm" 3
  bằng phiếu nhập kho tổng → `supplier-inbound.ts` ghi `receipt +3` vào on-hand → worker 09:00
  (giới hạn bởi `min(snapshot 08:00, H − R hiện tại)`) cấp tiếp 3 bao không tồn tại.
- Nguyên nhân gốc: nhầm **quan sát** "B hiện còn bao nhiêu" với **sự kiện** "có hàng nhập thêm",
  và thiếu liên kết "A đã cam kết → B đã ghi nhận". Thuật toán phân bổ (P0A–P3, theo vòng) không
  sai; đầu vào nguồn bị tăng sai.

Invariant cũ (với mọi SKU): khả dụng = on-hand − reserved, on-hand tăng bằng phiếu nhập/điều chỉnh.
Invariant mới (chỉ với SKU đã bật đối chiếu Reshare): on-hand là **projection** `H = R + F`; không
có đường nào khác được làm tăng khả dụng. SKU chưa bật giữ nguyên luồng cũ.

## 2. Công thức

Theo từng SKU đã bật (một SKU thuộc tối đa một nguồn vì `warehouse_balances` theo SKU):

| Ký hiệu | Ý nghĩa                                                                                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S       | Tổng tồn có thể đặt C thấy ở B lúc `observedAt`; bất biến sau xác nhận.                                                                                                                                                                       |
| ΔB      | Sự kiện B chưa nằm trong S: đơn đặt (−q), hoàn nguồn có bằng chứng (+q). Hủy đơn không tự cộng B.                                                                                                                                             |
| B_eff   | S + ΔB. Sự kiện **AMBIGUOUS** (ghi muộn, xảy ra trước S) được tính bảo thủ: đơn bị trừ, hoàn nguồn không cộng.                                                                                                                                |
| U       | Cam kết A chưa được B ghi nhận = giữ ưu tiên (`stock_held_quantity`) + phần reservation đang hiệu lực chưa liên kết đơn B (net đặt − hủy) + dòng đơn RE chưa được lần cập nhật tồn nào xác nhận đã trừ (0042, `docs/reshare-auto-orders.md`). |
| F       | max(0, B_eff − U) — phần còn phân bổ được.                                                                                                                                                                                                    |
| D       | max(0, U − B_eff) — thiếu nguồn, hiển thị riêng, không xóa cam kết.                                                                                                                                                                           |
| R       | Reserved trong sổ A (giữ ưu tiên + reservation + kiểm thiếu). R ≠ U.                                                                                                                                                                          |
| H       | On-hand trong sổ A = R + F sau mỗi lệnh đối chiếu/sự kiện B (bút toán `adjustment` có nguồn, không phải phiếu nhận giả).                                                                                                                      |

Hàm thuần: `packages/domain/src/supplier-reconciliation.ts` (`computeSupplierPosition`,
`planObservationCoverage`, `distributeSupplierCancellation`, `supplierOrderState`).

### 2.1 Ánh xạ từng loại giữ hàng sang R, U, sự kiện B

| Loại giữ                                               | Trong R | Trong U                                       | Ghi chú                                                                              |
| ------------------------------------------------------ | ------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Đề nghị ưu tiên đang giữ (offered/accepted chưa cấp)   | Có      | Có                                            | Không đặt B được cho tới khi thành phân bổ.                                          |
| Reservation phân bổ (kể cả hàng ưu tiên giữ qua phiên) | Có      | Phần chưa liên kết đơn B                      | Khóa cam kết = `allocation_line_id` (sống qua tách/tạo lại reservation khi Từ chối). |
| Reservation đã liên kết đơn B (đã đặt, chờ giao)       | Có      | Không                                         | Giảm R/H khi HTKD chốt thực nhận; B không bị trừ lần hai.                            |
| Kiểm thiếu (`warehouse_shortage_checks` pending)       | Có      | Không                                         | B đã trừ khi nhận đơn.                                                               |
| Phiếu chờ chưa giữ hàng / nhu cầu chưa cấp             | Không   | Không                                         |                                                                                      |
| Legacy: reservation có trước baseline, chưa có đơn B   | Có      | UNKNOWN → U sau khi Admin xác nhận "chưa đặt" | Không suy ra từ ACCEPTED/dispatched/ngày tạo.                                        |

## 3. Luồng nghiệp vụ

1. **Cấu hình** (Admin, tab "Cấu hình nguồn"): tạo nguồn (mã như `RESHARE`) và chọn SKU. SKU ở trạng
   thái `pending_baseline`: phiếu nhập cộng dồn, hủy phiếu nhập cũ và điều chỉnh tồn thủ công bị từ
   chối (`SOURCE_RECONCILED`); worker không tạo đề nghị ưu tiên và không cấp mới (vẫn chuyển hàng đã
   giữ của đề nghị đã chấp nhận).
2. **Đối chiếu** (Admin/C, tab "Đối chiếu tồn"): chọn SKU → nhập **tổng** số B đang cho đặt, thời
   điểm xem (giờ Việt Nam, tới giây), chứng từ → **Xem trước** (read-only) → trả lời từng sự kiện B
   xảy ra trước thời điểm xem: "đã gồm trong số vừa nhập" hay "chưa gồm" (không đoán theo
   `createdAt`) → **Lưu đối chiếu**. Server tính lại toàn bộ, so `expectedRevision`, ghi coverage,
   bút toán `H := R + F`, dòng observation bất biến, audit.
3. **Đặt Reshare** — từ 0042 thay bằng đơn RE tự động khi chấp nhận kết quả (`docs/reshare-auto-orders.md`);
   luồng ghi nhận thủ công dưới đây chỉ còn cho hàng giữ trước khi có RE (mục "Đơn ghi nhận thủ công").
   (HTKD cửa hàng được giao đang hoạt động, hoặc Admin): chỉ
   các reservation có kết quả phân bổ `accepted`/`not_required`/`legacy`. Đặt ở B trước, rồi ghi đúng
   số bao B đã nhận (từng phần, nhiều đơn cho một phân bổ, nhiều dòng một đơn). U và B_eff cùng giảm
   q ⇒ F không đổi; R không giải phóng.
4. **Hủy/hoàn nguồn**: "Ghi nhận Reshare hủy" khôi phục nghĩa vụ chưa đặt (U +q); chỉ khi tích "Reshare
   đã xác nhận đặt lại được" mới tạo sự kiện hoàn nguồn (+q). Admin có lệnh hoàn nguồn độc lập (bắt
   buộc căn cứ).
5. **Nhận hàng**: không đổi. Finalize trừ H và R đúng phần nhận; phần thiếu vào kiểm thiếu.
6. **Cửa hàng/quầy sỉ**: tab "Trạng thái đặt Reshare" chỉ xem hàng của mình.

Trạng thái B của cam kết (độc lập PENDING/ACCEPTED/REJECTED và reserved/dispatched/received):
`UNKNOWN`, `NOT_ORDERED`, `PARTIALLY_ORDERED`, `ORDERED`, `CANCELLED_CONFIRMED` (B đã hủy — cần đặt
lại), `CANCEL_PENDING` (A đã giải phóng nhưng còn đơn B — cần hủy bên Reshare). A chỉ ghi các sự
kiện B **đã xác nhận**; không có trạng thái "đã gửi yêu cầu hủy".

## 4. Các đường tắt đã chặn (SKU đã bật)

| Đường                                                      | Xử lý                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Phiếu nhập kho tổng (`receiveSupplierInbound`)             | Từ chối `SOURCE_RECONCILED` (UI hướng sang đối chiếu).                                               |
| Hủy phiếu nhập cũ                                          | Từ chối (sẽ trừ tồn ngoài đối chiếu).                                                                |
| Điều chỉnh tồn thủ công (tăng/giảm)                        | Từ chối; replay điều chỉnh nay kiểm tra Admin còn hoạt động trước khi trả kết quả.                   |
| Kiểm thiếu "còn ở kho"                                     | Giải phóng giữ **và** trừ on-hand: không tạo khả dụng. Hoàn nguồn chỉ qua sự kiện/quan sát.          |
| Nhận dư ngoài phân bổ                                      | Không trừ A (tránh trừ hai lần với quan sát B); tồn cửa hàng ghi như cũ; SKU chuyển "cần đối chiếu". |
| Trả hàng về kho                                            | Không cộng A; audit `SUPPLIER_RETURN_AWAITS_SOURCE_CONFIRMATION`.                                    |
| Giao nhầm SKU (SKU thực tế)                                | Không trừ A; SKU chuyển "cần đối chiếu".                                                             |
| Mọi biến động khác (lưới an toàn `applyWarehouseMovement`) | Nguồn ngoài danh sách nhất quán ⇒ SKU `needs_reconciliation` (khóa cấp mới tới lần đối chiếu sau).   |
| Worker 08:00/09:00                                         | Trần = F công thức (0 nếu chưa baseline/cần đối chiếu/thiếu nguồn), độc lập với sổ kho.              |

## 5. Dữ liệu (migration 0041, additive)

`supplier_sources`, `supplier_source_products` (UNIQUE product, status, revision, baseline line,
block reason), `supplier_stock_observations` + `_lines` (S, B_eff, U, F, D, H/R trước–sau, ledger
entry), `supplier_event_batches` (lệnh, idempotency theo actor), `supplier_external_events` (UNIQUE
nguồn+loại+mã B+dòng B; coverage `open/covered/ambiguous/not_applicable`),
`supplier_order_source_links` (sự kiện → reservation/allocation line, q),
`supplier_observation_event_coverage` (câu trả lời từng sự kiện). Trigger: observation, line,
coverage, link, batch bất biến; sự kiện chỉ được đổi coverage theo chiều tiến; nguồn/mapping không
xóa. Công cụ reset dữ liệu test purge các bảng này (cập nhật `EXPECTED_RESET_SCHEMA_HASH`).

## 6. Đồng thời và thứ tự khóa

Mọi lệnh supplier chạy trong transaction serializable (retry 40001/40P01) theo thứ tự:

1. advisory idempotency (actor + key) — xác thực actor trong transaction trước cả replay;
2. reservations `FOR UPDATE` theo id (ghi/hủy đơn B);
3. advisory `warehouse-balance:<product>` theo product id;
4. `supplier_source_products FOR UPDATE` theo product id.

| Luồng hiện có                       | Thứ tự khóa                                   | Tương thích                                              |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Worker 08:00/09:00                  | job lock → ticket → offer → reservation → (3) | Đọc mapping không khóa; serializable phát hiện xung đột. |
| Phản hồi/hủy ưu tiên                | ticket → offer → (3)                          | Không chạm (4).                                          |
| Chấp nhận/Từ chối kết quả, dispatch | decision → shipment → reservation → (3)       | Cùng hướng 2 → 3.                                        |
| Finalize nhận hàng                  | receipt → outbound line → reservation → (3)   | Cùng hướng.                                              |
| Lưới an toàn / nhận dư / giao nhầm  | (3) → cập nhật (4)                            | Lệnh supplier lấy (3) trước (4) nên không ngược chiều.   |

Test song song thật: `packages/database/tests/supplier-reconciliation.integration.test.ts` (T21/T23:
hai HTKD + một xác nhận đối chiếu đua trên các kết nối riêng).

## 7. API

`GET /supplier-sources`, `POST /supplier-sources`, `POST /supplier-sources/{id}/products`,
`GET /supplier-reconciliation`, `GET /supplier-reconciliation/history`,
`POST /supplier-stock-observations/preview`, `POST /supplier-stock-observations`,
`GET /supplier-commitments`, `GET|POST /supplier-orders`,
`POST /supplier-orders/{eventId}/cancellations`, `POST /supplier-source-returns`.
Mã lỗi: `VERSION_CONFLICT`, `SOURCE_NOT_RECONCILED`, `SOURCE_RECONCILED`,
`EXTERNAL_EVENT_COVERAGE_AMBIGUOUS`, `ORDER_SOURCE_NOT_ELIGIBLE`, `QUANTITY_EXCEEDED`,
`DUPLICATE_EXTERNAL_EVENT`, `OBSERVATION_OUT_OF_ORDER`, `LEGACY_ATTESTATION_REQUIRED`,
`IDEMPOTENCY_CONFLICT`, `FORBIDDEN`. `SOURCE_SHORTFALL` được khai báo cho contract; thiếu nguồn hiện
được thể hiện bằng D và trạng thái `SHORTFALL`, không chặn lệnh ghi.

Quyền: đối chiếu, cấu hình, hoàn nguồn, lịch sử = Admin. Ghi/hủy đơn B = HTKD (cửa hàng được giao
đang hoạt động) hoặc Admin. Đọc cam kết/đơn B = Admin (mọi cửa hàng, có tên HTKD phụ trách); HTKD,
cửa hàng, quầy sỉ chỉ cửa hàng trong phạm vi (`scoped: true`, tổng chỉ của phạm vi đó).
`/warehouse-inventory` giữ nguyên contract (strict) để không phá bundle cũ.

## 8. Cutover theo SKU

1. Deploy code (SKU chưa bật ⇒ không đổi hành vi).
2. Chạy báo cáo dry-run read-only (mục 10) cho các SKU dự kiến bật.
3. Admin bật SKU (tab Cấu hình): SKU dừng cấp mới ngay.
4. HTKD ghi nhận các đơn Reshare **đã đặt** cho hàng đang giữ (thời điểm B nhận đơn thật).
5. C xem B, nhập tổng S; trong xem trước trả lời coverage từng đơn, tích xác nhận phần còn lại
   **chưa đặt** (`attested_unlinked_quantity` được lưu); lưu ⇒ SKU `active`, phân bổ lại bình thường.
6. Nếu thiếu dữ liệu B cho SKU nào: để SKU ở `pending_baseline` (không cấp mới) và ghi rõ trong báo
   cáo phát hành; không tự lấy 0.

Một SKU đã bật không hoàn tác từ UI (tránh chuyển qua lại giữa hai cơ chế ghi tăng nguồn).

## 9. Rollback

- Schema chỉ thêm; image cũ chạy được trên schema mới.
- **Nhưng** image cũ không biết mapping: nó lại cho phép phiếu nhập cộng dồn và điều chỉnh tồn trên
  SKU đã bật, và worker cũ không áp trần F. Nếu phải rollback image sau khi đã bật SKU: tạm dừng
  nhập kho/điều chỉnh các SKU đó theo quy trình vận hành và ưu tiên **forward-fix**. Không restore
  đè database để sửa lỗi thông thường.
- Dữ liệu observation/sự kiện là bằng chứng; sửa sai bằng quan sát mới hoặc sự kiện hủy/hoàn nguồn.

## 10. Đối soát read-only (production)

```sql
-- H/R khớp sổ phát sinh
SELECT b.product_id, b.on_hand_quantity, b.reserved_quantity,
       sum(l.on_hand_delta) AS ledger_on_hand, sum(l.reserved_delta) AS ledger_reserved
FROM warehouse_balances b JOIN warehouse_ledger_entries l USING (product_id)
GROUP BY 1,2,3 HAVING b.on_hand_quantity <> sum(l.on_hand_delta)
   OR b.reserved_quantity <> sum(l.reserved_delta);

-- Trạng thái SKU đã bật và sự kiện chưa được đối chiếu
SELECT m.status, count(*) FROM supplier_source_products m GROUP BY 1;
SELECT coverage, count(*) FROM supplier_external_events GROUP BY 1;

-- Liên kết vượt số lượng (phải rỗng)
SELECT coalesce(l.allocation_line_id, l.reservation_id) AS k,
       sum(l.quantity) FILTER (WHERE e.kind='order') - coalesce(sum(l.quantity) FILTER (WHERE e.kind='order_cancel'),0) AS net
FROM supplier_order_source_links l JOIN supplier_external_events e ON e.id=l.event_id
GROUP BY 1 HAVING sum(l.quantity) FILTER (WHERE e.kind='order') - coalesce(sum(l.quantity) FILTER (WHERE e.kind='order_cancel'),0) < 0;
```

Màn hình "Đối chiếu tồn" cũng hiển thị "Sổ kho đang ghi …" khi H − R ≠ F (ví dụ sau khi một giữ
hàng được giải phóng lúc đang thiếu nguồn); lần đối chiếu kế tiếp đồng bộ lại, worker luôn dùng F.

## 11. Giới hạn đã biết

- Số B là quan sát thủ công, không đồng bộ thời gian thực; UI luôn hiện `observedAt`.
- Mỗi SKU một nguồn đối chiếu (số dư theo SKU). Nhiều kho B cho cùng SKU cần tách số dư — ngoài phạm vi.
- Reservation legacy không có `allocation_line_id` không đặt B được qua UI; được tính vào U tới khi
  nhận hàng (bảo thủ).
- Cảnh báo độ cũ của số B theo policy cấu hình chưa có (không tự đặt hạn 24 giờ).
