#!/bin/bash
set -e

VERSION=${1:-1.0.0}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
RPM_BUILD="$SCRIPT_DIR/rpmbuild"

rm -rf "$RPM_BUILD" && mkdir -p "$RPM_BUILD"/{BUILD,RPMS,SOURCES,SPECS,SRPMS} "$DIST_DIR"

# Stage binary into SOURCES
mkdir -p "$RPM_BUILD/SOURCES/tnqr-$VERSION/usr/local/bin"
cp "$ROOT_DIR/tnqr-linux-x64" "$RPM_BUILD/SOURCES/tnqr-$VERSION/usr/local/bin/tnqr"
chmod +x "$RPM_BUILD/SOURCES/tnqr-$VERSION/usr/local/bin/tnqr"
cd "$RPM_BUILD/SOURCES" && tar czf "tnqr-$VERSION.tar.gz" "tnqr-$VERSION" && cd "$SCRIPT_DIR"

cat > "$RPM_BUILD/SPECS/tnqr.spec" << EOF
Name:           toneai-nux-qr
Version:        $VERSION
Release:        1
Summary:        AI-generated NUX MightyAmp QR tone presets
License:        MIT
URL:            https://github.com/steve-krisjanovs/toneai-nux-qr
Source0:        tnqr-%{version}.tar.gz

%description
Generate scannable NUX MightyAmp QR codes for any song or album
using AI-powered tone matching with web search for per-recording
gear research.

%prep
%setup -q

%install
mkdir -p %{buildroot}/usr/local/bin
cp usr/local/bin/tnqr %{buildroot}/usr/local/bin/tnqr
chmod +x %{buildroot}/usr/local/bin/tnqr

%files
/usr/local/bin/tnqr

%changelog
* $(date '+%a %b %d %Y') steve-krisjanovs <steve@innovia.ca> - $VERSION-1
- Release $VERSION
EOF

rpmbuild --define "_topdir $RPM_BUILD" -bb "$RPM_BUILD/SPECS/tnqr.spec"
cp "$RPM_BUILD/RPMS/x86_64/"*.rpm "$DIST_DIR/"
echo "Built: $DIST_DIR/toneai-nux-qr-$VERSION-1.x86_64.rpm"
