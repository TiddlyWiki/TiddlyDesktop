/*\
title: $:/core/modules/server/routes/get-attachments.js
type: application/javascript
module-type: route

GET /attachments/:filepath

Serves external-attachment files (referenced by a tiddler's _canonical_uri as ./attachments/<name>)
from the wiki folder's attachments/ directory, with HTTP Range/206 support so audio/video can be
seeked. Mirrors the core /files/ route. Bundled into core-server by bld.sh (TiddlyDesktop).

\*/
"use strict";

exports.methods = ["GET"];

exports.path = /^\/attachments\/(.+)$/;

exports.info = {
	priority: 100
};

exports.handler = function(request,response,state) {
	var path = require("path"),
		fs = require("fs"),
		suppliedFilename = $tw.utils.decodeURIComponentSafe(state.params[0]),
		baseFilename = path.resolve(state.boot.wikiPath,"attachments"),
		filename = path.resolve(baseFilename,suppliedFilename),
		relativePath = path.relative(baseFilename,filename),
		extension = path.extname(filename);
	// Check that the filename is inside the wiki attachments folder.
	//
	// path.relative() returns an ABSOLUTE path whenever the target cannot be expressed relative to
	// the base — on Windows that happens for a different drive letter, so a supplied filename of
	// "D:/Windows/win.ini" yields "D:\Windows\win.ini", which has no leading ".." and would pass a
	// bare indexOf("..") test. Checking path.isAbsolute() as well closes that escape.
	//
	// Testing the first path SEGMENT rather than a bare prefix also stops a legitimate attachment
	// named e.g. "..config.png" from being rejected.
	if(relativePath === ".." || relativePath.indexOf(".." + path.sep) === 0 || path.isAbsolute(relativePath)) {
		return state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
	}
	fs.stat(filename, function(err, stats) {
		if(err) {
			return state.sendResponse(404,{"Content-Type": "text/plain"},"File '" + suppliedFilename + "' not found");
		} else {
			var type = ($tw.config.fileExtensionInfo[extension] ? $tw.config.fileExtensionInfo[extension].type : "application/octet-stream"),
				responseHeaders = {
					"Content-Type": type,
					"Accept-Ranges": "bytes"
				};
			var rangeHeader = request.headers.range,
				stream;
			if(rangeHeader) {
				// Handle range requests
				var parts = rangeHeader.replace(/bytes=/, "").split("-"),
					start = parseInt(parts[0], 10),
					end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
				// Validate start and end
				if(isNaN(start) || isNaN(end) || start < 0 || end < start || end >= stats.size) {
					responseHeaders["Content-Range"] = "bytes */" + stats.size;
					return response.writeHead(416, responseHeaders).end();
				}
				var chunksize = (end - start) + 1;
				responseHeaders["Content-Range"] = "bytes " + start + "-" + end + "/" + stats.size;
				responseHeaders["Content-Length"] = chunksize;
				response.writeHead(206, responseHeaders);
				stream = fs.createReadStream(filename, {start: start, end: end});
			} else {
				responseHeaders["Content-Length"] = stats.size;
				response.writeHead(200, responseHeaders);
				stream = fs.createReadStream(filename);
			}
			// Common stream error handling
			stream.on("error", function(err) {
				if(!response.headersSent) {
					response.writeHead(500, {"Content-Type": "text/plain"});
					response.end("Read error");
				} else {
					response.destroy();
				}
			});
			stream.pipe(response);
		}
	});
};
