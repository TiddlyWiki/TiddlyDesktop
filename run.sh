#!/bin/bash

# build TiddlyWiki and TiddlyDesktop


pushd ../TiddlyWiki5

../build.jermolene.github.io/quick-bld.sh

popd

./bld.sh

./output/mac64/TiddlyWiki.app/Contents/MacOS/node-webkit

