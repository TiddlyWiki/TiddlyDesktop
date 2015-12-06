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
cp -R node_modules/tiddlywiki source/tiddlywiki

# Copy TiddlyDesktop plugin into the source directory
cp -R plugins/tiddlydesktop source/tiddlywiki/plugins/tiddlywiki

# Copy TiddlyDesktop version number from package.json to the plugin.info of the plugin and the tiddler $:/plugins/tiddlywiki/tiddlydesktop/version
node propogate-version.js

# Create the output directories
mkdir -p output
mkdir -p output/mac32
mkdir -p output/mac32/TiddlyDesktop-mac32-v0.0.8
mkdir -p output/mac64
mkdir -p output/mac64/TiddlyDesktop-mac64-v0.0.8
mkdir -p output/win32
mkdir -p output/win32/TiddlyDesktop-win32-v0.0.8
mkdir -p output/win64
mkdir -p output/win64/TiddlyDesktop-win64-v0.0.8
mkdir -p output/linux32
mkdir -p output/linux32/TiddlyDesktop-linux32-v0.0.8
mkdir -p output/linux64
mkdir -p output/linux64/TiddlyDesktop-linux64-v0.0.8

# For each platform, copy the stock nw.js binaries overlaying the "source" directory (and icons and plist for the Mac)

# OS X 64-bit App
cp -R nwjs/nwjs-v0.12.3-osx-x64/nwjs.app output/mac64/TiddlyDesktop-mac64-v0.0.8/TiddlyWiki.app
cp -R source output/mac64/TiddlyDesktop-mac64-v0.0.8/TiddlyWiki.app/Contents/Resources/app.nw
cp icons/app.icns output/mac64/TiddlyDesktop-mac64-v0.0.8/TiddlyWiki.app/Contents/Resources/nw.icns
cp Info.plist output/mac64/TiddlyDesktop-mac64-v0.0.8/TiddlyWiki.app/Contents/Info.plist

# OS X 32-bit App
cp -R nwjs/nwjs-v0.12.3-osx-ia32/nwjs.app output/mac32/TiddlyDesktop-mac32-v0.0.8/TiddlyWiki.app
cp -R source output/mac32/TiddlyDesktop-mac32-v0.0.8/TiddlyWiki.app/Contents/Resources/app.nw
cp icons/app.icns output/mac32/TiddlyDesktop-mac32-v0.0.8/TiddlyWiki.app/Contents/Resources/nw.icns
cp Info.plist output/mac32/TiddlyDesktop-mac32-v0.0.8/TiddlyWiki.app/Contents/Info.plist

# Windows 64-bit App
cp -R nwjs/nwjs-v0.12.3-win-x64/* output/win64/TiddlyDesktop-win64-v0.0.8
cp -R source/* output/win64/TiddlyDesktop-win64-v0.0.8

# Windows 32-bit App
cp -R nwjs/nwjs-v0.12.3-win-ia32/* output/win32/TiddlyDesktop-win32-v0.0.8
cp -R source/* output/win32/TiddlyDesktop-win32-v0.0.8

# Linux 64-bit App
cp -R nwjs/nwjs-v0.12.3-linux-x64/* output/linux64/TiddlyDesktop-linux64-v0.0.8
cp -R source/* output/linux64/TiddlyDesktop-linux64-v0.0.8

# Linux 32-bit App
cp -R nwjs/nwjs-v0.12.3-linux-ia32/* output/linux32/TiddlyDesktop-linux32-v0.0.8
cp -R source/* output/linux32/TiddlyDesktop-linux32-v0.0.8
