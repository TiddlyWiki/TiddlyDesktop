/*
 * Runs inside each wiki window. Defines window.__tdChooseSubfolder(): the shared "which subfolder
 * of attachments/ should this file go into?" prompt used by both import paths (in-wiki drag/drop
 * → attachments.js, and share-from-another-app → share-import.js).
 *
 * The choice is made in a NATIVE Android dialog (TDAttach.chooseSubfolder), so it works for the
 * share flow too (which has no wiki JS driving it before the file is staged). The bridge call is
 * asynchronous: it hands back a callback id, and Kotlin later invokes window.__tdAttachResolve.
 *
 * The last-used subfolder is remembered in $:/config/TiddlyDesktop/AttachmentsSubfolder so the
 * dialog pre-fills it — the common case is one tap to accept, but it is always editable, and blank
 * means the attachments/ root.
 */
(function () {
	if (window.__tdChooseSubfolder) { return; }

	var CONFIG = "$:/config/TiddlyDesktop/AttachmentsSubfolder";
	var seq = 0, callbacks = {};

	// Native → JS: Kotlin calls this with the callback id and a JSON result once the dialog closes.
	window.__tdAttachResolve = function (id, json) {
		var cb = callbacks[id];
		if (!cb) { return; }
		delete callbacks[id];
		var res;
		try { res = JSON.parse(json); } catch (e) { res = { status: "cancelled" }; }
		cb(res);
	};

	function rememberedDefault() {
		try { return ($tw.wiki.getTiddlerText(CONFIG, "") || "").trim(); } catch (e) { return ""; }
	}
	function remember(sub) {
		try { $tw.wiki.addTiddler(new $tw.Tiddler({ title: CONFIG, text: sub || "" })); } catch (e) {}
	}

	// Returns a Promise resolving to the chosen subfolder ("" = attachments root), or null if the
	// user cancelled. On a "saved" choice the value is remembered for next time.
	window.__tdChooseSubfolder = function () {
		return new Promise(function (resolve) {
			if (typeof TDAttach === "undefined" || !TDAttach.chooseSubfolder) { resolve(""); return; }
			var id = "sf" + (++seq);
			callbacks[id] = function (res) {
				if (res && res.status === "saved") {
					var sub = typeof res.subfolder === "string" ? res.subfolder : "";
					remember(sub);
					resolve(sub);
				} else {
					resolve(null); // cancelled
				}
			};
			try {
				TDAttach.chooseSubfolder(rememberedDefault(), id);
			} catch (e) {
				delete callbacks[id];
				resolve(""); // bridge unavailable → fall back to the attachments root
			}
		});
	};
})();
