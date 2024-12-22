#!/bin/bash

# build TiddlyDesktop

# Remove any old build
rm -Rf output
rm -Rf source/tiddlywiki

# Install TiddlyWiki to node_modules/tiddlywiki
npm install

# Copy TiddlyWiki core files into the source directory
cp -RH node_modules/tiddlywiki source/tiddlywiki

# Copy TiddlyDesktop plugin into the source directory
cp -RH plugins/tiddlydesktop source/tiddlywiki/plugins/tiddlywiki

# Copy TiddlyDesktop version number from package.json to the plugin.info of the plugin and the tiddler $:/plugins/tiddlywiki/tiddlydesktop/version
node propagate-version.js

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
mkdir -p output/linux32
mkdir -p output/linux32/TiddlyDesktop-linux32-v$(./bin/get-version-number)
mkdir -p output/linux64
mkdir -p output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)

# For each platform, copy the stock nw.js binaries overlaying the "source" directory (and icons and plist for the Mac)

# Calculate nw.js version

if [ $# -gt 0 ]; then
    NWJS_VERSION=$1
elif [ -z "$NWJS_VERSION" ]; then
    NWJS_VERSION=0.94.0
fi

# Build function definitions (which will be called at the end of the script)

# OS X 64-bit App
build_mac64() {

cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-x64/nwjs.app output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app
cp -RH source output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/app.nw
cp icons/app.icns output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/nw.icns
cp Info.plist output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Info.plist

for f in output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/*.lproj
do
	cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings"
done

}

# OS X Apple Silicon App
build_macapplesilicon() {

cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-osx-arm64/nwjs.app output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app
cp -RH source output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/app.nw
cp icons/app.icns output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/nw.icns
cp Info.plist output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Info.plist

for f in output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/Resources/*.lproj
do
	cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings"
done

xattr -c output/macapplesilicon/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app

}

# Windows 64-bit App
build_win64() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-win-x64/* output/win64/TiddlyDesktop-win64-v$(./bin/get-version-number)
cp -RH source/* output/win64/TiddlyDesktop-win64-v$(./bin/get-version-number)
}

# # Windows 32-bit App
build_win32() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-win-ia32/* output/win32/TiddlyDesktop-win32-v$(./bin/get-version-number)
cp -RH source/* output/win32/TiddlyDesktop-win32-v$(./bin/get-version-number)
}

# # Linux 64-bit App
build_linux64() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-x64/* output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)
cp -RH source/* output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)
}

# # Linux 32-bit App
build_linux32() {
cp -RH nwjs/nwjs-sdk-v${NWJS_VERSION}-linux-ia32/* output/linux32/TiddlyDesktop-linux32-v$(./bin/get-version-number)
cp -RH source/* output/linux32/TiddlyDesktop-linux32-v$(./bin/get-version-number)
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
    ia32)
        package_arch="linux32"
        appimagetool_arch="i686"
        curl -L https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-i686.AppImage -o output/appimagetool-$ARCH.AppImage
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
		linux-ia32)
			build_linux32
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
	build_linux32
	build_linux64
fi
