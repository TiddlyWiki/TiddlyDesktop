/*
Collapse each bundled plugin / theme / language / core folder in source/tiddlywiki into two
files: its plugin.info manifest and a single contents.json holding every constituent tiddler.

TiddlyWiki loads a folder plugin with $tw.loadPluginFolder, which reads plugin.info plus EVERY
other file in the folder (recursively) — a language plugin is ~72 files, core is ~1100. On
Windows each file open is scanned by Defender, so booting the backstage wiki (core + 34
languages + themes + plugins ≈ 3000 files) stalls for ~20s; Linux serves the same reads from
the page cache in about a second. Packing each folder to two files cuts those thousands of
reads to a few dozen with no change in what loadPluginFolder produces — the packed contents.json
is exactly the tiddler set it would have assembled from the loose files.

Runs from bld.sh AFTER the translations and plugin-priority steps, so the injected strings and
the priority-100 marker (both written into plugin.info / extra files) are captured in the pack.

Usage: node bin/pack-bundled-plugins.js <tiddlywiki-dir>
*/

"use strict";

var fs = require("fs"),
	path = require("path");

var twDir = process.argv[2];
if(!twDir) {
	console.error("usage: pack-bundled-plugins.js <tiddlywiki-dir>");
	process.exit(1);
}

// Boot a throwaway TiddlyWiki from the bundled core purely to get a fully wired $tw.loadPluginFolder
// (it needs the deserializers and $tw.utils that boot installs). We point it at no real wiki.
var $tw = require(path.resolve(twDir, "boot/bootprefix.js")).bootprefix({});
require(path.resolve(twDir, "boot/boot.js")).TiddlyWiki($tw);

// loadPluginFolder is available once the boot kernel has run its synchronous setup. boot() takes a
// callback; everything we need ($tw.loadPluginFolder, deserializers) is ready inside it.
$tw.boot.argv = [twDir];	// harmless target; we never use the booted wiki, only the loader
$tw.boot.boot(function() {
	var roots = ["core", "core-server", "plugins", "themes", "languages", "languages-backstage"].map(function(d) {
		return path.resolve(twDir, d);
	});
	var packed = 0, filesBefore = 0, filesAfter = 0;

	function countFiles(dir) {
		var n = 0;
		(function walk(d) {
			var entries;
			try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch(e) { return; }
			entries.forEach(function(en) {
				if(en.isDirectory()) { walk(path.join(d, en.name)); } else { n++; }
			});
		}(dir));
		return n;
	}

	function packFolder(dir) {
		var info = $tw.loadPluginFolder(dir);
		if(!info || !info.text) { return; }
		var inner = JSON.parse(info.text).tiddlers;
		var arr = Object.keys(inner).map(function(title) { return inner[title]; });
		filesBefore += countFiles(dir);
		// Remove everything except the manifest, then write the single packed file. loadPluginFolder
		// reads plugin.info (the plugin's own fields) plus contents.json (deserialised to the tiddlers).
		fs.readdirSync(dir).forEach(function(name) {
			if(name === "plugin.info") { return; }
			fs.rmSync(path.join(dir, name), {recursive: true, force: true});
		});
		fs.writeFileSync(path.join(dir, "contents.json"), JSON.stringify(arr));
		filesAfter += countFiles(dir);
		packed++;
	}

	// Find every folder that carries a plugin.info (a loadable plugin/theme/language/core), without
	// descending into one we have identified — its own tiddlers never contain a nested plugin.info.
	function findPlugins(dir, out) {
		var entries;
		try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch(e) { return; }
		if(entries.some(function(en) { return en.isFile() && en.name === "plugin.info"; })) {
			out.push(dir);
			return;
		}
		entries.forEach(function(en) { if(en.isDirectory()) { findPlugins(path.join(dir, en.name), out); } });
	}

	var pluginDirs = [];
	roots.forEach(function(r) { if(fs.existsSync(r)) { findPlugins(r, pluginDirs); } });
	pluginDirs.forEach(packFolder);

	console.log("pack-bundled-plugins: packed " + packed + " folders, " +
		filesBefore + " files -> " + filesAfter);
});
