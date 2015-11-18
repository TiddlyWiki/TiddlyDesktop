/*
Utilities concerned with file and path manipulation
*/

(function(){

/*jslint browser: true */
"use strict";

exports.convertFileUrlToPath = function(url) {
	var os = require("os"),
		pathname = url,
		fileUriPrefix = "file://";
	if(process.platform.substr(0,3) === "win") {
		fileUriPrefix = fileUriPrefix + "/";
	}
	if(pathname.substr(0,fileUriPrefix.length) === fileUriPrefix) {
		pathname = pathname.substr(fileUriPrefix.length);
	}
	return pathname;
};

exports.convertPathToFileUrl = function(path) {
	// File prefix depends on platform
	var fileUriPrefix = "file://";
	if(process.platform.substr(0,3) === "win") {
		fileUriPrefix = fileUriPrefix + "/";
	}
	return fileUriPrefix + path.replace(/\\/g,"/");
}

})();
