#!/usr/bin/env node
/*
Injects a v8-serialized cache around $tw.loadPluginFolder in a TiddlyWiki boot.js.

For a PACKED plugin, loadPluginFolder reads contents.json (e.g. the 1.97 MB core), JSON.parses it,
rebuilds a hashmap, and JSON.stringifies it back into the plugin's `text` — then unpackPluginTiddlers
JSON.parses that text again. That's ~two 2 MB parses + a stringify per plugin, every boot, and it
dominates Node startup on Android's slow arm64 cores.

This caches loadPluginFolder's RETURN VALUE (a plain object) with v8.serialize, keyed by the plugin
folder's plugin.info + contents.json mtime/size (a cheap stat, no read). v8.deserialize reloads it far
faster than re-reading + re-parsing + re-stringifying. Fully fail-safe: enabled only when
TW_STORE_CACHE_DIR is set; any error (unwritable dir, stale/corrupt cache, missing v8) falls back to
the original loadPluginFolder, so a patched boot.js behaves identically when caching can't work.

Idempotent; warns + leaves the file untouched if the anchor isn't found (upstream boot.js changed).

Usage: node bin/patch-boot-store-cache.js <path/to/boot.js>
*/
"use strict";

var fs = require("fs");

var file = process.argv[2];
if(!file) { console.error("patch-boot-store-cache: missing boot.js path"); process.exit(1); }

var src = fs.readFileSync(file, "utf8");

if(src.indexOf("_origLoadPluginFolder") !== -1) {
	console.log("patch-boot-store-cache: already patched, skipping");
	process.exit(0);
}

var defAnchor = "$tw.loadPluginFolder = function(filepath,excludeRegExp) {";
var start = src.indexOf(defAnchor);
if(start === -1) {
	console.warn("patch-boot-store-cache: anchor not found (boot.js changed?) — leaving unpatched");
	process.exit(0);
}
// The function closes with "\n};" at column 0 (its body's braces are all tab-indented).
var closeMarker = "\n};";
var closeIdx = src.indexOf(closeMarker, start);
if(closeIdx === -1) {
	console.warn("patch-boot-store-cache: could not find end of loadPluginFolder — leaving unpatched");
	process.exit(0);
}
var insertAt = closeIdx + closeMarker.length;

var wrapper = [
	"",
	"",
	"// --- TiddlyDesktop: v8-serialized loadPluginFolder cache (see bin/patch-boot-store-cache.js) ---",
	"// Skips re-reading + re-parsing + re-stringifying packed plugins (esp. the 1.97 MB $:/core) each",
	"// boot. Enabled via TW_STORE_CACHE_DIR; degrades to the original on any problem.",
	"(function() {",
	"\tvar _origLoadPluginFolder = $tw.loadPluginFolder;",
	"\t$tw.loadPluginFolder = function(filepath,excludeRegExp) {",
	"\t\tvar _dir = process.env.TW_STORE_CACHE_DIR;",
	"\t\tif(!_dir || $tw.browser) { return _origLoadPluginFolder(filepath,excludeRegExp); }",
	"\t\tvar _fs, _path, _v8, _crypto;",
	"\t\ttry { _fs = require(\"fs\"); _path = require(\"path\"); _v8 = require(\"v8\"); _crypto = require(\"crypto\"); }",
	"\t\tcatch(e) { return _origLoadPluginFolder(filepath,excludeRegExp); }",
	"\t\ttry {",
	"\t\t\t// Cheap validity key from mtimes/sizes (no read). Non-plugin folders have no plugin.info,",
	"\t\t\t// so statSync throws → fall through to the original (which returns null for them).",
	"\t\t\tvar _info = _fs.statSync(filepath + _path.sep + \"plugin.info\");",
	"\t\t\tvar _h = _crypto.createHash(\"sha1\").update(filepath + \"|\" + _info.mtimeMs + \"|\" + _info.size + \"|\" + String(excludeRegExp || \"\"));",
	"\t\t\ttry { var _cs = _fs.statSync(filepath + _path.sep + \"contents.json\"); _h.update(\"|c|\" + _cs.mtimeMs + \"|\" + _cs.size); } catch(e) {}",
	"\t\t\tvar _cacheFile = _path.join(_dir, \"v8-\" + ((process.versions && process.versions.v8) || \"x\"), _h.digest(\"hex\") + \".plug\");",
	"\t\t\ttry { return _v8.deserialize(_fs.readFileSync(_cacheFile)); } catch(e) {}",
	"\t\t\tvar _result = _origLoadPluginFolder(filepath,excludeRegExp);",
	"\t\t\tif(_result) {",
	"\t\t\t\ttry { _fs.mkdirSync(_path.dirname(_cacheFile), {recursive: true}); _fs.writeFileSync(_cacheFile, _v8.serialize(_result)); } catch(e) {}",
	"\t\t\t}",
	"\t\t\treturn _result;",
	"\t\t} catch(e) {",
	"\t\t\treturn _origLoadPluginFolder(filepath,excludeRegExp);",
	"\t\t}",
	"\t};",
	"})();"
].join("\n");

src = src.slice(0, insertAt) + wrapper + src.slice(insertAt);
fs.writeFileSync(file, src);
console.log("patch-boot-store-cache: injected loadPluginFolder cache into " + file);
