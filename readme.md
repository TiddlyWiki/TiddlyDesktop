# TiddlyDesktop

TiddlyDesktop is a special purpose web browser for working with locally stored TiddlyWikis. See http://tiddlywiki.com/ for more details of TiddlyWiki.

It is based on node-webkit, a project created and developed in the Intel Open Source Technology Center:

https://github.com/rogerwang/node-webkit

# Download and Install

Download the Windows, linux or Mac binary .zip files from:

https://github.com/Jermolene/TiddlyDesktop/releases

Unzip into a folder and run `TiddlyWiki.app` or `nw.exe` and for linux `nw`

## Known issue - "nothing happens"

This has been seen in Ubuntu 13.10 (see Issue #14)

This is a known issue with node-webkit. Until this is fixed, here is one solution which involves making a tiny but significant change to the executable file nw.  
 
Download ghex:  (ghex is a hexidecimal editor)
    
    sudo apt-get install ghex        

Change to the folder containing TiddlyDesktop files and then make a copy of nw

    cp nw nw_orig

Open nw executable for editing: 
    ghex nw

Now find and replace string udev.so.0 and change the 0 to a 1. Detailed steps (based on ghex) are as follows:

    1. Ctrl-F to bring up the search pane
    2. type udev.so.0  in the right hand side of the search pane
    3. Press <Enter> to search
    
    Note that udev.so.0 will be highlighted in red when found.  
    
    4. Click on the red text and move cursor to 0
    5. Press '1' on your keyboard
    6. Check that the text now reads udev.so.1
    
    7. Now cancel search box and save the resulting file
    
Now launch nw

    ./nw

Other possible solutions: https://github.com/rogerwang/node-webkit/wiki/The-solution-of-lacking-libudev.so.0


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
