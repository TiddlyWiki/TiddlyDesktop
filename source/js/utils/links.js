/*
Utilities concerned with handling TiddlyDesktop links
*/

(function(){

/*jslint browser: true */
"use strict";

// Helper to trap wikilinks within a window
exports.trapLinks = function(doc) {
	doc.addEventListener("click",function(event) {
		// Check that we're not in an internal link
		// "tc-tiddlylink" is for TW5, "tiddlyLink" for TWC
		var link = $tw.desktop.utils.dom.findParentWithTag(event.target,"a");
		if(link) {
			var href;
			if(link.namespaceURI === "http://www.w3.org/2000/svg") {
				// SVG
				href = link.href.baseVal.split("#");
				href = (href[0] || doc.location.href.split("#")[0]) + "#" + href[1];
			} else {
				// HTML
				href = link.href;
			}
			if(href && href.slice(0,11) !== "javascript:" && href.slice(0,5) !== "blob:" && href.slice(0,5) !== "data:" && href.split("#")[0] !== doc.location.href.split("#")[0]) {
				$tw.desktop.gui.Shell.openExternal(href);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
		}
		return true;
	},false);
};

})();
