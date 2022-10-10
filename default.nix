# The following Nix expression provides the result of building the tiddlydesktop.nix package.
# The version of Nixpkgs comes from the Nix Flake lock file, flake.lock.
# To build, simply change to the repo's directory and run: nix-build

let
  lock = builtins.fromJSON (builtins.readFile ./flake.lock);
  pkgs = import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/${lock.nodes.nixpkgs.locked.rev}.tar.gz") { };
in pkgs.callPackage ./tiddlydesktop.nix { }
