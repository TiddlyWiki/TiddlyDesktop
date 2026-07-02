/*
 * Runs inside single-file wiki windows. Adds saving for TiddlyWiki CLASSIC (2.x), which has no TW5
 * `put` saver. Classic saves via the TiddlyFox protocol — it calls window.mozillaSaveFile, and we
 * PUT the content back to SingleFileWikiServer (the same file-write + backup path TW5 uses). Classic
 * also reads its template back via mozillaLoadFile (from /_source, the un-injected file), and it goes
 * read-only when not served from file://, so we re-enable editing.
 *
 * No-op for TiddlyWiki5 (detected by the absence of classic's #storeArea/#versionArea; TW5 saves via
 * the Dav/PUT saver and must not be touched).
 */
(function () {
	if (window.__tdClassicSaver) { return; }

	function isClassic() {
		var store = document.getElementById("storeArea");
		var ver = document.getElementById("versionArea");
		return !!(store && ver && /TiddlyWiki/.test(ver.textContent || ver.innerText || ""));
	}
	// Classic has finished booting once its store/story globals exist.
	function booted() { return isClassic() && window.store && window.story; }

	var tries = 0;
	(function wait() {
		if (booted()) { setup(); return; }
		if (window.$tw) { return; }             // it's TiddlyWiki5 — leave it alone
		if (tries++ < 100) { setTimeout(wait, 200); }
	})();

	function setup() {
		if (window.__tdClassicSaver) { return; }
		window.__tdClassicSaver = true;

		// TiddlyFox message box.
		var box = document.getElementById("tiddlyfox-message-box");
		if (!box) { box = document.createElement("div"); box.id = "tiddlyfox-message-box"; document.body.appendChild(box); }

		// The clean file (no ephemeral media-CSS) that classic swaps its store into when saving.
		var sourceText = null;
		function refreshSource() {
			return fetch("/_source", { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) { sourceText = t; });
		}
		refreshSource();

		// Classic's saver/loader hooks.
		window.mozillaSaveFile = function (path, content) {
			var msg = document.createElement("div");
			msg.setAttribute("data-tiddlyfox-path", path || "/");
			msg.setAttribute("data-tiddlyfox-content", content);
			box.appendChild(msg);
			var ev = document.createEvent("Events");
			ev.initEvent("tiddlyfox-save-file", true, false);
			msg.dispatchEvent(ev);
			return true;
		};
		window.mozillaLoadFile = function () { return sourceText != null ? sourceText : false; };
		window.convertUriToUTF8 = function (s) { return s; };
		window.convertUnicodeToFileFormat = function (s) { return s; };

		box.addEventListener("tiddlyfox-save-file", function (event) {
			var msg = event.target,
				content = msg.getAttribute("data-tiddlyfox-content"),
				path = msg.getAttribute("data-tiddlyfox-path");
			fetch("/", { method: "PUT", headers: { "Content-Type": "text/html;charset=UTF-8" }, body: content })
				.then(function (r) {
					if (!r.ok) { throw new Error("save HTTP " + r.status); }
					if (msg.parentNode) { msg.parentNode.removeChild(msg); }
					var done = document.createEvent("Events");
					done.initEvent("tiddlyfox-have-saved-file", true, false);
					done.savedFilePath = path;
					msg.dispatchEvent(done);
					refreshSource(); // next save templates off the just-saved file
				})
				.catch(function (e) { console.error("[classic-saver] save failed:", e); });
		}, false);

		// Classic is read-only unless served from file:// — flip it and re-render the chrome so the
		// edit/save UI appears. Best-effort across classic versions (each call guarded).
		try {
			if (window.config && config.options) { config.options.chkHttpReadOnly = false; }
			window.readOnly = false;
			if (typeof refreshPageTemplate === "function") { refreshPageTemplate(); }
			if (window.story && story.refreshAllTiddlers) { story.refreshAllTiddlers(true); }
			if (typeof refreshColorPalette === "function") { refreshColorPalette(); }
		} catch (e) { console.warn("[classic-saver] enable-edit failed:", e); }
	}
})();
