#!/bin/bash

# build TiddlyWiki and TiddlyDesktop


pushd ../TiddlyWiki5

../build.jermolene.github.io/quick-bld.sh

popd

./bld.sh

./output/mac64/TiddlyDesktop-mac64-v0.0.7/TiddlyWiki.app/Contents/MacOS/nwjs

