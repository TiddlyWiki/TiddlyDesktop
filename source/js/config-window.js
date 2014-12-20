(function(){

/*jslint browser: true */
"use strict";

var devTools = require("../js/dev-tools.js");

/*
A hashmap of ConfigWindow objects for open windows. The key is the tiddler title and the values of all specified variables, concatenated with a vertical bar. For example:
"TiddlerTitle|variable:value|variable:value"
Note that the variable names must be sorted
*/
var configWindows = {};

/*
Make a key for the configWindows hashmap
*/
function makeWindowIdentifier(tiddler,variables) {
	var result = [tiddler],
		variableNames = Object.keys(variables).sort(),
		name;
	for(var t=0; t<variableNames.length; t++) {
		name = variableNames[t];
		result.push(encodeURIComponent(name + ":" + variables[name]));
	}
	return result.join("|");
}

/*
Open a window showing a specified tiddler. Options include:
html: filename of html file to use as a template (defaults to "html/config-window.html")
tiddler: title of tiddler to be displayed
callback: optional callback to be invoked when the window has loaded
variables: optional hashmap of variables to be passed to the widget trees
*/
function ConfigWindow(options) {
	var self = this;
	// Check parameters
	var html = options.html || "../html/config-window.html",
		variables = options.variables || {};
	// Create the window
	this.window = $tw.desktop.gui.Window.open(html,{
		toolbar: false
	});
	this.window.once("loaded",function() {
		var doc = self.window.window.document;
		// Trap developer tools on F12
		devTools.trapDevTools(self.window,self.window.window.document);
		// Set up the styles
		self.styleWidgetNode = $tw.wiki.makeTranscludeWidget("$:/core/ui/PageStylesheet",{document: $tw.fakeDocument, variables: variables});
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
		self.widgetNode = $tw.wiki.makeTranscludeWidget(options.tiddler,{document: doc, parentWidget: $tw.rootWidget, variables: variables});
		self.pageContainer = doc.createElement("div");
		$tw.utils.addClass(self.pageContainer,"tc-page-container-wrapper");
		doc.body.insertBefore(self.pageContainer,doc.body.firstChild);
		self.widgetNode.render(self.pageContainer,null);
		// Add the change event handler
		$tw.wiki.addEventListener("change",function(changes) {
			self.widgetNode.refresh(changes,self.pageContainer,null);
		});
		// Invoke the callback if provided
		if(options.callback) {
			options.callback();
		}
	});
}

exports.open = function(options) {
	// Check if the window already exists
	var configWindowIdentifier = makeWindowIdentifier(options.tiddler,options.variables || {}),
		configWindow;
	if($tw.utils.hop(configWindows,configWindowIdentifier)) {
		// If so, activate it and return it
		configWindow = configWindows[configWindowIdentifier];
		try {
			configWindow.window.focus();
		} catch(e) {
			console.log("WARNING: Focusing existing config window failed '" + options.tiddler + "'");
		}
	} else {
		// Otherwise create the new window
		configWindow = new ConfigWindow(options);
		configWindows[configWindowIdentifier] = configWindow;
	}
	return configWindow;
};

})();
