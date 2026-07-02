#!/usr/bin/env sh
# Assemble the WikiList folder wiki (packaging/wikilist/) from:
#   - the classic plugin at ../../plugins/tiddlydesktop   (the UI)
#   - packaging/wikilist-android/                          (Android $tw.desktop bridge + overrides)
#
# The result is a TiddlyWiki folder wiki that the Gradle packageWikiListAsset task zips into
# assets/wikilist.zip, extracted on first run and served by Node.js (host/NodeServer.kt).
#
# Run this before building the app (or whenever the plugin / android overrides change).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)          # .../TiddlyDesktopAndroid/packaging
REPO=$(cd "$HERE/../.." && pwd)              # .../TiddlyDesktopOverhaul
PLUGIN="$REPO/plugins/tiddlydesktop"
ANDROID="$HERE/wikilist-android"
OUT="$HERE/wikilist"                         # generated (git-ignored)

if [ ! -d "$PLUGIN" ]; then
	echo "error: classic plugin not found at $PLUGIN" >&2
	exit 1
fi

echo "Assembling WikiList folder wiki -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/tiddlers" "$OUT/plugins/tiddlywiki"

# tiddlywiki.info (references tiddlywiki/tiddlydesktop, resolved via TIDDLYWIKI_PLUGIN_PATH)
cp "$ANDROID/tiddlywiki.info" "$OUT/tiddlywiki.info"

# Android bridge + override tiddlers (these mask the plugin's node-only shadows)
cp -R "$ANDROID/tiddlers/." "$OUT/tiddlers/"

# The classic plugin itself, resolvable by name as tiddlywiki/tiddlydesktop
cp -R "$PLUGIN" "$OUT/plugins/tiddlywiki/tiddlydesktop"

# Backstage language set: for each language we have translations for, copy the engine's
# language plugin, inject the TiddlyDesktop UI strings, and bump plugin-priority to "100"
# so the active language's translations win over the plugin's English defaults. NodeServer
# points the WikiList's node boot at this set (see host/NodeServer.kt).
ENGINE_LANGS="$REPO/source/tiddlywiki/languages"
if [ -d "$ENGINE_LANGS" ]; then
	mkdir -p "$OUT/languages"
	for tdir in "$REPO"/translations/*/ ; do
		lang=$(basename "$tdir")
		if [ -d "$ENGINE_LANGS/$lang" ]; then
			cp -R "$ENGINE_LANGS/$lang" "$OUT/languages/$lang"
			cp "$tdir/TiddlyDesktop.multids" "$OUT/languages/$lang/" 2>/dev/null || true
			cp "$tdir/EmptyMessage.tid" "$OUT/languages/$lang/" 2>/dev/null || true
			python3 - "$OUT/languages/$lang/plugin.info" <<-'PY'
			import json, sys
			p = sys.argv[1]
			info = json.load(open(p, encoding="utf-8"))
			info["plugin-priority"] = "100"
			json.dump(info, open(p, "w", encoding="utf-8"), indent=4, ensure_ascii=False)
			PY
		fi
	done
	echo "Backstage languages built: $(ls "$OUT/languages" | wc -l) languages"
fi

echo "Done. Now build the app (Gradle zips this into assets/wikilist.zip)."
