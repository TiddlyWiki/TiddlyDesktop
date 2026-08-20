/*
Spellcheck helpers for TiddlyDesktop.

Three deliberately separate concerns:

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
   Chromium loads and reconciles the profile Preferences early, so this node-main pre-seed can lose the
   race (it is authoritative over its own spellcheck block — e.g. it re-derives spellcheck.dictionaries
   from intl.selected_languages). writeSpellingPrefsAtQuit(profileDir, allowed, lang) is the companion:
   on quit, main.js calls spawnPrefWriter() to start a DETACHED js/spellcheck-writer.js that waits for
   the app to fully exit and then calls it, so the values are on disk before the next launch's Chromium
   reads them — the only write that survives, since anything written while Chromium runs gets
   re-flushed away.

2. isEnabled($tw) / applyToDocument(doc, enabled, lang) — the user-facing on/off toggle for LOCAL
   spellcheck ($:/config/TiddlyDesktop/EnableSpellcheck, default "yes"). Chromium keeps
   --enable-spell-checking on so the engine is always available; we gate the visible red squiggles per
   document via the inherited `spellcheck` attribute on <html>. Editors that don't set their own
   attribute inherit it, so the toggle takes effect on the next wiki (re)load with no app restart. (With
   local spellcheck off no text is checked at all, so the Google service — even if opted in — never
   runs.)

3. getLanguage($tw) — the spellcheck language setting ($:/config/TiddlyDesktop/SpellcheckLanguage,
   default "en"). Sets the `lang` attribute on <html> so Chromium's spellchecker (both local Hunspell
   and the Google service) uses the correct dictionary. Also written into the Chromium Preferences file
   as `spellcheck.dictionaries` so the profile-level spellcheck engine loads the right dictionary.
*/

"use strict";

var CONFIG_TITLE = "$:/config/TiddlyDesktop/EnableSpellcheck";
exports.CONFIG_TITLE = CONFIG_TITLE;

var GOOGLE_CONFIG_TITLE = "$:/config/TiddlyDesktop/EnableGoogleSpellcheck";
exports.GOOGLE_CONFIG_TITLE = GOOGLE_CONFIG_TITLE;

var LANG_CONFIG_TITLE = "$:/config/TiddlyDesktop/SpellcheckLanguage";
exports.LANG_CONFIG_TITLE = LANG_CONFIG_TITLE;

// Path of the spellcheck language marker file. Stores the BCP47 language code (e.g. "en-GB") so
// node-main can read it before TiddlyWiki boots. Lives in the same profile dir as the Google marker.
function langMarkerPath(profileDir) {
	return require("path").join(profileDir, "td-spellcheck-language");
}

// Read the spellcheck language from the on-disk marker file. Falls back to "en-GB" when unset.
// Called by node-main before TiddlyWiki boots (cannot read the config tiddler at that point).
exports.readLanguageMarker = function(profileDir) {
	try {
		if(!profileDir) { return "en-GB"; }
		return require("fs").readFileSync(langMarkerPath(profileDir), "utf8").trim() || "en-GB";
	} catch(e) { return "en-GB"; }
};

// Write the spellcheck language marker file. Called from main.js when the setting changes.
// Takes effect on the NEXT launch (node-main reads it to pre-seed Preferences) AND immediately
// for the current session via applyToDocument.
exports.setLanguageMarker = function(profileDir, lang) {
	var fs = require("fs");
	try {
		if(!profileDir) { return; }
		lang = lang || "en-GB";
		try { fs.mkdirSync(profileDir, {recursive: true}); } catch(e) {}
		fs.writeFileSync(langMarkerPath(profileDir), lang);
	} catch(e) {}
};

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

// Normalize a SpellcheckLanguage dropdown code (settings/Spellcheck.tid) to the code Chromium expects
// for a spellcheck dictionary. Only regional variants that collapse to a base dictionary are listed
// (German is one dictionary "de", not de-DE/de-AT/de-CH); every other code — en-GB, es-ES, pt-BR, and
// languages with no Hunspell dictionary like ja-JP — passes through unchanged. We deliberately do NOT
// hard-code an "unsupported" verdict: which languages are spellcheckable is platform-dependent
// (Hunspell on Linux, the OS spellchecker on macOS/Windows), so Chromium accepts or drops the code per
// its own backend and the Diagnostics panel reports what actually stuck ("dictionary active for
// language"). The base-code collapses below are Hunspell/Linux shaped; a wrong one just shows up there.
var LANGUAGE_TO_DICTIONARY = {
	"en-PH": "en-US",
	"ca-ES": "ca", "cs-CZ": "cs", "da-DK": "da",
	"de-AT": "de", "de-CH": "de", "de-DE": "de",
	"el-GR": "el", "fa-IR": "fa", "fr-FR": "fr", "he-IL": "he",
	"hi-IN": "hi", "it-IT": "it", "ko-KR": "ko", "nl-NL": "nl",
	"pl-PL": "pl", "ru-RU": "ru", "sk-SK": "sk", "sl-SI": "sl", "sv-SE": "sv"
};

// Map a SpellcheckLanguage code to the code Chromium expects: normalize a regional variant that
// collapses to a base dictionary (de-DE → de), and pass everything else through unchanged. The
// collapse is Hunspell-specific, so it only applies on Linux; macOS (NSSpellChecker) and Windows
// (ISpellChecker) support the regional codes natively, so we pass the dropdown code straight through.
exports.dictionaryForLanguage = function(lang) {
	if(!lang) { return "en-GB"; }
	if(process.platform !== "linux") { return lang; }
	return LANGUAGE_TO_DICTIONARY.hasOwnProperty(lang) ? LANGUAGE_TO_DICTIONARY[lang] : lang;
};

// True if `lang` is already listed in prefs.intl.selected_languages.
function intlHasLanguage(prefs, lang) {
	var sel = prefs.intl && prefs.intl.selected_languages;
	return typeof sel === "string" && sel.split(",").indexOf(lang) !== -1;
}

// Ensure `lang` is present in prefs.intl.selected_languages, so Chromium keeps its spellcheck
// dictionary — it drops a dictionary whose language is not in that list and falls back to the OS
// locale. Appended, never reordered, so the primary UI language is unchanged. Mutates prefs.
function ensureLanguageInIntl(prefs, lang) {
	if(intlHasLanguage(prefs, lang)) { return; }
	prefs.intl = prefs.intl || {};
	var sel = typeof prefs.intl.selected_languages === "string" && prefs.intl.selected_languages
		? prefs.intl.selected_languages.split(",") : [];
	sel.push(lang);
	prefs.intl.selected_languages = sel.join(",");
}

// Set Chromium's remote (Google) spelling-service preference and the spellcheck dictionary language in
// the profile's Preferences file. Preserves all existing preferences — only merges the spellcheck and
// intl keys. profileDir is the active profile dir (e.g. .../TiddlyDesktop/Default). Only safe to call
// while Chromium is NOT running against that profile — i.e. from node-main, before the first window opens.
exports.syncSpellingServicePref = function(profileDir, lang) {
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
		lang = lang || "en-GB";
		var dict = exports.dictionaryForLanguage(lang);
		// Already correct in an existing file → nothing to do. (A fresh profile has no file yet, so we
		// still pre-seed it below so the very first launch honours the default/opt-in and language.)
		if(existed
			&& prefs.spellcheck.use_spelling_service === allowed
			&& JSON.stringify(prefs.spellcheck.dictionaries) === JSON.stringify([dict])
			&& intlHasLanguage(prefs, dict)) {
			return;
		}
		prefs.spellcheck.use_spelling_service = allowed;
		prefs.spellcheck.dictionaries = [dict];
		ensureLanguageInIntl(prefs, dict);
		try { fs.mkdirSync(profileDir, {recursive: true}); } catch(e) {}
		fs.writeFileSync(prefsPath, JSON.stringify(prefs));
	} catch(e) {
		try { console.error("[TiddlyDesktop] syncSpellingServicePref failed:", e); } catch(_e) {}
	}
};

// Absolute path of the application directory (source/), derived from this module's own location so
// it is correct both unbuilt and inside a packaged build, and independent of the cwd the app was
// launched from. The pref-writer's script path is resolved against it.
var APP_DIR = require("path").resolve(__dirname, "..", "..");

// Spawn the detached pref-writer that writes the spellcheck prefs once this app instance is gone.
// Called from main.js quitApp(); see js/spellcheck-writer.js for why it must be gone by then.
//
// NWJS_START_AS_NODE turns our own binary into a plain Node interpreter, which is what keeps the
// helper window-less and stops it opening — and locking — the Chromium profile it is writing into.
// process.execPath is that binary; NW.js ships no separate node to point at. The script path is
// absolute and the cwd is pinned to the app directory, so nothing here depends on where the user
// launched TiddlyDesktop from.
exports.spawnPrefWriter = function(profileDir, allowed, lang) {
	try {
		var env = Object.assign({}, process.env, {
			NWJS_START_AS_NODE: "1",
			TD_SPELLCHECK_PROFILE: profileDir || "",
			TD_SPELLCHECK_ALLOWED: allowed ? "1" : "0",
			TD_SPELLCHECK_LANG: lang || "en-GB",
			TD_SPELLCHECK_PARENT_PID: String(process.pid)
		});
		require("child_process").spawn(
			process.execPath,
			[require("path").join(APP_DIR, "js", "spellcheck-writer.js")],
			{detached: true, stdio: "ignore", cwd: APP_DIR, env: env}
		).unref();
	} catch(e) {
		try { console.error("[TiddlyDesktop] spellcheck pref-writer spawn failed:", e); } catch(_e) {}
	}
};

// Write the spellcheck prefs into the profile's Preferences. Called by the DETACHED pref-writer AFTER
// the app has fully exited (js/spellcheck-writer.js, started by spawnPrefWriter above), so it is the
// last write and survives into the next launch — Chromium re-flushes these prefs while running, so an in-process
// write loses that race. Best-effort and fail-safe.
//   - use_spelling_service: the Google remote-spellcheck opt-in.
//   - dictionaries: force the chosen language. Chromium keeps a spellcheck dictionary only for a
//     language present in intl.selected_languages, so we also ensure `lang` is in that list (appended,
//     to avoid changing the primary UI language) — otherwise Chromium drops it and falls back to the
//     OS locale, which is why the language selector currently appears to have no effect.
exports.writeSpellingPrefsAtQuit = function(profileDir, allowed, lang) {
	var fs = require("fs"), path = require("path");
	try {
		if(!profileDir) { return; }
		lang = lang || "en-GB";
		var prefsPath = path.join(profileDir, "Preferences"), prefs = {};
		try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) || {}; } catch(e) { prefs = {}; }
		var dict = exports.dictionaryForLanguage(lang);
		prefs.spellcheck = prefs.spellcheck || {};
		prefs.spellcheck.use_spelling_service = !!allowed;
		prefs.spellcheck.dictionaries = [dict];
		ensureLanguageInIntl(prefs, dict);
		fs.writeFileSync(prefsPath, JSON.stringify(prefs));
	} catch(e) {
		try { console.error("[TiddlyDesktop] writeSpellingPrefsAtQuit failed:", e); } catch(_e) {}
	}
};

// Read the toggle from the backstage wiki. Defaults to enabled when unset or unreadable.
exports.isEnabled = function($tw) {
	try {
		return $tw.wiki.getTiddlerText(CONFIG_TITLE, "yes") !== "no";
	} catch(e) { return true; }
};

// Read the spellcheck language from the backstage wiki. Defaults to "en" when unset or unreadable.
exports.getLanguage = function($tw) {
	try {
		return $tw.wiki.getTiddlerText(LANG_CONFIG_TITLE, "en-GB") || "en-GB";
	} catch(e) { return "en-GB"; }
};

// Apply the toggle and language to a document by setting the inherited `spellcheck` and `lang`
// attributes on <html>. Descendant editors that don't set their own attributes inherit these, so
// squiggles switch on/off and the language takes effect on the next wiki (re)load with no app restart.
exports.applyToDocument = function(doc, enabled, lang) {
	try {
		if(!doc || !doc.documentElement) { return; }
		doc.documentElement.setAttribute("spellcheck", enabled ? "true" : "false");
		if(lang) { doc.documentElement.setAttribute("lang", lang); }
	} catch(e) {}
};
