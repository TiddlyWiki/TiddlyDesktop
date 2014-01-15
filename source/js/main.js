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
mainWindow.showDevTools();

// Current window
var currentWindow = null;

// Hacky flag for when we're shutting down
var shuttingDown = false;

// Get the current wikiList
//loadWikiList();

// Close all windows when the current window is closed
mainWindow.on("close",function() {
	shuttingDown = true;
	gui.App.closeAllWindows();
	gui.App.quit();
});

// Track the current window
trackCurrentWindow(mainWindow);

// Add a menubar
//addMenuBar(mainWindow);

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
	openWikiIfNotOpen("file://" + chooseWiki.value);
},false);
var btnChooseWiki = document.getElementById("btnChooseWiki");
btnChooseWiki.addEventListener("click",function(event) {
	chooseWiki.click();
},false);

function openWikiIfNotOpen(wikiUrl) {
	var wikiInfo = findwikiInfo(wikiUrl);
	if(!wikiInfo || !wikiInfo.isOpen) {
		console.log("Now opening wiki")
		openWiki(wikiUrl);
	}
}

// Helper to open a TiddlyWiki in a new window
function openWiki(wikiUrl) {
	// Add the path to the wikiList if not already there
	var wikiInfo = findwikiInfo(wikiUrl);
	if(wikiInfo === null) {
		wikiInfo = {url: wikiUrl};
	}
	// Save the wiki list and update it in the DOM
	wikiList[wikiList.length] = wikiInfo;
	wikiInfo.isOpen = true;
	saveWikiList();
	renderWikiList();
	// Open the window
	var newWindow = gui.Window.open(wikiUrl,{
		toolbar: true,
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
		newWindow.showDevTools();
		trackCurrentWindow(newWindow);
		trapLinks(newWindow.window.document);
		newWindow.capturePage(function(imgDataUri) {
			wikiInfo.img = imgDataUri;
			wikiInfo.title = newWindow.title;
			saveWikiList();
			renderWikiList();
		},"png");
	});
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
	win.menu = new gui.Menu({ type: "menubar" });
	var fileMenu = new gui.MenuItem({
	    label: "File",
	    submenu: new gui.Menu()
	});
	win.menu.insert(fileMenu,1);
	fileMenu.submenu.append(new gui.MenuItem({
	    label: "New",
	    click: function () {
	    	alert("New!!!!")
	    }
	}));
	fileMenu.submenu.append(new gui.MenuItem({
	    type: "separator"
	}));
	fileMenu.submenu.append(new gui.MenuItem({
	    label: "Close",
	    click: function () {
	        win.close();
	    }
	}));
	var developerMenu = new gui.MenuItem({
	    label: "Developer",
	    submenu: new gui.Menu()
	});
	win.menu.append(developerMenu);
	developerMenu.submenu.append(new gui.MenuItem({
	    label: "Developer Tools",
	    click: function () {
	    	if(currentWindow) {
		    	currentWindow.showDevTools();
	    	}
	    }
	}));
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
