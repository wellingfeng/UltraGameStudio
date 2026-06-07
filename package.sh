#!/usr/bin/env bash
# FreeUltraCode Packager (macOS / Linux) — counterpart to run.sh.
# Builds DISTRIBUTABLE installers/bundles with Tauri (NOT just a launchable
# binary), then collects them into ./release for shipping.
#
#   ./package.sh            auto : bundle the right formats for THIS OS  [default]
#   ./package.sh dmg        macOS  : .app + .dmg disk image
#   ./package.sh deb        Linux  : .deb package
#   ./package.sh appimage   Linux  : .AppImage portable bundle
#   ./package.sh rpm        Linux  : .rpm package
#   ./package.sh all        every native format supported on this OS
#   ./package.sh --target X pass an explicit Tauri bundle target (advanced)
#   ./package.sh clean      remove previous build artifacts + ./release
#   ./package.sh --help     show this help
#
# Building requires Rust/cargo (https://rustup.rs); the script can install it for
# you on first run. The script still passes --bundles explicitly so each host
# produces the native formats expected for that OS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
TAURI_DIR="$APP_DIR/src-tauri"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle"
RELEASE_DIR="$SCRIPT_DIR/release"
EXE="$TAURI_DIR/target/release/FreeUltraCode"

c_ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m[..]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[X]\033[0m %s\n' "$*" >&2; }

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Read productName/version straight from tauri.conf.json (no jq dependency).
conf_value() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    "$TAURI_DIR/tauri.conf.json" | head -n 1
}
PRODUCT="$(conf_value productName)"; PRODUCT="${PRODUCT:-FreeUltraCode}"
VERSION="$(conf_value version)";     VERSION="${VERSION:-0.0.0}"

OS="$(uname -s)"
MODE="auto"
EXPLICIT_TARGET=""
case "${1:-}" in
  ""|auto)            MODE="auto" ;;
  dmg|--dmg)          MODE="dmg" ;;
  deb|--deb)          MODE="deb" ;;
  appimage|--appimage) MODE="appimage" ;;
  rpm|--rpm)          MODE="rpm" ;;
  all|--all)          MODE="all" ;;
  clean|--clean)      MODE="clean" ;;
  --target)
    MODE="explicit"
    EXPLICIT_TARGET="${2:-}"
    [ -n "$EXPLICIT_TARGET" ] || { c_err "--target needs a value (e.g. --target dmg)"; exit 2; }
    ;;
  -h|--help|help)     usage; exit 0 ;;
  *) c_err "unknown option: $1"; echo; usage; exit 2 ;;
esac

echo "============================================================"
echo "  FreeUltraCode Packager  (mode: $MODE)"
echo "  $PRODUCT v$VERSION  on  $OS"
echo "============================================================"

# ---- clean mode: wipe artifacts and exit early ----
if [ "$MODE" = "clean" ]; then
  c_info "removing $BUNDLE_DIR ..."
  rm -rf "$BUNDLE_DIR"
  c_info "removing $RELEASE_DIR ..."
  rm -rf "$RELEASE_DIR"
  c_ok "clean complete."
  exit 0
fi

# ---- pick the Tauri bundle targets for this run ----
# Tauri's --bundles takes a comma-separated list. We choose per host OS so
# explicit modes and CI logs stay deterministic across hosts.
choose_targets() {
  if [ -n "$EXPLICIT_TARGET" ]; then
    BUNDLES="$EXPLICIT_TARGET"
    return 0
  fi
  case "$OS" in
    Darwin)
      case "$MODE" in
        auto|all) BUNDLES="app,dmg" ;;
        dmg)      BUNDLES="dmg" ;;
        *) c_err "'$MODE' is not a macOS format. Use: dmg | all"; exit 2 ;;
      esac
      ;;
    Linux)
      case "$MODE" in
        auto)     BUNDLES="deb,appimage" ;;
        all)      BUNDLES="deb,appimage,rpm" ;;
        deb)      BUNDLES="deb" ;;
        appimage) BUNDLES="appimage" ;;
        rpm)      BUNDLES="rpm" ;;
        *) c_err "'$MODE' is not a Linux format. Use: deb | appimage | rpm | all"; exit 2 ;;
      esac
      ;;
    *)
      c_err "unsupported OS for this script: $OS (use run.bat / NSIS on Windows)"
      exit 1
      ;;
  esac
}
choose_targets
c_info "bundle targets: $BUNDLES"

# ---- Node.js / npm (frontend is built by Tauri's beforeBuildCommand) ----
require_node() {
  command -v node >/dev/null 2>&1 || { c_err "Node.js 20.19+ or 22.12+ not found: https://nodejs.org"; exit 1; }
  node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj===20&&min>=19)||maj>22||(maj===22&&min>=12)?0:1)" >/dev/null 2>&1 \
    || { c_err "Node.js $(node -v) is unsupported. Install Node.js 20.19+ or 22.12+."; exit 1; }
  c_ok "Node.js $(node -v)"
}
require_node
command -v npm  >/dev/null 2>&1 || { c_err "npm not found (ships with Node.js)"; exit 1; }
c_ok "npm $(npm -v)"

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

# ---- Rust toolchain (required to build the native bundle) ----
# Make a user-local rustup install visible even if the shell didn't load it yet.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" 2>/dev/null || true

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    c_ok "$(cargo -V)"
    return 0
  fi
  c_err "Rust/cargo not found — required to build the installer."
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
      c_err "Aborting. Install Rust from https://rustup.rs, then re-run."
      exit 1
      ;;
  esac
}

# Older checkouts pinned a Windows MSVC toolchain in rust-toolchain.toml. If
# present, override it on macOS/Linux so cargo uses this host's stable toolchain.
override_windows_toolchain() {
  [ "$OS" = "Darwin" ] || [ "$OS" = "Linux" ] || return 0
  grep -q 'pc-windows' "$TAURI_DIR/rust-toolchain.toml" 2>/dev/null || return 0
  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain list 2>/dev/null | grep -q '^stable' || {
      c_info "installing host stable toolchain (rustup toolchain install stable) ..."
      rustup toolchain install stable || { c_err "failed to install stable toolchain"; exit 1; }
    }
  fi
  export RUSTUP_TOOLCHAIN="stable"
  c_info "overriding Windows toolchain pin -> RUSTUP_TOOLCHAIN=stable (host)"
}

# Heads-up about slow first-time crate downloads. Advice only — we never touch
# the user's global cargo config.
hint_cargo_mirror() {
  [ -f "$HOME/.cargo/config.toml" ] && return 0
  [ -f "$HOME/.cargo/config" ] && return 0
  c_info "tip: the first build downloads many Rust crates. If it stalls on 'Fetch ... pending',"
  c_info "     a crates.io mirror can help. e.g. add to ~/.cargo/config.toml:"
  c_info "       [source.crates-io]"
  c_info "       replace-with = 'rsproxy'"
  c_info "       [source.rsproxy]"
  c_info "       registry = 'sparse+https://rsproxy.cn/index/'"
}

ensure_rust
override_windows_toolchain
ensure_deps
hint_cargo_mirror

# ---- build the distributable bundle(s) ----
# Tauri runs beforeBuildCommand (`npm run build`) to produce the frontend first,
# then compiles the release binary and packages it into each requested format.
c_info "building installer(s): tauri build --bundles $BUNDLES"
c_info "IMPORTANT: the FIRST build downloads + compiles 100+ Rust crates and can take"
c_info "           several minutes. Do NOT close this terminal until you see 'package done'."
echo "------------------------------------------------------------"
( cd "$APP_DIR" && npm run tauri -- build --bundles "$BUNDLES" ) \
  || { c_err "build failed — see errors above"; exit 1; }

[ -d "$BUNDLE_DIR" ] || { c_err "build finished but no bundle dir at $BUNDLE_DIR"; exit 1; }

# ---- collect artifacts into ./release ----
# Tauri scatters outputs under target/release/bundle/<format>/. Gather the
# shippable files (and the raw binary) into one flat, versioned folder.
mkdir -p "$RELEASE_DIR"
c_info "collecting artifacts into $RELEASE_DIR ..."

found=0
while IFS= read -r artifact; do
  cp -R "$artifact" "$RELEASE_DIR/" && { c_ok "collected: $(basename "$artifact")"; found=1; }
done < <(find "$BUNDLE_DIR" -maxdepth 2 -type f \
           \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \
              -o -name '*.rpm' -o -name '*.app.tar.gz' \) 2>/dev/null)

# Also copy the standalone binary as a convenience (rename with version).
if [ -f "$EXE" ]; then
  cp "$EXE" "$RELEASE_DIR/${PRODUCT}-${VERSION}-$(uname -m)" \
    && c_ok "collected: ${PRODUCT}-${VERSION}-$(uname -m) (raw binary)"
fi

if [ "$found" = "0" ]; then
  c_info "no installer files matched in $BUNDLE_DIR — listing bundle dir for reference:"
  find "$BUNDLE_DIR" -maxdepth 2 -type f -print 2>/dev/null | sed 's/^/    /' || true
fi

echo "------------------------------------------------------------"
c_ok "package done."
c_ok "artifacts in: $RELEASE_DIR"
ls -lh "$RELEASE_DIR" 2>/dev/null | sed 's/^/    /' || true
