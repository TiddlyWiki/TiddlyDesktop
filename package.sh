#!/bin/bash

# package TiddlyDesktop into zip files

# run this after bld.sh

# Zip them up
pushd ./output/win
zip -r ../tiddlydesktop-win-0.0.1.zip *
popd
pushd ./output/mac
zip -r ../tiddlydesktop-mac-0.0.1.zip *
popd
pushd ./output/linux32
zip -r ../tiddlydesktop-linux32-0.0.1.zip *
popd
pushd ./output/linux64
zip -r ../tiddlydesktop-linux64-0.0.1.zip *
popd
