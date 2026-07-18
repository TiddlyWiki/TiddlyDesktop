#!/bin/bash

# package TiddlyDesktop into zip files

# run this after bld.sh

VERSION=$(./bin/get-version-number)

# Generic packaging functions

# macOS: xattr + codesign + zip
#   $1 = output dir  $2 = zip name
package_macos() {
	local out_dir="$1" zip_name="$2"
	pushd "./$out_dir"
	local app_dir
	for app_dir in TiddlyDesktop-*-v${VERSION}*/TiddlyDesktop.app; do
		[ -d "$app_dir" ] || continue
		sudo xattr -rc "$app_dir"
		sudo codesign --force --deep --sign - "$app_dir"
	done
	zip --symlinks -r "../${zip_name}" *
	popd
}

# Windows / Linux: just zip
#   $1 = output dir  $2 = zip name
package_flat() {
	local out_dir="$1" zip_name="$2"
	pushd "./$out_dir"
	zip -r "../${zip_name}" *
	popd
}

# Non-SDK (production) packages — no -dev suffix
package_win32()      { package_flat  "output/win32"          "tiddlydesktop-win32-v${VERSION}.zip"; }
package_win64()      { package_flat  "output/win64"          "tiddlydesktop-win64-v${VERSION}.zip"; }
package_mac64()      { package_macos "output/mac64"          "tiddlydesktop-mac64-v${VERSION}.zip"; }
package_macapplesilicon() { package_macos "output/macapplesilicon" "tiddlydesktop-macapplesilicon-v${VERSION}.zip"; }
package_linuxarm64() { package_flat  "output/linuxarm64"     "tiddlydesktop-linuxarm64-v${VERSION}.zip"; }
package_linux64()    { package_flat  "output/linux64"        "tiddlydesktop-linux64-v${VERSION}.zip"; }

# SDK (dev) packages — -dev suffix
package_win32_dev()      { package_flat  "output/win32-dev"          "tiddlydesktop-win32-v${VERSION}-dev.zip"; }
package_win64_dev()      { package_flat  "output/win64-dev"          "tiddlydesktop-win64-v${VERSION}-dev.zip"; }
package_mac64_dev()      { package_macos "output/mac64-dev"          "tiddlydesktop-mac64-v${VERSION}-dev.zip"; }
package_macapplesilicon_dev() { package_macos "output/macapplesilicon-dev" "tiddlydesktop-macapplesilicon-v${VERSION}-dev.zip"; }
package_linuxarm64_dev() { package_flat  "output/linuxarm64-dev"     "tiddlydesktop-linuxarm64-v${VERSION}-dev.zip"; }
package_linux64_dev()    { package_flat  "output/linux64-dev"        "tiddlydesktop-linux64-v${VERSION}-dev.zip"; }


if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH variables supplied by the GitHub Actions script
	case "$PLATFORM-$ARCH" in
		osx-x64)
			package_mac64
			package_mac64_dev
			;;
		osx-arm64)
			package_macapplesilicon
			package_macapplesilicon_dev
			;;
		win-ia32)
			package_win32
			package_win32_dev
			;;
		win-x64)
			package_win64
			package_win64_dev
			;;
		linux-arm64)
			package_linuxarm64
			package_linuxarm64_dev
			;;
		linux-x64)
			package_linux64
			package_linux64_dev
			;;
	esac
else
    # Running at the command line, where each platfom builds one at a time in sequence
	package_mac64
	package_mac64_dev
	package_macapplesilicon
	package_macapplesilicon_dev
	package_win32
	package_win32_dev
	package_win64
	package_win64_dev
	package_linuxarm64
	package_linuxarm64_dev
	package_linux64
	package_linux64_dev
fi
