(function(){

/*jslint browser: true */
"use strict";

function runSlaveWiki(argv) {
console.log("in runSlaveWiki",argv)
	var $tw = {
		browser: false,
		node: true,
		nodeWebKit: false
	};
	// First part of boot process
	module.require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);
	// Set command line
	$tw.boot = $tw.boot || {};
	$tw.boot.argv = argv;
	// Main part of boot process
	module.require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);
}

exports.runSlaveWiki = runSlaveWiki;

})();
