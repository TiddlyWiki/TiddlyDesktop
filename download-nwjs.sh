#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs || exit 1

# Download nw.js

curl --output 'nwjs/nwjs-sdk-v0.77.0-win-x64.zip' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-win-x64.zip' || exit 1
curl --output 'nwjs/nwjs-sdk-v0.77.0-win-ia32.zip' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-win-ia32.zip' || exit 1
curl --output 'nwjs/nwjs-sdk-v0.77.0-linux-x64.tar.gz' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-linux-x64.tar.gz' || exit 1
curl --output 'nwjs/nwjs-sdk-v0.77.0-linux-ia32.tar.gz' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-linux-ia32.tar.gz' || exit 1
curl --output 'nwjs/nwjs-sdk-v0.77.0-osx-x64.zip' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-osx-x64.zip' || exit 1
curl --output 'nwjs/nwjs-sdk-v0.77.0-osx-arm64.zip' 'https://dl.nwjs.io/v0.77.0/nwjs-sdk-v0.77.0-osx-arm64.zip' || exit 1

pushd nwjs

ls *.gz | xargs -n 1 tar -xvzf || exit 1
ls *.zip | xargs -n 1 unzip || exit 1

popd
