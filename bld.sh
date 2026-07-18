#!/bin/bash

# build TiddlyDesktop

# Remove any old build
rm -Rf output
rm -Rf source/tiddlywiki

# Install dependencies (tiddlywiki + ws)
npm install

# Copy ws WebSocket library into the source directory so NW.js can require() it
mkdir -p source/node_modules
cp -RH node_modules/ws source/node_modules/ws

# Copy TiddlyWiki core files into the source directory
cp -RH node_modules/tiddlywiki source/tiddlywiki

# Speed up Node boot: inject a persistent V8 compile cache into boot.js so module tiddlers are
# deserialized from cachedData instead of recompiled every launch (gated by TW_COMPILE_CACHE_DIR,
# set by the Android app; a no-op everywhere else). Fail-safe — falls back to plain compilation.
node bin/patch-boot-compile-cache.js source/tiddlywiki/boot/boot.js
# ...and cache loadPluginFolder's output (v8-serialized) so packed plugins — above all the 1.97 MB
# $:/core — aren't re-read/re-parsed/re-stringified every launch (gated by TW_STORE_CACHE_DIR).
node bin/patch-boot-store-cache.js source/tiddlywiki/boot/boot.js

# Add the /attachments/ range-capable server route (external attachments) to the bundled core-server
# plugin, mirroring core's /files/ route. Copied post-core-copy so pack-bundled-plugins captures it.
cp overrides/core-server/server/routes/get-attachments.js source/tiddlywiki/core-server/server/routes/

# Drop the demo/documentation editions the desktop never boots (~37 MB: tw5.com, geospatialdemo,
# tour, the language demo editions, …), keeping only the tiny starter editions. We keep "empty"
# and "server" so a "new wiki from edition" / `--init <edition>` path stays available (they total
# ~8 KB). To offer more editions (e.g. in the "Create new wiki" dropdown later), add their names
# to the keep-list below — they're always present in node_modules/tiddlywiki at build time.
find source/tiddlywiki/editions -mindepth 1 -maxdepth 1 ! -name empty ! -name server -exec rm -rf {} +

# Build the TiddlyDesktop WikiList translations, then create a BACKSTAGE-ONLY language set with those
# strings injected and priority bumped. The backstage wiki (main.js points its boot at
# languages-backstage) shows the wiki list in the active language. The shared source/tiddlywiki/
# languages stays clean so a language the PluginChooser installs into a user wiki — or a folder wiki
# resolves at runtime — carries no TiddlyDesktop strings and no priority override.
node translations/build-translations.js
cp -RH source/tiddlywiki/languages source/tiddlywiki/languages-backstage
for langdir in translations/*/ ; do
	lang=$(basename "$langdir")
	if [ -d "source/tiddlywiki/languages-backstage/$lang" ]; then
		cp "$langdir"TiddlyDesktop.multids "source/tiddlywiki/languages-backstage/$lang/" 2>/dev/null || true
		cp "$langdir"EmptyMessage.tid "source/tiddlywiki/languages-backstage/$lang/" 2>/dev/null || true
	fi
done
# Backstage languages win over the tiddlydesktop plugin's English defaults via plugin-priority 100
# (as the STRING "100"; a numeric value white-screens single-file wikis). The shared languages have
# any upstream priority (de-DE, zh-* ship 100) stripped so installed languages are never priority 100.
node translations/set-language-priority.js source/tiddlywiki/languages-backstage
node translations/strip-language-priority.js source/tiddlywiki/languages

# Copy TiddlyDesktop plugin into the source directory
cp -RH plugins/tiddlydesktop source/tiddlywiki/plugins/tiddlywiki

# Copy collaborative-editing NW.js transport plugin into the source directory
cp -RH plugins/codemirror-6-collab-nwjs source/tiddlywiki/plugins/tiddlywiki

# Stamp the collab plugin's auto-derived version (major.minor from its plugin.info, patch =
# git commit count of its source) into the BUNDLED copy, so a wiki can detect a newer bundled
# collab plugin without relying on a developer-side git hook. Needs full git history (CI uses
# fetch-depth: 0); falls back to the existing version if history is unavailable.
node bin/stamp-collab-version.js source/tiddlywiki/plugins/tiddlywiki/codemirror-6-collab-nwjs/plugin.info

# Copy TiddlyDesktop version number from package.json to the plugin.info of the plugin and the tiddler $:/plugins/tiddlywiki/tiddlydesktop/version
node propagate-version.js

# Collapse each bundled core/plugin/theme/language folder to plugin.info + a single contents.json.
# loadPluginFolder reads every file in a plugin folder, so booting the backstage wiki (core + 34
# languages + themes + plugins) otherwise opens ~3000 small files — on Windows each is scanned by
# Defender, stalling startup ~20s. Packing cuts that to a few dozen reads with an identical result.
# Runs last so the injected translations, priority-100 marker, stamped collab version and propagated
# version number are all captured in the pack.
node bin/pack-bundled-plugins.js source/tiddlywiki

# Calculate nw.js version

if [ $# -gt 0 ]; then
    NWJS_VERSION=$1
elif [ -z "$NWJS_VERSION" ]; then
    NWJS_VERSION=0.113.0
fi

TD_VERSION=$(./bin/get-version-number)

# Create the output directories

mkdir -p output
mkdir -p output/mac64
mkdir -p output/mac64-dev
mkdir -p output/macapplesilicon
mkdir -p output/macapplesilicon-dev
mkdir -p output/win32
mkdir -p output/win32-dev
mkdir -p output/win64
mkdir -p output/win64-dev
mkdir -p output/linuxarm64
mkdir -p output/linuxarm64-dev
mkdir -p output/linux64
mkdir -p output/linux64-dev

# Generic build functions (called twice per platform: once for non-SDK → plain output, once for SDK → -dev output)

# macOS (x64 or arm64)
#   $1 = nwjs source dir  $2 = output dir  $3 = version string  $4 = platform label (e.g. mac64)
build_macos() {
	local nwjs_src="$1" out_dir="$2" ver="$3" label="$4"
	local app_dir="$out_dir/TiddlyDesktop-${label}-v${ver}/TiddlyDesktop.app"
	cp -RH "$nwjs_src/nwjs.app" "$app_dir"
	cp -RH source "$app_dir/Contents/Resources/app.nw"
	cp icons/app.icns "$app_dir/Contents/Resources/nw.icns"
	cp Info.plist "$app_dir/Contents/Info.plist"
	# Rename the bundle executable to TiddlyDesktop (matches CFBundleExecutable) so the dock /
	# process / menu-bar name is TiddlyDesktop instead of nwjs.
	local mac_bin="$app_dir/Contents/MacOS"
	[ -e "$mac_bin/nwjs" ] && mv "$mac_bin/nwjs" "$mac_bin/TiddlyDesktop"
	for f in "$app_dir"/Contents/Resources/*.lproj; do
		cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings" 2>/dev/null || true
	done
	# Ad-hoc code-sign the bundle (free). Re-bundling invalidated NW.js's signature, and a
	# broken/unsigned app won't launch on Apple Silicon.
	command -v codesign >/dev/null 2>&1 && [ -e "$mac_bin/TiddlyDesktop" ] && codesign --force --deep --sign - "$app_dir" || true
}

# Windows (x64 or ia32)
#   $1 = nwjs source dir  $2 = output dir  $3 = version string  $4 = platform label (e.g. win64)
build_win() {
	local nwjs_src="$1" out_dir="$2" ver="$3" label="$4"
	local win_dir="$out_dir/TiddlyDesktop-${label}-v${ver}"
	mkdir -p "$win_dir"
	cp -RH "$nwjs_src"/* "$win_dir"
	cp -RH source/* "$win_dir"
	# Rename the executable and embed the TiddlyDesktop icon + version metadata so
	# Windows shows our icon in the taskbar, Start menu, Explorer and pinned shortcuts
	mv "$win_dir/nw.exe" "$win_dir/TiddlyDesktop.exe"
	node bin/set-win-icon.js "$win_dir/TiddlyDesktop.exe" icons/app.ico "$ver"
}

# Linux (x64 or arm64)
#   $1 = nwjs source dir  $2 = output dir  $3 = version string  $4 = platform label (e.g. linux64)
build_linux() {
	local nwjs_src="$1" out_dir="$2" ver="$3" label="$4"
	local linux_dir="$out_dir/TiddlyDesktop-${label}-v${ver}"
	mkdir -p "$linux_dir"
	cp -RH "$nwjs_src"/* "$linux_dir"
	cp -RH source/* "$linux_dir"
	# Rename the launcher binary to TiddlyDesktop (NW.js finds its resources by location, not name).
	[ -e "$linux_dir/nw" ] && mv "$linux_dir/nw" "$linux_dir/TiddlyDesktop"
}

# AppImage (Linux only, uses the non-SDK / production build)
#   $1 = output dir  $2 = version string  $3 = platform label (e.g. linux64)
build_linux_appimage() {
	local out_dir="$1" ver="$2" label="$3"
	local pkg_arch
	local appimagetool_arch
	local appdir="output/AppDir.${label}"

	sudo apt-get install -y fonts-dejavu-core fonts-dejavu-extra libnss3 libnspr4 libasound2-dev libatomic1 libatk1.0-0 libcups2-dev libxkbcommon-dev libatspi2.0-dev libxcomposite-dev libxdamage-dev libxfixes-dev libxrandr-dev libpango1.0-dev libgbm-dev libcairo2-dev libxi-dev libxrender-dev libwayland-dev libfribidi-dev libthai-dev libharfbuzz-dev libpng-dev libfontconfig-dev libfreetype-dev libpixman-1-dev libdatrie-dev libgraphite2-dev libbz2-dev fonts-dejavu curl findutils desktop-file-utils

	case "$label" in
		linuxarm64)
			pkg_arch="linuxarm64"
			appimagetool_arch="aarch64"
			curl -L https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-aarch64.AppImage -o output/appimagetool-${label}.AppImage
			;;
		linux64)
			pkg_arch="linux64"
			appimagetool_arch="x86_64"
			curl -L https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o output/appimagetool-${label}.AppImage
			;;
	esac

	chmod u+x "output/appimagetool-${label}.AppImage"
	mkdir -p "$appdir"
	mkdir -p "$appdir/usr/bin"
	mkdir -p "$appdir/usr/lib"
	mkdir -p "$appdir/usr/share/fonts/truetype/dejavu"
	cp icons/app-icon1024.png "$appdir/tiddlydesktop.png"
	cp linux/AppRun "$appdir/"
	cp linux/tiddlydesktop.desktop "$appdir/"
	cp -r "$out_dir/TiddlyDesktop-${pkg_arch}-v${ver}"/* "$appdir/usr/bin/"

	local libraries
	libraries=$(dpkg -L fonts-dejavu-core fonts-dejavu-extra libnss3 libnspr4 libasound2-dev libatomic1 libatk1.0-0 libcups2-dev libxkbcommon-dev libatspi2.0-dev libxcomposite-dev libxdamage-dev libxfixes-dev libxrandr-dev libpango1.0-dev libgbm-dev libcairo2-dev libxi-dev libxrender-dev libwayland-dev libfribidi-dev libthai-dev libharfbuzz-dev libpng-dev libfontconfig-dev libfreetype-dev libpixman-1-dev libdatrie-dev libgraphite2-dev libbz2-dev fonts-dejavu 2>/dev/null | grep "\.so" || true)
	for f in $libraries; do
		cp "$f"* "$appdir/usr/lib/"
	done

	dpkg -L fonts-dejavu-core fonts-dejavu-extra 2>/dev/null | grep "\.ttf" | xargs -I '{}' -- cp '{}' "$appdir/usr/share/fonts/truetype/dejavu/"
	local appimage_ver="$ver"
	ARCH="$appimagetool_arch" ./output/appimagetool-${label}.AppImage --no-appstream "$appdir" "output/tiddlydesktop-${pkg_arch}-v${appimage_ver}.AppImage"
}

# Build functions: called twice per platform — non-SDK (plain output) and SDK (-dev output)

# OS X 64-bit
build_mac64() {
	build_macos "nwjs/nwjs-v${NWJS_VERSION}-osx-x64" "output/mac64" "$TD_VERSION" "mac64"
}
build_mac64_dev() {
	build_macos "nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-x64" "output/mac64-dev" "$TD_VERSION" "mac64-dev"
}

# OS X Apple Silicon
build_macapplesilicon() {
	build_macos "nwjs/nwjs-v${NWJS_VERSION}-osx-arm64" "output/macapplesilicon" "$TD_VERSION" "macapplesilicon"
}
build_macapplesilicon_dev() {
	build_macos "nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-arm64" "output/macapplesilicon-dev" "$TD_VERSION" "macapplesilicon-dev"
}

# Windows 32-bit
build_win32() {
	build_win "nwjs/nwjs-v${NWJS_VERSION}-win-ia32" "output/win32" "$TD_VERSION" "win32"
}
build_win32_dev() {
	build_win "nwjs/nwjs-sdk-v${NWJS_VERSION}-win-ia32" "output/win32-dev" "$TD_VERSION" "win32-dev"
}

# Windows 64-bit
build_win64() {
	build_win "nwjs/nwjs-v${NWJS_VERSION}-win-x64" "output/win64" "$TD_VERSION" "win64"
}
build_win64_dev() {
	build_win "nwjs/nwjs-sdk-v${NWJS_VERSION}-win-x64" "output/win64-dev" "$TD_VERSION" "win64-dev"
}

# Linux ARM64
build_linuxarm64() {
	build_linux "nwjs/nwjs-v${NWJS_VERSION}-linux-arm64" "output/linuxarm64" "$TD_VERSION" "linuxarm64"
}
build_linuxarm64_dev() {
	build_linux "nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-arm64" "output/linuxarm64-dev" "$TD_VERSION" "linuxarm64-dev"
}

# Linux 64-bit
build_linux64() {
	build_linux "nwjs/nwjs-v${NWJS_VERSION}-linux-x64" "output/linux64" "$TD_VERSION" "linux64"
}
build_linux64_dev() {
	build_linux "nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-x64" "output/linux64-dev" "$TD_VERSION" "linux64-dev"
}

if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH variables supplied by the GitHub Actions script
	case "$PLATFORM-$ARCH" in
		osx-x64)
			build_mac64
			build_mac64_dev
			;;
		osx-arm64)
			build_macapplesilicon
			build_macapplesilicon_dev
			;;
		win-ia32)
			build_win32
			build_win32_dev
			;;
		win-x64)
			build_win64
			build_win64_dev
			;;
		linux-arm64)
			build_linuxarm64
			build_linuxarm64_dev
			build_linux_appimage "output/linuxarm64" "$TD_VERSION" "linuxarm64"
			;;
		linux-x64)
			build_linux64
			build_linux64_dev
			build_linux_appimage "output/linux64" "$TD_VERSION" "linux64"
			;;
	esac
else
    # Running at the command line, where each platfom builds one at a time in sequence
	build_mac64
	build_mac64_dev
	build_macapplesilicon
	build_macapplesilicon_dev
	build_win32
	build_win32_dev
	build_win64
	build_win64_dev
	build_linuxarm64
	build_linuxarm64_dev
	build_linux64
	build_linux64_dev
fi
