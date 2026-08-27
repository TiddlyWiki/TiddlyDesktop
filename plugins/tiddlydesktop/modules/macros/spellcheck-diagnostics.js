/*\
title: $:/TiddlyDesktop/macros/spellcheck-diagnostics.js
type: application/javascript
module-type: macro

Report the LIVE Chromium spellcheck state so you can see whether the settings actually reached the
engine. Reads, straight from disk, the profile's Preferences file and the marker files that node-main
consumes, alongside the TiddlyDesktop config tiddlers. Because Chromium owns and reconciles the
spellcheck prefs (see source/js/utils/spellcheck.js), the config tiddler and the effective value can
disagree; this macro makes that visible. Runs in the backstage wiki, which has Node integration.

\*/
"use strict";

exports.name = "td-spellcheck-diagnostics";

// `token` is ignored by the report but lets a Refresh button re-run the macro (which re-reads the
// files) by changing the argument value — macros don't track external files as dependencies.
exports.params = [{name: "token"}];

exports.run = function(token) {
	var lines = [];
	function row(label,value) { lines.push("  " + (label + ":").padEnd(34) + value); }
	try {
		var fs = require("fs"),
			path = require("path");
		var profileDir = $tw.desktop && $tw.desktop.gui && $tw.desktop.gui.App && $tw.desktop.gui.App.dataPath;
		lines.push("Config tiddlers (what the UI is set to)");
		row("EnableSpellcheck (local)",$tw.wiki.getTiddlerText("$:/config/TiddlyDesktop/EnableSpellcheck","yes"));
		row("EnableGoogleSpellcheck",$tw.wiki.getTiddlerText("$:/config/TiddlyDesktop/EnableGoogleSpellcheck","no"));
		var cfgLang = $tw.wiki.getTiddlerText("$:/config/TiddlyDesktop/SpellcheckLanguage","en-GB");
		row("SpellcheckLanguage",cfgLang);
		lines.push("");
		if(!profileDir) {
			lines.push("Profile directory unavailable (open this from the backstage window).");
			return lines.join("\n");
		}
		function exists(p) { try { return fs.existsSync(p); } catch(e) { return false; } }
		function read(p) { try { return fs.readFileSync(p,"utf8").trim(); } catch(e) { return "(unreadable)"; } }
		lines.push("Marker files (read by node-main before Chromium boots)");
		row("td-allow-google-spellcheck",exists(path.join(profileDir,"td-allow-google-spellcheck")) ? "present (opted in)" : "absent (off)");
		var langMarker = path.join(profileDir,"td-spellcheck-language");
		row("td-spellcheck-language",exists(langMarker) ? read(langMarker) : "absent");
		// The dictionary code TiddlyDesktop added to intl.selected_languages and will remove again on the
		// next language change. Empty means the current dictionary was already there (nothing of ours to
		// take back); absent means the profile has not been through the accumulation cleanup yet.
		var intlMarker = path.join(profileDir,"td-spellcheck-intl");
		row("td-spellcheck-intl",exists(intlMarker) ? (read(intlMarker) || "(none owned)") : "absent");
		lines.push("");
		lines.push("Chromium Preferences (the value that actually takes effect)");
		var prefs = null;
		try { prefs = JSON.parse(fs.readFileSync(path.join(profileDir,"Preferences"),"utf8")); } catch(e) {}
		if(!prefs) {
			lines.push("  (no Preferences file yet — launch and quit once)");
		} else {
			var sc = prefs.spellcheck || {},
				intl = prefs.intl || {};
			row("spellcheck.use_spelling_service",JSON.stringify(sc.use_spelling_service));
			row("spellcheck.dictionaries",JSON.stringify(sc.dictionaries));
			row("intl.selected_languages",JSON.stringify(intl.selected_languages));
			// Does Chromium actually have a dictionary loaded for the selected language? Compare base
			// languages (de-DE → de) so a normalized dictionary still counts as a match. A "NO" means
			// Chromium has no dictionary for that language (e.g. Japanese) or dropped the one we asked
			// for and fell back to the OS locale.
			var base = String(cfgLang).split("-")[0].toLowerCase(),
				dicts = Array.isArray(sc.dictionaries) ? sc.dictionaries : [];
			var active = dicts.some(function(d) { return String(d).split("-")[0].toLowerCase() === base; });
			row("dictionary active for language",active ? "yes" : "NO — no Chromium dictionary for '" + cfgLang + "' (or it was dropped)");
		}
		lines.push("");
		lines.push("Profile dir: " + profileDir);
	} catch(e) {
		lines.push("Diagnostics unavailable: " + ((e && e.message) || e));
	}
	return lines.join("\n");
};
