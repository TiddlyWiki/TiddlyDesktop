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

// Get the main window
var mainWindow = gui.Window.get();
// mainWindow.showDevTools();

// Current window
var currentWindow = null;

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

// Track the current window
trackCurrentWindow(mainWindow);

// Add a menubar
addMenuBar(mainWindow);

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
		console.log("Now opening wiki")
		openWiki(wikiUrl);
	}
}

// Helper to open a TiddlyWiki in a new window
function openWiki(wikiUrl) {
console.log("Opening wiki",wikiUrl)
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
	// Trap close event
	newWindow.on("close",function() {
		if(!shuttingDown) {
			wikiInfo.isOpen = false;
			saveWikiList();
		}
		this.close(true);
	});
	// Set up the new window when loaded
	newWindow.on("loaded",function() {
		if(process.platform !== "darwin") {
			addMenuBar(newWindow);
		}
		trackCurrentWindow(newWindow);
		// newWindow.showDevTools();
		var hostIframe = newWindow.window.document.getElementById("twFrame");
		if(hostIframe.src !== wikiUrl) {
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
				trapLinks(hostIframe.contentWindow.document);
				newWindow.window.document.title = title;
				wikiInfo.title = title;
				saveWikiList();
				renderWikiList();
				event.stopPropagation();
				event.preventDefault();
				return false;
			},false);
			hostIframe.src = wikiUrl;
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

// Helper to add current window tracking to a window
function trackCurrentWindow(win) {
	currentWindow = win;
	win.on("focus",function() {
		currentWindow = win;
	});
}

// Helper to add a menubar to a window
function addMenuBar(win) {
	var menu = new gui.Menu({ type: "menubar" }),
		developerMenu = new gui.MenuItem({
	    label: "Developer",
	    submenu: new gui.Menu()
	});
	menu.append(developerMenu);
	developerMenu.submenu.append(new gui.MenuItem({
	    label: "Developer Tools",
	    click: function () {
	    	if(currentWindow) {
		    	currentWindow.showDevTools();
	    	}
	    }
	}));
	win.menu = menu;
}

// Helper to trap wikilinks within a window
function trapLinks(doc) {
	doc.addEventListener("click",function(event) {
		// See if we're in an interwiki link
		var interwikiLink = findParentWithClass(event.target,"tw-interwiki-link");
		if(interwikiLink) {
			openWikiIfNotOpen(interwikiLink.getAttribute("href"));
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		// See if we're in an external link
		var externalLink = findParentWithClass(event.target,"tw-tiddlylink-external");
		if(externalLink) {
			gui.Shell.openExternal(externalLink.getAttribute("href"));
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
		var createButton = function(caption,handler) {
			var button = doc.createElement("button");
			button.className = "td-" + caption;
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
		toolbar.appendChild(createButton("open",function(event) {
			if(!wikiInfo.isOpen) {
				openWiki(wikiInfo.url);
			}
			event.stopPropagation();
			event.preventDefault();
			return false;
		}));
		toolbar.appendChild(createButton("clone",function(event) {
			alert("Not yet implemented");
			event.stopPropagation();
			event.preventDefault();
			return false;
		}));
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

function findParentWithClass(node,className) {
	while(node) {
		if(node.classList && node.classList.contains(className)) {
			return node;
		}
		node = node.parentNode;
	}
	return null;
}

})();
