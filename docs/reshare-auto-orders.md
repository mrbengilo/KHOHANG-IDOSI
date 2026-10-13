# Đơn đặt Reshare tự động (RE) và xuất kho khi xác nhận kết quả phân bổ

Trạng thái: triển khai trong migration `0042_reshare_orders_and_issue`. Bằng chứng kiểm thử:
`docs/reshare-auto-orders-release-evidence.md`.

## 1. Bối cảnh và quyết định

- Khi cửa hàng (STORE), quầy sỉ (cửa hàng sỉ) hoặc HTKD được phân công **chấp nhận** một kết quả
  phân bổ có lượng cấp mới, IDOSI tự lập **một** phiếu đặt Reshare nội bộ mã `RE-000001`,
  `RE-000002`, … đúng các mặt hàng và số bao được cấp của kết quả đó, và **trong cùng transaction**
  ghi sổ xuất số hàng này khỏi kho tổng IDOSI.
- Phiếu RE là chứng từ nội bộ: người dùng tự dùng mã và số bao để đặt hàng trên hệ thống Reshare.
  IDOSI không gọi API, bot, webhook hay đồng bộ gì với Reshare và không cần tài khoản Reshare.
- Nhãn **“Đã đặt Reshare”** nghĩa là IDOSI đã lập phiếu RE và ghi sổ xuất kho theo quy trình nội
  bộ; không có nghĩa IDOSI đã gửi đơn sang hệ thống khác.

## 2. Invariant thay đổi

| Trước (≤ 0041)                                                                                           | Sau (0042)                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chấp nhận kết quả chỉ dispatch chuyến; tồn kho tổng `H` và đặt giữ `R` giữ nguyên tới khi HTKD finalize. | Chấp nhận tạo RE và ghi ledger `reshare_order` **`H −q`, `R −q`** cho từng mặt hàng; reservation chuyển `issued` (đã xuất, chờ giao/nhận). Khả dụng `H − R` không đổi.                        |
| Finalize phiếu nhận trừ `H` theo **thực nhận**, `R` theo lượng duyệt (`store_receipt`).                  | Finalize **không trừ lại** phần đã xuất theo RE; chỉ quyết toán (nhận/thiếu) từng nguồn. Nguồn legacy (giữ trước khi có RE) vẫn trừ theo cách cũ. Tồn cửa hàng chỉ tăng theo lượng thực nhận. |
| Thiếu hàng lúc nhận: kiểm thiếu giữ `R` (hàng có thể còn trên kệ).                                       | Thiếu của phần đã xuất: kiểm thiếu chế độ `issued` (không giữ hàng). “Thất lạc” không trừ thêm; “Còn ở kho” nhập lại bằng bút toán bù `return` có liên kết (SKU Reshare: không tự cộng).      |
| Chỉ STORE/WHOLESALE trả lời kết quả.                                                                     | HTKD được phân công cửa hàng đang hoạt động được **Chấp nhận** (không được Từ chối). Admin vẫn chỉ xem.                                                                                       |
| Đối chiếu Reshare: U = giữ ưu tiên + reservation chưa đặt B.                                             | U còn gồm **dòng RE chưa được lần cập nhật tồn nào xác nhận đã trừ** (kể cả đã nhận), nên số nguồn cũ nhập lại không cấp trùng.                                                               |

Ví dụ (bắt buộc, có test PostgreSQL và E2E):

| Bước                                    |   H |   R | H − R | Đã xuất chưa quyết toán | Tồn cửa hàng tăng |
| --------------------------------------- | --: | --: | ----: | ----------------------: | ----------------: |
| Có 10, giữ 4 cho kết quả, chưa xác nhận |  10 |   4 |     6 |                       0 |                 0 |
| Chấp nhận → RE, xuất 4                  |   6 |   0 |     6 |                       4 |                 0 |
| Nhận đủ 4, finalize                     |   6 |   0 |     6 |                       0 |                 4 |
| (nhánh khác) Nhận 3/4, finalize         |   6 |   0 |     6 |          1 (kiểm thiếu) |                 3 |

## 3. Mô hình dữ liệu (0042, additive)

| Đối tượng                                                      | Nội dung                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation_status += 'issued'`                               | Hàng đã ra khỏi `H`/`R`, vẫn thuộc cửa hàng tới khi phiếu nhận quyết toán.                                                                                                                                                                                                                    |
| `reshare_orders`                                               | Một dòng/kết quả (unique `allocation_decision_id`, unique `(run, store)`), `code` do DB cấp, snapshot tên cửa hàng/mã phiên, tổng bao, thời điểm chấp nhận/lập, actor + vai trò thật, `origin` (`acceptance`/`backfill`), trạng thái `ordered`/`cancelled` (không có lệnh hủy trong bản này). |
| `reshare_order_lines`                                          | Một dòng/mặt hàng: snapshot tên/SKU, số bao, `issue_ledger_entry_id` (unique), `supplier_reflected_quantity` (chỉ tăng).                                                                                                                                                                      |
| `reshare_order_sources`                                        | Lineage: reservation (unique) + allocation line (unique) ⇒ một nguồn không bao giờ xuất hai lần; quyết toán nhận/thiếu, phiếu nhận, dòng xuất, kiểm thiếu.                                                                                                                                    |
| `supplier_observation_reshare_coverage`                        | Lượng RE một lần cập nhật tồn xác nhận “số tồn này đã trừ đơn…” (bất biến).                                                                                                                                                                                                                   |
| `warehouse_shortage_checks.stock_mode`                         | `held` (cũ) / `issued`; unique theo (dòng phiếu nhận, chế độ) cho dòng trộn nguồn.                                                                                                                                                                                                            |
| `supplier_stock_observation_lines.issued_unreflected_quantity` | Phần U là đơn RE chưa phản ánh tại thời điểm cập nhật tồn (công thức check cập nhật).                                                                                                                                                                                                         |

Mã RE: `next_reshare_order_code()` dùng `document_code_counters` (tiền tố `RE`), đúng 6 chữ số,
khóa dòng counter trong transaction (rollback không tiêu số), hết dải sau `RE-999999` báo lỗi
`IDR01`, không quay vòng. `next_document_code()` (PDH/PPB/PNH/PXK…) không đổi.

### Guard ở database (không thể vượt bằng SQL trực tiếp)

| Guard                                                     | Kiểm tra                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reshare_orders_validate_insert`                          | Chỉ cho kết quả `accepted` đúng run/phiên/cửa hàng/thời điểm chấp nhận; mã chỉ do DB cấp.                                                                      |
| `reshare_orders_protect_history`, lines/sources guard     | Không xóa; danh tính/số lượng bất biến; nguồn chỉ quyết toán một lần.                                                                                          |
| `reshare_order_lines_guard`                               | Dòng RE phải có bút toán `reshare_order` đúng sản phẩm, `−q/−q`.                                                                                               |
| `reshare_order_sources_guard`                             | Nguồn phải là hold `issued` của chính kết quả, cùng cửa hàng/sản phẩm/số lượng.                                                                                |
| `reservations_issuance_consistency` (deferred)            | Hold `issued` luôn có nguồn RE chưa quyết toán; rời `issued` chỉ khi đã quyết toán.                                                                            |
| `allocation_acceptance_requires_reshare_order` (deferred) | Chuyển `pending → accepted` mà không có RE thì không commit được (binary cũ cũng fail-closed).                                                                 |
| `validate_store_receipt_finalization` (thay thân 0032)    | Giữ mọi kiểm tra cũ; bằng chứng ledger theo nguồn: phần legacy phải có `store_receipt` đúng lượng, dòng xuất RE toàn bộ thì **không** được có `store_receipt`. |

## 4. Luồng và khóa

`respondAllocationDecision` (ACCEPT): quyền (route → repository → trong transaction, kể cả replay
idempotency) → `STOCK_JOBS_LOCK` → khóa chuyến `warehouse-outbound` → decision `FOR UPDATE` →
cập nhật `accepted` → `issueReshareOrderInTransaction`: reservation của **chính kết quả**
`FOR UPDATE` → insert `reshare_orders` (khóa counter RE; luôn nằm sau `STOCK_JOBS_LOCK` nên không
tranh chấp) → hold `issued` → `applyWarehouseMovement` theo thứ tự product id (khóa
`warehouse-balance`) → lines/sources → audit `RESHARE_ORDER_CREATED` (actor, vai trò, ledger IDs,
trước/sau) → dispatch chuyến (nếu có) → audit `ALLOCATION_RESULT_ACCEPTED`. Lỗi ở bất kỳ bước nào
(thiếu tồn → `409 INSUFFICIENT_STOCK`, constraint, ledger) rollback toàn bộ.

- Hai khóa idempotency khác nhau, STORE và HTKD cùng lúc: một bên thắng, bên còn lại `409`; một RE,
  một lần xuất (test đa kết nối).
- Cùng khóa, cùng nội dung: trả lại kết quả cũ cùng mã RE; khác nội dung: `IDEMPOTENCY_CONFLICT`.
- Hàng ưu tiên chấp nhận khi chưa có chuyến: vẫn lập RE và xuất ngay; worker 09:00 ghép hold
  `issued` vào chuyến của đơn thường kế tiếp đúng một lần (không xuất lại).
- Từ chối: không lập RE, không xuất; giải phóng giữ hàng của chính kết quả như cũ. Hàng `issued` của
  phiên trước đi cùng chuyến bị hủy giữ nguyên hold (chỉ gỡ liên kết chuyến).

## 5. Đối chiếu Reshare

- `U = giữ ưu tiên + reservation chưa đặt B + Σ(dòng RE − đã phản ánh − đã ghi đơn B thủ công)`;
  `F = max(0, B_eff − U)`, `D = max(0, U − B_eff)`, `H = R + F`.
- Lập RE: `H −q`, `R −q`, U không đổi ⇒ F không đổi (nguồn 10, cam kết 4: trước/sau đều 6).
- Cập nhật tồn: người cập nhật đánh dấu “Số tồn này đã trừ các đơn RE…” (có thể một phần) khi đã đặt
  trên Reshare trước lúc xem tồn; không suy diễn từ ngày tạo hay chênh lệch tổng. Đơn lập sau thời
  điểm xem tồn không thể đánh dấu. Lượng đã đánh dấu rời U vĩnh viễn (không trừ hai lần).
- Không gọi `recordSupplierOrder()` cho RE: `supplier_external_events` vẫn chỉ là sự kiện Reshare
  thật do người dùng ghi nhận (luồng thủ công cũ, giữ để tra cứu).

## 6. Giao diện và quyền

| Vai trò          | “Đơn & tồn Reshare”                                                                  | Kết quả phân bổ                             |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Admin            | Đơn đặt Reshare (mọi cửa hàng), Cập nhật tồn Reshare, Lịch sử cập nhật tồn, Cấu hình | Chỉ xem                                     |
| HTKD             | Đơn của cửa hàng được phân công                                                      | **Chấp nhận** thay cửa hàng (không Từ chối) |
| Cửa hàng/quầy sỉ | Đơn của phạm vi mình                                                                 | Chấp nhận / Từ chối như cũ                  |

- Bảng “Lịch sử đặt hàng theo phân bổ”: Mã phiên (mở phiên/hoàn tất phân bổ/xác nhận, giờ Việt Nam
  tới giây), Mã RE (hoặc “—”), Tên cửa hàng, Mặt hàng, Số lượng (bao), Tổng (một lần/đơn), Trạng thái
  (Đã đặt Reshare / Chưa đặt Reshare / Hủy) kèm ghi chú xuất kho/chờ giao/nhận/thiếu tách riêng.
  Lọc phía server (phiên, khoảng ngày, cửa hàng trong phạm vi, mặt hàng, trạng thái, mã RE), sắp xếp
  theo thời gian + id, phân trang theo đơn. Mobile ≤ 620 px: mỗi đơn một thẻ.
- Phiếu kết quả: tag “Đã đặt Reshare · RE-xxxxxx” (liên kết tới đơn), dòng “Đã xuất … bao khỏi kho
  tổng theo đơn …” tách khỏi tiến độ giao/nhận.
- Tương thích bundle cũ: các trường mới (`allowedActions`, `reshareOrder`, `issuedUnreflectedQuantity`,
  `issuedOrders`) chỉ trả khi client mới yêu cầu (`includeReshare=true`, `includeIssued=true`, gửi
  `reshareCoverage`). Endpoint mới: `GET /api/v1/reshare-orders`.

## 7. Cutover dữ liệu cũ

`node infra/scripts/backfill-reshare-orders.mjs` (mặc định **dry-run**, chỉ đọc).
Trên VPS, script nằm trong ảnh `migrate` của release đang chạy (không cần Node trên host):

```bash
cd /opt/khohang-idosi/current
mkdir -p /root/reshare-cutover
docker compose --env-file /etc/khohang-idosi/production.env --file docker-compose.yml \
  --project-name khohang-idosi run --rm --no-deps --pull never --user 0:0 \
  --volume /root/reshare-cutover:/out --entrypoint node migrate \
  infra/scripts/backfill-reshare-orders.mjs --output /out/plan.json
```

Dry-run phân loại:

| Nhóm                    | Ý nghĩa / xử lý                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `PENDING_NEW_FLOW`      | Chờ xác nhận: khi được chấp nhận sau triển khai sẽ đi luồng mới.                                         |
| `ACCEPTED_ELIGIBLE`     | Đã chấp nhận trước 0042, toàn bộ hold còn trên kho: có thể backfill RE + xuất **một lần** theo manifest. |
| `ACCEPTED_SETTLED`      | Đã nhận/quyết toán: chỉ là lịch sử, **không bao giờ xuất lại**.                                          |
| `ACCEPTED_MANUAL_ORDER` | Có đơn Reshare ghi thủ công: giữ dữ liệu thủ công, không chuyển đổi.                                     |
| `ACCEPTED_EXCEPTION`    | Hold một phần/không bảo toàn: cần người quyết định.                                                      |
| `legacyResultCount`     | Kết quả LEGACY: không bao giờ coi là đã được người dùng xác nhận.                                        |

Apply (`--apply --plan plan.json --decision <id>… --actor <admin>`): kiểm tra lại hash tập
`ACCEPTED_ELIGIBLE` của plan đã duyệt, chỉ xử lý decision được liệt kê, bỏ qua mọi nhóm khác, idempotent
khi chạy lại, audit `RESHARE_ORDER_CUTOVER_APPLIED`. Không gắn vào seed/startup. Kết quả accepted cũ
chưa backfill vẫn hiển thị “Chưa đặt Reshare” (chưa đủ căn cứ) và vẫn finalize theo luồng legacy.

Trong cửa sổ deploy (migration chạy khi binary cũ còn phục vụ): binary cũ **không thể** chấp nhận kết
quả (deferred guard từ chối commit) và không finalize được nguồn đã xuất (thiếu reservation `active`)
⇒ fail-closed, không có kết quả ACCEPTED mới thiếu RE. Phân bổ 09:00 của worker cũ vẫn bị giới hạn bởi
`H − R` (không đổi khi xuất RE).

## 8. Rollback

- Schema additive, nhưng **không rollback image về bản chưa hiểu `issued`** khi đã có RE: bản cũ không
  chấp nhận được kết quả mới (an toàn) nhưng worker/đối chiếu cũ không tính U của đơn RE; nếu bắt buộc
  phải chạy bản cũ: tạm dừng chấp nhận kết quả, nhận hàng của chuyến có hàng đã xuất và **cập nhật tồn
  Reshare** cho SKU đối chiếu cho tới khi forward-fix.
- Ưu tiên forward-fix. Không xóa RE/ledger/audit, không restore đè database, không sửa tay balance.
  Bù sai lệch bằng nghiệp vụ có chứng từ (hoàn/nhập lại có liên kết).

## 9. Đối soát read-only

```sql
-- Mã RE duy nhất, đúng định dạng.
SELECT count(*), count(DISTINCT code), bool_and(code ~ '^RE-[0-9]{6}$') FROM reshare_orders;
-- Phải rỗng: kết quả chấp nhận sau 0042 thiếu RE (origin allocation_run, responded sau deploy).
SELECT d.id FROM allocation_result_decisions d
LEFT JOIN reshare_orders o ON o.allocation_decision_id = d.id
WHERE d.status = 'accepted' AND o.id IS NULL AND d.responded_at > :deployed_at;
-- Phải rỗng: dòng RE lệch bút toán xuất.
SELECT l.id FROM reshare_order_lines l JOIN warehouse_ledger_entries e ON e.id = l.issue_ledger_entry_id
WHERE e.on_hand_delta <> -l.quantity OR e.reserved_delta <> -l.quantity OR e.source_id <> l.reshare_order_id;
-- Phải rỗng: tổng nguồn ≠ dòng; hold issued thiếu nguồn mở.
SELECT l.id FROM reshare_order_lines l JOIN reshare_order_sources s ON s.reshare_order_line_id = l.id
GROUP BY l.id, l.quantity HAVING sum(s.quantity) <> l.quantity;
SELECT r.id FROM reservations r LEFT JOIN reshare_order_sources s ON s.reservation_id = r.id AND s.settled_at IS NULL
WHERE r.status = 'issued' AND s.id IS NULL;
-- H/R khớp sổ phát sinh (như docs/supplier-stock-reconciliation.md §10).
```
