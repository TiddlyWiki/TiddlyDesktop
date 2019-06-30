#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs

# Download nw.js

curl -o 'nwjs/nwjs-sdk-v0.33.3-win-x64.zip' 'https://dl.nwjs.io/v0.39.2/nwjs-sdk-v0.33.3-win-x64.zip'
curl -o 'nwjs/nwjs-sdk-v0.33.3-win-ia32.zip' 'https://dl.nwjs.io/v0.39.2/nwjs-sdk-v0.33.3-win-ia32.zip'
curl -o 'nwjs/nwjs-sdk-v0.33.3-linux-x64.tar.gz' 'https://dl.nwjs.io/v0.39.2/nwjs-sdk-v0.33.3-linux-x64.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.33.3-linux-ia32.tar.gz' 'https://dl.nwjs.io/v0.39.2/nwjs-sdk-v0.33.3-linux-ia32.tar.gz'
curl -o 'nwjs/nwjs-sdk-v0.33.3-osx-x64.zip' 'https://dl.nwjs.io/v0.33.3/nwjs-sdk-v0.39.2-osx-x64.zip'

