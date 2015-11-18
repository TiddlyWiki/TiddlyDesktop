/*
Utilities concerned with nwjs menu bars
*/

(function(){

/*jslint browser: true */
"use strict";

exports.createMenuBar = function() {
	var menuBar = new $tw.desktop.gui.Menu({type:"menubar"});
	if(process.platform === "darwin") {
		menuBar.createMacBuiltin("TiddlyDesktop");
	}
	return menuBar;
};

})();
