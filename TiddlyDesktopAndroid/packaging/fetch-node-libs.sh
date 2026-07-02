#!/usr/bin/env bash
#
# Download the Termux-built Node.js (arm64) + its shared-library deps and assemble
# app/src/main/jniLibs/arm64-v8a/ (git-ignored, so both CI and a fresh checkout need this).
#
# Versions are PINNED for reproducibility — bump them here when upgrading Node, and re-test on a
# real device (an ICU/OpenSSL soname-major change also needs LIB_SYMLINKS in NodeEnvironment.kt).
# See app/src/main/jniLibs/README.md.
set -euo pipefail

BASE="https://packages.termux.dev/apt/termux-main/pool/main"

# Pinned Termux package .deb paths (aarch64).
DEBS=(
	"n/nodejs/nodejs_26.3.1_aarch64.deb"
	"o/openssl/openssl_1:3.6.3_aarch64.deb"
	"c/c-ares/c-ares_1.34.6_aarch64.deb"
	"libi/libicu/libicu_78.3_aarch64.deb"
	"libs/libsqlite/libsqlite_3.53.3_aarch64.deb"
	"z/zlib/zlib_1.3.2_aarch64.deb"
	"libf/libffi/libffi_3.5.2_aarch64.deb"
	"libc/libc++/libc++_29_aarch64.deb"
)

# Unversioned sonames to place in jniLibs. Each is resolved to its REAL file inside the extracted
# packages via readlink -f (so this stays correct across point releases); node comes from usr/bin.
LIBS=(libz.so libssl.so libcrypto.so libcares.so libffi.so libc++_shared.so
      libicuuc.so libicui18n.so libicudata.so libsqlite3.so)

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # TiddlyDesktopAndroid
JNI="$HERE/app/src/main/jniLibs/arm64-v8a"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$JNI" "$TMP/x"
for d in "${DEBS[@]}"; do
	echo "↓ $(basename "$d")"
	curl -fsSL --retry 3 "$BASE/$d" -o "$TMP/$(basename "$d")"
	( cd "$TMP/x" && ar x "$TMP/$(basename "$d")" && tar xf data.tar.* && rm -f control.tar.* debian-binary data.tar.* )
done

L="$TMP/x/data/data/com.termux/files/usr/lib"
B="$TMP/x/data/data/com.termux/files/usr/bin"

cp "$B/node" "$JNI/libnode.so"                    # the node executable, renamed
for name in "${LIBS[@]}"; do
	real="$(readlink -f "$L/$name" 2>/dev/null || true)"
	[ -f "$real" ] || { echo "✗ could not resolve $name in the extracted packages" >&2; exit 1; }
	cp "$real" "$JNI/$name"
done
chmod 0755 "$JNI"/*.so

echo "✓ assembled $(ls "$JNI"/*.so | wc -l) libraries in $JNI"
if command -v readelf >/dev/null 2>&1; then
	for f in "$JNI"/*.so; do
		readelf -h "$f" | grep -q AArch64 || { echo "✗ $(basename "$f") is not AArch64" >&2; exit 1; }
	done
	echo "✓ all libraries verified AArch64"
fi
