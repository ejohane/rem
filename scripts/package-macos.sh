#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-$(git rev-parse --short=12 HEAD)}"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64)
    ARCH_LABEL="arm64"
    ;;
  x86_64)
    ARCH_LABEL="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

DIST_ROOT="$ROOT_DIR/dist/macos"
PACKAGE_NAME="rem-${VERSION}-macos-${ARCH_LABEL}"
PACKAGE_DIR="$DIST_ROOT/$PACKAGE_NAME"
ARCHIVE_PATH="$DIST_ROOT/${PACKAGE_NAME}.tar.gz"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

bun run --cwd apps/ui build

bun build --compile --outfile "$PACKAGE_DIR/rem" apps/cli/src/index.ts
bun build --compile --outfile "$PACKAGE_DIR/rem-api" apps/api/src/index.ts

cp -R apps/ui/dist "$PACKAGE_DIR/ui-dist"
cp README.md "$PACKAGE_DIR/README.md"

"$PACKAGE_DIR/rem" --help >/dev/null

API_LOG="$PACKAGE_DIR/rem-api-smoke.log"
REM_API_PORT=0 REM_UI_DIST="$PACKAGE_DIR/ui-dist" "$PACKAGE_DIR/rem-api" >"$API_LOG" 2>&1 &
API_PID=$!

sleep 2
if ! kill -0 "$API_PID" 2>/dev/null; then
  cat "$API_LOG" >&2 || true
  wait "$API_PID" || true
  echo "rem-api smoke test failed to start" >&2
  exit 1
fi

kill "$API_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true
rm -f "$API_LOG"

rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
(
  cd "$DIST_ROOT"
  tar -czf "$(basename "$ARCHIVE_PATH")" "$PACKAGE_NAME"
)

shasum -a 256 "$ARCHIVE_PATH" >"$CHECKSUM_PATH"

printf 'Created package:\n- %s\n- %s\n' "$ARCHIVE_PATH" "$CHECKSUM_PATH"
