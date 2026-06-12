/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/collab-safety.js
type: application/javascript
module-type: library

Single source of truth for "may we apply this peer-originated tiddler?".

Folder wikis run with full Node access, so writing a peer-provided tiddler that
carries executable content is remote code execution. Executable-ness can also be
introduced AFTER an innocent tiddler is shared — by adding a tag, a field, or
changing the type, whether through the sharing protocol, a programmatic edit, or
the real-time Y.Map field sync. Every code path that writes a remote-originated
tiddler must therefore run its RESULTING fields through acceptTiddler():

  - sharing.js  _applyRemote()            (collab-tiddler-response / -update / conflict)
  - collab.js   Y.Map field-sync observer (live co-editing)

Keeping the rule here (not duplicated at each call site) is what prevents a new
write path from silently re-opening the hole.
\*/

"use strict";

var ALLOW_SYSTEM = "$:/config/codemirror-6-collab/allow-system-tiddlers";

// isShadowTiddler() only knows ENABLED plugins (their payload is unpacked into the
// shadow index). A DISABLED plugin is still a real tiddler carrying its payload, so
// a peer could otherwise plant a tiddler at one of its titles that springs to life
// the moment the plugin is re-enabled. We enumerate disabled plugins' payload titles
// and protect them too. Cached, and invalidated when a plugin or its disabled state
// changes; deletions only leave harmless over-protection, so we ignore those.
var _disabledPayloadTitles = null;

function _getDisabledPluginPayloadTitles() {
	if(_disabledPayloadTitles) { return _disabledPayloadTitles; }
	var set = Object.create(null);
	try {
		$tw.wiki.each(function(tiddler, title) {
			if(!tiddler.fields["plugin-type"]) { return; }
			// Enabled plugins are already covered by isShadowTiddler().
			if($tw.wiki.getTiddlerText("$:/config/Plugins/Disabled/" + title, "no") !== "yes") { return; }
			set[title] = true; // the plugin container itself
			var payload;
			try { payload = JSON.parse(tiddler.fields.text || "{}"); } catch(e) { return; }
			var tids = payload && payload.tiddlers;
			if(tids) {
				for(var t in tids) { if($tw.utils.hop(tids, t)) { set[t] = true; } }
			}
		});
	} catch(e) {}
	_disabledPayloadTitles = set;
	return set;
}

if($tw && $tw.wiki && $tw.wiki.addEventListener) {
	$tw.wiki.addEventListener("change", function(changes) {
		if(!_disabledPayloadTitles) { return; }
		for(var t in changes) {
			if(t.indexOf("$:/config/Plugins/Disabled/") === 0) { _disabledPayloadTitles = null; return; }
			var td = $tw.wiki.getTiddler(t);
			if(td && td.fields["plugin-type"]) { _disabledPayloadTitles = null; return; }
		}
	});
}

// Code-bearing tiddlers are NEVER applied from a peer, regardless of title — a
// non-system application/javascript module still runs with the wiki's privileges.
exports.isExecutable = function(fields) {
	fields = fields || {};
	var type = String(fields.type || "").toLowerCase();
	if(type === "application/javascript") { return true; }
	if(fields["module-type"]) { return true; }
	if(fields["plugin-type"]) { return true; }
	var tags = $tw.utils.isArray(fields.tags) ? fields.tags : $tw.utils.parseStringArray(fields.tags || "");
	for(var i = 0; i < (tags || []).length; i++) {
		// $:/tags/RawMarkup* inject raw HTML/JS straight into the page.
		if(String(tags[i]).indexOf("$:/tags/RawMarkup") === 0) { return true; }
	}
	return false;
};

// Our own collaboration / external-attachment configuration must never be
// rewritten by a peer (it could redirect the relay, leak the room token, or flip
// these very safety switches).
exports.isProtectedConfig = function(title) {
	return (/^\$:\/config\/codemirror-6-collab\//).test(title)
		|| (/^\$:\/config\/ExternalAttachments\//i).test(title);
};

// Titles a peer may never overwrite, even with NON-executable content — because
// the act of overwriting them is itself the attack:
//   - this collaboration plugin (incl. this very guard module): replacing it with
//     a tiddler whose module-type is empty would neuter the guard on next load;
//   - any installed plugin / core shadow: peers don't get to override your plugins;
//   - any tiddler that is currently a real JS module locally.
exports.isProtectedTitle = function(title) {
	title = String(title);
	if(exports.isProtectedConfig(title)) { return true; }
	if((/^\$:\/plugins\/tiddlywiki\/codemirror-6-collab-nwjs/).test(title)) { return true; }
	// Collaboration's own runtime / UI state (member list, chat, share status):
	// a peer writing these could only spoof or disrupt the UI.
	if((/^\$:\/temp\/collab\//).test(title)) { return true; }
	if((/^\$:\/config\/state\/collab\//).test(title)) { return true; }
	// Any installed plugin / core / theme / language shadow — wherever it lives.
	try { if($tw.wiki.isShadowTiddler(title)) { return true; } } catch(e) {}
	// …and titles owned by a DISABLED plugin, which isShadowTiddler misses.
	if(_getDisabledPluginPayloadTitles()[title]) { return true; }
	// An existing local JS module.
	var existing = $tw.wiki.getTiddler(title);
	if(existing && exports.isExecutable(existing.fields)) { return true; }
	return false;
};

// True if a remote tiddler with these RESULTING fields may be written locally.
exports.acceptTiddler = function(title, fields) {
	if(exports.isExecutable(fields)) { return false; }
	// Protected titles are refused regardless of the allow-system setting, since
	// overwriting them can defeat the safety net or your installed plugins/core.
	if(exports.isProtectedTitle(title)) { return false; }
	if(String(title).indexOf("$:/") === 0) {
		if($tw.wiki.getTiddlerText(ALLOW_SYSTEM, "no") !== "yes") { return false; }
	}
	return true;
};
