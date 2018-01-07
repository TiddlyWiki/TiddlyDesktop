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
			var href = link.getAttribute("href");
			if (doc.location.protocol === "file:" && href.substr(0, 5) === 'file:') {
				// File links - open as local files
				var locationPathParts = doc.location.pathname.split("/").slice(0,-1).map(decodeURIComponent),
					filePathParts = href.substr(5).split(/[\\\/]/mg).map(decodeURIComponent),
					url = locationPathParts.join('/') + '/' + filePathParts.join('/');
				$tw.desktop.gui.Shell.openItem(url);
			} else {
				$tw.desktop.gui.Shell.openExternal(href);
			}
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
};

})();
