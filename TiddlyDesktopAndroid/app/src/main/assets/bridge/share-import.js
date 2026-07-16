/*
 * Runs inside each wiki window. Defines window.__tdImportShare(payloadJson): imports a shared
 * payload (JSON array of entries) queued natively (ShareQueue):
 *   - text / links               → a tiddler;
 *   - tiddler-container files     → deserialized into tiddlers (.tid/.json/.html/.csv/.multids/…);
 *   - other binary files (media)  → external attachment (attachments/ + _canonical_uri) if the
 *                                   External Attachments plugin is enabled, else embedded as base64.
 * Opens the first imported tiddler and saves.
 */
(function () {
	if (window.__tdImportShareDefined) { return; }
	window.__tdImportShareDefined = true;

	function externalEnabled() {
		return !!$tw.wiki.getTiddler("$:/plugins/tiddlywiki/external-attachments") &&
			$tw.wiki.getTiddlerText("$:/config/ExternalAttachments/Enable", "no") === "yes";
	}
	function uniqueTitle(title) {
		if (!$tw.wiki.tiddlerExists(title) && !$tw.wiki.isShadowTiddler(title)) { return title; }
		var n = 2;
		while ($tw.wiki.tiddlerExists(title + " " + n) || $tw.wiki.isShadowTiddler(title + " " + n)) { n++; }
		return title + " " + n;
	}
	// tm-import-tiddlers is handled only by the navigator widget (it bubbles UP to it). Dispatching
	// on $tw.rootWidget — an ancestor — never reaches it, so find the navigator and dispatch on it.
	function findNavigator(widget) {
		if (!widget) { return null; }
		if (typeof widget.handleImportTiddlersEvent === "function") { return widget; }
		var kids = widget.children;
		if (kids) {
			for (var i = 0; i < kids.length; i++) {
				var found = findNavigator(kids[i]);
				if (found) { return found; }
			}
		}
		return null;
	}

	// Filename extension → TiddlyWiki deserializer content-type (fallback when the wiki's own
	// $tw.config.fileExtensionInfo registry doesn't cover it).
	var EXT_TYPE = {
		".tid": "application/x-tiddler", ".json": "application/json",
		".html": "text/html", ".htm": "text/html", ".csv": "text/csv",
		".multids": "application/x-tiddlers", ".tids": "application/x-tiddlers",
		".tiddler": "application/x-tiddler-html-div"
	};

	window.__tdImportShare = function (payloadJson) {
		if (!payloadJson) { return; }
		(async function go() {
			if (!(window.$tw && $tw.wiki && $tw.rootWidget)) { setTimeout(go, 200); return; }
			try {
				var fieldsList = JSON.parse(payloadJson);
				var extAttach = externalEnabled();
				var firstTitle = null;
				var directAdded = false;   // media / text / link tiddlers added straight in
				var importTiddlers = [];   // tiddler-container contents → native $:/Import flow

				// Async: awaits the native subfolder chooser for the attachment branches.
				async function importOne(fields) {
					fields = JSON.parse(JSON.stringify(fields)); // clone
					fields.title = uniqueTitle(fields.title || "shared");
					var type = fields.type || "";
					// A file staged natively (streamed to a temp file, not base64'd into the payload).
					var staged = fields.__sharedFile;
					if (staged != null) { delete fields.__sharedFile; }
					function finishAdd() {
						$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), fields, $tw.wiki.getModificationFields()));
						directAdded = true;
						if (!firstTitle) { firstTitle = fields.title; }
					}
					if (staged && typeof TDAttach !== "undefined") {
						if (type.indexOf("text/") === 0) {
							// Shared text file → import its text.
							fields.text = TDAttach.sharedFileText(staged);
							finishAdd(); return;
						}
						if (extAttach) {
							// Binary + External Attachments ON → choose a subfolder, then stream it in (kept external).
							var sub = await window.__tdChooseSubfolder();
							if (sub === null) {
								fields.text = TDAttach.sharedFileBase64(staged); // cancelled → embed (keep the shared file)
							} else {
								var rel = TDAttach.importSharedFile(staged, fields.title, type, sub);
								if (rel) { fields._canonical_uri = rel; }
								else { fields.text = TDAttach.sharedFileBase64(staged); } // fallback: embed
							}
							finishAdd(); return;
						}
						// External Attachments OFF → import (embed) the file as base64.
						fields.text = TDAttach.sharedFileBase64(staged);
						finishAdd(); return;
					}
					// Legacy: base64 already in the payload (small files) — attach it if EA is on.
					var isBinary = type && type.indexOf("text/") !== 0 && fields.text && !fields._canonical_uri;
					if (isBinary && extAttach && typeof TDAttach !== "undefined") {
						var b64 = fields.text;
						var sub2 = await window.__tdChooseSubfolder();
						if (sub2 !== null) {
							var rel2 = TDAttach.saveAttachment(b64, fields.title, type, sub2);
							if (rel2) { delete fields.text; fields._canonical_uri = rel2; }
						}
						finishAdd(); return;
					}
					finishAdd();
				}

				// A tiddler-container file (its text): deserialize into tiddlers via the type inferred
				// from the extension, and collect them for TiddlyWiki's native import. If it isn't a
				// recognised/parseable container, fall back to a single tiddler holding the raw text.
				function importContainer(text, name) {
					var ext = "", dot = (name || "").lastIndexOf(".");
					if (dot >= 0) { ext = name.slice(dot).toLowerCase(); }
					var type = "";
					try {
						if (ext && $tw.config.fileExtensionInfo && $tw.config.fileExtensionInfo[ext]) {
							type = $tw.config.fileExtensionInfo[ext].type;
						}
					} catch (e) {}
					if (!type) { type = EXT_TYPE[ext] || ""; }
					var tiddlers = null;
					if (type) { try { tiddlers = $tw.wiki.deserializeTiddlers(type, text, {}); } catch (e) { tiddlers = null; } }
					if (tiddlers && tiddlers.length) {
						tiddlers.forEach(function (t) {
							if (!t.title) { t.title = name || "shared"; }
							importTiddlers.push(t);
						});
					} else {
						importOne({ title: name || "shared", text: text, type: type || "text/plain", tags: "shared" });
					}
				}

				for (var i = 0; i < fieldsList.length; i++) {
					var entry = fieldsList[i];
					if (entry && entry.__importText != null) {
						importContainer(String(entry.__importText), entry.__importName || "");
					} else if (entry && entry.__tid != null) {
						// Legacy payload shape (older shares): a bare .tid.
						importContainer(String(entry.__tid), "shared.tid");
					} else {
						await importOne(entry);
					}
				}
				// Tiddler-container files → TiddlyWiki's native import: stage into $:/Import and show
				// its review listing (name clashes, import filters, upgrades, confirm/cancel). On
				// confirm the wiki saves itself, so we don't force a save here for these.
				if (importTiddlers.length) {
					var nav = findNavigator($tw.rootWidget);
					if (nav) {
						nav.dispatchEvent({ type: "tm-import-tiddlers", param: JSON.stringify(importTiddlers) });
					} else {
						// No navigator (unusual) → import directly so nothing is lost, then save.
						importTiddlers.forEach(function (t) { $tw.wiki.addTiddler(new $tw.Tiddler(t)); });
						$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });
					}
				}
				// Directly-added shares (media / text / links) → open the first and save.
				if (directAdded) {
					if (firstTitle) { $tw.rootWidget.dispatchEvent({ type: "tm-navigate", navigateTo: firstTitle }); }
					$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });
				}
			} catch (e) {
				console.error("[TiddlyDesktop] share import failed:", e);
			}
		})();
	};
})();
