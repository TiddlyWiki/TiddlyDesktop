/*
Spellcheck helpers for TiddlyDesktop.

Two deliberately separate concerns:

1. The Chromium remote (Google) spelling service. NW.js turns Google's REMOTE "spelling service" (the
   kSpellCheckUseSpellingService preference) on by default whenever --enable-spell-checking is set (see
   nwjs/nw.js#5129), which ships everything the user types into an editor to Google for suggestions. It
   is OFF by default in TiddlyDesktop and opt-in via $:/config/TiddlyDesktop/EnableGoogleSpellcheck.
   syncSpellingServicePref(profileDir) writes the matching preference into the Chromium "Preferences"
   file from node-main, BEFORE Chromium opens the profile — the only safe time to touch Preferences.
   Because node-main runs before TiddlyWiki boots it cannot read that config tiddler, so the settings UI
   mirrors the tiddler into an on-disk marker file (setGoogleServiceAllowed) that node-main can read
   (isGoogleServiceAllowed). Changing the opt-in therefore takes effect on the NEXT launch. Fail-safe
   and idempotent. This covers every window (all share the one Chromium profile), including folder wikis.

2. isEnabled($tw) / applyToDocument(doc, enabled) — the user-facing on/off toggle for LOCAL spellcheck
   ($:/config/TiddlyDesktop/EnableSpellcheck, default "yes"). Chromium keeps --enable-spell-checking on
   so the engine is always available; we gate the visible red squiggles per document via the inherited
   `spellcheck` attribute on <html>. Editors that don't set their own attribute inherit it, so the
   toggle takes effect on the next wiki (re)load with no app restart. (With local spellcheck off no text
   is checked at all, so the Google service — even if opted in — never runs.)
*/

"use strict";

var CONFIG_TITLE = "$:/config/TiddlyDesktop/EnableSpellcheck";
exports.CONFIG_TITLE = CONFIG_TITLE;

var GOOGLE_CONFIG_TITLE = "$:/config/TiddlyDesktop/EnableGoogleSpellcheck";
exports.GOOGLE_CONFIG_TITLE = GOOGLE_CONFIG_TITLE;

// Path of the opt-in marker file. Its presence means the user has opted into Google's remote spelling
// service; absence (the default) means keep it off. Lives in the profile dir so node-main can find it
// from the same resolveProfileDir() it already uses.
function markerPath(profileDir) {
	return require("path").join(profileDir, "td-allow-google-spellcheck");
}

// True if the user has opted into the Google remote spelling service. Read by node-main before boot.
exports.isGoogleServiceAllowed = function(profileDir) {
	try { return !!profileDir && require("fs").existsSync(markerPath(profileDir)); } catch(e) { return false; }
};

// Create/remove the opt-in marker to mirror the config tiddler. Called from main.js when the setting
// changes. Takes effect on the NEXT launch (Chromium reads the preference at profile load).
exports.setGoogleServiceAllowed = function(profileDir, allowed) {
	var fs = require("fs");
	try {
		if(!profileDir) { return; }
		var p = markerPath(profileDir);
		if(allowed) {
			try { fs.mkdirSync(profileDir, {recursive: true}); } catch(e) {}
			try { fs.writeFileSync(p, ""); } catch(e) {}
		} else {
			try { fs.unlinkSync(p); } catch(e) {}
		}
	} catch(e) {}
};

// Set Chromium's remote (Google) spelling-service preference in the profile's Preferences file to match
// the opt-in marker: OFF by default (nothing typed leaves the machine), ON only if the user opted in.
// profileDir is the active profile dir (e.g. .../TiddlyDesktop/Default). Only safe to call while Chromium
// is NOT running against that profile — i.e. from node-main, before the first window opens.
exports.syncSpellingServicePref = function(profileDir) {
	var fs = require("fs"), path = require("path");
	try {
		if(!profileDir) { return; }
		var allowed = exports.isGoogleServiceAllowed(profileDir),
			prefsPath = path.join(profileDir, "Preferences"),
			prefs = {},
			existed = false;
		try {
			prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) || {};
			existed = true;
		} catch(e) { prefs = {}; }
		prefs.spellcheck = prefs.spellcheck || {};
		// Already correct in an existing file → nothing to do. (A fresh profile has no file yet, so we
		// still pre-seed it below so the very first launch honours the default/opt-in.)
		if(existed && prefs.spellcheck.use_spelling_service === allowed) { return; }
		prefs.spellcheck.use_spelling_service = allowed;
		try { fs.mkdirSync(profileDir, {recursive: true}); } catch(e) {}
		fs.writeFileSync(prefsPath, JSON.stringify(prefs));
	} catch(e) {
		try { console.error("[TiddlyDesktop] syncSpellingServicePref failed:", e); } catch(_e) {}
	}
};

// Read the toggle from the backstage wiki. Defaults to enabled when unset or unreadable.
exports.isEnabled = function($tw) {
	try {
		return $tw.wiki.getTiddlerText(CONFIG_TITLE, "yes") !== "no";
	} catch(e) { return true; }
};

// Apply the toggle to a document by setting the inherited `spellcheck` attribute on <html>. Descendant
// editors that don't set their own attribute inherit this, so squiggles switch on/off without a restart.
exports.applyToDocument = function(doc, enabled) {
	try {
		if(!doc || !doc.documentElement) { return; }
		doc.documentElement.setAttribute("spellcheck", enabled ? "true" : "false");
	} catch(e) {}
};
