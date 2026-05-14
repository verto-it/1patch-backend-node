#!/usr/bin/env bash
# setup-backend-node.sh — Write .env for a 1Patch backend node on Linux.
# Run inside the 1patch-backend-node directory.
#
# Prerequisites:
#   - Management server must be running
#   - Node enrollment token from the management dashboard (24-hour TTL, single-use)
#
# Usage:
#   ./scripts/setup-backend-node.sh \
#     --mgmt-url    "https://manage.1patch.local:4100" \
#     --node-id     "<uuid from management dashboard>" \
#     --token       "<enrollment token>" \
#     --public-url  "https://node-1.1patch.local:4200" \
#     --dragonfly   "redis://localhost:6380"

set -euo pipefail

MANAGEMENT_URL=""
NODE_ID=""
NODE_ENROLLMENT_TOKEN=""
NODE_PUBLIC_URL=""
DRAGONFLY_URL="redis://localhost:6380"
CORS_ALLOWED_ORIGINS=""
REGISTER_NOW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mgmt-url)   MANAGEMENT_URL="$2";          shift 2 ;;
    --node-id)    NODE_ID="$2";                 shift 2 ;;
    --token)      NODE_ENROLLMENT_TOKEN="$2";   shift 2 ;;
    --public-url) NODE_PUBLIC_URL="$2";         shift 2 ;;
    --dragonfly)  DRAGONFLY_URL="$2";           shift 2 ;;
    --cors)       CORS_ALLOWED_ORIGINS="$2";    shift 2 ;;
    --register-now) REGISTER_NOW=true;          shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
die()  { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

[[ -z "$MANAGEMENT_URL"       ]] && die "--mgmt-url is required"
[[ -z "$NODE_ID"              ]] && die "--node-id is required"
[[ -z "$NODE_ENROLLMENT_TOKEN" ]] && die "--token is required"
[[ -z "$NODE_PUBLIC_URL"      ]] && die "--public-url is required"

# ── write .env ────────────────────────────────────────────────────────────────

cat > .env <<EOF
PORT=4200
NODE_ID=${NODE_ID}
NODE_ENROLLMENT_TOKEN=${NODE_ENROLLMENT_TOKEN}
NODE_PUBLIC_URL=${NODE_PUBLIC_URL}
MANAGEMENT_URL=${MANAGEMENT_URL}
TENANT_ID=default
DRAGONFLY_URL=${DRAGONFLY_URL}
CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}
# Written automatically by the node after first successful registration.
# Do not set manually.
NODE_DECOMMISSION_TOKEN_HASH=
EOF

echo ""
echo -e "${GREEN}=== Backend node setup complete ===${NC}"
echo ""
ok ".env written"
echo "  Node ID:      $NODE_ID"
echo "  Management:   $MANAGEMENT_URL"
echo "  Public URL:   $NODE_PUBLIC_URL"
echo "  DragonflyDB:  $DRAGONFLY_URL"
echo ""
echo -e "${CYAN}Authentication: mTLS only.${NC}"
echo "On first start the node registers with management using the enrollment token,"
echo "receives a Vault-issued EC P-256 certificate (24 h TTL), and uses it for all"
echo "subsequent calls. No shared secrets remain after initial enrollment."
echo ""

if [[ "$REGISTER_NOW" == "true" ]]; then
  echo -e "${CYAN}Registering node with management server...${NC}"
  HTTP_STATUS=$(curl -s -o /tmp/node-register-resp.json -w "%{http_code}" \
    -X POST "${MANAGEMENT_URL%/}/nodes/register" \
    -H "Content-Type: application/json" \
    -d "{\"nodeId\":\"${NODE_ID}\",\"enrollmentToken\":\"${NODE_ENROLLMENT_TOKEN}\",\"version\":\"0.1.0\",\"capacity\":{\"packageCache\":\"local\"}}" || true)
  if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "201" ]]; then
    ok "Node registered — mTLS certificate will be saved to ./tls/ on first npm start"
  else
    warn "Registration returned HTTP $HTTP_STATUS — the node will retry automatically on first start"
  fi
else
  echo -e "${CYAN}Next: npm install && npm run build && npm start${NC}"
  echo "The node will register with management and receive its mTLS certificate automatically."
fi
