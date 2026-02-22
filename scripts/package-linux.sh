#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SEMVER_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'
VERSION="${1:-$(bun run scripts/semver-version.ts)}"
if [[ ! "$VERSION" =~ $SEMVER_PATTERN ]]; then
  echo "Version must be semantic (MAJOR.MINOR.PATCH), got: $VERSION" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64)
    ARCH_LABEL="x64"
    ;;
  aarch64 | arm64)
    ARCH_LABEL="arm64"
    ;;
  *)
    echo "Unsupported Linux architecture: $ARCH" >&2
    exit 1
    ;;
esac

DIST_ROOT="$ROOT_DIR/dist/linux"
PACKAGE_NAME="rem-${VERSION}-linux-${ARCH_LABEL}"
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
cp scripts/install-linux.sh "$PACKAGE_DIR/install.sh"
printf '%s\n' "$VERSION" >"$PACKAGE_DIR/VERSION"
chmod +x "$PACKAGE_DIR/install.sh"

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

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE_PATH" >"$CHECKSUM_PATH"
else
  shasum -a 256 "$ARCHIVE_PATH" >"$CHECKSUM_PATH"
fi

printf 'Created package:\n- %s\n- %s\n' "$ARCHIVE_PATH" "$CHECKSUM_PATH"
