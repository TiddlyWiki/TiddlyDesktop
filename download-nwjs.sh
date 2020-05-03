#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs || exit 1

# Download nw.js

curl -o 'nwjs/nwjs-sdk-v0.45.4-win-x64.zip' 'https://dl.nwjs.io/v0.45.4/nwjs-sdk-v0.45.4-win-x64.zip' || exit 1
curl -o 'nwjs/nwjs-sdk-v0.45.4-win-ia32.zip' 'https://dl.nwjs.io/v0.45.4/nwjs-sdk-v0.45.4-win-ia32.zip' || exit 1
curl -o 'nwjs/nwjs-sdk-v0.45.4-linux-x64.tar.gz' 'https://dl.nwjs.io/v0.45.4/nwjs-sdk-v0.45.4-linux-x64.tar.gz' || exit 1
curl -o 'nwjs/nwjs-sdk-v0.45.4-linux-ia32.tar.gz' 'https://dl.nwjs.io/v0.45.4/nwjs-sdk-v0.45.4-linux-ia32.tar.gz' || exit 1
curl -o 'nwjs/nwjs-sdk-v0.45.4-osx-x64.zip' 'https://dl.nwjs.io/v0.45.4/nwjs-sdk-v0.45.4-osx-x64.zip' || exit 1

pushd nwjs

ls *.gz | xargs -n 1 tar -xvzf || exit 1
ls *.zip | xargs -n 1 unzip || exit 1

popd
