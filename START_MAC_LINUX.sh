#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 18+ no esta instalado. https://nodejs.org/"
  exit 1
fi
MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$MAJOR" -lt 18 ]; then
  echo "ERROR: Se requiere Node.js 18+. Version actual: $(node -v)"
  exit 1
fi
[ -f .env ] || cp .env.example .env
node start.mjs
