{ stdenv
, lib
, nodePackages
, nwjs
, jq
, writeScript
, bash
, makeDesktopItem
, copyDesktopItems
, gsettings-desktop-schemas
, wrapGAppsHook
, gtk3
}:
let
  launcher = writeScript "tiddlydesktop" ''
    #! ${bash}/bin/bash

    ${nwjs}/bin/nw @out@/lib/tiddlydesktop $@
  '';

  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
in stdenv.mkDerivation rec {
  pname = "tiddlydesktop";
  version = "${packageJson.version}";

  src = ./.;

  nativeBuildInputs = [ copyDesktopItems wrapGAppsHook gtk3 ]; 
  buildInputs = [ nodePackages.tiddlywiki jq ];

  # These instructions are based on those from the bld.sh upstream script.
  buildPhase = ''
    cp -RH ${nodePackages.tiddlywiki}/lib/node_modules/tiddlywiki source/tiddlywiki
    chmod -R u+w source
    cp -RH plugins/tiddlydesktop source/tiddlywiki/plugins/tiddlywiki

    version=$(jq < package.json '.version')
    plugin_info=$(mktemp) 
    cat source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/plugin.info > $plugin_info
    jq < $plugin_info --arg version $version '. + {version: $version}' > source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/plugin.info
    echo $version > source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/system/version.txt
  '';
 
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    mkdir -p $out/lib/tiddlydesktop
    mkdir -p $out/share/icons/hicolor

    cp -R source/* $out/lib/tiddlydesktop/
    cp ${launcher} $out/bin/tiddlydesktop
    substituteAllInPlace $out/bin/tiddlydesktop

    for n in 16 32 48 64 128 256 1024; do
      size=$n"x"$n
      mkdir -p $out/share/icons/hicolor/$size/apps
      cp icons/app-icon$n.png $out/share/icons/hicolor/$size/apps/${pname}.png
    done

    runHook postInstall
  ''; 

  desktopItems = [
    (makeDesktopItem {
      name = pname;
      exec = pname;
      icon = pname;
      desktopName = "Tiddly Desktop";
      categories = ["Utility" "TextEditor"];
    })
  ];

  meta = with lib; {
    homepage = "https://github.com/TiddlyWiki/TiddlyDesktop";
    description = "A custom desktop browser for TiddlyWiki 5 and TiddlyWiki Classic, based on nw.js";
    license = licenses.bsd0;
    maintainers = with maintainers; [ emmanuelrosa ];
    platforms = [ "x86_64-linux" ];
  };
}
