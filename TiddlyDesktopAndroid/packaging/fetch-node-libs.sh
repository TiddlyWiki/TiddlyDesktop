#!/usr/bin/env bash
#
# Download the Termux-built Node.js (arm64) + its shared-library deps and assemble
# app/src/main/jniLibs/arm64-v8a/ (git-ignored, so both CI and a fresh checkout need this).
#
# Versions are PINNED for reproducibility — bump them here when upgrading Node, and re-test on a
# real device (an ICU/OpenSSL soname-major change also needs LIB_SYMLINKS in NodeEnvironment.kt).
# See app/src/main/jniLibs/README.md.
set -euo pipefail

BASE="https://packages.termux.dev/apt/termux-main"
INDEX="$BASE/dists/stable/main/binary-aarch64/Packages.gz"

# Termux keeps ONLY the current version of each package in its pool — a hard-pinned .deb URL
# eventually 404s when the package is bumped (that's what breaks CI). So we resolve each
# package's CURRENT .deb filename from the repo index at build time instead of pinning the URL.
#
# The versions below are the ones this app was last TESTED against; they are used only to WARN
# when the repo has drifted, so a soname-major change (ICU/OpenSSL/libc++) that needs LIB_SYMLINKS
# updated in NodeEnvironment.kt — or a Node bump that needs a device re-test — is surfaced loudly.
# The build itself always downloads whatever is current, so it can't 404. See jniLibs/README.md.
PACKAGES=(nodejs openssl c-ares libicu libsqlite zlib libffi "libc++")
declare -A TESTED=(
	[nodejs]="26.3.1"
	[openssl]="1:3.6.3"
	[c-ares]="1.34.8"
	[libicu]="78.3"
	[libsqlite]="3.53.3"
	[zlib]="1.3.2"
	[libffi]="3.5.2"
	[libc++]="29"
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

# Fetch the aarch64 package index once, then look up each package's current Version + Filename.
echo "↓ package index"
curl -fsSL --retry 3 "$INDEX" | gzip -dc > "$TMP/Packages"

for pkg in "${PACKAGES[@]}"; do
	# Parse the package's stanza: capture Version, emit "<version> <filename>" at its Filename line.
	read -r ver file < <(awk -v p="$pkg" '
		$1=="Package:"{cur=($2==p); v=""}
		cur&&$1=="Version:"{v=$2}
		cur&&$1=="Filename:"{print v, $2; exit}' "$TMP/Packages")
	[ -n "$file" ] || { echo "✗ '$pkg' not found in the Termux aarch64 index" >&2; exit 1; }
	want="${TESTED[$pkg]}"
	if [ "$ver" != "$want" ]; then
		echo "⚠ $pkg: repo has $ver, last tested $want — re-test on device" \
		     "(a soname-major change also needs LIB_SYMLINKS in NodeEnvironment.kt)"
	fi
	echo "↓ $(basename "$file")  ($ver)"
	curl -fsSL --retry 3 "$BASE/$file" -o "$TMP/$(basename "$file")"
	( cd "$TMP/x" && ar x "$TMP/$(basename "$file")" && tar xf data.tar.* && rm -f control.tar.* debian-binary data.tar.* )
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
