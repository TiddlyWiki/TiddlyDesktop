#!/bin/bash

# build and run TiddlyDesktop

./bld.sh || exit 1

./output/mac64/TiddlyDesktop-mac64-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/MacOS/nwjs --debug || exit 1
