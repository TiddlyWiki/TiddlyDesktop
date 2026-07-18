#!/bin/bash

# Create dir if not existent

[[ -d ./nwjs ]] || mkdir ./nwjs || exit 1

# Set default nw.js version if not specified in environment variable or parameter

if [ $# -gt 0 ]; then
    NWJS_VERSION=$1
elif [ -z "$NWJS_VERSION" ]; then
    NWJS_VERSION=0.113.0
fi

# Download nw.js (SDK for dev builds with devtools, non-SDK for production builds)

NWJS_BASE_URL="https://dl.node-webkit.org"

if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH and EXT variables supplied by the GitHub Actions script
    curl --output "nwjs/nwjs-sdk-v${NWJS_VERSION}-${PLATFORM}-${ARCH}.${EXT}" "${NWJS_BASE_URL}/v${NWJS_VERSION}/nwjs-sdk-v${NWJS_VERSION}-${PLATFORM}-${ARCH}.${EXT}" || exit 1
    curl --output "nwjs/nwjs-v${NWJS_VERSION}-${PLATFORM}-${ARCH}.${EXT}" "${NWJS_BASE_URL}/v${NWJS_VERSION}/nwjs-v${NWJS_VERSION}-${PLATFORM}-${ARCH}.${EXT}" || exit 1
else
    # Running at the command line, where each platfom builds one at a time in sequence
    for plat in "win-x64" "win-ia32" "linux-x64" "linux-arm64" "osx-x64" "osx-arm64"; do
        case "$plat" in
            *.tar.gz)
                ext="tar.gz" ;;
            *.zip)
                ext="zip" ;;
            linux-*)
                ext="tar.gz" ;;
            *)
                ext="zip" ;;
        esac
        curl --output "nwjs/nwjs-sdk-v${NWJS_VERSION}-${plat}.${ext}" "${NWJS_BASE_URL}/v${NWJS_VERSION}/nwjs-sdk-v${NWJS_VERSION}-${plat}.${ext}" || exit 1
        curl --output "nwjs/nwjs-v${NWJS_VERSION}-${plat}.${ext}" "${NWJS_BASE_URL}/v${NWJS_VERSION}/nwjs-v${NWJS_VERSION}-${plat}.${ext}" || exit 1
    done
fi

pushd nwjs

if [ ".$EXT" = ".tar.gz" ]; then
ls *.gz | xargs -n 1 tar -xvzf || exit 1
elif [ ".$EXT" = ".zip" ]; then
ls *.zip | xargs -n 1 unzip || exit 1
else
# Running at command line, not in GitHub Actions
ls *.gz | xargs -n 1 tar -xvzf || exit 1
ls *.zip | xargs -n 1 unzip || exit 1
fi

popd
