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
plugins and has no such element. Deliberately not the `versionArea` id that the rest of the Classic
support keys on — that one was only introduced in 2.4, and this has to recognise the older files
too. Testing the raw bytes is only a filter, and a coarse one: the injected code identifies the
document properly before it changes anything, so a TW5 wiki with the word in a tiddler costs an
inert script and nothing else.
*/
exports.isClassic = function(html) {
	return html.indexOf("shadowArea") !== -1;
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
