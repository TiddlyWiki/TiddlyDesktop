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

## Known issue - "nothing happens"

This has been seen in Ubuntu 13.10 (see Issue #14)

This is a known issue with node-webkit. Until this is fixed, here is one solution:

1. Install the package ''bless'' -- with the package manager, synaptic or from the terminal

```
sudo apt-get install bless
```

2. Load bless

3. Open the ''nw'' binary (file tab)

4. Select find and replace (search tab)

5. Search for "udev.so.0" and replace with "udev.so.1" -- set both fields to text 

6. Save the edited ''nw'' binary

Other possible solutions: https://github.com/nwjs/nw.js/wiki/The-solution-of-lacking-libudev.so.0

# Usage

## Developer Tools

The F12 key opens the Chromium developer tools for the current window.

# Building

1. Download **nwjs-v0.12.3-osx-ia32** , **nwjs-v0.12.3-osx-x64** , **nwjs-v0.12.3-win-ia32** , **nwjs-v0.12.3-win-x64** , **nwjs-v0.12.3-linux-x64** **nwjs-v0.12.3-linux-ia32** from the <a href="https://github.com/nwjs/nw.js#downloads">node-webkit GitHub repo</a> and unpack them into `/nwjs`
2. Download the TiddlyWiki5 repo from https://github.com/Jermolene/TiddlyWiki5 to a sibling directory to the TiddlyDesktop repo called "TiddlyWiki5"
3. Run `bld.sh`
4. Execute `output/mac/TiddlyWiki.app` or `output/win/nw.exe` or `output/linux32/nw` or `output/linux64/nw`

# Creating inter-wiki links

You can create links that open a TiddlyWiki in a new window:

```
<a href="/Users/jack/MyTiddlyWiki.html" class="tc-interwiki-link">Open my wiki</a>
```

These links only work within TiddlyDesktop.
