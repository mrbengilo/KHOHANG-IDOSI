# Triển khai `khoidosi.io.vn`

Tài liệu này là runbook production cho một VPS Linux chạy Docker Engine và Docker Compose v2.
Không lưu mật khẩu, token registry, khóa SSH hoặc file môi trường production vào Git.

## Điều kiện bắt buộc

- Nhánh phát hành đã được review, CI xanh và checkout đúng một commit SHA đầy đủ.
- Bản ghi `A` của `khoidosi.io.vn` trỏ tới IP công khai của VPS.
- TCP 22 chỉ mở cho địa chỉ quản trị; TCP 80, TCP 443 và UDP 443 mở công khai.
- VPS có Docker Engine, Compose v2, đồng bộ thời gian và ít nhất một thư mục backup nằm ngoài checkout.
- Có tài khoản SSH dùng khóa, có quyền chạy Docker và quyền quản trị firewall cần thiết.
- Có kế hoạch backup ngoài VPS và đã thử restore vào database mới.

## Biến môi trường

Tạo file chỉ đọc bởi root, ví dụ `/etc/khohang-idosi/production.env`, từ `.env.example`.
Các giá trị tối thiểu phải được thay bằng giá trị production:

```dotenv
APP_DOMAIN=khoidosi.io.vn
WEB_ORIGIN=https://khoidosi.io.vn
IMAGE_PREFIX=local/khohang-idosi
IMAGE_TAG=<FULL_COMMIT_SHA>
POSTGRES_PASSWORD=<RANDOM_LONG_SECRET>
DATABASE_URL=postgresql://idosi:<URL_ENCODED_PASSWORD>@db:5432/idosi
```

Giữ `VITE_ENABLE_MOCK_FALLBACK=false`. `DATABASE_URL` phải dùng hostname nội bộ `db`; PostgreSQL
không được publish ra Internet. Khóa file bằng `chmod 600` và không đặt các biến
`BOOTSTRAP_ADMIN_*` lâu dài trong file này.

## Preflight trên VPS

### Kết nối thống kê IDOSI

Đặt `IDOSI_INTEGRATION_SECRET` bằng khóa `WAREHOUSE_API_KEY` do hệ thống IDOSI cấp,
chỉ trong file môi trường riêng tư trên VPS. Không đưa khóa vào frontend hoặc Git.
`IDOSI_STORE_ID_MAP` là JSON ánh xạ mã cửa hàng kho sang ID cửa hàng trên API IDOSI,
ví dụ `IDOSI_STORE_ID_MAP={"DS_BMT":"CH003"}`. Xác minh tên cửa hàng qua API thực
trước khi thêm từng ánh xạ; không suy đoán từ dữ liệu mẫu. Không đổi mã/UUID trong
database kho để khớp hệ thống bên ngoài.

API và worker cùng đọc ánh xạ này. Khi ánh xạ có nội dung, cửa hàng chưa được cấu
hình sẽ báo lỗi đồng bộ, không tự gửi mã kho sang IDOSI. Giá trị trống hoặc `{}`
giữ hành vi cũ cho hệ thống có mã hai bên giống nhau. Cấu hình sai hoặc trùng ID
đích sẽ ngăn service khởi động. Worker cần mạng `edge` để gọi HTTPS ra ngoài;
database vẫn chỉ nằm trên mạng `data` nội bộ, không publish cổng.

Chạy từ checkout sạch tại commit sẽ phát hành:

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
release_sha="$(git rev-parse HEAD)"
test "${#release_sha}" -eq 40
docker version
docker compose version
docker compose --env-file /etc/khohang-idosi/production.env config --quiet
```

Đảm bảo `IMAGE_TAG` trong file môi trường đúng bằng `release_sha`. Trước lần triển khai thay thế,
tạo backup đã kiểm tra checksum:

```bash
sudo install -d -m 700 /var/backups/khohang-idosi
sudo ./infra/scripts/backup-db.sh \
  --env-file /etc/khohang-idosi/production.env \
  --output-dir /var/backups/khohang-idosi
```

Lần triển khai đầu tiên chưa có database đang chạy thì bỏ qua bước backup.

### Giữ asset của các tab đang mở

Web dùng volume `khohang-idosi_web-assets` để giữ các file `/assets` có hash qua các lần
thay container. Trước **lần đầu** nâng cấp từ phiên bản chưa có volume này, chuyển asset
từ các image web còn giữ trên VPS vào volume **trước khi** thay container. Cách này
khôi phục được cả asset của tab mở từ bản cũ hơn container đang chạy:

```bash
set -euo pipefail
mapfile -t web_images < <(
  docker image ls --format '{{.Repository}}:{{.Tag}}' |
    grep -E '^local/khohang-idosi-web:[0-9a-f]{40}$'
)
test "${#web_images[@]}" -gt 0
docker volume create khohang-idosi_web-assets >/dev/null
for image in "${web_images[@]}"; do
  docker run --rm --network none --read-only --user 0:0 \
    --mount type=volume,source=khohang-idosi_web-assets,target=/retained \
    --entrypoint /bin/sh "$image" \
    -c 'cp -an /app/public/assets/. /retained/'
done
docker run --rm --network none --read-only --user 0:0 \
  --mount type=volume,source=khohang-idosi_web-assets,target=/retained \
  --entrypoint /bin/sh "${web_images[0]}" \
  -c 'chown -R 1000:1000 /retained'
docker run --rm --network none --read-only \
  --mount type=volume,source=khohang-idosi_web-assets,target=/retained,readonly \
  --entrypoint /bin/sh "${web_images[0]}" \
  -c 'test -n "$(find /retained -type f -print -quit)"'
```

Không xóa volume này khi deploy hoặc rollback. Các tab tham chiếu tới asset không còn
trong bất kỳ image nào cần tải lại trang một lần. Theo dõi dung lượng volume và chỉ dọn các
asset cũ sau khi chắc chắn không còn tab nào dùng phiên bản tương ứng.

## Deploy tự động từ `main`

Đây là cách deploy mặc định. VPS chạy `khohang-autodeploy.timer` khoảng 2 phút một lần. Khi đầu
nhánh `main` khác bản đang chạy và check `Node 24 / PostgreSQL 17` của chính commit đó đã xanh,
watcher `/usr/local/sbin/khohang-autodeploy`:

1. Fetch commit vào mirror `/opt/khohang-idosi/repo.git` và tạo checkout
   `/opt/khohang-idosi/releases/<FULL_SHA>`.
2. Chạy `infra/scripts/deploy.sh` của chính commit đó: backup database có checksum, build bốn ảnh
   ứng dụng, chạy migration, thay `api`, `worker`, `web`, `caddy` rồi kiểm tra `/health`, `/ready`,
   `/openapi.json` và `/` qua HTTPS.
3. Chỉ khi mọi kiểm tra đạt mới đổi `IMAGE_TAG` trong file môi trường và symlink `current`. Nếu lỗi
   sau khi đã thay container, script tự đưa ảnh về bản trước bằng `rollback.sh` (không đảo
   migration). Lỗi trước bước đó không đụng tới service đang chạy.

VPS chỉ gọi ra GitHub qua HTTPS vì repository public; GitHub không cần khóa SSH hay secret. Commit
có CI đỏ hoặc deploy lỗi không bị thử lại; merge một commit mới để deploy tiếp. Deploy dùng khóa
`/run/lock/khohang-idosi-deploy.lock`, nên watcher và người vận hành không thể deploy chồng nhau.

Cài lần đầu bằng root từ checkout đang chạy. Sau mỗi lần deploy thành công, watcher tự cập nhật từ
release mới:

```bash
sudo bash /opt/khohang-idosi/current/infra/autodeploy/install.sh
```

Theo dõi trạng thái:

```bash
cat /var/lib/khohang-autodeploy/status
journalctl -u khohang-autodeploy --since today
ls -t /var/lib/khohang-autodeploy/logs/ | head
```

`state` là một trong `up-to-date`, `waiting-ci`, `deploying`, `deployed`, `ci-failed`, `failed`,
`skipped`, `busy`, `paused` hoặc `error`; `detail` ghi đường dẫn log của lần deploy.

- Tạm dừng khi xử lý sự cố: `sudo touch /etc/khohang-idosi/autodeploy.paused`; xóa file để chạy lại.
- Cho phép thử lại một commit đã lỗi sau khi sửa nguyên nhân ngoài code:
  `sudo rm /var/lib/khohang-autodeploy/failed/<FULL_SHA>`.
- Tùy chọn trong `/etc/khohang-idosi/autodeploy.env` (không bắt buộc): `AUTODEPLOY_BRANCH`,
  `AUTODEPLOY_REQUIRED_CHECK`, `AUTODEPLOY_GITHUB_TOKEN` (chỉ cần nếu repository chuyển sang
  private hoặc bị giới hạn tốc độ API).

Deploy tay một commit đã merge, dùng cùng script và khóa với watcher:

```bash
set -euo pipefail
sha=<FULL_SHA>
mirror=/opt/khohang-idosi/repo.git
git --git-dir="$mirror" fetch --quiet https://github.com/mrbengilo/KHOHANG-IDOSI.git \
  +refs/heads/main:refs/heads/main
git --git-dir="$mirror" worktree add --detach "/opt/khohang-idosi/releases/$sha" "$sha"
sudo "/opt/khohang-idosi/releases/$sha/infra/scripts/deploy.sh" --sha "$sha" --yes
```

Nếu `main` mới hơn commit vừa deploy tay, watcher sẽ đưa production về đầu `main` ở lần kiểm tra kế
tiếp; tạm dừng watcher nếu cần giữ bản khác.

Sau khi deploy thành công, `deploy.sh` giữ ảnh của năm release gần nhất và bản ngay trước, xóa ảnh
ứng dụng cũ hơn cùng build cache quá bảy ngày, và gỡ checkout cũ được tạo từ mirror. Checkout tạo
trước khi có watcher được giữ nguyên để người vận hành tự dọn. Script không bao giờ xóa backup,
volume hoặc file môi trường.

## Build và triển khai

Các bước dưới đây là quy trình thủ công mà `infra/scripts/deploy.sh` tự động hóa; chỉ dùng trực tiếp
khi chẩn đoán sự cố.

VPS build ảnh bất biến từ đúng checkout; `--pull never` ngăn Compose tìm registry khi dùng prefix
`local/`. Nếu dùng registry, CI phải build/push cùng một SHA cho đủ bốn ảnh `api`, `migrate`,
`worker`, `web` và VPS phải đăng nhập registry trước khi pull.

```bash
set -euo pipefail
env_file=/etc/khohang-idosi/production.env

# Tải trước các ảnh bên thứ ba. Các lệnh `--pull never` bên dưới sau đó chỉ dùng
# đúng ảnh ứng dụng đã build tại commit phát hành và không truy cập registry.
docker compose --env-file "$env_file" pull db caddy caddy-storage-init
docker compose --env-file "$env_file" build --pull api migrate worker web
docker compose --env-file "$env_file" up --detach --pull never --wait db
docker compose --env-file "$env_file" run --rm --no-deps --pull never migrate
docker compose --env-file "$env_file" up --detach --pull never --wait api worker web caddy
docker compose --env-file "$env_file" ps
```

Migration dùng advisory lock và phải hoàn tất trước khi API/worker khởi động. Seed chỉ thêm reference
row còn thiếu; deploy không được đổi tên, kích hoạt lại hoặc phục hồi catalog/store đã được quản trị.

Caddy chạy bằng UID/GID `65532:65532`, filesystem chỉ đọc và `no-new-privileges`.
Chỉ giữ capability `NET_BIND_SERVICE` trong bounding set vì binary chính thức có file
capability này; nếu chỉ đặt `cap_drop: ALL`, Linux có thể từ chối khởi chạy với
`exec /usr/bin/caddy: operation not permitted` ngay cả khi dùng cổng nội bộ 8080/8443.
CI phải chạy và kiểm tra health của toàn bộ stack bằng đúng cấu hình Compose, không
chỉ validate Caddyfile trong container root mặc định.

## Tạo Admin lần đầu

Chỉ chạy một lần qua terminal riêng tư. Không đưa mật khẩu vào lịch sử shell hoặc chat. Nạp ba biến
`BOOTSTRAP_ADMIN_*` từ secret manager rồi chạy:

```bash
docker compose \
  --env-file /etc/khohang-idosi/production.env \
  --profile bootstrap run --rm --no-deps --pull never bootstrap-admin
```

Xóa các biến bootstrap khỏi phiên shell ngay sau khi hoàn tất và đăng nhập kiểm tra bằng HTTPS.

## Kiểm tra sau triển khai

```bash
curl --fail --silent --show-error https://khoidosi.io.vn/health
curl --fail --silent --show-error https://khoidosi.io.vn/ready
curl --fail --silent --show-error https://khoidosi.io.vn/openapi.json >/dev/null
curl --head --fail --silent --show-error https://khoidosi.io.vn/
```

Sau đó kiểm tra bằng trình duyệt trên desktop và mobile:

1. Đăng nhập từng vai trò Admin, HTKD và cửa hàng.
2. Kiểm tra menu/route theo quyền; không có dữ liệu mock trong production.
3. Thực hiện một luồng ghi thử có thể đối soát, xác nhận busy/disabled/error/retry và audit log.
4. Xác nhận API, worker, web, database và Caddy đều healthy; log không có lỗi hoặc secret.
5. Tạo một backup mới và kiểm tra `pg_restore --list`/checksum.

## Rollback

Chỉ rollback ảnh khi schema hiện tại tương thích với commit trước. Script không đảo migration và
không tự restore database:

```bash
./infra/scripts/rollback.sh \
  --env-file /etc/khohang-idosi/production.env \
  --image-source local \
  --from-tag <CURRENT_FULL_SHA> \
  --to-tag <PREVIOUS_VERIFIED_FULL_SHA> \
  --confirm-forward-compatible-db \
  --yes
```

Dùng `--image-source local` khi ảnh được build ngay trên VPS như quy trình ở trên. Nếu dùng registry,
đổi thành `--image-source registry`; script sẽ tải và kiểm tra cả ảnh đích lẫn ảnh khôi phục trước
khi thay container. Ở chế độ local, script không truy cập registry và dừng trước khi thay container
nếu thiếu bất kỳ ảnh nào.

Nếu cần phục hồi dữ liệu, dùng `restore-db.sh` vào một database mới, xác minh độc lập rồi mới đổi
`DATABASE_URL`; không restore đè trực tiếp database đang chạy. Luôn truyền
`--env-file /etc/khohang-idosi/production.env` cho cả `restore-db.sh` để Compose có đủ biến nội suy.

## Gate dừng triển khai

Không triển khai hoặc phải dừng ngay khi có một trong các điều kiện sau:

- CI/test/build chưa xanh hoặc checkout còn thay đổi chưa commit.
- DNS không trỏ đúng VPS, cổng 80/443 chưa truy cập được hoặc Caddy chưa cấp được chứng chỉ.
- Thiếu backup hợp lệ khi thay thế hệ thống đang có dữ liệu.
- Thiếu SSH/registry credential, secret production hoặc quyền firewall.
- Một route production còn hiển thị `UnavailableFeature`, dữ liệu mẫu, nút no-op hoặc mutation không
  có trạng thái bận/lỗi/idempotency phù hợp.
