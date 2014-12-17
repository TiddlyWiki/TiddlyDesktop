#!/bin/bash

# build TiddlyWiki and TiddlyDesktop


pushd ../TiddlyWiki5

../build.jermolene.github.io/quick-bld.sh

popd

./bld.sh

./output/mac/TiddlyWiki.app/Contents/MacOS/node-webkit

