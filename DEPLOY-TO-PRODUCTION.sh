#!/bin/bash
set -euo pipefail

# DEPLOYMENT GUIDE FOR khoidosi.io.vn (160.191.88.246)
# Branch: feat/add-wholesale-account-role
# Final commit: 0f0b921

cat << 'EOF'
╔════════════════════════════════════════════════════════════════╗
║   KHOHANG-IDOSI DEPLOYMENT TO PRODUCTION                       ║
║   VPS: 160.191.88.246                                          ║
║   Domain: khoidosi.io.vn                                       ║
╚════════════════════════════════════════════════════════════════╝

📋 Deployment Checklist:
  ☐ SSH access to VPS
  ☐ Project directory located
  ☐ Database backup created
  ☐ Code pulled and verified
  ☐ Docker images built
  ☐ Migrations executed
  ☐ Services restarted
  ☐ Health checks passed
  ☐ Smoke tests completed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: SSH vào VPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ssh root@160.191.88.246

# hoặc nếu dùng user khác:
ssh username@160.191.88.246

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: Tìm project directory
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Kiểm tra các vị trí thông dụng:
ls -la /opt/khohang-idosi 2>/dev/null || echo "Not found in /opt"
ls -la /home/*/khohang-idosi 2>/dev/null || echo "Not found in /home"
ls -la /var/www/khohang-idosi 2>/dev/null || echo "Not found in /var/www"

# Sau khi tìm thấy, cd vào:
cd /path/to/khohang-idosi  # THAY ĐỔI PATH NÀY

# Verify docker-compose.yml exists:
ls -la docker-compose.yml

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: Kiểm tra trạng thái hiện tại
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Xem containers đang chạy:
docker compose ps

# Xem commit hiện tại:
git log --oneline -5

# Kiểm tra resource usage:
df -h
free -h
docker stats --no-stream

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4: 🔴 BACKUP DATABASE (QUAN TRỌNG!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Tạo thư mục backup:
mkdir -p /opt/backups/khohang-idosi

# Backup database:
BACKUP_FILE="/opt/backups/khohang-idosi/backup-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U idosi -d idosi -Fc > "$BACKUP_FILE"

# Verify backup:
ls -lh "$BACKUP_FILE"
echo "✅ Backup saved to: $BACKUP_FILE"

# LƯU Ý: Ghi lại đường dẫn backup file để rollback nếu cần!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5: Pull code mới từ GitHub
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Fetch latest changes:
git fetch origin

# Checkout feature branch:
git checkout feat/add-wholesale-account-role

# Pull latest:
git pull origin feat/add-wholesale-account-role

# Verify commits (phải thấy 0f0b921):
git log --oneline -10

Expected commits:
  0f0b921 - chore: add deployment scripts and documentation
  cccd1eb - feat(ui): add partner receipts UI
  a59b1d5 - feat(api): add partner receipts API endpoints
  14b272f - feat(partner-receipts): add contracts and database operations
  be98261 - feat(auth): add wholesale_account role and partner_receipts tables

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6: Build Docker images
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "⏳ Building images... (có thể mất 5-10 phút)"

# Build migrate service:
docker compose build --no-cache migrate

# Build API service:
docker compose build --no-cache api

# Build worker service:
docker compose build --no-cache worker

# Build web service:
docker compose build --no-cache web

# Verify images:
docker images | grep khohang-idosi

echo "✅ Images built successfully"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7: Stop application services (GIỮ DATABASE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Stop API, Worker, Web, Caddy (database vẫn chạy):
docker compose stop api worker web caddy

# Verify database vẫn running:
docker compose ps db
# Should show "Up"

echo "✅ Application stopped, database still running"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 8: 🔴 RUN MIGRATIONS (QUAN TRỌNG!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "⏳ Running migrations..."

# Run migration container:
docker compose up migrate

# Check migration logs:
docker compose logs migrate

# Expected output:
#   ✓ Running migration 0011_add_wholesale_account_role.sql
#   ✓ Running migration 0012_add_partner_receipts.sql

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "VERIFY MIGRATIONS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check table partner_receipts exists:
docker compose exec db psql -U idosi -d idosi -c "\dt partner_receipts"

# Check table partner_receipt_lines exists:
docker compose exec db psql -U idosi -d idosi -c "\dt partner_receipt_lines"

# Check enum updated:
docker compose exec db psql -U idosi -d idosi -c "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'user_role'::regtype ORDER BY enumlabel"

# Expected output should include: admin, htkd, store, wholesale_account

echo "✅ Migrations verified"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 9: Start application services
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "⏳ Starting services..."

# Start all services:
docker compose up -d api worker web caddy

# Wait for services to be healthy:
echo "Waiting 30 seconds for health checks..."
sleep 30

# Check status:
docker compose ps

# All containers should show "Up" or "healthy"

echo "✅ Services started"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 10: Health checks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RUNNING HEALTH CHECKS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Container status:
docker compose ps

# 2. API health endpoint:
curl -k https://khoidosi.io.vn/ready
# Should return 200 OK

# 3. Check recent logs:
docker compose logs api --tail=50
docker compose logs worker --tail=20

# 4. Check for errors:
ERROR_COUNT=$(docker compose logs api --tail=100 | grep -i "error" | wc -l)
echo "Recent error count: $ERROR_COUNT"

if [ "$ERROR_COUNT" -lt 5 ]; then
    echo "✅ Error count acceptable"
else
    echo "⚠️  WARNING: High error count!"
fi

# 5. Resource usage:
docker stats --no-stream

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 11: 🧪 SMOKE TESTS (Manual testing required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mở trình duyệt và test:

1. Truy cập: https://khoidosi.io.vn

2. Test Login STORE role:
   ✓ Login thành công
   ✓ Thấy menu "Nhập hàng đối tác"
   ✓ Click vào menu

3. Test tạo phiếu nhập:
   ✓ Click "Tạo phiếu nhập"
   ✓ Điền tên đối tác: "Test Deployment"
   ✓ Chọn mặt hàng
   ✓ Nhập số lượng: 5
   ✓ Click "Lưu phiếu nhập"
   ✓ Phiếu xuất hiện trong danh sách

4. Test authorization:
   ✓ Logout
   ✓ Login với Admin hoặc HTKD
   ✓ KHÔNG thấy menu "Nhập hàng đối tác"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 12: Monitor (30 phút)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Monitor logs real-time:
docker compose logs -f api worker

# Press Ctrl+C to stop monitoring

# Hoặc check định kỳ:
watch -n 60 'docker compose ps && docker stats --no-stream'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DEPLOYMENT COMPLETE!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deployed:
  ✓ Branch: feat/add-wholesale-account-role
  ✓ Commit: 0f0b921
  ✓ Domain: https://khoidosi.io.vn
  ✓ Features: WHOLESALE_ACCOUNT role, Partner Receipts

Next steps:
  1. Monitor logs for 30 minutes
  2. Test with real users
  3. Keep backup file for 24 hours
  4. Merge to main after confirmation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 ROLLBACK (Nếu có vấn đề)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Stop all services:
docker compose down

# Restore database:
docker compose up -d db
sleep 10
docker compose exec -T db pg_restore -U idosi -d idosi -c < /opt/backups/khohang-idosi/backup-YYYYMMDD-HHMMSS.dump

# Checkout previous commit:
git checkout <previous-commit-sha>

# Rebuild and start:
docker compose build
docker compose up -d

# Verify:
docker compose ps
curl -k https://khoidosi.io.vn/ready

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
