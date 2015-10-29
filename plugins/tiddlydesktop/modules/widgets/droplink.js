/*\
title: $:/core/modules/widgets/droplink.js
type: application/javascript
module-type: widget

Droplink widget

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

var DropLinkWidget = function(parseTreeNode,options) {
	this.initialise(parseTreeNode,options);
};

/*
Inherit from the base widget class
*/
DropLinkWidget.prototype = new Widget();

/*
Render this widget into the DOM
*/
DropLinkWidget.prototype.render = function(parent,nextSibling) {
	var self = this;
	// Remember parent
	this.parentDomNode = parent;
	// Compute attributes and execute state
	this.computeAttributes();
	this.execute();
	// Create element
	var domNode = this.document.createElement("div");
	domNode.className = "tc-droplink";
	// Add event handlers
	$tw.utils.addEventListeners(domNode,[
		{name: "dragenter", handlerObject: this, handlerMethod: "handleDragEnterEvent"},
		{name: "dragover", handlerObject: this, handlerMethod: "handleDragOverEvent"},
		{name: "dragleave", handlerObject: this, handlerMethod: "handleDragLeaveEvent"},
		{name: "drop", handlerObject: this, handlerMethod: "handleDropEvent"},
		{name: "paste", handlerObject: this, handlerMethod: "handlePasteEvent"}
	]);
	domNode.addEventListener("click",function (event) {
	},false);
	// Insert element
	parent.insertBefore(domNode,nextSibling);
	this.renderChildren(domNode,null);
	this.domNodes.push(domNode);
};

DropLinkWidget.prototype.enterDrag = function() {
	// Check for this window being the source of the drag
	if($tw.dragInProgress) {
		return false;
	}
	// We count enter/leave events
	this.dragEnterCount = (this.dragEnterCount || 0) + 1;
	// If we're entering for the first time we need to apply highlighting
	if(this.dragEnterCount === 1) {
		$tw.utils.addClass(this.domNodes[0],"tc-dragover");
	}
};

DropLinkWidget.prototype.leaveDrag = function() {
	// Reduce the enter count
	this.dragEnterCount = (this.dragEnterCount || 0) - 1;
	// Remove highlighting if we're leaving externally
	if(this.dragEnterCount <= 0) {
		$tw.utils.removeClass(this.domNodes[0],"tc-dragover");
	}
};

DropLinkWidget.prototype.handleDragEnterEvent  = function(event) {
	this.enterDrag();
	// Tell the browser that we're ready to handle the drop
	event.preventDefault();
	// Tell the browser not to ripple the drag up to any parent drop handlers
	event.stopPropagation();
};

DropLinkWidget.prototype.handleDragOverEvent  = function(event) {
	// Check for being over a TEXTAREA or INPUT
	if(["TEXTAREA","INPUT"].indexOf(event.target.tagName) !== -1) {
		return false;
	}
	// Check for this window being the source of the drag
	if($tw.dragInProgress) {
		return false;
	}
	// Tell the browser that we're still interested in the drop
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy"; // Explicitly show this is a copy
};

DropLinkWidget.prototype.handleDragLeaveEvent  = function(event) {
	this.leaveDrag();
};

DropLinkWidget.prototype.handleDropEvent  = function(event) {
	this.leaveDrag();
	// Check for being over a TEXTAREA or INPUT
	if(["TEXTAREA","INPUT"].indexOf(event.target.tagName) !== -1) {
		return false;
	}
	// Check for this window being the source of the drag
	if($tw.dragInProgress) {
		return false;
	}
	var self = this,
		dataTransfer = event.dataTransfer;
	// Reset the enter count
	this.dragEnterCount = 0;
	// Remove highlighting
	$tw.utils.removeClass(this.domNodes[0],"tc-dragover");
	// Import any files in the drop
	var file, tiddler,title;
	for(var f=0; f<dataTransfer.files.length; f++) {
		file = dataTransfer.files[f];
		if(file.path) {
			title = "file://" + file.path;
			tiddler = {
				title: title,
				tags: ["wikilist"],
				"page-title": "Loading..."
			};
			this.wiki.addTiddler(new $tw.Tiddler(this.wiki.getCreationFields(),tiddler,this.wiki.getModificationFields()));
			this.dispatchEvent({type: "tiddlydesktop-add-wiki-url", param: title});
		}
	}
	// Tell the browser that we handled the drop
	event.preventDefault();
	// Stop the drop ripple up to any parent handlers
	event.stopPropagation();
};

/*
Compute the internal state of the widget
*/
DropLinkWidget.prototype.execute = function() {
	// Make child widgets
	this.makeChildWidgets();
};

/*
Selectively refreshes the widget if needed. Returns true if the widget or any of its children needed re-rendering
*/
DropLinkWidget.prototype.refresh = function(changedTiddlers) {
	return this.refreshChildren(changedTiddlers);
};

exports.droplink = DropLinkWidget;

})();
