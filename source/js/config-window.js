(function(){

/*jslint browser: true */
"use strict";

var devTools = require("../js/dev-tools.js")

/*
Open a window showing a specified tiddler. Options include:
html: filename of html file to use as a template (defaults to "html/config-window.html")
tiddler: title of tiddler to be displayed
*/
function ConfigWindow(options) {
	var self = this;
	// Check parameters
	var html = options.html || "html/config-window.html";
	// Create the window
	this.window = options.gui.Window.get(window.open(html));
	this.window.on("loaded",function() {
		var doc = self.window.window.document;
		// Trap developer tools on F12
		devTools.trapDevTools(self.window,self.window.window.document);
		// Set up the styles
		self.styleWidgetNode = $tw.wiki.makeTranscludeWidget("$:/core/ui/PageStylesheet",{document: $tw.fakeDocument});
		self.styleContainer = $tw.fakeDocument.createElement("style");
		self.styleWidgetNode.render(self.styleContainer,null);
		self.styleElement = doc.createElement("style");
		self.styleElement.innerHTML = self.styleContainer.textContent;
		doc.head.insertBefore(self.styleElement,doc.head.firstChild);
		$tw.wiki.addEventListener("change",$tw.perf.report("styleRefresh",function(changes) {
			if(self.styleWidgetNode.refresh(changes,self.styleContainer,null)) {
				self.styleElement.innerHTML = self.styleContainer.textContent;
			}
		}));
		// Render the tiddler
		self.widgetNode = $tw.wiki.makeTranscludeWidget(options.tiddler,{document: doc, parentWidget: $tw.rootWidget});
		self.pageContainer = doc.createElement("div");
		$tw.utils.addClass(self.pageContainer,"tc-page-container-wrapper");
		doc.body.insertBefore(self.pageContainer,doc.body.firstChild);
		self.widgetNode.render(self.pageContainer,null);
		// Add the change event handler
		$tw.wiki.addEventListener("change",function(changes) {
			self.widgetNode.refresh(changes,self.pageContainer,null);
		});
	});
}

exports.open = function(options) {
	return new ConfigWindow(options);
};

})();
