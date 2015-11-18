/*
Utilities concerned with handling TiddlyDesktop links
*/

(function(){

/*jslint browser: true */
"use strict";

// Helper to trap wikilinks within a window
exports.trapLinks = function(doc) {
	doc.addEventListener("click",function(event) {
		// See if we're in an interwiki link
		var interwikiLink = $tw.desktop.utils.dom.findParentWithClass(event.target,"tc-interwiki-link") || $tw.desktop.utils.dom.findParentWithClass(event.target,"tw-interwiki-link");
		if(interwikiLink) {
			$tw.desktop.openWiki(interwikiLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		// See if we're in an external link
		// "tw-tiddlylink-external" is for TW5, "externallink" for TWC
		var externalLink = $tw.desktop.utils.dom.findParentWithClass(event.target,"tc-tiddlylink-external tw-tiddlylink-external externalLink");
		if(externalLink) {
			gui.Shell.openExternal(externalLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
};

})();
