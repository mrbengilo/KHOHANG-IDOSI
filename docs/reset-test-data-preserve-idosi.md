# Reset dữ liệu nghiệp vụ, giữ tài khoản và dữ liệu IDOSI

Maintenance được chủ hệ thống giao riêng cho từng đợt. Không gọi từ boot, seed,
migration, watcher, timer hoặc endpoint HTTP. Ngoại lệ với `AGENTS.md` chỉ áp dụng
cho dữ liệu nghiệp vụ thuộc manifest của đợt đó; vận hành thường vẫn giữ trigger bất biến
và không xóa cứng phiếu chờ/chứng từ.

## Đợt reset mới sau đợt cũ (từ migration 0037)

Một hệ thống đã reset có thể được giao **đợt reset mới** cho toàn bộ dữ liệu nghiệp vụ hiện tại.
Mỗi đợt là một operation riêng (UUID, manifest, cutoff, epoch, baseline, thư mục trạng thái riêng):

- Chỉ bắt đầu khi **mọi** operation trước đó ở `COMPLETE` và cutoff mới **sau** cutoff mới nhất.
  `plan` ghi các vi phạm vào `review` (không apply được); `apply` kiểm tra lại dưới khóa.
- Không xóa journal cũ, không giả operation ID. Cùng operation ID + manifest chỉ resume; manifest
  của đợt cũ chạy lại chỉ trả `resumed` và không đụng dữ liệu mới.
- Operation có hiệu lực là operation có **cutoff mới nhất**
  (`ORDER BY cutoff DESC, committed_at DESC, id DESC`), dùng chung cho epoch API
  (`x-idosi-reset-epoch`) và baseline đồng bộ Sale/NORMAL; không còn `LIMIT 1` không xác định.
- `test_data_reset_baselines` là REBASE: đợt mới xóa baseline của đợt trước rồi tạo lại `pending`
  theo kỳ của cutoff mới; snapshot IDOSI nguồn giữ nguyên. Payload/kỳ trước cutoff mới bị chặn.
- `test_data_reset_replay_keys` tích lũy: key của mọi epoch cũ đều bị từ chối.
- Audit `TEST_DATA_RESET` của đợt trước là nhật ký maintenance, được KEEP và fingerprint.

### Chế độ giữ backup phục hồi (`backupRetention: "retain"`)

Mặc định (`purge`, quy trình gốc) xóa các backup test đã inventory sau khi chứng minh backup sạch.
Đợt reset dữ liệu vận hành **không** mặc nhiên xóa backup; dùng `retain` trong `context.json`:

1. `enter` (như cũ) → `pre-backup`: tạo backup trước reset bằng `backup-db.sh` (có checksum).
2. `pre-restore`: restore vào `idosi_reset_verify_<op>_pre`, CLI `verify-pre-backup` so schema và
   fingerprint từng bảng với DB đang chạy, ghi `pre-proof.json`, rồi chỉ DROP đúng DB diễn tập đó.
3. Inventory backup: **mọi** file là `KEEP` (CLI từ chối `PURGE` trong chế độ này) và backup trước
   reset phải có trong inventory, không đổi. Tạo `restores.json`, `context.json` như phase 3–4.
4. `plan` / `apply` / `verify` / `backup` / `restore` như cũ (wrapper tự truyền `pre-proof.json`).
5. `inventory-restores` → `retain-backups`: kiểm tra clean proof, pre-proof, mọi file backup và DB
   restore cũ còn nguyên, chạy lại verify, ghi phase `BACKUPS_RETAINED` + `complete.json`.
   Không chạy `drop-restores`/`purge-backups`/`record-backups`.
6. `leave` → smoke → `complete` (chấp nhận `BACKUPS_PURGED` hoặc `BACKUPS_RETAINED`).

CLI `--command history` liệt kê mọi operation, dòng đầu là operation có hiệu lực.

## Phạm vi và điều kiện dừng

Source khảo sát: `92d041518d1df6d6025c215e8328173d54659b84`. Thực hiện từ SHA đã merge,
CI xanh, watcher `running=target=SHA`, `state=deployed/up-to-date`. Deploy chỉ thêm
cấu trúc và code bảo vệ, **không reset dữ liệu**.

KEEP: users/hash mật khẩu/trạng thái/token version, sessions, HTKD assignments,
cửa hàng/nhóm/sản phẩm/quy đổi/link IDOSI, lịch sử cấu hình, tất cả snapshot và sync
attempts IDOSI, migration journal và hai bảng counter. Không gọi API sửa/xóa IDOSI.
Kiểm tra provenance; `manual` không phải predicate xóa. Nguồn fixture lẫn thật chưa
phân biệt được là REVIEW, không suy đoán.

PURGE: allowlist tường minh trong `test-data-reset.ts` gồm toàn bộ chứng từ nội bộ,
lines, ledger, bao/tồn, phân bổ/giữ hàng, phí/VAT, Sale/từ thiện, chuyển/nhập đối tác,
idempotency responses và heartbeat. Bao gồm soft-delete và mọi trạng thái.
Balance tái tạo zero/product; checkpoint Sale/NORMAL cũ bị xóa; counter được giữ.

Audit nghiệp vụ và IDOSI inventory event bị xóa. Audit tài khoản/cấu hình/IDOSI chỉ
được giữ khi entity/action được review và không chứa tham chiếu nghiệp vụ bị xóa.
Record lạ/pha trộn phải REVIEW. Chỉ disable `audit_logs_immutable`, delete chọn lọc
và enable lại trong cùng transaction; không tắt FK/trigger toàn DB.

CLI đối chiếu catalog PostgreSQL với fingerprint schema đã review từ migrations
0000..0035. Bảng/schema/partition/view lạ, column/FK/trigger thay đổi làm dừng.
Mỗi bảng có count và SHA-256 canonical JSONB rows; account hash, token và payload
không in vào log. Owners/ACL/RLS/policies/extensions được fingerprint trước/sau.

## Baseline và replay

Cutoff là ISO UTC; kỳ nghiệp vụ dùng Asia/Ho_Chi_Minh (UTC+7). Tháng trước cutoff
không áp vào kho mới. Snapshot lọc ngày/ca/thanh toán không làm baseline toàn tháng.
Snapshot đúng tại cutoff và đầy đủ: baseline=observed nguồn, applied=0.

Snapshot trước cutoff không đủ để tách chính xác trước/sau cutoff: để pending đến
quan sát toàn tháng hợp lệ đầu tiên sau cutoff, lưu `established_at`, dùng quan sát
đó làm baseline. **Doanh số từ cutoff đến quan sát này có thể không được trừ**.
Không đoán baseline 0. Snapshot gốc vẫn được giữ, kể cả incomplete.

Sau baseline, payload lặp không áp hai lần; tăng chỉ áp phần vượt baseline;
correction chỉ hoàn lượng đã áp sau reset. Tháng mới bắt đầu 0 khi mapping đã được
thiết lập. Sản phẩm mới dùng quan sát đầy đủ đầu tiên. Tập ID mapping đổi chuyển
sang `mapping_review`. Đối soát bảng `test_data_reset_baselines` trước nghiệm thu.

API trả `x-idosi-reset-epoch`, mutation yêu cầu đúng epoch sau reset. Web ghim epoch
trong document, reload khi thay đổi, không retry write cũ. SHA-256 key cũ làm
tombstone; không giữ key/payload/response/resource ID nguyên văn. Key cũ cũng bị
từ chối với epoch mới. Session/mật khẩu được giữ. Bundle cũ phải tải lại khi nhận 409. Source không có persisted query cache/service worker; local/session storage
chỉ giữ trạng thái UI, tab ID và phạm vi cửa hàng.

## Inventory và maintenance

Manifest/dump/evidence riêng tư ở `/var/lib/khohang-reset/<operation-uuid>`, mode
0700/0600, không commit hoặc tải dump production về máy test. Kiểm kê DATABASE_URL
cả API và worker, database/cluster/OID, project, release, migrations và writers;
không chỉ dựa vào POSTGRES_DB. Wrapper hỗ trợ deployment `/opt/khohang-idosi`,
Compose `khohang-idosi`, PostgreSQL `db/idosi`, backup `/var/backups/khohang-idosi`.

Kiểm kê dump/sidecar/file tạm/partial/tên ngoài chuẩn; từng file KEEP/PURGE. `.env`
backup chỉ chứa cấu hình được KEEP sau kiểm tra. Đối chiếu canonical path, symlink,
hardlink, mount, inode, mtime, size và SHA-256. Không xóa thư mục/bucket/volume.
Mọi database ngoài template/current/postgres phải được phân loại. Restore copy
`idosi_verify_*`, `idosi_policy_verify_*`, `idosi_reset_verify_*` có inventory riêng
với cluster/OID/schema/data fingerprint. Không DROP FORCE hoặc terminate client.

Kiểm kê offsite/version/trash/retention, export/upload/cache/log chứa payload,
provider snapshot, WAL archive/PITR và replica. Ghi VERIFIED/ABSENT/BLOCKED/UNKNOWN
cho từng đích, phân biệt xác nhận chủ hệ thống với kiểm tra kỹ thuật. Wrapper từ
chối offsite được cấu hình; thiếu adapter/quyền phải báo BLOCKED.

## Các phase từ release đã merge

Trong các lệnh dưới đây, `SCRIPT=infra/scripts/reset-test-data.sh`, SHA là full
merged SHA đã được watcher triển khai, DIR là thư mục operation riêng tư.

1. Xác minh CI/watcher/health và đủ dung lượng cho backup sạch + restore rehearsal.
2. `bash "$SCRIPT" enter --release SHA --state-dir DIR`: lưu trạng thái timer,
   dừng timer, đợi deploy/backup/upload đang chạy, giữ watcher/deploy locks, xác minh
   runtime DB, dừng Caddy/API/worker có grace. Giữa các phase, chúng vẫn dừng.
3. Dùng migrate image cùng SHA chạy `purge-test-data-backups.mjs --root ROOT
--output /reset/backups.json`. Mặc định chỉ inventory, file bắt đầu REVIEW.
   Review nội dung và đổi từng action. Tạo `restores.json` bằng
   `reset-test-data.mjs --command inventory-restores --output /reset/restores.json`.
4. Tạo context.json gồm host/project/release, UUID operationId, ISO cutoff,
   expectedSchemaHash từ export đã review, inventoryHash bằng
   `resetHash({backups,restores})`. Ghi kết luận provenance và các đích khác riêng.
5. `bash "$SCRIPT" plan --release SHA --state-dir DIR` tạo manifest.json bằng
   READ ONLY/REPEATABLE READ. Review mọi table/count/hash/action/FK/cutoff. Dữ liệu,
   schema hoặc backup thay đổi thì tạo lại plan; không ghi đè manifest đã apply.
6. `bash "$SCRIPT" apply --release SHA --state-dir DIR --confirm MANIFEST_HASH`.
   Kiểm tra context, cluster/database và inventory; từ chối client khác, khóa bảng,
   so lại fingerprint, thực hiện transaction tường minh và kiểm tra hậu điều kiện.
7. `bash "$SCRIPT" verify ...`: tài khoản/IDOSI/reference/counter/journal match,
   purge tables=0, balance/applied=0, schema/grants/trigger nguyên vẹn.
8. `bash "$SCRIPT" backup ...`: tạo backup sạch bằng backup-db.sh, ghi clean.path.
   `bash "$SCRIPT" restore ...`: restore-db.sh tạo database cô lập theo operation
   ID; CLI kiểm tra fingerprint/checksum/sidecar và ghi clean-proof.json.
9. `bash "$SCRIPT" inventory-restores ...`: tạo restores-final.json có thêm bản
   sạch vừa restore. So các bản cũ với restores.json, chỉ thêm tài nguyên do
   operation này tạo. Tính resetHash(restoresFinal), gọi
   `bash "$SCRIPT" drop-restores ... --confirm HASH`. Mỗi copy được đối chiếu lại
   identity/fingerprint và không có client trước DROP.
10. Lấy hash bằng purge-test-data-backups.mjs `--command hash --manifest FILE`.
    `bash "$SCRIPT" purge-backups ... --confirm HASH` chỉ unlink file đã review,
    giữ clean dump/sidecar/KEEP, ghi journal và quét lại. Dọn log/export/cache chứa
    payload theo inventory riêng đã review; không chạm WAL PostgreSQL đang chạy.
11. `bash "$SCRIPT" record-backups ...` kiểm tra clean proof, files/copies và DB
    invariants, ghi BACKUPS_PURGED + complete.json. `bash "$SCRIPT" leave ...`
    kiểm tra evidence trong DB, khởi động API/worker → Caddy → timer từng hoạt động.
12. Read-only smoke bằng quyền được cấp. Trong migrate image trên mạng Compose,
    chạy CLI `--command complete --operation-id UUID --health-url ORIGIN` để kiểm
    tra health/readiness API/worker và ghi COMPLETE. Kiểm tra lịch backup/sync.
    Không đổi password để có quyền test hoặc tạo lại phiếu giả trên production.

Log Docker có SQL/payload hoặc ID chứng từ phải có inventory riêng: container ID,
Compose labels, log paths/checksums và mount identities. Chỉ sau clean restore proof,
khi API/worker/Caddy đã dừng, mới dừng PostgreSQL có grace nếu cần dọn log DB.
Xác minh lại đúng container/mount, ghi metadata vận hành đã che payload, rồi remove
đúng container bằng Docker (không `-v`) và recreate từ cùng release. Volume PostgreSQL,
web assets, Caddy data/config giữ nguyên. Đối chiếu cluster ID, database OID và chạy
verify lại sau restart DB trước khi mở writers. Không truncate file json-log đang mở.
Log mới chỉ chứa vận hành database đã sạch; journal/deploy logs không chứa payload
được giữ. Không dùng thao tác này để xóa log app khác trên VPS.

Migrate image cần mount DIR tại `/reset`, backup root giữ nguyên absolute path.
Inventory/verify dùng read-only mount backup; purge cần read-write. Wrapper truyền
RESET_HOST/RESET_PROJECT/RESET_RELEASE thật. Không shell-eval JSON hoặc in secret.

## Resume và giới hạn

PLANNED là manifest trên filesystem, dry-run không ghi DB. Journal:
DATABASE_COMMITTED → VERIFIED → (BACKUPS_PURGED | BACKUPS_RETAINED) → COMPLETE. Lỗi
transaction rollback cả dữ liệu và scoped trigger. Mất kết nối sau COMMIT phải đọc status. Cùng
operation ID/hash chỉ tiếp tục phase thiếu, không reset/purge lần hai; operation ID mới chỉ được
phép khi mọi operation trước đã COMPLETE và cutoff mới hơn (xem đầu tài liệu).

Rollback code: chỉ dùng release tương thích schema/epoch hiện tại (≥ 0037). Khôi phục dữ liệu
trước reset là thao tác phục hồi riêng từ backup trước reset (chế độ `retain`), vào DB mới bằng
`restore-db.sh`; không restore đè DB đang chạy sau khi đã có giao dịch mới.

Purge resume ghi ABSENT cho file đã mất; identity đổi/file mới làm dừng. Nếu restore
bị ngắt giữa chừng, kiểm tra restore.started và đúng database của operation trước
khi xử lý; không restore đè. Sau restore hoàn tất mà mất response, verify lại bản
hiện có. Backup lỗi không rollback DB sạch về test và không reset DB lần hai.

Sau purge, rollback chỉ dùng code tương thích epoch/reset boundary hoặc backup
sạch. Không hứa khôi phục giao dịch đã hủy hoặc xóa vật lý mọi byte khỏi WAL/đĩa.
Nghiệm thu là xóa logic và bản sao quản lý được trong inventory. Còn đích không
kiểm tra/xóa được phải báo DATABASE RESET VERIFIED, BACKUP PURGE PARTIAL/BLOCKED.

## Gates và báo cáo

Chạy toàn bộ quality gates trong AGENTS.md. Reset unit/PostgreSQL nằm trong npm test
với RUN_POSTGRES_TESTS=1. `node --test infra/scripts/test-data-backups.test.mjs` dùng
filesystem sandbox. `node --test infra/scripts/reset-cli.integration.test.mjs` tự
tạo Docker cluster, diễn tập dump/restore/purge và chứng minh resume giữ dữ liệu mới.
`npm run e2e:live -w @idosi/web -- --grep 'isolated reset'` tự tạo DB/API riêng cho
auth/roles/replay/390/1440. Không dùng production để tạo fixture.

Báo cáo SHA/PR/CI/watcher, operation/hash/cutoff/phases, counts trước/sau, fingerprint
match, baseline, inventory trước/sau, clean backup/checksum, login/roles và giới hạn.
Không kèm payload/password hash/token. Phân biệt local/fixture/CI/production;
SKIPPED hoặc hạn chế Windows không được tính là PASS.
