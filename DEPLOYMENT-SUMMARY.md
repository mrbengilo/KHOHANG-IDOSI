# 🚀 DEPLOYMENT SUMMARY - PARTNER RECEIPTS FEATURE

## ✅ Đã hoàn thành

### 📦 Code Changes (5 commits pushed)

1. **be98261** - feat(auth): add wholesale_account role and partner_receipts tables
   - Migration 0011: Thêm role `wholesale_account` vào enum
   - Migration 0012: Tạo bảng `partner_receipts` và `partner_receipt_lines`
   - Schema cho quản lý phiếu nhập từ đối tác bên ngoài

2. **14b272f** - feat(partner-receipts): add contracts and database operations
   - API contracts: request/response schemas
   - Database operations: create, list, get partner receipts
   - Validation và error handling

3. **a59b1d5** - feat(api): add partner receipts API endpoints
   - GET `/api/v1/partner-receipts` - List phiếu nhập
   - GET `/api/v1/partner-receipts/:id` - Chi tiết phiếu
   - POST `/api/v1/partner-receipts` - Tạo phiếu mới
   - Authorization: Chỉ STORE role

4. **cccd1eb** - feat(ui): add partner receipts UI
   - Trang `/partner-receipts` với form và danh sách
   - Validation đầy đủ
   - Navigation menu entry
   - Access control

5. **0f0b921** - chore: add deployment scripts and documentation
   - deploy.sh - Automated deployment
   - verify-deployment.sh - Post-deploy verification
   - DEPLOYMENT.md - Chi tiết hướng dẫn
   - deploy-vps.sh - VPS-specific script

**Branch:** `feat/add-wholesale-account-role`  
**GitHub:** https://github.com/mrbengilo/KHOHANG-IDOSI

---

## 🎯 Features Delivered

### 1. WHOLESALE_ACCOUNT Role
- Thêm role mới vào hệ thống
- Chuẩn bị cho tài khoản đối tác sỉ
- Migration tương thích ngược

### 2. Partner Receipts Management
- **Tạo phiếu nhập:** Form với validation
- **Danh sách phiếu:** Table với filter và pagination
- **Chi tiết phiếu:** Xem đầy đủ thông tin
- **Authorization:** Chỉ STORE role truy cập được

### 3. Database Schema
```sql
-- partner_receipts table
- id (UUID)
- receipt_number (unique, format: PN-YYYYMMDD-HHMMSS-XXXX)
- store_id
- partner_name
- notes
- total_quantity
- status (draft/confirmed/cancelled)
- created_by_user_id
- timestamps

-- partner_receipt_lines table
- id (UUID)
- receipt_id (FK)
- product_id (FK)
- quantity
- timestamps
```

---

## 📋 CÁCH DEPLOY LÊN VPS

### Thông tin VPS:
- **IP:** 160.191.88.246
- **Domain:** khoidosi.io.vn

### Option 1: Deploy tự động (Khuyến nghị)

```bash
# 1. SSH vào VPS
ssh root@160.191.88.246

# 2. Tìm project directory (ví dụ: /opt/khohang-idosi)
cd /opt/khohang-idosi

# 3. Pull deployment script
git fetch origin
git checkout feat/add-wholesale-account-role
git pull origin feat/add-wholesale-account-role

# 4. Cấp quyền thực thi
chmod +x deploy-vps.sh verify-deployment.sh

# 5. Chạy deployment
./deploy-vps.sh

# 6. Sau khi deploy xong, verify
./verify-deployment.sh
```

Script tự động sẽ:
- ✅ Backup database
- ✅ Pull code mới
- ✅ Build Docker images
- ✅ Run migrations
- ✅ Restart services
- ✅ Health checks
- ✅ Show rollback commands

### Option 2: Deploy thủ công từng bước

Xem chi tiết trong file: **DEPLOY-TO-PRODUCTION.sh**

```bash
# View step-by-step guide
cat DEPLOY-TO-PRODUCTION.sh
```

---

## 🧪 SMOKE TESTS (Sau khi deploy)

### Test 1: Login với STORE role
1. Truy cập: https://khoidosi.io.vn
2. Login với tài khoản cửa hàng
3. ✅ Thấy menu "Nhập hàng đối tác"

### Test 2: Tạo phiếu nhập
1. Click "Nhập hàng đối tác"
2. Click "Tạo phiếu nhập"
3. Điền form:
   - Tên đối tác: "Test Deployment Partner"
   - Ghi chú: "Testing after deployment"
   - Chọn sản phẩm: Bất kỳ
   - Số lượng: 10
4. Click "Lưu phiếu nhập"
5. ✅ Phiếu xuất hiện trong danh sách với:
   - Số phiếu: PN-YYYYMMDD-HHMMSS-XXXX
   - Tên đối tác đúng
   - Số lượng: 10
   - Trạng thái: Nháp

### Test 3: Authorization
1. Logout khỏi STORE account
2. Login với Admin hoặc HTKD account
3. ✅ KHÔNG thấy menu "Nhập hàng đối tác"
4. Thử truy cập trực tiếp: https://khoidosi.io.vn/partner-receipts
5. ✅ Hiển thị "Không có quyền truy cập"

### Test 4: List và filter
1. Login lại với STORE account
2. Vào "Nhập hàng đối tác"
3. ✅ Danh sách hiển thị tất cả phiếu của cửa hàng
4. ✅ Không thấy phiếu của cửa hàng khác

---

## 🔍 VERIFICATION CHECKLIST

### Pre-deployment:
- [x] Code reviewed và tested locally
- [x] Typecheck passed
- [x] Migrations tested
- [x] All commits pushed to GitHub
- [x] Branch: feat/add-wholesale-account-role

### During deployment:
- [ ] SSH vào VPS thành công
- [ ] Database backup created
- [ ] Code pulled (commit: 0f0b921)
- [ ] Docker images built
- [ ] Migrations executed successfully
- [ ] Services restarted
- [ ] All containers healthy

### Post-deployment:
- [ ] Tables created: partner_receipts, partner_receipt_lines
- [ ] Enum updated: wholesale_account
- [ ] API /ready returns 200
- [ ] No critical errors in logs
- [ ] STORE login successful
- [ ] Menu "Nhập hàng đối tác" visible
- [ ] Create partner receipt works
- [ ] List displays correctly
- [ ] Admin/HTKD authorization enforced
- [ ] Resource usage normal

---

## 📊 DATABASE MIGRATIONS

### Migration 0011: Add wholesale_account role
```sql
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'wholesale_account';
```

### Migration 0012: Add partner_receipts tables
```sql
CREATE TABLE partner_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number TEXT UNIQUE NOT NULL,
  store_id UUID NOT NULL REFERENCES stores(id),
  partner_name TEXT NOT NULL,
  notes TEXT,
  total_quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE partner_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES partner_receipts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_receipts_store ON partner_receipts(store_id);
CREATE INDEX idx_partner_receipts_status ON partner_receipts(status);
CREATE INDEX idx_partner_receipt_lines_receipt ON partner_receipt_lines(receipt_id);
```

---

## 🔄 ROLLBACK PROCEDURE

Nếu gặp vấn đề sau deploy:

### Quick rollback (giữ migrations):
```bash
cd /opt/khohang-idosi
docker compose stop api worker web
git checkout <previous-commit>  # Commit trước be98261
docker compose build api worker web
docker compose up -d api worker web
docker compose ps
```

### Full rollback (restore database):
```bash
cd /opt/khohang-idosi
docker compose down
docker compose up -d db
sleep 10

# Restore from backup
BACKUP_FILE=/opt/backups/khohang-idosi/backup-YYYYMMDD-HHMMSS.dump
docker compose exec -T db pg_restore -U idosi -d idosi -c < $BACKUP_FILE

# Revert code
git checkout <previous-commit>
docker compose build
docker compose up -d

# Verify
docker compose ps
curl -k https://khoidosi.io.vn/ready
```

---

## 📞 SUPPORT & TROUBLESHOOTING

### Nếu migrations fail:
```bash
# Check migration logs
docker compose logs migrate

# Check database connection
docker compose exec db psql -U idosi -d idosi -c "SELECT version()"

# Check current migrations
docker compose exec db psql -U idosi -d idosi -c "SELECT * FROM migrations ORDER BY id DESC LIMIT 5"
```

### Nếu containers không healthy:
```bash
# Check logs
docker compose logs api --tail=100
docker compose logs worker --tail=100

# Restart specific container
docker compose restart api

# Check health command
docker inspect khohang-idosi-api-1 | grep -A 5 "Healthcheck"
```

### Nếu UI không load:
```bash
# Check web container
docker compose logs web

# Check Caddy
docker compose logs caddy

# Test direct to container
docker compose exec web wget -O- http://localhost:3000
```

---

## 📝 FILES CREATED

### Deployment Scripts:
- `deploy-vps.sh` - Automated deployment for VPS
- `deploy.sh` - General deployment script
- `verify-deployment.sh` - Post-deploy verification

### Documentation:
- `DEPLOYMENT.md` - Chi tiết deployment guide
- `DEPLOY-TO-PRODUCTION.sh` - Step-by-step commands
- `quick-deploy-commands.sh` - Quick reference
- `DEPLOYMENT-SUMMARY.md` - This file

### Code Files:
- Contracts: `packages/contracts/src/partner-receipts.ts`
- Database: `packages/database/src/partner-receipt-operations.ts`
- Migrations: `packages/database/migrations/0011_*.sql`, `0012_*.sql`
- API: `apps/api/src/app.ts`, `apps/api/src/postgres-repository.ts`
- UI: `apps/web/src/features/partner-receipts/*`

---

## ✅ READY TO DEPLOY

Tất cả code đã sẵn sàng. Để deploy:

1. **SSH vào VPS:** `ssh root@160.191.88.246`
2. **Navigate:** `cd /opt/khohang-idosi` (hoặc path của bạn)
3. **Pull code:** `git checkout feat/add-wholesale-account-role && git pull`
4. **Run script:** `chmod +x deploy-vps.sh && ./deploy-vps.sh`
5. **Verify:** `./verify-deployment.sh`
6. **Test:** Smoke tests như mô tả ở trên

**Estimated time:** 15-20 phút (bao gồm build images)

---

## 🎉 POST-DEPLOYMENT

Sau khi deploy thành công và verify:

1. **Monitor trong 30 phút:** `docker compose logs -f api worker`
2. **Test với users thật**
3. **Giữ backup 24 giờ:** `/opt/backups/khohang-idosi/backup-*.dump`
4. **Nếu ổn định:** Merge branch vào `main`
5. **Update documentation** nếu cần

---

**Deployment prepared by:** OpenCode AI  
**Date:** 2026-09-22  
**Branch:** feat/add-wholesale-account-role  
**Target:** khoidosi.io.vn (160.191.88.246)
