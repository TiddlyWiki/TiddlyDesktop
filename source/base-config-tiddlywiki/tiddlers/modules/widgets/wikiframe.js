/*\
title: $:/TiddlyDesktop/widgets/wikiframe.js
type: application/javascript
module-type: widget

iframe to contain a TiddlyWiki document

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

var WikiFrameWidget = function(parseTreeNode,options) {
	this.initialise(parseTreeNode,options);
};

/*
Inherit from the base widget class
*/
WikiFrameWidget.prototype = new Widget();

/*
Render this widget into the DOM
*/
WikiFrameWidget.prototype.render = function(parent,nextSibling) {
	var self = this;
	// Remember parent
	this.parentDomNode = parent;
	// Compute attributes and execute state
	this.computeAttributes();
	this.execute();
	// Create element
	var domNode = this.document.createElement("iframe");
	domNode.src = this.frameUrl;
	if(this.frameClass) {
		domNode.className = this.frameClass;
	}
	domNode.setAttribute("nwdisable","nwdisable");
	domNode.setAttribute("nwfaketop","nwfaketop");
	// Set up the frame when it has loaded
	var loaded = false;
	domNode.onload = function() {
		if(!loaded) {
			loaded = true;
			// Enable saving and trap links
			var doc = domNode.contentWindow.document;
			$tw.desktop.savingSupport.enableSaving(doc);
			$tw.desktop.trapLinks(doc);			
			// If there's a page title specified then save the iframe title to it when it changes
			if(self.framePageTitle) {
				var currentTitle = self.wiki.getTextReference(self.framePageTitle,"",self.getVariable("currentTiddler"));
				setInterval(function() {
					if(doc.title && doc.title !== currentTitle) {
						currentTitle = doc.title;
						self.wiki.setTextReference(self.framePageTitle,doc.title,self.getVariable("currentTiddler"));
					}
				},1000);
			}
		}
	};
	// Insert frame into DOM
	parent.insertBefore(domNode,nextSibling);
	this.renderChildren(domNode,null);
	this.domNodes.push(domNode);
};

/*
Compute the internal state of the widget
*/
WikiFrameWidget.prototype.execute = function() {
	// Get attributes
	this.frameUrl = this.getAttribute("url");
	this.framePageTitle = this.getAttribute("pagetitle");
	this.frameClass = this.getAttribute("class");
};

/*
Selectively refreshes the widget if needed. Returns true if the widget or any of its children needed re-rendering
*/
WikiFrameWidget.prototype.refresh = function(changedTiddlers) {
	var changedAttributes = this.computeAttributes();
	if(changedAttributes.url || changedAttributes.class) {
		this.refreshSelf();
		return true;
	}
	return this.refreshChildren(changedTiddlers);
};

exports.wikiframe = WikiFrameWidget;

})();
