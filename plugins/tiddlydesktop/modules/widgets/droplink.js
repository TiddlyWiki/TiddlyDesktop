/*\
title: $:/core/modules/widgets/droplink.js
type: application/javascript
module-type: widget

Droplink widget

\*/
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
		{name: "drop", handlerObject: this, handlerMethod: "handleDropEvent"},
		{name: "paste", handlerObject: this, handlerMethod: "handlePasteEvent"}
	]);
	// The drag-over OVERLAY is driven from a CAPTURE-phase dragover listener plus a short hide
	// timer, not the stock dragenter/dragleave counter. The wikilist's rows are nested droppable
	// widgets, and on Windows the enter/leave events across those child boundaries leave the
	// counter unbalanced, so the overlay never appears. dragover fires continuously while the
	// pointer is anywhere in the droplink subtree, and capturing it means a child droppable that
	// stops propagation can't hide it from us — so this works identically on Linux, macOS and
	// Windows.
	domNode.addEventListener("dragover",function(event) { self.handleOverlayDragOver(event); },true);
	domNode.addEventListener("click",function (event) {
	},false);
	// Insert element
	parent.insertBefore(domNode,nextSibling);
	this.renderChildren(domNode,null);
	this.domNodes.push(domNode);
};

// Show/hide the drag-over overlay. Driven by dragover (which fires continuously) rather than an
// enter/leave counter: on each captured dragover we make sure the overlay is shown and re-arm a
// short timer that hides it once dragover stops firing — i.e. the drag has left the droplink.
DropLinkWidget.prototype.handleOverlayDragOver = function(event) {
	// An internal drag (e.g. reordering a wikilist row) sets $tw.dragInProgress — no file overlay.
	if($tw.dragInProgress) { return; }
	if(["TEXTAREA","INPUT"].indexOf(event.target.tagName) !== -1) { return; }
	var self = this;
	if(!this.dropOverlayShown) {
		$tw.utils.addClass(this.domNodes[0],"tc-dragover");
		this.dropOverlayShown = true;
	}
	if(this.dropOverlayTimer) { clearTimeout(this.dropOverlayTimer); }
	this.dropOverlayTimer = setTimeout(function() {
		self.dropOverlayTimer = null;
		self.hideDropOverlay();
	},150);
};

DropLinkWidget.prototype.hideDropOverlay = function() {
	if(this.dropOverlayTimer) { clearTimeout(this.dropOverlayTimer); this.dropOverlayTimer = null; }
	if(this.dropOverlayShown) {
		$tw.utils.removeClass(this.domNodes[0],"tc-dragover");
		this.dropOverlayShown = false;
	}
};

DropLinkWidget.prototype.handleDragEnterEvent  = function(event) {
	// Allow the drop (and don't ripple to parent handlers). The overlay is handled by dragover.
	event.preventDefault();
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

DropLinkWidget.prototype.handleDropEvent  = function(event) {
	this.hideDropOverlay();
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
	// Import any files in the drop
	var file, tiddler,title;
	for(var f=0; f<dataTransfer.files.length; f++) {
		file = dataTransfer.files[f];
		if(file.path) {
			title = "file://" + file.path;
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
