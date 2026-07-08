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

# The WikiList EmptyMessage on desktop tells the user to "drag & drop from your file explorer",
# which doesn't apply on Android. Rewrite each copy to keep the (translated) first paragraph and
# drop that second paragraph — leaving a correct, still-localized message. Applied to the plugin's
# English default and (below) each language override; only touches the Android WikiList copies.
androidify_empty() {
	[ -f "$1" ] || return 0
	python3 - "$1" <<-'PY'
	import sys
	lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
	out, i, n = [], 0, len(lines)
	while i < n and lines[i].strip() != "": out.append(lines[i]); i += 1   # title/header
	out.append("")
	while i < n and lines[i].strip() == "": i += 1                          # skip blanks
	while i < n and lines[i].strip() != "": out.append(lines[i]); i += 1    # first paragraph only
	open(sys.argv[1], "w", encoding="utf-8").write("\n".join(out).rstrip() + "\n")
	PY
}
androidify_empty "$OUT/plugins/tiddlywiki/tiddlydesktop/language/EmptyMessage.tid"

# The tiddlydesktop plugin the WikiList actually loads comes from the ENGINE's PACKED copy
# (source/tiddlywiki/.../contents.json), not the folder copy above — so its default EmptyMessage
# (shown for untranslated locales such as en-GB / en-US) must be androidified here too. Truncate it
# to the first paragraph inside the packed JSON. This only touches the Android engine zip (Gradle
# zips source/tiddlywiki AFTER this script); the desktop build already packed its own copy in bld.sh.
ENGINE_TD="$REPO/source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/contents.json"
if [ -f "$ENGINE_TD" ]; then
	python3 - "$ENGINE_TD" <<-'PY'
	import json, sys
	p = sys.argv[1]
	d = json.load(open(p, encoding="utf-8"))
	tids = d if isinstance(d, list) else d.get("tiddlers", [])
	for t in [x for x in tids if x.get("title") == "$:/language/TiddlyDesktop/List/EmptyMessage"]: t["text"] = t.get("text", "").split("\n\n")[0].rstrip() + "\n"
	json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False)
	PY
	echo "Androidified engine EmptyMessage default"
fi

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
			androidify_empty "$OUT/languages/$lang/EmptyMessage.tid"
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

	# Available-language stubs for the switcher. Only the ACTIVE language is loaded at runtime
	# (NodeServer trims the rest — the full language plugins are ~80% of the served page), so the
	# language switcher lists these tiny stubs (title + display name) instead of the real plugins.
	printf 'title: $:/TiddlyDesktop/AvailableLanguage/en-GB\ntags: $:/tags/TiddlyDesktopLanguage\nlanguage: $:/languages/en-GB\ncaption: English (British)\n' \
		> "$OUT/tiddlers/AvailableLanguage-en-GB.tid"
	for ldir in "$OUT"/languages/*/ ; do
		lang=$(basename "$ldir")
		desc=$(python3 -c "import json;print(json.load(open('$ldir/plugin.info')).get('description') or '$lang')" 2>/dev/null || echo "$lang")
		printf 'title: $:/TiddlyDesktop/AvailableLanguage/%s\ntags: $:/tags/TiddlyDesktopLanguage\nlanguage: $:/languages/%s\ncaption: %s\n' \
			"$lang" "$lang" "$desc" > "$OUT/tiddlers/AvailableLanguage-$lang.tid"
	done
	# Engine languages NOT in the translated backstage set (English variants en-US / en-PH). They
	# aren't copied into languages-all, but selecting one loads it from the engine's clean languages
	# (tiddlywiki.info languages=[code]) with the plugin's English UI defaults.
	for ldir in "$REPO"/source/tiddlywiki/languages/*/ ; do
		lang=$(basename "$ldir")
		[ -f "$OUT/tiddlers/AvailableLanguage-$lang.tid" ] && continue
		[ "$lang" = "en-GB" ] && continue
		desc=$(python3 -c "import json;print(json.load(open('$ldir/plugin.info')).get('description') or '$lang')" 2>/dev/null || echo "$lang")
		printf 'title: $:/TiddlyDesktop/AvailableLanguage/%s\ntags: $:/tags/TiddlyDesktopLanguage\nlanguage: $:/languages/%s\ncaption: %s\n' \
			"$lang" "$lang" "$desc" > "$OUT/tiddlers/AvailableLanguage-$lang.tid"
	done
	echo "Available-language stubs: $(ls "$OUT"/tiddlers/AvailableLanguage-*.tid | wc -l)"
fi

echo "Done. Now build the app (Gradle zips this into assets/wikilist.zip)."
