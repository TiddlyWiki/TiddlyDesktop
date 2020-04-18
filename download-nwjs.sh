#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs

# Download nw.js

curl -o 'nwjs/nwjs-sdk-v0.45.2-win-x64.zip' 'https://dl.nwjs.io/v0.45.2/nwjs-sdk-v0.45.2-win-x64.zip'
curl -o 'nwjs/nwjs-sdk-v0.45.2-win-ia32.zip' 'https://dl.nwjs.io/v0.45.2/nwjs-sdk-v0.45.2-win-ia32.zip'
curl -o 'nwjs/nwjs-sdk-v0.45.2-linux-x64.tar.gz' 'https://dl.nwjs.io/v0.45.2/nwjs-sdk-v0.45.2-linux-x64.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.45.2-linux-ia32.tar.gz' 'https://dl.nwjs.io/v0.45.2/nwjs-sdk-v0.45.2-linux-ia32.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.45.2-osx-x64.zip' 'https://dl.nwjs.io/v0.45.2/nwjs-sdk-v0.45.2-osx-x64.zip'

