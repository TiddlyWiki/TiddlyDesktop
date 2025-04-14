/*
Base class methods for TiddlyDesktop window objects
*/

"use strict";

exports.addBaseMethods = function(proto) {

	proto.getConfigTitle = function(type,identifier) {
		identifier = identifier || this.getIdentifier();
		return "$:/TiddlyDesktop/Config/" + type + "/" + identifier;
	}

	proto.removeFromWikiListOnClose = function() {
		this.mustRemoveFromWikiListOnClose = true;
	};

	proto.onTitleChange = function() {
		var fields = {
			title: this.getConfigTitle("title"),
			text: this.getWikiTitle()
		}
		$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields))
	};

	proto.onFavIconChange = function() {
		var fields = {
			title: this.getConfigTitle("favicon"),
			text: this.getWikiFavIconText(),
			type: this.getWikiFavIconType(),
		}
		$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields))
	};

}
