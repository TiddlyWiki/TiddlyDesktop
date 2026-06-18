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
	// Add event handlers. The drag-over OVERLAY is an enter/leave COUNTER, but registered in the
	// CAPTURE phase (the three listeners below). Why:
	//   • Capture (not bubble) so the wikilist's nested droppable ROWS can't desync it — a child
	//     droppable that stops propagation of its dragenter would otherwise hide the overlay the
	//     moment the pointer crossed onto a row (the bug on Windows, where the overlay never showed).
	//   • A counter (not a dragover timer) so the overlay survives the pointer being held STILL —
	//     Chromium doesn't reliably keep firing dragover while stationary (notably on Linux), so a
	//     timer-based hide would make the overlay vanish when the mouse stops. Enter/leave fire only
	//     on actual boundary crossings, so a still pointer keeps the count at 1.
	domNode.addEventListener("dragenter",function(event) { self.handleDragEnterEvent(event); },true);
	domNode.addEventListener("dragleave",function(event) { self.handleDragLeaveEvent(event); },true);
	domNode.addEventListener("dragover",function(event) { self.handleDragOverEvent(event); },true);
	$tw.utils.addEventListeners(domNode,[
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

// Enter/leave counter: show the overlay while the drag is anywhere inside the droplink subtree,
// hide it only when it has actually left (count back to 0). No timer, so a stationary pointer keeps
// it shown. enterDrag/leaveDrag are driven by the CAPTURE-phase listeners registered in render().
DropLinkWidget.prototype.enterDrag = function() {
	// An internal drag (e.g. reordering a wikilist row) sets $tw.dragInProgress — no file overlay.
	if($tw.dragInProgress) { return; }
	this.dragEnterCount = (this.dragEnterCount || 0) + 1;
	if(this.dragEnterCount === 1) {
		$tw.utils.addClass(this.domNodes[0],"tc-dragover");
	}
};

DropLinkWidget.prototype.leaveDrag = function() {
	this.dragEnterCount = (this.dragEnterCount || 0) - 1;
	if(this.dragEnterCount <= 0) {
		this.dragEnterCount = 0;
		$tw.utils.removeClass(this.domNodes[0],"tc-dragover");
	}
};

DropLinkWidget.prototype.handleDragEnterEvent  = function(event) {
	this.enterDrag();
	// Allow the drop.
	event.preventDefault();
};

DropLinkWidget.prototype.handleDragLeaveEvent  = function(event) {
	this.leaveDrag();
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
	this.dragEnterCount = 0;
	$tw.utils.removeClass(this.domNodes[0],"tc-dragover");
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
