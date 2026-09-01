/*
Serves utils/classic-local-inject.js to the wiki server, which injects it into the head of a
TiddlyWiki Classic document before the document's own scripts run. See that file for what it does
and why it has to run that early.
*/

"use strict";

var cached = null;

/*
Whether a document about to be served is a TiddlyWiki Classic.

Every Classic carries its shadow tiddlers in a `<div id="shadowArea">`; TW5 keeps its shadows in
plugins and writes no such element. Deliberately neither of the two markers that look more obvious
and are not: `#storeArea` is written by TW5 as well, for the benefit of 5.1.x tooling, and the
`versionArea` id only arrived in 2.4, so keying on it would miss the older files this has to
recognise.

Matching the id attribute rather than the bare word, so that a TiddlyWiki 5 wiki that merely writes
about `shadowArea` in a tiddler is not taken for a Classic. Testing the raw bytes is only a filter
in any case: the injected code identifies the document properly before it changes anything.
*/
exports.isClassic = function(html) {
	return (/\bid=["']?shadowArea\b/).test(html.toString("utf8"));
};

/*
The script to inject, with the data it needs defined ahead of it: the absolute pathname of the
wiki file, which is the one thing the injected code cannot work out for itself.
*/
exports.source = function(options) {
	if(cached === null) {
		var fs = require("fs"),
			path = require("path");
		cached = fs.readFileSync(path.resolve(path.dirname(module.filename),"classic-local-inject.js"),"utf8");
	}
	return "window.tiddlywikiFilePath=" + JSON.stringify(String(options.pathname || "")) + ";\n\n" + cached;
};
