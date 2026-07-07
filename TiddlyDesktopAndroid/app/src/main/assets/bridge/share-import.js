/*
 * Runs inside each wiki window. Defines window.__tdImportShare(payloadJson): imports a shared
 * payload (JSON array of tiddler fields) queued natively (ShareQueue) — text/links as tiddlers,
 * and binary files (image/pdf/…) as external attachments (attachments/ + _canonical_uri) IF the
 * External Attachments plugin is enabled in this wiki, otherwise embedded as base64. Opens the
 * first imported tiddler and saves.
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

	window.__tdImportShare = function (payloadJson) {
		if (!payloadJson) { return; }
		function go() {
			if (!(window.$tw && $tw.wiki && $tw.rootWidget)) { setTimeout(go, 200); return; }
			try {
				var fieldsList = JSON.parse(payloadJson);
				var extAttach = externalEnabled();
				var firstTitle = null;
				function importOne(fields) {
					fields = JSON.parse(JSON.stringify(fields)); // clone
					fields.title = uniqueTitle(fields.title || "shared");
					var type = fields.type || "";
					// A file staged natively (streamed to a temp file, not base64'd into the payload).
					var staged = fields.__sharedFile;
					if (staged != null) { delete fields.__sharedFile; }
					if (staged && typeof TDAttach !== "undefined") {
						if (type.indexOf("text/") === 0) {
							// Shared text file → import its text.
							fields.text = TDAttach.sharedFileText(staged);
						} else if (extAttach) {
							// Binary + External Attachments ON → attach (streamed into attachments/, kept external).
							var rel = TDAttach.importSharedFile(staged, fields.title, type);
							if (rel) { fields._canonical_uri = rel; }
							else { fields.text = TDAttach.sharedFileBase64(staged); } // fallback: embed
						} else {
							// External Attachments OFF → import (embed) the file as base64.
							fields.text = TDAttach.sharedFileBase64(staged);
						}
					} else {
						// Legacy: base64 already in the payload (small files) — attach it if EA is on.
						var isBinary = type && type.indexOf("text/") !== 0 && fields.text && !fields._canonical_uri;
						if (isBinary && extAttach && typeof TDAttach !== "undefined") {
							var rel2 = TDAttach.saveAttachment(fields.text, fields.title, type);
							if (rel2) { delete fields.text; fields._canonical_uri = rel2; }
						}
					}
					$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), fields, $tw.wiki.getModificationFields()));
					if (!firstTitle) { firstTitle = fields.title; }
				}
				fieldsList.forEach(function (entry) {
					if (entry && entry.__tid != null) {
						// An opened/shared .tid file: deserialize it as a proper tiddler.
						$tw.wiki.deserializeTiddlers("application/x-tiddler", String(entry.__tid), {}).forEach(importOne);
					} else {
						importOne(entry);
					}
				});
				if (firstTitle) { $tw.rootWidget.dispatchEvent({ type: "tm-navigate", navigateTo: firstTitle }); }
				$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });
			} catch (e) {
				console.error("[TiddlyDesktop] share import failed:", e);
			}
		}
		go();
	};
})();
