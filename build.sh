#!/usr/bin/env bash
# FreeUltraCode (Build Installer) — macOS/Linux counterpart to build.bat.
# Mirrors build.bat: check prerequisites -> install deps -> tauri build ->
# print output paths -> open the output folder.
#
# On macOS/Linux we pass --bundles per host OS (dmg on macOS,
# deb+appimage on Linux) so the output is deterministic.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
TAURI_DIR="$APP_DIR/src-tauri"
REL_DIR="$TAURI_DIR/target/release"
BUNDLE_DIR="$REL_DIR/bundle"

c_ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m[..]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[X]\033[0m %s\n' "$*" >&2; }

pause() { printf 'Press Enter to continue...'; read -r _ || true; }

cd "$APP_DIR"

echo "============================================================"
echo "  FreeUltraCode  -  Package Installer  (tauri build)"
echo "============================================================"
echo

# ---- prerequisites ----
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" 2>/dev/null || true
command -v node  >/dev/null 2>&1 || { c_err "Node.js 20.19+ or 22.12+ not found: https://nodejs.org"; pause; exit 1; }
node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj===20&&min>=19)||maj>22||(maj===22&&min>=12)?0:1)" >/dev/null 2>&1 \
    || { c_err "Node.js $(node -v) is unsupported. Install Node.js 20.19+ or 22.12+."; pause; exit 1; }
command -v cargo >/dev/null 2>&1 || { c_err "Rust/cargo not found: https://rustup.rs"; pause; exit 1; }
c_ok "Node.js $(node -v)"
c_ok "$(cargo -V)"

# ---- install JS deps if missing ----
if [ ! -d node_modules ]; then
    c_info "installing dependencies ..."
    npm install || { c_err "npm install failed"; pause; exit 1; }
fi

# ---- choose bundle target for this host OS ----
OS="$(uname -s)"
case "$OS" in
    Darwin) BUNDLES="app,dmg" ;;
    Linux)  BUNDLES="deb,appimage" ;;
    *) c_err "unsupported OS: $OS (use build.bat on Windows)"; pause; exit 1 ;;
esac

# ---- override older Windows toolchain pins so cargo uses host stable ----
if grep -q 'pc-windows' "$TAURI_DIR/rust-toolchain.toml" 2>/dev/null; then
    if command -v rustup >/dev/null 2>&1; then
        rustup toolchain list 2>/dev/null | grep -q '^stable' || \
            rustup toolchain install stable || { c_err "failed to install stable toolchain"; pause; exit 1; }
    fi
    export RUSTUP_TOOLCHAIN="stable"
    c_info "overriding Windows toolchain pin -> RUSTUP_TOOLCHAIN=stable"
fi

echo
c_info "building frontend + compiling Rust + packaging installer ($BUNDLES) ..."
echo "      (first build downloads bundler tools and compiles crates;"
echo "       this can take several minutes)"
echo "============================================================"
echo

if ! npm run tauri -- build --bundles "$BUNDLES"; then
    echo
    c_err "build failed. See the log above."
    pause
    exit 1
fi

echo
echo "============================================================"
echo "  BUILD COMPLETE"
echo "============================================================"

# ---- list shippable artifacts ----
if [ -d "$BUNDLE_DIR" ]; then
    echo "  Bundles in: $BUNDLE_DIR"
    find "$BUNDLE_DIR" -maxdepth 2 -type f \
        \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \
           -o -name '*.rpm' -o -name '*.app.tar.gz' \) 2>/dev/null \
        | sed 's/^/    - /'
fi
if [ -d "$BUNDLE_DIR/macos" ]; then
    find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print 2>/dev/null \
        | sed 's/^/    - /'
fi
[ -f "$REL_DIR/FreeUltraCode" ] && \
    echo "  Standalone binary: $REL_DIR/FreeUltraCode"
echo "------------------------------------------------------------"
echo "  - On macOS: open the .dmg, drag FreeUltraCode into Applications."
echo "  - On Linux: install the .deb (sudo dpkg -i …) or run the .AppImage."
echo "------------------------------------------------------------"

# ---- open the output folder in the system file browser ----
open_dir() {
    local d="$1"
    [ -d "$d" ] || return 0
    if   command -v open     >/dev/null 2>&1; then open "$d" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$d" >/dev/null 2>&1 || true
    fi
}
[ -d "$BUNDLE_DIR" ] && open_dir "$BUNDLE_DIR"

echo
pause
