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
		if(link && !$tw.desktop.utils.dom.hasClass(link,"tc-tiddlylink tw-tiddlylink tiddlyLink")) {
			$tw.desktop.gui.Shell.openExternal(link.getAttribute("href"));
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
};

})();
