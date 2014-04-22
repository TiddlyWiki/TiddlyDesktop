#!/bin/bash

# build TiddlyWiki and TiddlyDesktop


pushd ../TiddlyWiki5

./qbld.sh

popd

./bld.sh

./output/mac/TiddlyWiki.app/Contents/MacOS/node-webkit

