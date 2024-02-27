#!/bin/bash

# package TiddlyDesktop into zip files

# run this after bld.sh

VERSION=$(./bin/get-version-number)

# Zip them up
package_win32() {
pushd ./output/win32
zip -r "../tiddlydesktop-win32-v$VERSION.zip" *
popd
}

package_win64() {
pushd ./output/win64
zip -r "../tiddlydesktop-win64-v$VERSION.zip" *
popd
}

package_mac64() {
pushd ./output/mac64
zip --symlinks -r "../tiddlydesktop-mac64-v$VERSION.zip" *
popd
}

package_macapplesilicon() {
pushd ./output/macapplesilicon
sudo xattr -rc "./TiddlyDesktop-macapplesilicon-v$VERSION/TiddlyDesktop.app" -a sudo codesign --force --deep --sign - "./TiddlyDesktop-macapplesilicon-v$VERSION/TiddlyDesktop.app"
zip --symlinks -r "../tiddlydesktop-macapplesilicon-v$VERSION.zip" *
popd
}

package_linux32() {
pushd ./output/linux32
zip -r "../tiddlydesktop-linux32-v$VERSION.zip" *
popd
}

package_linux64() {
pushd ./output/linux64
zip -r "../tiddlydesktop-linux64-v$VERSION.zip" *
popd
}


if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH variables supplied by the GitHub Actions script
	case "$PLATFORM-$ARCH" in
		osx-x64)
			package_mac64
			;;
		osx-arm64)
			package_macapplesilicon
			;;
		win-ia32)
			package_win32
			;;
		win-x64)
			package_win64
			;;
		linux-ia32)
			package_linux32
			;;
		linux-x64)
			package_linux64
			;;
	esac
else
    # Running at the command line, where each platfom builds one at a time in sequence
	package_mac64
	package_macapplesilicon
	package_win32
	package_win64
	package_linux32
	package_linux64
fi
