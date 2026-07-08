/*
Shared media-embed host allowlist.

Used by embeds.js (which decides whether an iframe is allowed and rewrites it through the
local shim) and by local-server.js (which validates the shim's `src` so the loopback server
can't be coaxed into embedding an arbitrary site). Keeping the list in one place stops the
two from drifting apart.
*/

"use strict";

// Hosts allowed by default (suffix match, so "youtube.com" also allows "www.youtube.com").
exports.DEFAULT_HOSTS = [
	"youtube.com", "youtube-nocookie.com", "youtu.be",
	"player.vimeo.com", "vimeo.com",
	"dailymotion.com",
	"open.spotify.com",
	"soundcloud.com", "w.soundcloud.com",
	"bandcamp.com",
	"player.twitch.tv", "clips.twitch.tv",
	"embed.music.apple.com",
	"openstreetmap.org",
	"google.com",            // maps embeds (www.google.com/maps/embed)
	"codepen.io",
	"codesandbox.io",
	"jsfiddle.net",
	"archive.org"
];

// Suffix match: hostname === h, or hostname ends with "." + h.
exports.hostAllowed = function(hostname, list) {
	hostname = (hostname || "").toLowerCase();
	list = list || exports.DEFAULT_HOSTS;
	for(var i = 0; i < list.length; i++) {
		var h = list[i];
		if(hostname === h || hostname.slice(-(h.length + 1)) === ("." + h)) { return true; }
	}
	return false;
};
