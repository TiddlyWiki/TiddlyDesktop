/*
 * Runs inside each wiki window. Adds a "Share" tiddler-toolbar button that opens a "Share as"
 * dropdown (text / .tid / HTML) and shares the chosen form out via Android's share sheet
 * (window.TDShare). The button tiddler is a $:/temp tiddler so it's never saved into the wiki.
 */
(function () {
	if (window.__tdShareTiddler || typeof TDShare === "undefined") { return; }
	window.__tdShareTiddler = true;

	// Labels localized to the device language (native strings.xml), with English fallback.
	var L = { share: "Share", tooltip: "Share this tiddler", text: "Share as text", tid: "Share as .tid", html: "Share as HTML" };
	try { if (TDShare.uiStrings) { L = Object.assign(L, JSON.parse(TDShare.uiStrings())); } } catch (e) {}

	function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

	var BTN =
		'<$button popup=<<qualify "$:/state/td-share-popup">> tooltip="' + esc(L.tooltip) + '" aria-label="' + esc(L.share) + '" class=<<tv-config-toolbar-class>>>' +
		'<$list filter="[<tv-config-toolbar-icons>match[yes]]">{{$:/core/images/export-button}}</$list>' +
		'<$list filter="[<tv-config-toolbar-text>match[yes]]"><span class="tc-btn-text">' + esc(L.share) + '</span></$list>' +
		'</$button>' +
		'<$reveal state=<<qualify "$:/state/td-share-popup">> type="popup" position="belowleft" animate="yes">' +
		'<div class="tc-drop-down">' +
		shareItem("text", L.text) +
		shareItem("tid", L.tid) +
		shareItem("html", L.html) +
		'</div></$reveal>';

	function shareItem(fmt, label) {
		return '<$button class="tc-btn-invisible">' +
			'<$action-sendmessage $message="tm-td-share-tiddler" tiddler=<<currentTiddler>> format="' + fmt + '"/>' +
			'<$action-deletetiddler $tiddler=<<qualify "$:/state/td-share-popup">>/>' +
			esc(label) + '</$button>';
	}

	function whenReady(fn) {
		if (window.$tw && $tw.wiki && $tw.rootWidget) { fn(); } else { setTimeout(function () { whenReady(fn); }, 250); }
	}
	whenReady(function () {
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/ShareButton",
			tags: "$:/tags/ViewToolbar",
			caption: L.share,
			description: L.tooltip,
			text: BTN
		}));

		$tw.rootWidget.addEventListener("tm-td-share-tiddler", function (event) {
			try {
				var po = event.paramObject || {};
				var title = po.tiddler || event.param;
				if (!title) { return false; }
				var fmt = po.format || "text";
				if (fmt === "tid") {
					// Share as an actual <title>.tid file (FileProvider).
					var tid = $tw.wiki.renderTiddler("text/plain", "$:/core/templates/tid-tiddler", { variables: { currentTiddler: title } });
					TDShare.shareTidFile(title, tid);
					return false;
				}
				var content;
				if (fmt === "html") {
					content = $tw.wiki.renderTiddler("text/html", title);
				} else {
					var t = $tw.wiki.getTiddler(title);
					content = (t && t.fields.text != null) ? String(t.fields.text) : "";
				}
				TDShare.shareText(title, content);
			} catch (e) {}
			return false;
		});
	});
})();
