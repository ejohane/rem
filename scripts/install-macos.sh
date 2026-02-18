#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

INSTALL_DIR="${REM_INSTALL_DIR:-/opt/rem}"
BIN_DIR="${REM_BIN_DIR:-/usr/local/bin}"
ALIAS_BLOCK_BEGIN="# >>> rem alias (managed by rem installer) >>>"
ALIAS_BLOCK_END="# <<< rem alias (managed by rem installer) <<<"

usage() {
  cat <<'EOF'
Install rem from an extracted macOS package directory.

Usage:
  ./install.sh [--install-dir <path>] [--bin-dir <path>] [--local]

Options:
  --install-dir <path>  Install binaries/assets into this directory.
                        Default: /opt/rem (or $REM_INSTALL_DIR)
  --bin-dir <path>      Write the launcher script to this directory.
                        Default: /usr/local/bin (or $REM_BIN_DIR)
  --local               Install without sudo into:
                        install dir: $HOME/.local/share/rem
                        bin dir:     $HOME/.local/bin
  -h, --help            Show this help message.
EOF
}

resolve_shell_home() {
  if [[ -n "${SUDO_USER:-}" ]]; then
    local sudo_home
    sudo_home="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    if [[ -n "$sudo_home" ]]; then
      printf '%s\n' "$sudo_home"
      return
    fi
  fi
  printf '%s\n' "$HOME"
}

configure_zsh_alias() {
  local launcher_path="$1"
  local shell_home
  local zshrc_path
  local tmp_file

  shell_home="$(resolve_shell_home)"
  zshrc_path="$shell_home/.zshrc"
  mkdir -p "$shell_home"
  touch "$zshrc_path"

  tmp_file="$(mktemp)"
  sed "/^$ALIAS_BLOCK_BEGIN$/,/^$ALIAS_BLOCK_END$/d" "$zshrc_path" >"$tmp_file"
  cat >>"$tmp_file" <<EOF

$ALIAS_BLOCK_BEGIN
alias rem='$launcher_path'
$ALIAS_BLOCK_END
EOF
  cat "$tmp_file" >"$zshrc_path"
  rm -f "$tmp_file"

  if [[ -n "${SUDO_USER:-}" ]]; then
    chown "$SUDO_USER" "$zshrc_path" 2>/dev/null || true
  fi

  printf 'Updated zsh alias in %s\n' "$zshrc_path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --install-dir" >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --bin-dir" >&2
        exit 1
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --local)
      INSTALL_DIR="$HOME/.local/share/rem"
      BIN_DIR="$HOME/.local/bin"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

for required in "rem" "rem-api" "ui-dist/index.html"; do
  if [[ ! -e "$PACKAGE_DIR/$required" ]]; then
    echo "Expected package file missing: $PACKAGE_DIR/$required" >&2
    exit 1
  fi
done

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

cp "$PACKAGE_DIR/rem" "$INSTALL_DIR/rem"
cp "$PACKAGE_DIR/rem-api" "$INSTALL_DIR/rem-api"
rm -rf "$INSTALL_DIR/ui-dist"
cp -R "$PACKAGE_DIR/ui-dist" "$INSTALL_DIR/ui-dist"
if [[ -f "$PACKAGE_DIR/README.md" ]]; then
  cp "$PACKAGE_DIR/README.md" "$INSTALL_DIR/README.md"
fi

chmod +x "$INSTALL_DIR/rem" "$INSTALL_DIR/rem-api"

LAUNCHER_PATH="$BIN_DIR/rem"
cat >"$LAUNCHER_PATH" <<EOF
#!/bin/sh
export REM_API_BINARY="$INSTALL_DIR/rem-api"
export REM_UI_DIST="$INSTALL_DIR/ui-dist"
exec "$INSTALL_DIR/rem" "\$@"
EOF
chmod +x "$LAUNCHER_PATH"

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
  xattr -d com.apple.quarantine "$LAUNCHER_PATH" 2>/dev/null || true
fi

configure_zsh_alias "$LAUNCHER_PATH"

printf 'Installed rem:\n- install dir: %s\n- launcher: %s\n\n' "$INSTALL_DIR" "$LAUNCHER_PATH"
printf 'Run: %s app\n' "$LAUNCHER_PATH"
