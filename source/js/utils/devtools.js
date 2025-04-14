/*
Utilities concerned with managing the devtools panel
*/

"use strict";

/*
Display the dev tools when F12 is pressed
*/
exports.trapDevTools = function(window_nwjs,document) {
	document.addEventListener("keyup",function(event) {
		if(event.keyCode === 123) {
			window_nwjs.showDevTools();
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	});
};
