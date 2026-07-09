/*
Spellcheck helpers for TiddlyDesktop.

Two deliberately separate concerns:

1. disableSpellingService(profileDir) — runs from node-main BEFORE Chromium opens the profile.
   NW.js turns Google's REMOTE "spelling service" (the kSpellCheckUseSpellingService preference) on by
   default whenever --enable-spell-checking is set (see nwjs/nw.js#5129), which ships everything the
   user types into an editor to Google for suggestions. We force that preference off in the Chromium
   "Preferences" file so only the LOCAL Hunspell dictionary is ever used and no typed text leaves the
   machine. Fail-safe and idempotent; re-applied every launch because Chromium rewrites Preferences on
   shutdown. This covers every window (all share the one Chromium profile), including folder wikis.

2. isEnabled($tw) / applyToDocument(doc, enabled) — the user-facing on/off toggle for LOCAL spellcheck
   ($:/config/TiddlyDesktop/EnableSpellcheck, default "yes"). Chromium keeps --enable-spell-checking on
   so the engine is always available; we gate the visible red squiggles per document via the inherited
   `spellcheck` attribute on <html>. Editors that don't set their own attribute inherit it, so the
   toggle takes effect on the next wiki (re)load with no app restart.
*/

"use strict";

var CONFIG_TITLE = "$:/config/TiddlyDesktop/EnableSpellcheck";
exports.CONFIG_TITLE = CONFIG_TITLE;

// Force Chromium's remote (Google) spelling service off in the profile's Preferences file. profileDir
// is the active profile dir (e.g. .../TiddlyDesktop/Default). Only safe to call while Chromium is not
// running against that profile — i.e. from node-main, before the first window opens.
exports.disableSpellingService = function(profileDir) {
	var fs = require("fs"), path = require("path");
	try {
		if(!profileDir) { return; }
		var prefsPath = path.join(profileDir, "Preferences"),
			prefs = {},
			existed = false;
		try {
			prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) || {};
			existed = true;
		} catch(e) { prefs = {}; }
		prefs.spellcheck = prefs.spellcheck || {};
		// Already off in an existing file → nothing to do. (A fresh profile has no file yet, so we
		// still pre-seed it below so the very first launch never enables the Google service.)
		if(existed && prefs.spellcheck.use_spelling_service === false) { return; }
		prefs.spellcheck.use_spelling_service = false;
		try { fs.mkdirSync(profileDir, {recursive: true}); } catch(e) {}
		fs.writeFileSync(prefsPath, JSON.stringify(prefs));
	} catch(e) {
		try { console.error("[TiddlyDesktop] disableSpellingService failed:", e); } catch(_e) {}
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
