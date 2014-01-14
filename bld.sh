#!/bin/bash

# build TiddlyDesktop

# Create the output directory
mkdir -p source/bin
mkdir -p output
mkdir -p output/mac
mkdir -p output/win
mkdir -p output/linux32
mkdir -p output/linux64

# Build the app wiki
tiddlywiki ./app-wiki \
	--rendertiddler SaveTemplate ./source/bin/app-wiki.html text/plain \
	|| exit 1

# Remove any old build
rm -R output/mac/TiddlyWiki.app

# Copy the OS X App
cp -R node-webkit/node-webkit-v0.8.4-osx-ia32/node-webkit.app output/mac/TiddlyWiki.app

# Copy the OS X app folder
cp -R source output/mac/TiddlyWiki.app/Contents/Resources/app.nw

# Copy the OS X icon
cp icons/app.icns output/mac/TiddlyWiki.app/Contents/Resources/nw.icns

# Copy OS X Info.plist
cp Info.plist output/mac/TiddlyWiki.app/Contents/Info.plist

# Copy the Windows App
cp -R node-webkit/node-webkit-v0.8.4-win-ia32/* output/win

# Copy our source into it
cp -R source/* output/win

# Copy the Linux32 App
cp -R node-webkit/node-webkit-v0.8.4-linux-ia32/* output/linux32

# Copy our source into Linux32
cp -R source/* output/linux32

# Copy the Linux64 App
cp -R node-webkit/node-webkit-v0.8.4-linux-x64/* output/linux64

# Copy our source into Linux64
cp -R source/* output/linux64
