/*
Utilities concerned with managing the devtools panel
*/

(function(){

/*jslint browser: true */
"use strict";

/*
Display the dev tools when F12 is pressed
*/
exports.trapDevTools = function(window,document) {
	document.addEventListener("keyup",function(event) {
		if(event.keyCode === 123) {
			window.showDevTools();
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	});
};

})();
