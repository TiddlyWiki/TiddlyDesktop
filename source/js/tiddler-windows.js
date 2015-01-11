(function(){

/*jslint browser: true */
"use strict";

var devTools = require("../js/dev-tools.js"),
	slaveWiki = require("../js/slave-wiki.js"),
	path = require("path"),
	fs = require("fs");

/*
A hashmap of TiddlerWindow objects for open windows. The key is the tiddler title and the values of all specified variables, concatenated with a vertical bar. For example:
"TiddlerTitle|variable:value|variable:value"
Note that the variable names must be sorted
*/
var tiddlerWindows = {};

/*
Make a key for the tiddlerWindows hashmap
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
html: filename of html file to use as a template (defaults to "html/tiddler-window.html")
tiddler: title of tiddler to be displayed
callback: optional callback to be invoked when the window has loaded
variables: optional hashmap of variables to be passed to the widget trees
*/
function TiddlerWindow(options,tiddlerWindowIdentifier) {
	var self = this;
	// Check parameters
	var html = options.html || "../html/tiddler-window.html",
		variables = options.variables || {};
	// Copy options
	this.tiddlerWindowIdentifier = tiddlerWindowIdentifier;
	this.captureWindowToTiddler = options.captureWindowToTiddler;
	this.tiddler = options.tiddler;
	// Initialisation
	this.removeOnClose = false; // Flag for removing a window from the list when closing it
	// Set up the title
	this.titleWidgetNode = $tw.wiki.makeTranscludeWidget(options.tiddler,{field: "page-title", document: $tw.fakeDocument, parseAsInline: true, variables: variables});
	this.titleContainer = $tw.fakeDocument.createElement("div");
	this.titleWidgetNode.render(this.titleContainer,null);
	var pageTitle = this.titleContainer.textContent,
		configData = this.getWindowConfigData();
	// Create the window
	var packageJson = require("../package.json");
	this.window = $tw.desktop.gui.Window.open(html,{
		toolbar: false,
		show: false,
		title: pageTitle,
		x: "x" in configData ? configData.x : undefined,
		y: "y" in configData ? configData.y : undefined,
		width: "width" in configData ? configData.width : packageJson.window.width,
		height: "height" in configData ? configData.height : packageJson.window.height,
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
		// Show the window
		self.window.show();
		self.window.focus();
		// Trap developer tools on F12
		devTools.trapDevTools(self.window,self.window.window.document);
// self.window.showDevTools();
		// Trap external links
		$tw.desktop.trapLinks(doc);
		// Make $tw available in the window
		self.window.window.$tw = $tw;
		// Set up the title
		doc.title = pageTitle;
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
	var closeHandler = function(event) {
		// Remove this window from the open list
		if($tw.utils.hop(tiddlerWindows,self.tiddlerWindowIdentifier)) {
			delete tiddlerWindows[self.tiddlerWindowIdentifier];
		}
		// Remove our wiki change event handler
		$tw.wiki.removeEventListener("change",changeHandler);
		// Close the window
		self.window.close(true);
	};
	this.window.on("close",function(event) {
		// Check the window is happy to close (only works for TiddlyWiki Classic)
		var iframes = self.window.window.document.getElementsByTagName("iframe");
		for(var t=0; t<iframes.length; t++) {
			var onbeforeunload = iframes[t].contentWindow.onbeforeunload;
			if(onbeforeunload) {
				var msg = onbeforeunload({});
				if(msg && !self.window.window.confirm(msg + "\n\nAre you sure you wish to leave this page?")) {
					return false;
				}				
			}
		}
		// Delete tiddlers if the window should be removed
		if(self.removeOnClose) {
			closeHandler(event);
		} else {
			// Capture the window
			self.captureWindow(function() {
				closeHandler(event)
			});
		}
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
	this.window.on("resize",function() {
		moveHandler();
		self.captureWindow();
	});
}

TiddlerWindow.prototype.getWindowConfigData = function() {
	return $tw.wiki.getTiddlerData("$:/TiddlyDesktop/Config/" + this.tiddlerWindowIdentifier,{});
};

TiddlerWindow.prototype.saveWindowConfigData = function(data) {
	$tw.wiki.setTiddlerData("$:/TiddlyDesktop/Config/" + this.tiddlerWindowIdentifier,data);
};

TiddlerWindow.prototype.moveAndResizeWindow = function() {
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

TiddlerWindow.prototype.captureWindow = function(callback) {
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
	var tiddlerWindowIdentifier = makeWindowIdentifier(options.tiddler,options.variables || {}),
		tiddlerWindow = findTiddlerWindow(tiddlerWindowIdentifier);
	if(tiddlerWindow) {
		// If so, activate it and return it
		try {
			tiddlerWindow.window.focus();
		} catch(e) {
			console.log("WARNING: Focusing existing tiddler window failed '" + options.tiddler + "'");
		}
	} else {
		// Otherwise create the new window
		tiddlerWindow = new TiddlerWindow(options,tiddlerWindowIdentifier);
		tiddlerWindows[tiddlerWindowIdentifier] = tiddlerWindow;
	}
	return tiddlerWindow;
}

function findTiddlerWindow(tiddlerWindowIdentifier) {
	if($tw.utils.hop(tiddlerWindows,tiddlerWindowIdentifier)) {
		return tiddlerWindows[tiddlerWindowIdentifier];
	} else {
		return null;
	}
}

/*
Opens a host window for the specified URL
*/
function openHostWindowByUrl(url) {
	// Create or update the corresponding wikilist tiddler
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getTiddler(url),$tw.wiki.getModificationFields(),{title: url, tags: ["wikilist"]}));
	// Open the window
	var hostWindow = open({
		tiddler: "HostWindow",
		variables: {
			"currentTiddler": url
		},
		captureWindowToTiddler: "$:/TiddlyDesktop/Thumbnail/" + url
	});
}

/*
Opens a host window for the specified path
*/
function openHostWindowByPath(pathname) {
	openHostWindowByUrl(convertPathToFileUrl(pathname));
}

/*
Removes host window for the specified URL
*/
function removeHostWindowByUrl(url) {
	var tiddlerWindowIdentifier = makeWindowIdentifier("HostWindow",{"currentTiddler": url}),
		tiddlerWindow = findTiddlerWindow(tiddlerWindowIdentifier);
	if(tiddlerWindow) {
		tiddlerWindow.removeOnClose = true;
		tiddlerWindow.window.close();
	}
	// Delete the tiddlers for this window
	$tw.wiki.deleteTiddler(url);
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/" + url);
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Thumbnail/" + url);
}

/*
Navigate backwards for the host window for the specified URL
*/
function navigateBackForHostWindowByUrl(url) {
	findHostWindowIframe(url,function(tiddlerWindow,iframe) {
		iframe.contentWindow.history.back()
	});
}

/*
Navigate forwards for the host window for the specified URL
*/
function navigateForwardForHostWindowByUrl(url) {
	findHostWindowIframe(url,function(tiddlerWindow,iframe) {
		iframe.contentWindow.history.forward()
	});
}

/*
Show devtools for the host window for the specified URL
*/
function showDevToolsForHostWindowByUrl(url) {
	findHostWindowIframe(url,function(tiddlerWindow,iframe) {
		tiddlerWindow.window.showDevTools(iframe);
	});
}

/*
Create a new wiki of the specified edition
*/
function createNewWiki(edition,pathname) {
console.log("in createNewWiki",edition,pathname)
	// Use a slave wiki to create the new file
	slaveWiki.runSlaveWiki([path.resolve(path.dirname(module.filename),"../tiddlywiki/editions/",edition),"--verbose","--rendertiddler","$:/core/save/all",pathname,"text/plain"]);
	// Add it and open it
	openHostWindowByPath(pathname);
}

function findHostWindowIframe(url,callback) {
	var tiddlerWindowIdentifier = makeWindowIdentifier("HostWindow",{"currentTiddler": url}),
		tiddlerWindow = findTiddlerWindow(tiddlerWindowIdentifier);
	if(tiddlerWindow) {
		var iframes = tiddlerWindow.window.window.document.getElementsByClassName("td-wiki-frame");
		if(iframes.length > 0) {
			callback(tiddlerWindow,iframes[0]);		
		}
	}
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
exports.removeHostWindowByUrl = removeHostWindowByUrl;
exports.showDevToolsForHostWindowByUrl = showDevToolsForHostWindowByUrl;
exports.navigateBackForHostWindowByUrl = navigateBackForHostWindowByUrl;
exports.navigateForwardForHostWindowByUrl = navigateForwardForHostWindowByUrl;
exports.createNewWiki = createNewWiki;

})();
