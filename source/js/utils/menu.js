/*
Utilities concerned with nwjs menu bars
*/

"use strict";

exports.createMenuBar = function(win) {
	if(process.platform === "darwin") {	
		var menuBar = new $tw.desktop.gui.Menu({type:"menubar"});
		menuBar.createMacBuiltin("TiddlyDesktop");
		win.menu = menuBar;
	}
};
