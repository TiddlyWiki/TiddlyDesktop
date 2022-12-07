# This is a Nix Flake which provides the tiddlydesktop package.
# To execute TiddlyDesktop, simply run: nix run github:TiddlyWiki/TiddlyDesktop

{
  description = "A Nix Flake for TiddlyDesktop.";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/master";

  outputs = { self, nixpkgs }: {

    packages.x86_64-linux.tiddlydesktop = let 
      pkgs = import "${nixpkgs}" {
        system = "x86_64-linux";
      };
    in pkgs.callPackage ./tiddlydesktop.nix { };

    packages.x86_64-linux.default = self.packages.x86_64-linux.tiddlydesktop;
    
    apps.x86_64-linux.tiddlydesktop = {
      type = "app";
      program = "${self.packages.x86_64-linux.tiddlydesktop}/bin/tiddlydesktop";
    };

    apps.x86_64-linux.default = self.apps.x86_64-linux.tiddlydesktop;

  };
}
