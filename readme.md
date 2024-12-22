# TiddlyDesktop

TiddlyDesktop is a special purpose web browser for working with locally stored TiddlyWikis. See http://tiddlywiki.com/ for more details of TiddlyWiki.

See this video tutorial for an overview of installing and using TiddlyDesktop on Windows and OS X:

https://www.youtube.com/watch?v=i3Bggkm7paA

It is based on nw.js, a project created and developed in the Intel Open Source Technology Center:

https://github.com/nwjs/nw.js

# Download and Install

Download the Windows, linux or Mac binary .zip files from:

https://github.com/TiddlyWiki/TiddlyDesktop/releases

Unzip into a folder and run `TiddlyWiki.app` or `nw.exe` and for linux `nw`

Note that TiddlyDesktop will not work correctly from a Windows UNC network share (eg ``\\MY-SERVER\SHARE\MyFolder``). You should map the network share to a local drive, and run it from there.

## Linux AppImage

Linux releases are also available in the AppImage format. The AppImages are compatible with glibc-based Desktop Linux distributions such as Ubuntu, Fedora, and Arch Linux. The AppImages are _not_ compatible with musl-based Linux distributions such as Alpine Linux, nor are they compatible with Linux server distributions; Server distributions don't provide enough of the required dependencies.

To use an AppImage, your Linux distribution must provide `fusermount3`, which is typically provided in a package named `fuse3`.

Before you can execute an AppImage, you must set the executable permission:

```
chmod u+x tiddlydesktop-*-v*.AppImage
```

## NixOS

To install TiddlyDesktop on NixOS, you first need to add this repo to your `configuration.nix`; Using a `let` expression at the top of the file is a good approach: 

```
let
  twdesktop = let
    rev = "Set this to the TiddlyDesktop Git revision that you want to install.";
  in import (fetchTarball "https://github.com/TiddlyWiki/TiddlyDesktop/archive/${rev}.tar.gz") { };
in
 ...
``` 

Then add the attribute name (which is twdesktop in the example above) to your `systemPackages`:

```
...
environment.systemPackages = with pkgs; [
   ...
   twdesktop
];
...
```

In addition to the method described above, the tiddlydesktop package is available as a Nix Flake; See https://wiki.nixos.org/wiki/Flakes to read more about Flakes. Simply use the Flake input `github:TiddlyWiki/TiddlyDesktop`. For example, you can run TiddlyDesktop with the command `nix run github:TiddlyWiki/TiddlyDesktop`.

# Usage

## Multiple Configurations

To have separate mutliple instances of TiddlyDesktop (for example, separate Personal and Professional instances), you can pass the `--user-data-dir` argument.  e.g. `/opt/TiddlyDesktop/nw --user-data-dir=/mnt/data/TiddlyWiki/config`.  The property should be a directory to use for holding configuration data.

## Developer Tools

The F12 key opens the Chromium developer tools for the current window.

## Debugging With VSCode

Instructions for Windows 10 64-bit (updates for other OSs welcome).

* Required software: VScode, Debugger for NWjs plugin installed in vscode
* Download the latest version of TiddlyDesktop-win64-v0.0.15 and unzip it to keep only four folders: html, images, js, tiddlywiki and package.json file
* Download nwjs-sdk-v0.69.1-win-x64, put it in C:\Users\your username\.nwjs folder and unzip it. After unzipping you can see the nw.exe program in the .nwjs\nwjs-sdk-v0.69.1-win-x64 folder to indicate that it is correct. (Again, you can use Ctrl + shift + p in vscode to bring up the command to execute the NWjs Install command and select the version to install)
* Use vscode to open the TiddlyDesktop-win64 folder
* Modify the "main" field in the package.json file to "html/main.html"
* Click 'Debug' and select nwjs to automatically create the configuration file laugh.json (no need to modify it). Then click Start to debug.

# Releasing with Continuous Integration

1. Update the version number in package.json, plus any other changes that should be included
2. Run `npm install --save`
2. Make a commit and push it
3. Check the build output in the GitHub Actions tab
3. Tag that commit with `git tag v0.0.21`, the version number you just updated in package.json
4. Push that tag with `git push v0.0.21` and a draft release will be created
5. Edit the draft release: add release notes, edit whatever else might need to be changed. Download its build files and test them
6. Switch the draft release to be a public release once it's tested and ready

# Building

1. Run `download-nwjs.sh` to download the latest nw.js binaries
2. Download the TiddlyWiki5 repo from https://github.com/Jermolene/TiddlyWiki5 to a sibling directory to the TiddlyDesktop repo called "TiddlyWiki5"
3. Run `bld.sh`
4. Execute `output/mac/TiddlyWiki.app` or `output/win/nw.exe` or `output/linux32/nw` or `output/linux64/nw`
