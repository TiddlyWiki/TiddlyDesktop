# TiddlyDesktop

TiddlyDesktop is a special purpose web browser for working with locally stored TiddlyWikis. See http://tiddlywiki.com/ for more details of TiddlyWiki.

See this video tutorial for an overview of installing and using TiddlyDesktop on Windows and OS X:

https://www.youtube.com/watch?v=i3Bggkm7paA

It is based on nw.js, a project created and developed in the Intel Open Source Technology Center:

https://github.com/nwjs/nw.js

# Download and Install

Download the Windows, linux or Mac binary .zip files from:

https://github.com/Jermolene/TiddlyDesktop/releases

Unzip into a folder and run `TiddlyWiki.app` or `nw.exe` and for linux `nw`

Note that TiddlyDesktop will not work correctly from a Windows UNC network share (eg ``\\MY-SERVER\SHARE\MyFolder``). You should map the network share to a local drive, and run it from there.

# Usage

## Multiple Configurations

To have separate mutliple instances of TiddlyDesktop (for example, separate Personal and Professional instances), you can pass the `--data-path` argument.  e.g. `/opt/TiddlyDesktop/nw --data-path=/mnt/data/TiddlyWiki/config`.  The property should be a directory to use for holding configuration data.

## Developer Tools

The F12 key opens the Chromium developer tools for the current window.

# Building

1. Run `download-nwjs.sh` to download the latest nw.js binaries
2. Download the TiddlyWiki5 repo from https://github.com/Jermolene/TiddlyWiki5 to a sibling directory to the TiddlyDesktop repo called "TiddlyWiki5"
3. Run `bld.sh`
4. Execute `output/mac/TiddlyWiki.app` or `output/win/nw.exe` or `output/linux32/nw` or `output/linux64/nw`
