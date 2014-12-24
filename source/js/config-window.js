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
function ConfigWindow(options,configWindowIdentifier) {
	var self = this;
	// Check parameters
	var html = options.html || "../html/config-window.html",
		variables = options.variables || {};
	// Copy options
	this.configWindowIdentifier = configWindowIdentifier;
	this.captureWindowToTiddler = options.captureWindowToTiddler;
	// Create the window
	this.window = $tw.desktop.gui.Window.open(html,{
		toolbar: false,
		show: false
	});
	// Handler for wiki change events
	function changeHandler(changes) {
		var doc = self.window.window.document;
		// Title changes
		if(self.titleWidgetNode.refresh(changes,self.titleContainer,null)) {
			doc.title = self.titleContainer.textContent;
		}
		// Style changes
		if(self.styleWidgetNode.refresh(changes,self.styleContainer,null)) {
			self.styleElement.innerHTML = self.styleContainer.textContent;
		}
		// Body changes
		self.widgetNode.refresh(changes,self.pageContainer,null);
	}
	// When the window is loaded
	this.window.once("loaded",function() {
		var doc = self.window.window.document;
		// Position and show the window
		self.moveAndResizeWindow();
		self.window.show();
		self.window.focus();
		// Trap developer tools on F12
		devTools.trapDevTools(self.window,self.window.window.document);
// self.window.showDevTools();
		// Set up the title
		self.titleWidgetNode = $tw.wiki.makeTranscludeWidget(options.tiddler,{field: "page-title", document: $tw.fakeDocument, parseAsInline: true, variables: variables});
		self.titleContainer = $tw.fakeDocument.createElement("div");
		self.titleWidgetNode.render(self.titleContainer,null);
		doc.title = self.titleContainer.textContent;
		// Set up the styles
		self.styleWidgetNode = $tw.wiki.makeTranscludeWidget("$:/core/ui/PageStylesheet",{document: $tw.fakeDocument, variables: variables});
		self.styleContainer = $tw.fakeDocument.createElement("style");
		self.styleWidgetNode.render(self.styleContainer,null);
		self.styleElement = doc.createElement("style");
		self.styleElement.innerHTML = self.styleContainer.textContent;
		doc.head.insertBefore(self.styleElement,doc.head.firstChild);
		// Render the tiddler
		self.widgetNode = $tw.wiki.makeTranscludeWidget(options.tiddler,{document: doc, parentWidget: $tw.rootWidget, variables: variables});
		self.pageContainer = doc.createElement("div");
		$tw.utils.addClass(self.pageContainer,"tc-page-container-wrapper");
		doc.body.insertBefore(self.pageContainer,doc.body.firstChild);
		self.widgetNode.render(self.pageContainer,null);
		// Add the change event handler
		$tw.wiki.addEventListener("change",changeHandler);
		// Invoke the callback if provided
		if(options.callback) {
			options.callback();
		}
		// Capture the window in 1000ms
		setTimeout(function() {self.captureWindow();},1000);
	});
	// Trap closing the window
	this.window.on("close",function(event) {
		// Capture the window
		self.captureWindow(function() {
			// Remove this window from the open list
			if($tw.utils.hop(configWindows,self.configWindowIdentifier)) {
				delete configWindows[self.configWindowIdentifier];
			}
			// Remove our wiki change event handler
			$tw.wiki.removeEventListener("change",changeHandler);
			// Close the window
			self.window.close(true);
		});
	});
	// Trap moving or resizing the window
	function moveHandler() {
		var data = self.getWindowConfigData();
		data.x = self.window.x;
		data.y = self.window.y;
		data.width = self.window.width;
		data.height = self.window.height;
		self.saveWindowConfigData(data);
	}
	this.window.on("move",moveHandler);
	this.window.on("resize",moveHandler);
}

ConfigWindow.prototype.getWindowConfigData = function() {
	return $tw.wiki.getTiddlerData("config of " + this.configWindowIdentifier,{});
};

ConfigWindow.prototype.saveWindowConfigData = function(data) {
	$tw.wiki.setTiddlerData("config of " + this.configWindowIdentifier,data);
};

ConfigWindow.prototype.moveAndResizeWindow = function() {
	var data = this.getWindowConfigData();
	if(data.x) {
		this.window.x = data.x;
	}
	if(data.y) {
		this.window.y = data.y;
	}
	if(data.width) {
		this.window.width = data.width;
	}
	if(data.height) {
		this.window.height = data.height;
	}
};

ConfigWindow.prototype.captureWindow = function(callback) {
	var self = this;
	if(this.captureWindowToTiddler) {
		this.window.capturePage(function(imgDataUri) {
			var imgPrefix = "data:image/png;base64,",
				imgData = "";
			if(imgDataUri.substr(0,imgPrefix.length) == imgPrefix) {
				imgData = imgDataUri.substr(imgPrefix.length);
			}
			$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getModificationFields(),
				{title: self.captureWindowToTiddler, type: "image/png", text: imgData}));
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

function open(options) {
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
		configWindow = new ConfigWindow(options,configWindowIdentifier);
		configWindows[configWindowIdentifier] = configWindow;
	}
	return configWindow;
}

/*
Opens a host window for the specified URL
*/
function openHostWindowByUrl(url) {
	// Create or update the corresponding wikilist tiddler
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getModificationFields(),{title: url, tags: ["wikilist"]}));
	// Open the window
	var hostWindow = open({
		tiddler: "HostWindow",
		variables: {
			"currentTiddler": url
		},
		captureWindowToTiddler: "img of " + url
	});
}

/*
Opens a host window for the specified path
*/
function openHostWindowByPath(pathname) {
	openHostWindowByUrl(convertPathToFileUrl(pathname));
}

function convertPathToFileUrl(path) {
	// File prefix depends on platform
	var fileUriPrefix = "file://";
	if(process.platform.substr(0,3) === "win") {
		fileUriPrefix = fileUriPrefix + "/";
	}
	return fileUriPrefix + path.replace(/\\/g,"/");
}

exports.open = open;
exports.openHostWindowByUrl = openHostWindowByUrl;
exports.openHostWindowByPath = openHostWindowByPath;

})();
