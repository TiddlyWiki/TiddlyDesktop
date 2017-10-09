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
		var internalLink = $tw.desktop.utils.dom.findParentWithClass(event.target,"tc-tiddlylink tw-tiddlylink tiddlyLink");
		if(!internalLink) {
			$tw.desktop.gui.Shell.openExternal(event.target.getAttribute("href"));
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
};

})();
