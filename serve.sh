#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Serving on http://localhost:${PORT}/ (Ctrl-C to stop)"
exec python3 -m http.server "${PORT}"
