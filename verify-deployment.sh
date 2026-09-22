#!/bin/bash
set -euo pipefail

# KHOHANG-IDOSI Post-Deployment Verification Script
# Kiểm tra hệ thống sau khi deploy

echo "🔍 Running post-deployment verification..."
echo "================================================"

PROJECT_DIR="${PROJECT_DIR:-/opt/khohang-idosi}"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
    local name="$1"
    local command="$2"
    
    echo -n "Checking $name... "
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}"
        ((PASS++))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        ((FAIL++))
        return 1
    fi
}

echo ""
echo "📦 Container Health Checks"
echo "================================================"

check "Database container" "docker compose ps db | grep -q 'Up'"
check "API container" "docker compose ps api | grep -q 'Up'"
check "Worker container" "docker compose ps worker | grep -q 'Up'"
check "Web container" "docker compose ps web | grep -q 'Up'"
check "Caddy container" "docker compose ps caddy | grep -q 'Up'"

echo ""
echo "🗄️  Database Schema Checks"
echo "================================================"

check "Table: partner_receipts" "docker compose exec -T db psql -U idosi -d idosi -c '\dt partner_receipts'"
check "Table: partner_receipt_lines" "docker compose exec -T db psql -U idosi -d idosi -c '\dt partner_receipt_lines'"
check "Enum: user_role has wholesale_account" "docker compose exec -T db psql -U idosi -d idosi -tc \"SELECT 'wholesale_account'::user_role\" | grep -q wholesale_account"

echo ""
echo "🔧 Migration Checks"
echo "================================================"

# Check if migrations were run
MIGRATION_11=$(docker compose exec -T db psql -U idosi -d idosi -tc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='users' AND column_name='role' AND data_type='USER-DEFINED'" | tr -d ' ')
MIGRATION_12=$(docker compose exec -T db psql -U idosi -d idosi -tc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='partner_receipts'" | tr -d ' ')

if [ "$MIGRATION_11" -gt 0 ]; then
    echo -e "${GREEN}✓ PASS${NC} Migration 0011 (wholesale_account role)"
    ((PASS++))
else
    echo -e "${RED}✗ FAIL${NC} Migration 0011 not applied"
    ((FAIL++))
fi

if [ "$MIGRATION_12" -gt 0 ]; then
    echo -e "${GREEN}✓ PASS${NC} Migration 0012 (partner_receipts tables)"
    ((PASS++))
else
    echo -e "${RED}✗ FAIL${NC} Migration 0012 not applied"
    ((FAIL++))
fi

echo ""
echo "📝 Application Logs Check"
echo "================================================"

# Check for critical errors in recent logs
API_ERRORS=$(docker compose logs api --tail=100 | grep -i "error" | grep -v "404" | wc -l)
WORKER_ERRORS=$(docker compose logs worker --tail=100 | grep -i "error" | wc -l)

echo "API error count (last 100 lines): $API_ERRORS"
echo "Worker error count (last 100 lines): $WORKER_ERRORS"

if [ "$API_ERRORS" -lt 5 ] && [ "$WORKER_ERRORS" -lt 5 ]; then
    echo -e "${GREEN}✓ PASS${NC} Error count acceptable"
    ((PASS++))
else
    echo -e "${YELLOW}⚠ WARN${NC} High error count detected"
fi

echo ""
echo "💾 Resource Usage"
echo "================================================"

docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

echo ""
echo "================================================"
echo "📊 Verification Summary"
echo "================================================"
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed!${NC}"
    echo ""
    echo "Next steps for manual testing:"
    echo "  1. Login as STORE role"
    echo "  2. Navigate to 'Nhập hàng đối tác'"
    echo "  3. Create a new partner receipt"
    echo "  4. Verify it appears in the list"
    echo "  5. Check authorization (Admin/HTKD should not see the menu)"
    exit 0
else
    echo -e "${RED}❌ Some checks failed!${NC}"
    echo ""
    echo "Troubleshooting steps:"
    echo "  1. Check logs: docker compose logs api worker"
    echo "  2. Check migrations: docker compose logs migrate"
    echo "  3. Verify database: docker compose exec db psql -U idosi -d idosi"
    exit 1
fi
