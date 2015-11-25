/*
Utilities concerned with the DOM
*/

(function(){

/*jslint browser: true */
"use strict";

exports.decodeQueryString = function(location) {
	var result = {};
	location.search.substr(1).split('&').forEach(function(pair) {
		if(pair) {
			var parts = pair.split("=");
			result[parts[0]] = decodeURIComponent(parts[1].replace(/\+/g, " "));
		}
	});
	return result;
};

exports.findParentWithClass = function(node,classNames) {
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
};

})();
