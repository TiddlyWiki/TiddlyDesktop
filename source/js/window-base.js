/*
Base class methods for TiddlyDesktop window objects
*/

(function(){

/*jslint browser: true */
"use strict";

exports.addBaseMethods = function(proto) {

	proto.getConfigTitle = function(type,identifier) {
		identifier = identifier || this.getIdentifier();
		return "$:/TiddlyDesktop/Config/" + type + "/" + identifier;
	}

	proto.getWindowConfigData = function(type) {
		return $tw.wiki.getTiddlerData(this.getConfigTitle(type),{});
	};

	proto.saveWindowConfigData = function(type,data) {
		$tw.wiki.setTiddlerData(this.getConfigTitle(type),data);
	};

	proto.removeFromWikiListOnClose = function() {
		this.mustRemoveFromWikiListOnClose = true;
	};

	proto.trackWindowLayout = function() {
		var self = this;
		// Start in the normal state
		this.windowState = "normal";
		// Flag to help us handle the fact that users on OS X can manually resize a maximised window so that it is no longer maximised, all without a minimize event. The first resize event after a maximize event is to tell us the size of the maximised window, any further resize events are to take us out of maximized mode
		this.resizesSinceMaximized = 0;
		// Listen for changes to the state
		var win = this.window_nwjs;
		win.on("resize",function () {
// console.log("resize event")
			// if(self.resizesSinceMaximized > 0) {
			// 	self.windowState = "normal";
			// }
			// self.resizesSinceMaximized += 1;
			if(self.windowState === "normal") {
				self.windowWidth = self.window_nwjs.width;
				self.windowHeight = self.window_nwjs.height;
			}
		});
		win.on("move",function () {
// console.log("move event")
			self.windowX = self.window_nwjs.x;
			self.windowY = self.window_nwjs.y;
		});
		win.on("maximize",function () {
// console.log("maximize event")
			self.resizesSinceMaximized = 0;
		    self.windowState = "maximized";
		});
		win.on("unmaximize",function () {
// console.log("unmaximize event")
		    self.windowState = "normal";
		});
		win.on("minimize",function () {
// console.log("minimize event")
		    self.windowState = "minimized";
		});
		win.on("restore",function () {
// console.log("restore event")
		    self.windowState = "normal";
		});
		win.on("enter-fullscreen",function () {
// console.log("enter-fullscreen event")
		    self.windowState = "fullscreen";
		});
		win.on("leave-fullscreen",function () {
// console.log("leave-fullscreen event")
		    self.windowState = "normal";
		});
	};

	proto.getWindowLayout = function() {
		return {
			state: this.windowState,
			x: this.windowX,
			y: this.windowY,
			width: this.windowWidth,
			height: this.windowHeight,
		};
	};

	proto.restoreWindowLayout = function(layout) {
		layout = layout || {};
		var packageJson = require("../package.json"),
			state = layout.state === undefined ? "normal" : layout.state,
			x = layout.x === undefined ? packageJson.window.x : layout.x,
			y = layout.y === undefined ? packageJson.window.y : layout.y,
			width = layout.width === undefined ? packageJson.window.width : layout.width,
			height = layout.height === undefined ? packageJson.window.height : layout.height;
		// Set the position
		this.window_nwjs.moveTo(x,y);
		this.window_nwjs.resizeTo(width,height);
		// Set the window state
		switch(state) {
			case "minimized":
				this.window_nwjs.minimize();
				break;
			case "maximized":
				this.window_nwjs.maximize();
				break;
			case "fullscreen":
				this.window_nwjs.enterFullscreen();
				break;
		}
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

})();
