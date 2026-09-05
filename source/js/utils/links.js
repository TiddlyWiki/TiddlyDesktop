/*
Utilities concerned with handling TiddlyDesktop links
*/

"use strict";

// Helper to trap wikilinks within a window
exports.trapLinks = function(doc) {
	var getLinkHref = function(link) {
		if(link.namespaceURI === "http://www.w3.org/2000/svg") {
			// SVG
			var href = link.href.baseVal.split("#");
			return (href[0] || doc.location.href.split("#")[0]) + "#" + href[1];
		}
		// HTML
		return link.href;
	};

	var getNonTiddlyLink = function(event) {
		var link = $tw.desktop.utils.dom.findParentWithTag(event.target,"a");
		var isTiddlyLink = link && (link.classList.contains("tc-tiddlylink") || link.classList.contains("tiddlyLink"));
		return link && !isTiddlyLink ? link : null;
	};

	doc.addEventListener("click",function(event) {
		// Check that we're not in an internal link
		// "tc-tiddlylink" is for TW5, "tiddlyLink" for TWC
		var link = $tw.desktop.utils.dom.findParentWithTag(event.target,"a");
		if(link) {
			var href = getLinkHref(link);
			if(href && href.slice(0,11) !== "javascript:" && href.slice(0,5) !== "blob:" && href.slice(0,5) !== "data:" && href.split("#")[0] !== doc.location.href.split("#")[0]) {
				$tw.desktop.gui.Shell.openExternal(href);
				event.preventDefault();
				event.stopPropagation();
				return false;
			}
		}
		return true;
	},false);

	doc.addEventListener("mouseover",function(event) {
		var link = getNonTiddlyLink(event);
		if(link) {
			var href = getLinkHref(link);
			if(href) {
				link.title = href;
			}
		}
	},false);

	doc.addEventListener("contextmenu",function(event) {
		var link = getNonTiddlyLink(event);
		if(link) {
			var href = getLinkHref(link);
			if(href) {
				var menu = new nw.Menu();
				menu.append(new nw.MenuItem({
					label: "Copy Link Address",
					click: function() {
						nw.Clipboard.get().set(href);
					}
				}));
				nw.Window.get().focus();
				menu.popup(event.screenX, event.screenY);
				event.preventDefault();
			}
		}
	},false);
};
