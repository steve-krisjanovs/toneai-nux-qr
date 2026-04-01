#!/bin/bash
set -e

VERSION=${1:-1.0.0}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
PKG_ROOT="$SCRIPT_DIR/pkgroot"

rm -rf "$PKG_ROOT" "$DIST_DIR"
mkdir -p "$PKG_ROOT/usr/local/bin" "$DIST_DIR"

# Copy both architectures — user runs whichever matches their Mac
cp "$ROOT_DIR/tnqr-mac-arm64" "$PKG_ROOT/usr/local/bin/tnqr-arm64"
cp "$ROOT_DIR/tnqr-mac-x64"   "$PKG_ROOT/usr/local/bin/tnqr-x64"
chmod +x "$PKG_ROOT/usr/local/bin/tnqr-arm64"
chmod +x "$PKG_ROOT/usr/local/bin/tnqr-x64"

# Wrapper script that picks the right arch at runtime
cat > "$PKG_ROOT/usr/local/bin/tnqr" << 'EOF'
#!/bin/bash
ARCH=$(uname -m)
DIR="$(dirname "$(readlink -f "$0")")"
if [ "$ARCH" = "arm64" ]; then
  exec "$DIR/tnqr-arm64" "$@"
else
  exec "$DIR/tnqr-x64" "$@"
fi
EOF
chmod +x "$PKG_ROOT/usr/local/bin/tnqr"

# Build the .pkg
pkgbuild \
  --root "$PKG_ROOT" \
  --identifier "com.steve-krisjanovs.toneai-nux-qr" \
  --version "$VERSION" \
  --install-location "/" \
  "$DIST_DIR/tnqr-$VERSION-macos.pkg"

echo "Built: $DIST_DIR/tnqr-$VERSION-macos.pkg"
