#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://localhost:8080}"

echo "=== LexFlow Docker smoke test ==="
echo "Target: $BASE"
echo

# Health check
echo "1. GET /health"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
if [ "$STATUS" = "200" ]; then
  echo "   PASS  (HTTP $STATUS)"
else
  echo "   FAIL  (HTTP $STATUS)"
  exit 1
fi

# Frontend index
echo "2. GET / (frontend)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
if [ "$STATUS" = "200" ]; then
  echo "   PASS  (HTTP $STATUS)"
else
  echo "   FAIL  (HTTP $STATUS)"
  exit 1
fi

echo
echo "=== Automated checks passed ==="
echo
echo "Manual smoke checklist:"
echo "  - Open $BASE in a browser"
echo "  - Log in with the seed admin credentials"
echo "  - Verify the matter list loads"
echo "  - Create a test matter and confirm it persists after page reload"
echo "  - Run a backup inside the API container:"
echo "    docker compose exec lexflow-api node scripts/backup.js"
