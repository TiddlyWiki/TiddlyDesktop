#!/bin/bash

# build TiddlyDesktop

# Remove any old build
rm -Rf output
rm -Rf source/tiddlywiki

# Get the correct version of TiddlyWiki
# (Here we install from a sibling directory; use plain "npm install" to install the latest)
npm install ../TiddlyWiki5
pushd ./node_modules/tiddlywiki
./bin/clean.sh
popd

# Copy TiddlyWiki core files into the source directory
cp -RH node_modules/tiddlywiki source/tiddlywiki

# Copy TiddlyDesktop plugin into the source directory
cp -RH plugins/tiddlydesktop source/tiddlywiki/plugins/tiddlywiki

# Copy TiddlyDesktop version number from package.json to the plugin.info of the plugin and the tiddler $:/plugins/tiddlywiki/tiddlydesktop/version
node propagate-version.js

# Create the output directories
mkdir -p output
mkdir -p output/mac64
mkdir -p output/mac64/TiddlyDesktop-mac64-v0.0.14
mkdir -p output/win32
mkdir -p output/win32/TiddlyDesktop-win32-v0.0.14
mkdir -p output/win64
mkdir -p output/win64/TiddlyDesktop-win64-v0.0.14
mkdir -p output/linux32
mkdir -p output/linux32/TiddlyDesktop-linux32-v0.0.14
mkdir -p output/linux64
mkdir -p output/linux64/TiddlyDesktop-linux64-v0.0.14

# For each platform, copy the stock nw.js binaries overlaying the "source" directory (and icons and plist for the Mac)

# OS X 64-bit App

cp -RH nwjs/nwjs-sdk-v0.31.1-osx-x64/nwjs.app output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app
cp -RH source output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app/Contents/Resources/app.nw
cp icons/app.icns output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app/Contents/Resources/nw.icns
cp Info.plist output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app/Contents/Info.plist

for f in output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app/Contents/Resources/*.lproj
do
	cp "./strings/InfoPlist.strings" "$f/InfoPlist.strings"
done

# Windows 64-bit App
cp -RH nwjs/nwjs-sdk-v0.31.1-win-x64/* output/win64/TiddlyDesktop-win64-v0.0.14
cp -RH source/* output/win64/TiddlyDesktop-win64-v0.0.14

# # Windows 32-bit App
cp -RH nwjs/nwjs-sdk-v0.31.1-win-ia32/* output/win32/TiddlyDesktop-win32-v0.0.14
cp -RH source/* output/win32/TiddlyDesktop-win32-v0.0.14

# # Linux 64-bit App
cp -RH nwjs/nwjs-sdk-v0.31.1-linux-x64/* output/linux64/TiddlyDesktop-linux64-v0.0.14
cp -RH source/* output/linux64/TiddlyDesktop-linux64-v0.0.14

# # Linux 32-bit App
cp -RH nwjs/nwjs-sdk-v0.31.1-linux-ia32/* output/linux32/TiddlyDesktop-linux32-v0.0.14
cp -RH source/* output/linux32/TiddlyDesktop-linux32-v0.0.14
