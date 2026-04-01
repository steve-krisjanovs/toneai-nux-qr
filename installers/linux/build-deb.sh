#!/bin/bash
set -e

VERSION=${1:-1.0.0}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
PKG_DIR="$SCRIPT_DIR/deb/tnqr_${VERSION}_amd64"

rm -rf "$PKG_DIR" && mkdir -p "$PKG_DIR/usr/local/bin" "$PKG_DIR/DEBIAN" "$DIST_DIR"

cp "$ROOT_DIR/tnqr-linux-x64" "$PKG_DIR/usr/local/bin/tnqr"
chmod +x "$PKG_DIR/usr/local/bin/tnqr"

cat > "$PKG_DIR/DEBIAN/control" << EOF
Package: toneai-nux-qr
Version: $VERSION
Section: sound
Priority: optional
Architecture: amd64
Maintainer: steve-krisjanovs
Description: AI-generated NUX MightyAmp QR tone presets
 Generate scannable NUX MightyAmp QR codes for any song or album
 using AI-powered tone matching with web search for per-recording
 gear research.
EOF

dpkg-deb --build "$PKG_DIR" "$DIST_DIR/tnqr_${VERSION}_amd64.deb"
echo "Built: $DIST_DIR/tnqr_${VERSION}_amd64.deb"
