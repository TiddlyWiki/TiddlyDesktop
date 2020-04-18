#!/bin/bash

# build TiddlyWiki and TiddlyDesktop


pushd ../TiddlyWiki5

./bin/quick-bld.sh || exit 1

popd

./bld.sh || exit 1

./output/mac64/TiddlyDesktop-mac64-v0.0.14/TiddlyDesktop.app/Contents/MacOS/nwjs || exit 1
