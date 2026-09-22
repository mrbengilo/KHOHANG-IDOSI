# HƯỚNG DẪN DEPLOY LÊN VPS

## Tổng quan

Deploy branch `feat/add-wholesale-account-role` với các thay đổi:

- Thêm vai trò WHOLESALE_ACCOUNT
- Thêm bảng partner_receipts và partner_receipt_lines
- API endpoints cho partner receipts
- UI form và danh sách partner receipts

**Commits:**

- `be98261` - feat(auth): add wholesale_account role and partner_receipts tables
- `14b272f` - feat(partner-receipts): add contracts and database operations
- `a59b1d5` - feat(api): add partner receipts API endpoints
- `cccd1eb` - feat(ui): add partner receipts UI

---

## Cách 1: Sử dụng Deploy Script (Khuyến nghị)

### Bước 1: Upload scripts lên VPS

```bash
# Trên máy local
scp deploy.sh verify-deployment.sh user@your-vps:/opt/khohang-idosi/

# SSH vào VPS
ssh user@your-vps
cd /opt/khohang-idosi

# Cấp quyền thực thi
chmod +x deploy.sh verify-deployment.sh
```

### Bước 2: Chạy deployment

```bash
# Set environment variables (optional)
export PROJECT_DIR=/opt/khohang-idosi
export BACKUP_DIR=/opt/backups/khohang-idosi

# Run deployment
./deploy.sh
```

Script sẽ tự động:

1. ✅ Backup database
2. ✅ Pull code mới
3. ✅ Build Docker images
4. ✅ Stop services (trừ database)
5. ✅ Run migrations
6. ✅ Start services
7. ✅ Health checks
8. ✅ Show deployment summary

### Bước 3: Verify deployment

```bash
# Chạy verification script
./verify-deployment.sh
```

---

## Cách 2: Deploy Thủ Công (Step-by-step)

### Bước 1: SSH vào VPS

```bash
ssh user@your-vps-ip
cd /opt/khohang-idosi  # hoặc đường dẫn project của bạn
```

### Bước 2: Kiểm tra trạng thái hiện tại

```bash
# Xem containers đang chạy
docker compose ps

# Xem logs gần nhất
docker compose logs --tail=50 api worker

# Kiểm tra disk space
df -h

# Kiểm tra memory
free -h
```

### Bước 3: Backup Database

```bash
# Tạo thư mục backup
mkdir -p /opt/backups/khohang-idosi

# Backup database
docker compose exec -T db pg_dump -U idosi -d idosi -Fc > "/opt/backups/khohang-idosi/backup-$(date +%Y%m%d-%H%M%S).dump"

# Verify backup
ls -lh /opt/backups/khohang-idosi/
```

### Bước 4: Pull code mới

```bash
# Fetch changes
git fetch origin

# Checkout feature branch
git checkout feat/add-wholesale-account-role
git pull origin feat/add-wholesale-account-role

# Verify commit
git log --oneline -5
# Should see: cccd1eb, a59b1d5, 14b272f, be98261
```

### Bước 5: Build images

```bash
# Build all images
docker compose build --no-cache migrate
docker compose build --no-cache api
docker compose build --no-cache worker
docker compose build --no-cache web

# Verify images
docker images | grep khohang-idosi
```

### Bước 6: Stop services (keep database)

```bash
# Stop application services
docker compose stop api worker web caddy

# Database vẫn chạy
docker compose ps db
```

### Bước 7: Run migrations

```bash
# Run migrations
docker compose up migrate

# Kiểm tra logs
docker compose logs migrate

# Verify tables created
docker compose exec db psql -U idosi -d idosi -c "\dt partner_receipts"
docker compose exec db psql -U idosi -d idosi -c "\dt partner_receipt_lines"

# Verify enum updated
docker compose exec db psql -U idosi -d idosi -c "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'user_role'::regtype"
```

### Bước 8: Start services

```bash
# Start all services
docker compose up -d api worker web caddy

# Wait for health checks
sleep 30

# Check status
docker compose ps
```

### Bước 9: Health Checks

```bash
# 1. All containers healthy
docker compose ps
# All should show "Up" or "healthy"

# 2. Check logs for errors
docker compose logs api --tail=50
docker compose logs worker --tail=50

# 3. Test API health endpoint
curl -k https://your-domain.com/ready
# Should return 200 OK

# 4. Verify migrations
docker compose exec db psql -U idosi -d idosi -c "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'partner_%'"
```

### Bước 10: Monitor

```bash
# Monitor logs real-time
docker compose logs -f api worker

# Check resource usage
docker stats --no-stream

# Count recent errors
docker compose logs api --tail=200 | grep -i error | wc -l
```

---

## Smoke Tests (Manual Testing)

### Test 1: Login với các vai trò

1. **Admin account:**
   - Login thành công
   - KHÔNG thấy menu "Nhập hàng đối tác"

2. **HTKD account:**
   - Login thành công
   - KHÔNG thấy menu "Nhập hàng đối tác"

3. **STORE account (retail):**
   - Login thành công
   - THẤY menu "Nhập hàng đối tác"

### Test 2: Tạo phiếu nhập đối tác

1. Login với STORE account
2. Click "Nhập hàng đối tác"
3. Click "Tạo phiếu nhập"
4. Điền form:
   - Tên đối tác: "Nhà cung cấp ABC"
   - Ghi chú: "Test deployment"
   - Chọn mặt hàng
   - Nhập số lượng: 10
5. Click "Thêm dòng" để thêm sản phẩm thứ 2
6. Click "Lưu phiếu nhập"
7. Verify: Phiếu xuất hiện trong danh sách

### Test 3: Kiểm tra danh sách

1. Xem danh sách phiếu nhập
2. Verify: Hiển thị đúng:
   - Số phiếu (PN-YYYYMMDD-HHMMSS-XXXX)
   - Tên đối tác
   - Tổng số lượng
   - Trạng thái: "Nháp"
   - Ngày tạo

### Test 4: Authorization

1. Logout STORE account
2. Login với Admin hoặc HTKD
3. Verify: Không thấy "Nhập hàng đối tác" trong menu
4. Thử truy cập trực tiếp: https://your-domain.com/partner-receipts
5. Verify: Không có quyền hoặc redirect

---

## Rollback (Nếu cần)

### Option 1: Rollback code (giữ migrations)

```bash
# Stop services
docker compose stop api worker web

# Checkout commit trước
git checkout <previous-commit-sha>

# Rebuild images
docker compose build api worker web

# Start services
docker compose up -d api worker web

# Verify
docker compose ps
```

### Option 2: Rollback cả database

```bash
# Stop all services
docker compose down

# Restore database
docker compose up -d db
sleep 10
docker compose exec -T db pg_restore -U idosi -d idosi -c < /opt/backups/khohang-idosi/backup-YYYYMMDD-HHMMSS.dump

# Checkout previous code
git checkout <previous-commit-sha>

# Rebuild and start
docker compose build
docker compose up -d

# Verify
docker compose ps
```

---

## Troubleshooting

### Vấn đề: Migration thất bại

```bash
# Xem lỗi chi tiết
docker compose logs migrate

# Kiểm tra database connection
docker compose exec db psql -U idosi -d idosi -c "SELECT version()"

# Kiểm tra migrations đã chạy
docker compose exec db psql -U idosi -d idosi -c "SELECT * FROM migrations ORDER BY id DESC LIMIT 5"
```

### Vấn đề: Container không healthy

```bash
# Xem logs
docker compose logs api --tail=100

# Xem health check command
docker inspect khohang-idosi-api-1 | grep -A 5 "Healthcheck"

# Restart container
docker compose restart api
```

### Vấn đề: High error count

```bash
# Xem errors chi tiết
docker compose logs api | grep -i error | tail -20

# Xem stack traces
docker compose logs api --tail=500 | grep -A 10 "Error:"

# Kiểm tra database connection
docker compose exec api node -e "console.log(process.env.DATABASE_URL)"
```

### Vấn đề: UI không load

```bash
# Check web container logs
docker compose logs web

# Check Caddy logs
docker compose logs caddy

# Test directly to web container
docker compose exec web wget -O- http://localhost:3000
```

---

## Post-Deployment Monitoring

### Trong 30 phút đầu:

```bash
# Monitor logs continuously
docker compose logs -f api worker

# Check error rate mỗi 5 phút
watch -n 300 'docker compose logs api --since 5m | grep -i error | wc -l'

# Check resource usage
docker stats --no-stream
```

### Metrics cần theo dõi:

- ❌ Error rate tăng đột ngột
- ❌ Memory usage > 90%
- ❌ CPU usage > 80% kéo dài
- ❌ Response time tăng
- ❌ Container restart liên tục

Nếu có bất kỳ vấn đề nào → Rollback ngay

---

## Checklist Hoàn Thành

- [ ] Database backup thành công
- [ ] Code được pull về đúng branch và commit
- [ ] Images được build thành công
- [ ] Migrations chạy thành công
- [ ] Services start và healthy
- [ ] Không có critical errors trong logs
- [ ] Login thành công với 3 vai trò
- [ ] STORE role thấy menu "Nhập hàng đối tác"
- [ ] Tạo phiếu nhập đối tác thành công
- [ ] Danh sách hiển thị đúng
- [ ] Admin/HTKD không thấy menu
- [ ] Resource usage bình thường
- [ ] Monitoring trong 30 phút không có vấn đề

---

## Liên hệ

Nếu gặp vấn đề trong quá trình deploy, vui lòng:

1. Chụp screenshot logs lỗi
2. Ghi lại các bước đã thực hiện
3. Backup database trước khi thử rollback
4. Liên hệ team để hỗ trợ

**Lưu ý:** KHÔNG xóa backup database cho đến khi xác nhận deployment ổn định ít nhất 24 giờ.
