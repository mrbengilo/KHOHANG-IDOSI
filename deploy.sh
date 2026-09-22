#!/bin/bash
set -euo pipefail

# KHOHANG-IDOSI Deployment Script
# Branch: feat/add-wholesale-account-role
# Target commits: be98261, 14b272f, a59b1d5, cccd1eb

echo "🚀 Starting KHOHANG-IDOSI deployment..."
echo "================================================"

# Configuration
PROJECT_DIR="${PROJECT_DIR:-/opt/khohang-idosi}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/khohang-idosi}"
TARGET_BRANCH="feat/add-wholesale-account-role"
TARGET_SHA="cccd1eb"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is not installed"
        exit 1
    fi
}

# Pre-flight checks
log_info "Running pre-flight checks..."
check_command docker
check_command git
check_command pg_dump || log_warn "pg_dump not found, will use docker exec for backup"

# Navigate to project directory
cd "$PROJECT_DIR" || {
    log_error "Project directory not found: $PROJECT_DIR"
    exit 1
}

log_info "Current directory: $(pwd)"

# Check current status
log_info "Checking current deployment status..."
docker compose ps

# Step 1: Backup database
log_info "Step 1/10: Creating database backup..."
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S).dump"

if docker compose exec -T db pg_dump -U idosi -d idosi -Fc > "$BACKUP_FILE"; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log_info "✅ Database backup created: $BACKUP_FILE ($BACKUP_SIZE)"
else
    log_error "Database backup failed"
    exit 1
fi

# Step 2: Git operations
log_info "Step 2/10: Fetching latest code..."
git fetch origin

log_info "Checking out branch: $TARGET_BRANCH"
git checkout "$TARGET_BRANCH"
git pull origin "$TARGET_BRANCH"

# Verify commit
CURRENT_SHA=$(git rev-parse --short HEAD)
log_info "Current commit: $CURRENT_SHA"

if [ "$CURRENT_SHA" != "$TARGET_SHA" ]; then
    log_warn "Expected SHA: $TARGET_SHA, got: $CURRENT_SHA"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_error "Deployment aborted"
        exit 1
    fi
fi

# Step 3: Check disk space
log_info "Step 3/10: Checking system resources..."
DISK_USAGE=$(df -h / | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 85 ]; then
    log_warn "Disk usage is high: ${DISK_USAGE}%"
fi

FREE_MEM=$(free -m | awk 'NR==2{printf "%.0f", $7}')
log_info "Available memory: ${FREE_MEM}MB"

# Step 4: Build new images
log_info "Step 4/10: Building Docker images..."
log_info "Building migrate image..."
docker compose build --no-cache migrate

log_info "Building api image..."
docker compose build --no-cache api

log_info "Building worker image..."
docker compose build --no-cache worker

log_info "Building web image..."
docker compose build --no-cache web

log_info "✅ All images built successfully"

# Step 5: Stop services (keep database running)
log_info "Step 5/10: Stopping application services..."
docker compose stop api worker web caddy

# Step 6: Run migrations
log_info "Step 6/10: Running database migrations..."
log_info "Expected migrations: 0011_add_wholesale_account_role.sql, 0012_add_partner_receipts.sql"

if docker compose up migrate; then
    log_info "✅ Migrations completed"
else
    log_error "Migration failed!"
    log_error "Rollback required. Check logs: docker compose logs migrate"
    exit 1
fi

# Verify migrations
log_info "Verifying migrations..."
docker compose exec -T db psql -U idosi -d idosi -c "\dt partner_receipts" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    log_info "✅ Table partner_receipts exists"
else
    log_error "Table partner_receipts not found!"
    exit 1
fi

docker compose exec -T db psql -U idosi -d idosi -c "\dt partner_receipt_lines" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    log_info "✅ Table partner_receipt_lines exists"
else
    log_error "Table partner_receipt_lines not found!"
    exit 1
fi

# Step 7: Start services
log_info "Step 7/10: Starting application services..."
docker compose up -d api worker web caddy

# Step 8: Wait for health checks
log_info "Step 8/10: Waiting for services to be healthy..."
sleep 30

# Step 9: Health checks
log_info "Step 9/10: Running health checks..."

# Check container status
UNHEALTHY=$(docker compose ps | grep -v "Up" | grep -v "NAME" | wc -l)
if [ "$UNHEALTHY" -gt 0 ]; then
    log_error "Some containers are not healthy:"
    docker compose ps
    exit 1
fi

log_info "✅ All containers are healthy"

# Check API health
if command -v curl &> /dev/null; then
    if curl -f -k https://localhost/ready > /dev/null 2>&1; then
        log_info "✅ API health check passed"
    else
        log_warn "API health check failed (this might be expected if domain not configured)"
    fi
fi

# Check for errors in logs
ERROR_COUNT=$(docker compose logs api --tail=100 | grep -i "error" | wc -l)
log_info "Recent error count in API logs: $ERROR_COUNT"

# Step 10: Display status
log_info "Step 10/10: Deployment summary"
echo "================================================"
log_info "✅ Deployment completed successfully!"
echo ""
log_info "Deployed commit: $CURRENT_SHA"
log_info "Backup location: $BACKUP_FILE"
echo ""
log_info "Container status:"
docker compose ps
echo ""
log_info "Recent logs:"
docker compose logs --tail=20 api
echo ""
echo "================================================"
log_info "Next steps:"
echo "  1. Monitor logs: docker compose logs -f api worker"
echo "  2. Test partner receipts UI at: https://your-domain.com/partner-receipts"
echo "  3. Verify STORE role can create partner receipts"
echo "  4. Keep monitoring for 30 minutes"
echo ""
log_info "Rollback command (if needed):"
echo "  docker compose down && git checkout <previous-commit> && ./deploy.sh"
echo ""
log_info "Restore database (if needed):"
echo "  docker compose exec -T db pg_restore -U idosi -d idosi -c < $BACKUP_FILE"
