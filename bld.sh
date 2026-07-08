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

# Create the output directories
mkdir -p output
mkdir -p output/mac64
mkdir -p output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)
mkdir -p output/macapplesilicon
mkdir -p output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)
mkdir -p output/win32
mkdir -p output/win32/TiddlyDesktop-win32-v$(./bin/get-version-number)
mkdir -p output/win64
mkdir -p output/win64/TiddlyDesktop-win64-v$(./bin/get-version-number)
mkdir -p output/linuxarm64
mkdir -p output/linuxarm64/TiddlyDesktop-linuxarm64-v$(./bin/get-version-number)
mkdir -p output/linux64
mkdir -p output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)

# For each platform, copy the stock nw.js binaries overlaying the "source" directory (and icons and plist for the Mac)

# Calculate nw.js version

if [ $# -gt 0 ]; then
    NWJS_VERSION=$1
elif [ -z "$NWJS_VERSION" ]; then
    NWJS_VERSION=0.112.0
fi

# Build function definitions (which will be called at the end of the script)

# OS X 64-bit App
build_mac64() {

cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-x64/nwjs.app output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app
cp -RH source output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/app.nw
cp icons/app.icns output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/nw.icns
cp Info.plist output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Info.plist
# Rename the bundle executable to TiddlyDesktop (matches CFBundleExecutable) so the dock /
# process / menu-bar name is TiddlyDesktop instead of nwjs. Skipped if the nwjs SDK for this
# platform wasn't downloaded (the copy above is then a no-op).
MAC64_BIN="output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/MacOS"
[ -e "$MAC64_BIN/nwjs" ] && mv "$MAC64_BIN/nwjs" "$MAC64_BIN/TiddlyDesktop"

for f in output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/*.lproj
do
	cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings"
done

# Ad-hoc code-sign the bundle (free). Re-bundling (renaming the executable, injecting app.nw)
# invalidated NW.js's signature, and a broken/unsigned app won't launch on Apple Silicon.
# Ad-hoc signing makes it run; it does NOT satisfy Gatekeeper/notarization (those need the paid
# Apple Developer ID), so users still bypass once — see the readme. `--deep` signs the nested
# NW.js frameworks/helpers. Skipped where codesign is unavailable (non-macOS build hosts).
MAC64_APP="output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app"
command -v codesign >/dev/null 2>&1 && [ -e "$MAC64_APP/Contents/MacOS/TiddlyDesktop" ] && codesign --force --deep --sign - "$MAC64_APP" || true

}

# OS X Apple Silicon App
build_macapplesilicon() {

cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-arm64/nwjs.app output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app
cp -RH source output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/app.nw
cp icons/app.icns output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/nw.icns
cp Info.plist output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Info.plist
# Rename the bundle executable to TiddlyDesktop (matches CFBundleExecutable). Skipped if the
# nwjs SDK for this platform wasn't downloaded.
MACARM_BIN="output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/MacOS"
[ -e "$MACARM_BIN/nwjs" ] && mv "$MACARM_BIN/nwjs" "$MACARM_BIN/TiddlyDesktop"

for f in output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/*.lproj
do
	cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings"
done

xattr -c output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app

# Ad-hoc code-sign AFTER xattr -c (which would otherwise strip the signature). Mandatory for
# Apple Silicon to launch at all; free, but not Gatekeeper/notarization (paid) — see the readme.
MACARM_APP="output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app"
command -v codesign >/dev/null 2>&1 && [ -e "$MACARM_APP/Contents/MacOS/TiddlyDesktop" ] && codesign --force --deep --sign - "$MACARM_APP" || true

}

# Windows 64-bit App
build_win64() {
WIN64_DIR="output/win64/TiddlyDesktop-win64-v$(./bin/get-version-number)"
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-win-x64/* "$WIN64_DIR"
cp -RH source/* "$WIN64_DIR"
# Rename the executable and embed the TiddlyDesktop icon + version metadata so
# Windows shows our icon in the taskbar, Start menu, Explorer and pinned shortcuts
mv "$WIN64_DIR/nw.exe" "$WIN64_DIR/TiddlyDesktop.exe"
node bin/set-win-icon.js "$WIN64_DIR/TiddlyDesktop.exe" icons/app.ico $(./bin/get-version-number)
}

# # Windows 32-bit App
build_win32() {
WIN32_DIR="output/win32/TiddlyDesktop-win32-v$(./bin/get-version-number)"
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-win-ia32/* "$WIN32_DIR"
cp -RH source/* "$WIN32_DIR"
# Rename the executable and embed the TiddlyDesktop icon + version metadata so
# Windows shows our icon in the taskbar, Start menu, Explorer and pinned shortcuts
mv "$WIN32_DIR/nw.exe" "$WIN32_DIR/TiddlyDesktop.exe"
node bin/set-win-icon.js "$WIN32_DIR/TiddlyDesktop.exe" icons/app.ico $(./bin/get-version-number)
}

# # Linux 64-bit App
build_linux64() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-x64/* output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)
cp -RH source/* output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)
# Rename the launcher binary to TiddlyDesktop (NW.js finds its resources by location, not
# name). Skipped if the nwjs SDK for this platform wasn't downloaded.
LINUX64_DIR="output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)"
[ -e "$LINUX64_DIR/nw" ] && mv "$LINUX64_DIR/nw" "$LINUX64_DIR/TiddlyDesktop"
}

# # Linux ARM64 App
build_linuxarm64() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-arm64/* output/linuxarm64/TiddlyDesktop-linuxarm64-v$(./bin/get-version-number)
cp -RH source/* output/linuxarm64/TiddlyDesktop-linuxarm64-v$(./bin/get-version-number)
# Rename the launcher binary to TiddlyDesktop (NW.js finds its resources by location, not
# name). Skipped if the nwjs SDK for this platform wasn't downloaded.
LINUXARM64_DIR="output/linuxarm64/TiddlyDesktop-linuxarm64-v$(./bin/get-version-number)"
[ -e "$LINUXARM64_DIR/nw" ] && mv "$LINUXARM64_DIR/nw" "$LINUXARM64_DIR/TiddlyDesktop"
}

# # Linux AppImage
# # For Github CI, only
build_linux_appimage() {
appdir="output/AppDir.$ARCH"
build_dependencies="curl findutils desktop-file-utils"
font_packages="fonts-dejavu-core fonts-dejavu-extra"
runtime_dependencies="$font_packages libnss3 libnspr4 libasound2-dev libatomic1 libatk1.0-0 libcups2-dev libxkbcommon-dev libatspi2.0-dev libxcomposite-dev libxdamage-dev libxfixes-dev libxrandr-dev libpango1.0-dev libgbm-dev libcairo2-dev libxi-dev libxrender-dev libwayland-dev libfribidi-dev libthai-dev libharfbuzz-dev libpng-dev libfontconfig-dev libfreetype-dev libpixman-1-dev libdatrie-dev libgraphite2-dev libbz2-dev fonts-dejavu"
package_arch=""
appimagetool_arch=""
sudo apt-get install -y $runtime_dependencies $build_dependencies

case "$ARCH" in
    arm64)
        package_arch="linuxarm64"
        appimagetool_arch="aarch64"
        curl -L https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-aarch64.AppImage -o output/appimagetool-$ARCH.AppImage
    ;;
    x64)
        package_arch="linux64"
        appimagetool_arch="x86_64"
        curl -L https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o output/appimagetool-$ARCH.AppImage
    ;;
esac

chmod u+x output/appimagetool-$ARCH.AppImage
mkdir -p $appdir
mkdir -p $appdir/usr/{bin,lib,share}
mkdir -p $appdir/usr/share/fonts/truetype/dejavu
cp icons/app-icon1024.png $appdir/tiddlydesktop.png
cp linux/AppRun $appdir/
cp linux/tiddlydesktop.desktop $appdir/
cp -r output/$package_arch/TiddlyDesktop-$package_arch-v$(./bin/get-version-number)/* $appdir/usr/bin/

libraries=$(dpkg -L $runtime_dependencies | grep "\.so" 2>/dev/null)
for f in $libraries; do
    cp $f* $appdir/usr/lib/
done

dpkg -L $font_packages | grep "\.ttf" 2>/dev/null | xargs -I '{}' -- cp '{}' $appdir/usr/share/fonts/truetype/dejavu/
VERSION=$(./bin/get-version-number)
ARCH=$appimagetool_arch ./output/appimagetool-$ARCH.AppImage --no-appstream $appdir output/tiddlydesktop-$package_arch-v$(./bin/get-version-number).AppImage
}

if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH variables supplied by the GitHub Actions script
	case "$PLATFORM-$ARCH" in
		osx-x64)
			build_mac64
			;;
		osx-arm64)
			build_macapplesilicon
			;;
		win-ia32)
			build_win32
			;;
		win-x64)
			build_win64
			;;
		linux-arm64)
			build_linuxarm64
			build_linux_appimage
			;;
		linux-x64)
			build_linux64
			build_linux_appimage
			;;
	esac
else
    # Running at the command line, where each platfom builds one at a time in sequence
	build_mac64
	build_macapplesilicon
	build_win32
	build_win64
	build_linuxarm64
	build_linux64
fi
