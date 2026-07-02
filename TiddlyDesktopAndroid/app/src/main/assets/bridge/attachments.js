/*
 * Runs inside each wiki window. External-attachments support for Android.
 *
 * The official $:/plugins/tiddlywiki/external-attachments hook only fires under file:// with a
 * real file.path — neither exists in this WebView — so it no-ops here. We honour ITS settings
 * ($:/config/ExternalAttachments/Enable) but do the copy ourselves: on import of a non-native
 * file we copy it into the wiki's attachments/ folder (native TDAttach) and import a "skinny"
 * tiddler referencing it via _canonical_uri (kept external, not embedded).
 *
 * Paths are always relative ("./attachments/<name>") — the file is copied INTO the wiki's own
 * folder, so it's always a descendant. Absolute-path settings can't be honoured on Android
 * (SAF content:// folders have no addressable filesystem path).
 */
(function () {
	if (window.__tdAttach || typeof TDAttach === "undefined") { return; }
	window.__tdAttach = true;

	var NATIVE_RE = /\.(tid|json|html?|hta|meta|multids|tiddler|tiddlers)$/i;

	function whenReady(fn) {
		if (window.$tw && $tw.hooks && $tw.wiki) { fn(); } else { setTimeout(function () { whenReady(fn); }, 250); }
	}

	whenReady(function () {
		// Surface a note in Control Panel → Settings (when the EA plugin is installed) that the
		// plugin's absolute-path options have no effect on Android — attachments are always relative.
		try {
			if ($tw.wiki.getTiddler("$:/plugins/tiddlywiki/external-attachments") && TDAttach.note) {
				var n = JSON.parse(TDAttach.note());
				$tw.wiki.addTiddler(new $tw.Tiddler({
					title: "$:/TiddlyDesktop/ExternalAttachmentsNote",
					tags: "$:/tags/ControlPanel/Settings",
					caption: n.caption,
					text: n.body
				}));
			}
		} catch (e) {}

		// TiddlyWiki's invokeHook threads each hook's return into the next hook's first arg. The
		// stock external-attachments hook runs first and returns `false` on Android (needs
		// file://+file.path), which would arrive as our `info` and break us. Make ours the only
		// th-importing-file hook so it receives the real info object and its `true` return sticks.
		if ($tw.hooks && $tw.hooks.names) { $tw.hooks.names["th-importing-file"] = []; }
		$tw.hooks.addHook("th-importing-file", function (info) {
			try {
				// Only when the External Attachments plugin is installed AND enabled.
				if (!$tw.wiki.getTiddler("$:/plugins/tiddlywiki/external-attachments")) { return false; }
				if ($tw.wiki.getTiddlerText("$:/config/ExternalAttachments/Enable", "no") !== "yes") { return false; }
				var file = info.file;
				if (!file) { return false; }
				var name = file.name || "attachment";
				if (NATIVE_RE.test(name)) { return false; } // let TiddlyWiki import its own formats

				var type = info.type || file.type || "application/octet-stream";
				var reader = new FileReader();
				reader.onload = function () {
					var rel = "";
					try {
						var res = String(reader.result || "");
						var comma = res.indexOf(",");
						var b64 = comma >= 0 ? res.slice(comma + 1) : "";
						rel = TDAttach.saveAttachment(b64, name, type);
						if (rel) {
							info.callback([{ title: name, type: type, "_canonical_uri": rel }]);
						} else {
							// Fall back to embedding the binary if the copy failed.
							info.callback([{ title: name, type: type, text: b64 }]);
						}
					} catch (e) {
						info.callback([{ title: name, type: type }]);
					}
				};
				reader.onerror = function () { info.callback([{ title: name, type: type }]); };
				reader.readAsDataURL(file);
				return true; // handling asynchronously
			} catch (e) {
				return false;
			}
		});
	});
})();
