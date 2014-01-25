# TiddlyDesktop

TiddlyDesktop is a special purpose web browser for working with locally stored TiddlyWikis. See http://tiddlywiki.com/ for more details of TiddlyWiki.

It is based on node-webkit, a project created and developed in the Intel Open Source Technology Center:

https://github.com/rogerwang/node-webkit

# Download and Install

Download the Windows or Mac binary .zip files from:

https://github.com/Jermolene/TiddlyDesktop/releases

Unzip into a folder and run `TiddlyWiki.app` or `nw.exe` and for linux `nw`

# Usage

## Developer Tools

The F12 key opens the Chromium developer tools for the current window.

# Building

1. Download **node-webkit-v0.8.4-osx-ia32** , **node-webkit-v0.8.4-win-ia32** , **node-webkit-v0.8.4-linux-x64** **node-webkit-v0.8.4-linux-ia32** from the <a href="https://github.com/rogerwang/node-webkit#downloads">node-webkit GitHub repo</a> and unpack them into `/node-webkit`
2. Run `bld.sh`
3. Execute `output/mac/TiddlyWiki.app` or `output/win/nw.exe` or `output/linux32/nw` or `output/linux64/nw`

# Creating inter-wiki links

You can create links that open a TiddlyWiki in a new window:

```
<a href="/Users/jack/MyTiddlyWiki.html" class="tw-interwiki-link">Open my wiki</a>
```

These links only work within TiddlyDesktop.
