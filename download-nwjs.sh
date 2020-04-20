#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs

# Download nw.js

curl -o 'nwjs/nwjs-sdk-v0.28.1-win-x64.zip' 'https://dl.nwjs.io/v0.28.1/nwjs-sdk-v0.28.1-win-x64.zip'
curl -o 'nwjs/nwjs-sdk-v0.28.1-win-ia32.zip' 'https://dl.nwjs.io/v0.28.1/nwjs-sdk-v0.28.1-win-ia32.zip'
curl -o 'nwjs/nwjs-sdk-v0.28.1-linux-x64.tar.gz' 'https://dl.nwjs.io/v0.28.1/nwjs-sdk-v0.28.1-linux-x64.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.28.1-linux-ia32.tar.gz' 'https://dl.nwjs.io/v0.28.1/nwjs-sdk-v0.28.1-linux-ia32.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.28.1-osx-x64.zip' 'https://dl.nwjs.io/v0.28.1/nwjs-sdk-v0.28.1-osx-x64.zip'
