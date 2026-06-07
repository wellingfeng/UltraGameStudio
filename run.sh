#!/usr/bin/env bash
# FreeUltraCode Runner (macOS / Linux) — counterpart to run.bat.
# Builds the NATIVE desktop app with Tauri and launches it (same as run.bat),
# rather than opening a web page.
#
#   ./run.sh           auto : rebuild if sources changed, then launch the app  [default]
#   ./run.sh run       launch the existing built app only (no rebuild)
#   ./run.sh build     build only, do not launch
#   ./run.sh web       quick browser preview via Vite dev server (no Rust needed)
#   ./run.sh --help    show this help
#
# Building the native app requires Rust/cargo (https://rustup.rs); the script can
# install it for you on first run. The Vite `web` mode is only a fallback preview.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
TAURI_DIR="$APP_DIR/src-tauri"
# macOS/Linux native binary built by Tauri (no .exe suffix). Named via [[bin]] in Cargo.toml.
EXE="$TAURI_DIR/target/release/FreeUltraCode"
PORT=5173

c_ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m[..]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[X]\033[0m %s\n' "$*" >&2; }

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

MODE="auto"
case "${1:-}" in
  ""|auto)         MODE="auto" ;;
  run|--run)       MODE="run" ;;
  build|--build)   MODE="build" ;;
  web|--web|dev)   MODE="web" ;;
  -h|--help|help)  usage; exit 0 ;;
  *) c_err "unknown option: $1"; echo; usage; exit 2 ;;
esac

echo "============================================================"
echo "  FreeUltraCode Runner  (mode: $MODE)"
echo "============================================================"

# ---- Node.js / npm ----
require_node() {
  command -v node >/dev/null 2>&1 || { c_err "Node.js 20.19+ or 22.12+ not found: https://nodejs.org"; exit 1; }
  node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj===20&&min>=19)||maj>22||(maj===22&&min>=12)?0:1)" >/dev/null 2>&1 \
    || { c_err "Node.js $(node -v) is unsupported. Install Node.js 20.19+ or 22.12+."; exit 1; }
  c_ok "Node.js $(node -v)"
}
require_node
command -v npm  >/dev/null 2>&1 || { c_err "npm not found (ships with Node.js)"; exit 1; }
c_ok "npm $(npm -v)"

# ---- web fallback: quick browser preview, no Rust needed ----
ensure_deps() {
  cd "$APP_DIR"
  if [ ! -d node_modules ]; then
    c_info "installing dependencies (npm install) ..."
    npm install || { c_err "npm install failed"; exit 1; }
    c_ok "dependencies installed"
  else
    c_ok "dependencies present"
  fi
}

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

if [ "$MODE" = "web" ]; then
  ensure_deps
  c_info "starting Vite dev server (browser preview) on http://localhost:$PORT ..."
  c_info "NOTE: this is a WEB preview, not the native app. Use './run.sh' for the real desktop app."
  echo "------------------------------------------------------------"
  ( for _ in $(seq 1 600); do curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && { open_browser "http://localhost:$PORT/"; break; }; sleep 1; done ) &
  exec npm run dev
fi

# ---- native modes (auto / run / build) need Rust ----
# Make a user-local rustup install visible even if the shell didn't load it yet.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" 2>/dev/null || true

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    c_ok "$(cargo -V)"
    return 0
  fi
  c_err "Rust/cargo not found — required to build the native desktop app."
  printf '    Install it now with rustup? [y/N] '
  read -r ans
  case "$ans" in
    y|Y|yes|YES)
      command -v curl >/dev/null 2>&1 || { c_err "curl not found; install Rust manually: https://rustup.rs"; exit 1; }
      c_info "installing Rust via rustup (https://rustup.rs) ..."
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || { c_err "rustup install failed"; exit 1; }
      . "$HOME/.cargo/env" 2>/dev/null || true
      command -v cargo >/dev/null 2>&1 || { c_err "cargo still not on PATH; open a new terminal and re-run."; exit 1; }
      c_ok "$(cargo -V)"
      ;;
    *)
      c_err "Aborting. Install Rust from https://rustup.rs, then re-run. (Or './run.sh web' for a browser preview.)"
      exit 1
      ;;
  esac
}

# Older checkouts pinned a Windows MSVC toolchain in rust-toolchain.toml. If
# present, override it on macOS/Linux so cargo uses this host's stable toolchain.
override_windows_toolchain() {
  local os
  os="$(uname -s)"
  [ "$os" = "Darwin" ] || [ "$os" = "Linux" ] || return 0   # only needed off-Windows
  grep -q 'pc-windows' "$TAURI_DIR/rust-toolchain.toml" 2>/dev/null || return 0
  # `stable` (bare) lets rustup resolve the correct host triple and auto-install.
  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain list 2>/dev/null | grep -q '^stable' || {
      c_info "installing host stable toolchain (rustup toolchain install stable) ..."
      rustup toolchain install stable || { c_err "failed to install stable toolchain"; exit 1; }
    }
  fi
  export RUSTUP_TOOLCHAIN="stable"
  c_info "overriding Windows toolchain pin -> RUSTUP_TOOLCHAIN=stable (host)"
}

# Decide whether a rebuild is needed (mirrors needs-rebuild.ps1):
# rebuild if the binary is missing, or any source/config file is newer than it.
sources_newer_than_exe() {
  [ -f "$EXE" ] || return 0   # no binary yet -> needs build
  local newer
  newer="$(find "$APP_DIR/src" "$TAURI_DIR/src" \
              "$APP_DIR/index.html" "$APP_DIR/vite.config.ts" \
              "$APP_DIR/tailwind.config.ts" "$TAURI_DIR/tauri.conf.json" \
              "$TAURI_DIR/tauri.macos.conf.json" "$TAURI_DIR/tauri.linux.conf.json" \
              "$TAURI_DIR/Cargo.toml" "$TAURI_DIR/rust-toolchain.toml" \
              "$TAURI_DIR/capabilities/default.json" \
              -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.rs' \
                         -o -name '*.css' -o -name '*.html' -o -name '*.json' \
                         -o -name '*.toml' \) \
              -newer "$EXE" -print 2>/dev/null | head -n 1)"
  [ -n "$newer" ]
}

# Decide whether we need to build, before requiring Rust — so `run` with an
# already-built binary launches without cargo, just like run.bat /run.
NEED_BUILD=0
case "$MODE" in
  build) NEED_BUILD=1 ;;
  run)
    [ -f "$EXE" ] || { c_err "no built app found at $EXE — run './run.sh build' first."; exit 1; }
    ;;
  auto)
    if [ ! -f "$EXE" ]; then
      c_info "no built app yet — first build required."
      NEED_BUILD=1
    elif sources_newer_than_exe; then
      c_info "sources newer than the app — will rebuild."
      NEED_BUILD=1
    else
      c_ok "app up to date — skip build."
    fi
    ;;
esac

# Rust + JS deps are only needed when we actually build.
if [ "$NEED_BUILD" = "1" ]; then
  ensure_rust
  override_windows_toolchain
  ensure_deps
fi

# Stop a running instance before rebuilding (mirrors stop-running-exe.ps1).
stop_running_app() {
  command -v pkill >/dev/null 2>&1 || return 0
  if pkill -x FreeUltraCode >/dev/null 2>&1; then
    c_info "closing running FreeUltraCode before rebuild ..."
    sleep 1
  fi
}

# Heads-up about slow first-time crate downloads (common in mainland China when
# no crates.io mirror is configured). We only advise — we don't touch the user's
# global cargo config.
hint_cargo_mirror() {
  [ -f "$HOME/.cargo/config.toml" ] && return 0
  [ -f "$HOME/.cargo/config" ] && return 0
  c_info "tip: first build downloads many Rust crates. If it stalls on 'Fetch ... pending',"
  c_info "     a crates.io mirror can help. e.g. add to ~/.cargo/config.toml:"
  c_info "       [source.crates-io]"
  c_info "       replace-with = 'rsproxy'"
  c_info "       [source.rsproxy]"
  c_info "       registry = 'sparse+https://rsproxy.cn/index/'"
}

# Build the native release binary via the official Tauri flow, skipping the
# bundler for speed. `--no-bundle` compiles just the launchable binary (Tauri
# still runs beforeBuildCommand `npm run build` to produce the frontend).
# This is the macOS/Linux equivalent of FreeUltraCode.exe on Windows.
build_native() {
  stop_running_app
  hint_cargo_mirror
  c_info "building app (tauri build --no-bundle) ..."
  c_info "IMPORTANT: the FIRST build downloads + compiles 100+ Rust crates and can take"
  c_info "           several minutes. Do NOT close this terminal until you see 'build done'."
  echo "------------------------------------------------------------"
  ( cd "$APP_DIR" && npm run tauri -- build --no-bundle ) || { c_err "build failed — see errors above"; exit 1; }
  [ -f "$EXE" ] || { c_err "build finished but binary not found at $EXE"; exit 1; }
  c_ok "build done: $EXE"
}

launch_native() {
  [ -f "$EXE" ] || { c_err "binary not found: $EXE"; exit 1; }
  c_info "launching FreeUltraCode ..."
  # Detach so closing the terminal won't kill the app window.
  ( "$EXE" >/dev/null 2>&1 & )
  c_ok "FreeUltraCode launched in its own window. You can close this terminal."
}

[ "$NEED_BUILD" = "1" ] && build_native

case "$MODE" in
  build) c_ok "build complete (not launched)." ;;
  run|auto) launch_native ;;
esac
