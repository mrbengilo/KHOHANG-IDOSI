#!/bin/bash
set -euo pipefail

# Automated deployment script for khoidosi.io.vn
# Run this on VPS: 160.191.88.246

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   KHOHANG-IDOSI AUTOMATED DEPLOYMENT                           ║"
echo "║   VPS: 160.191.88.246 (khoidosi.io.vn)                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[✓]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; }
log_step() { echo -e "${BLUE}[→]${NC} $1"; }

# Configuration - UPDATE THESE IF NEEDED
PROJECT_DIR="${PROJECT_DIR:-/opt/khohang-idosi}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/khohang-idosi}"
TARGET_BRANCH="feat/add-wholesale-account-role"
TARGET_SHA="0f0b921"
DOMAIN="khoidosi.io.vn"

# Pre-flight checks
log_step "Running pre-flight checks..."
if ! command -v docker &> /dev/null; then
    log_error "Docker not found!"
    exit 1
fi
if ! command -v git &> /dev/null; then
    log_error "Git not found!"
    exit 1
fi
log_info "Pre-flight checks passed"

# Navigate to project
log_step "Navigating to project directory..."
if [ ! -d "$PROJECT_DIR" ]; then
    log_error "Project directory not found: $PROJECT_DIR"
    log_warn "Please update PROJECT_DIR variable in this script"
    exit 1
fi
cd "$PROJECT_DIR"
log_info "Working directory: $(pwd)"

# Check current status
log_step "Checking current deployment status..."
docker compose ps

echo ""
read -p "Continue with deployment? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Deployment cancelled by user"
    exit 0
fi

# Step 1: Backup database
log_step "Step 1/10: Creating database backup..."
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S).dump"

if docker compose exec -T db pg_dump -U idosi -d idosi -Fc > "$BACKUP_FILE"; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log_info "Database backup created: $BACKUP_FILE ($BACKUP_SIZE)"
    echo "BACKUP_FILE=$BACKUP_FILE" > /tmp/khohang-deployment.env
else
    log_error "Database backup failed!"
    exit 1
fi

# Step 2: Git operations
log_step "Step 2/10: Fetching latest code..."
git fetch origin

log_step "Checking out branch: $TARGET_BRANCH"
git checkout "$TARGET_BRANCH"
git pull origin "$TARGET_BRANCH"

CURRENT_SHA=$(git rev-parse --short HEAD)
log_info "Current commit: $CURRENT_SHA"

if [ "$CURRENT_SHA" != "$TARGET_SHA" ]; then
    log_warn "Expected SHA: $TARGET_SHA, got: $CURRENT_SHA"
fi

git log --oneline -5

# Step 3: System resources check
log_step "Step 3/10: Checking system resources..."
DISK_USAGE=$(df -h / | tail -1 | awk '{print $5}' | sed 's/%//')
FREE_MEM=$(free -m | awk 'NR==2{printf "%.0f", $7}')
log_info "Disk usage: ${DISK_USAGE}%, Free memory: ${FREE_MEM}MB"

if [ "$DISK_USAGE" -gt 90 ]; then
    log_error "Disk usage too high: ${DISK_USAGE}%"
    exit 1
fi

# Step 4: Build images
log_step "Step 4/10: Building Docker images (this may take 5-10 minutes)..."

log_info "Building migrate..."
docker compose build --no-cache migrate

log_info "Building api..."
docker compose build --no-cache api

log_info "Building worker..."
docker compose build --no-cache worker

log_info "Building web..."
docker compose build --no-cache web

log_info "All images built successfully"

# Step 5: Stop services
log_step "Step 5/10: Stopping application services..."
docker compose stop api worker web caddy
log_info "Services stopped (database still running)"

# Step 6: Run migrations
log_step "Step 6/10: Running database migrations..."
log_warn "Expected migrations: 0011_add_wholesale_account_role, 0012_add_partner_receipts"

if docker compose up migrate; then
    log_info "Migrations completed"
else
    log_error "Migration failed!"
    log_error "Check logs: docker compose logs migrate"
    log_error "Backup available at: $BACKUP_FILE"
    exit 1
fi

# Step 7: Verify migrations
log_step "Step 7/10: Verifying migrations..."

if docker compose exec -T db psql -U idosi -d idosi -c "\dt partner_receipts" > /dev/null 2>&1; then
    log_info "✓ Table partner_receipts exists"
else
    log_error "✗ Table partner_receipts not found!"
    exit 1
fi

if docker compose exec -T db psql -U idosi -d idosi -c "\dt partner_receipt_lines" > /dev/null 2>&1; then
    log_info "✓ Table partner_receipt_lines exists"
else
    log_error "✗ Table partner_receipt_lines not found!"
    exit 1
fi

if docker compose exec -T db psql -U idosi -d idosi -tc "SELECT 'wholesale_account'::user_role" > /dev/null 2>&1; then
    log_info "✓ Enum wholesale_account exists"
else
    log_error "✗ Enum wholesale_account not found!"
    exit 1
fi

log_info "All migrations verified successfully"

# Step 8: Start services
log_step "Step 8/10: Starting application services..."
docker compose up -d api worker web caddy

log_info "Waiting 30 seconds for health checks..."
sleep 30

# Step 9: Health checks
log_step "Step 9/10: Running health checks..."

docker compose ps

# Check if all containers are up
UNHEALTHY=$(docker compose ps | grep -v "Up" | grep -v "NAME" | grep -v "^$" | wc -l)
if [ "$UNHEALTHY" -gt 0 ]; then
    log_error "Some containers are not healthy!"
    docker compose ps
    log_error "Check logs: docker compose logs api worker web"
    exit 1
fi

log_info "All containers are healthy"

# Test API endpoint
if command -v curl &> /dev/null; then
    if curl -f -k "https://$DOMAIN/ready" > /dev/null 2>&1; then
        log_info "API health endpoint: OK"
    else
        log_warn "API health endpoint check failed (might be expected if SSL not configured)"
    fi
fi

# Check error count
ERROR_COUNT=$(docker compose logs api --tail=100 | grep -i "error" | grep -v "404" | wc -l)
log_info "Recent error count: $ERROR_COUNT"

if [ "$ERROR_COUNT" -gt 10 ]; then
    log_warn "High error count detected!"
fi

# Step 10: Summary
log_step "Step 10/10: Deployment summary"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    ✅ DEPLOYMENT SUCCESSFUL                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
log_info "Deployed commit: $CURRENT_SHA"
log_info "Backup location: $BACKUP_FILE"
log_info "Domain: https://$DOMAIN"
echo ""
echo "Container status:"
docker compose ps
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 NEXT STEPS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Monitor logs:"
echo "   docker compose logs -f api worker"
echo ""
echo "2. Test partner receipts UI:"
echo "   https://$DOMAIN/partner-receipts"
echo ""
echo "3. Manual smoke tests:"
echo "   - Login as STORE role"
echo "   - Create partner receipt"
echo "   - Verify authorization (Admin/HTKD should not see menu)"
echo ""
echo "4. Monitor for 30 minutes"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔴 ROLLBACK (if needed):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "docker compose down"
echo "docker compose up -d db"
echo "sleep 10"
echo "docker compose exec -T db pg_restore -U idosi -d idosi -c < $BACKUP_FILE"
echo "git checkout <previous-commit>"
echo "docker compose build"
echo "docker compose up -d"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
log_info "Deployment completed at $(date)"
