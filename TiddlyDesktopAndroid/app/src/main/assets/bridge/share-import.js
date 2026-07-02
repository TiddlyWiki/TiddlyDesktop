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
					// Binary file + external attachments enabled → keep external.
					var isBinary = fields.type && fields.type.indexOf("text/") !== 0 && fields.text && !fields._canonical_uri;
					if (isBinary && extAttach && typeof TDAttach !== "undefined") {
						var rel = TDAttach.saveAttachment(fields.text, fields.title, fields.type);
						if (rel) { delete fields.text; fields._canonical_uri = rel; }
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
