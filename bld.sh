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
    NWJS_VERSION=0.77.0
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
			;;
		linux-x64)
			build_linux64
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
