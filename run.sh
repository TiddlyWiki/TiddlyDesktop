#!/bin/bash

# build and run TiddlyDesktop

./bld.sh || exit 1

./output/mac64/TiddlyDesktop-macapplesilicon-v$(./bin/get-version-number)/TiddlyDesktop.app/Contents/MacOS/nwjs --debug || exit 1
