/*\
title: $:/TiddlyDesktop/startup/handlers.js
type: application/javascript
module-type: startup

Android override of the plugin's handlers.js. The original does `require("fs")` at load
time, which throws in a browser WebView. On Android the rootWidget handlers are registered
by $:/TiddlyDesktop/android/desktop.js instead, so this is a no-op.

\*/
"use strict";

exports.name = "tiddlydesktop-handlers-android-noop";
exports.after = ["startup"];
exports.synchronous = true;
exports.startup = function () { /* handlers live in android/desktop.js on Android */ };
