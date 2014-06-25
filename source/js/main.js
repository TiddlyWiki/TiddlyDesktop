(function(){

/*jslint browser: true */
"use strict";

var gui = require("nw.gui"),
	fs = require("fs");

// Information about each wiki we're tracking. Each entry is a hashmap with these fields:
// url: full file:// URI of the wiki
// title: last recorded title string for the wiki
// img: URI of thumbnail (usually a data URI)
// isOpen: true if these wiki is currently open
// 
var wikiList = [];
var openedWindows = [];

// Get the main window
var mainWindow = gui.Window.get();
// mainWindow.showDevTools();

// Hacky flag for when we're shutting down
var shuttingDown = false;

// Get the current wikiList
loadWikiList();

// Close all windows when the current window is closed
mainWindow.on("close",function() {
	shuttingDown = true;
	gui.App.closeAllWindows();
	gui.App.quit();
});

// Show dev tools on F12
trapDevTools(mainWindow,document);

// Trap clicks on wikilinks
trapLinks(document);

// Render the wiki list
renderWikiList(document);

// Open any windows that should be open
mainWindow.on("loaded",function() {
	wikiList.forEach(function(wikiInfo,index) {
		if(wikiInfo.isOpen) {
			openWiki(wikiInfo.url);
		}
	});
});

// Event handlers for browsing for a new wiki
var chooseWiki = document.getElementById("chooseWiki");
chooseWiki.addEventListener("change",function(event) {
	openWikiIfNotOpen(convertPathToFileUrl(chooseWiki.value));
},false);
var btnChooseWiki = document.getElementById("btnChooseWiki");
btnChooseWiki.addEventListener("click",function(event) {
	chooseWiki.click();
},false);

function convertPathToFileUrl(path) {
	// File prefix depends on platform
	var fileUriPrefix = "file://";
	if(process.platform.substr(0,3) === "win") {
		fileUriPrefix = fileUriPrefix + "/";
	}
	return fileUriPrefix + path.replace(/\\/g,"/");
}

function openWikiIfNotOpen(wikiUrl) {
	var wikiInfo = findwikiInfo(wikiUrl);
	if(!wikiInfo || !wikiInfo.isOpen) {
		console.log("Now opening wiki");
		openWiki(wikiUrl);
	} else if (wikiInfo.isOpen) {
        openedWindows[wikiUrl].focus();
    }
}

// Helper to open a TiddlyWiki in a new window
function openWiki(wikiUrl) {
    console.log("Opening wiki",wikiUrl);
	// Add the path to the wikiList if not already there
    var wikiInfo = findwikiInfo(wikiUrl);
	if(wikiInfo === null) {
		wikiInfo = {url: wikiUrl};
		wikiList[wikiList.length] = wikiInfo;
	}
	// Save the wiki list and update it in the DOM
	wikiInfo.isOpen = true;
	saveWikiList();
	renderWikiList();
	// Open the window
	var newWindow = gui.Window.open("./host.html",{
		toolbar: false,
		focus: true,
		width: 1024,
		height: 768,
		"min_width": 400,
		"min_height": 200
	});
    openedWindows[wikiUrl] = newWindow;
	// Trap close event
	newWindow.on("close",function() {
		if(!shuttingDown) {
			wikiInfo.isOpen = false;
            delete openedWindows[wikiInfo.url];
			saveWikiList();
            renderWikiList();
		}
		this.close(true);
	});
	// Set up the new window when loaded
	var haveSetSrc = false,
		haveDisplayedError = false;
	newWindow.on("loaded",function() {
		// newWindow.showDevTools();
		var hostIframe = newWindow.window.document.getElementById("twFrame");
		if(hostIframe.src !== encodeURI(wikiUrl)) {
			hostIframe.addEventListener("load",function(event) {
				setTimeout(function() {
					newWindow.capturePage(function(imgDataUri) {
						wikiInfo.img = imgDataUri;
						var title = hostIframe.contentWindow.document.title;
						newWindow.window.document.title = title;
						wikiInfo.title = title;
						saveWikiList();
						renderWikiList();
					},"png");
				},500);
				enableSaving(hostIframe.contentWindow,wikiUrl);
				trapDevTools(newWindow,hostIframe.contentWindow.document)
				trapLinks(hostIframe.contentWindow.document);
				saveWikiList();
				renderWikiList();
				event.stopPropagation();
				event.preventDefault();
				return false;
			},false);
			if(!haveSetSrc) {
				hostIframe.src = wikiUrl;
				haveSetSrc = true;
			} else {
				if(!haveDisplayedError) {
					mainWindow.window.console.log("Filenotfound")
					newWindow.window.showError("File not found: " + wikiUrl)
					haveDisplayedError = true;
				}
			}
		}
	});
}

// Helper to enable TiddlyFox-style saving for a window
function enableSaving(win,wikiUrl) {
	// Create the message box
	var doc = win.document,
		messageBox = doc.createElement("div");
	messageBox.id = "tiddlyfox-message-box";
	doc.body.appendChild(messageBox);
	// Inject saving code into TiddlyWiki classic
	if(isTiddlyWikiClassic(doc)) {
		injectClassicOverrides(doc);
	}
	// Listen for save events
	messageBox.addEventListener("tiddlyfox-save-file",function(event) {
		// Get the details from the message
		var message = event.target,
			path = message.getAttribute("data-tiddlyfox-path"),
			content = message.getAttribute("data-tiddlyfox-content");
		// Save the file
		saveFile(path,content);
		// Remove the message element from the message box
		message.parentNode.removeChild(message);
		// Send a confirmation message
		var event = doc.createEvent("Events");
		event.initEvent("tiddlyfox-have-saved-file",true,false);
		event.savedFilePath = path;
		message.dispatchEvent(event);
		return false;
	},false);
}

// Helper to detect whether a document is a TiddlyWiki Classic
function isTiddlyWikiClassic(doc) {
	var versionArea = doc.getElementById("versionArea");
	return doc.getElementById("storeArea") &&
		(versionArea && /TiddlyWiki/.test(versionArea.text));
}

// Helper to inject overrides into TiddlyWiki Classic
function injectClassicOverrides(doc) {
	// Read inject.js
	var xhReq = new XMLHttpRequest();
	xhReq.open("GET","../js/inject.js",false);
	xhReq.send(null);
	// Inject it in a script tag
	var script = doc.createElement("script");
	script.appendChild(doc.createTextNode(xhReq.responseText));
	doc.getElementsByTagName("head")[0].appendChild(script);
}


// Helper function to save a file
function saveFile(path,content) {
	var fs = require("fs");
	fs.writeFileSync(path,content);
}

// Helper to find an entry in the wiki list
function findwikiInfo(url) {
	var wikiInfo = null;
	wikiList.forEach(function(listItem,index) {
		if(listItem.url === url) {
			wikiInfo = listItem;
		}
	});
	return wikiInfo;
}

// Helper to trap dev tools opening within a window
function trapDevTools(window,document) {
	document.addEventListener("keyup",function(event) {
		if(event.keyCode === 123) {
			window.showDevTools();
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	});
}

// Helper to trap wikilinks within a window
function trapLinks(doc) {
	doc.addEventListener("click",function(event) {
		// See if we're in an interwiki link
		var interwikiLink = findParentWithClass(event.target,"tw-interwiki-link");
		if(interwikiLink) {
			openWikiIfNotOpen(interwikiLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		// See if we're in an external link
		// "tw-tiddlylink-external" is for TW5, "externallink" for TWC
		var externalLink = findParentWithClass(event.target,"tw-tiddlylink-external externalLink");
		if(externalLink) {
			gui.Shell.openExternal(externalLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
}

// Helper to re-render the wiki list
function renderWikiList(doc) {
	doc = doc || document;
	var wikiListContainer = doc.getElementById("wikiList");
	// Remove any existing entries
	while(wikiListContainer.hasChildNodes()) {
		wikiListContainer.removeChild(wikiListContainer.firstChild);
	}
	// Add the current entries
	wikiList.forEach(function(wikiInfo,index) {
		var createButton = function(id, caption,handler) {
            if (typeof caption === 'function') {
                handler = caption;
                caption = id;
            }
			var button = doc.createElement("button");
            button.id = "td-" + id + "-" + index;
			button.className = "td-" + id;
			button.appendChild(doc.createTextNode(caption));
			button.addEventListener("click",handler,false);
			return button
		};
		var li = doc.createElement("li"),
			link = doc.createElement("a"),
			img = doc.createElement("img"),
			info = doc.createElement("div"),
			title = doc.createElement("div"),
			url = doc.createElement("div"),
			toolbar = doc.createElement("div");
		link.className = "tw-interwiki-link";
		link.href = wikiInfo.url;
		img.src = wikiInfo.img;
		info.className = "td-info";
		title.appendChild(doc.createTextNode(wikiInfo.title));
		title.className = "td-title";
		url.appendChild(doc.createTextNode(wikiInfo.url));
		url.className = "td-url";
		toolbar.appendChild(createButton("open", wikiInfo.isOpen ? 'activate' : 'open' ,function(event) {
			if(!wikiInfo.isOpen) {
				openWiki(wikiInfo.url);
			} else if (openedWindows[wikiInfo.url]) {
                openedWindows[wikiInfo.url].focus()
            }
			event.stopPropagation();
			event.preventDefault();
			return false;
		}));
		// toolbar.appendChild(createButton("clone",function(event) {
		// 	alert("Not yet implemented");
		// 	event.stopPropagation();
		// 	event.preventDefault();
		// 	return false;
		// }));
		toolbar.appendChild(createButton("remove",function(event) {
			if(!wikiInfo.isOpen) {
				var index = wikiList.indexOf(wikiInfo);
				if(index !== -1) {
					wikiList.splice(index,1);
				} else {
					throw "Cannot find item in wikiList";
				}
				saveWikiList();
				renderWikiList();
			}
			event.stopPropagation();
			event.preventDefault();
			return false;
		}));
		toolbar.className = "td-toolbar";
		wikiListContainer.appendChild(li);
		li.appendChild(link);
		link.appendChild(img);
		info.appendChild(title);
		info.appendChild(url);
		info.appendChild(toolbar);
		link.appendChild(info);
	});
}

// Helper to save the wikiList structure to localStorage
function saveWikiList() {
	localStorage.wikiList = JSON.stringify(wikiList);
}

// Helper to load the wikiList structure from localStorage
function loadWikiList() {
	wikiList = JSON.parse(localStorage.wikiList || "[]");
}

function findParentWithClass(node,classNames) {
	classNames = classNames.split(" ");
	while(node) {
		if(node.classList) {
			for(var t=0; t<classNames.length; t++) {
				if(node.classList.contains(classNames[t])) {
					return node;
				}
			}
		}
		node = node.parentNode;
	}
	return null;
}

})();
