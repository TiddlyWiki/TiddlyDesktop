/*
Utilities concerned with nwjs features
*/

"use strict";

exports.captureWindowToTiddler = function(window_nwjs,tiddlerTitle,callback) {
	if(tiddlerTitle) {
		window_nwjs.capturePage(function(imgDataUri) {
			var imgPrefix = "data:image/png;base64,",
				imgData = "";
			if(imgDataUri.substr(0,imgPrefix.length) == imgPrefix) {
				imgData = imgDataUri.substr(imgPrefix.length);
			}
			$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getModificationFields(),
				{title: tiddlerTitle, type: "image/png", text: imgData}));
			if(callback) {
				callback();				
			}
		},"png");
	} else {
		if(callback) {
			callback();				
		}
	}
};
