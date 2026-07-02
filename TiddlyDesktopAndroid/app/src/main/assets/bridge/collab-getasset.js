/*
 * Runs inside each wiki window. The collab plugin's "save this attachment to a file on disk" button
 * is a `<$browse nwsaveas=…>` file input — an NW.js save-as dialog Android WebView doesn't support
 * (it opens a file-OPEN picker, and the resulting File has no .path, so the plugin embeds instead).
 *
 * We intercept the click on such inputs (they carry data-collab-asset = the shared tiddler title,
 * copied to the DOM by the $browse widget) and route to a native SAF "Save As" (TDCollab.saveAssetAs).
 * Native picks a content:// destination and re-dispatches codemirror-6-collab-get-asset with that
 * URI as the asset's dest path; the plugin then writes the bytes there via TDCollab.fileCmd.
 */
(function () {
	if (window.__tdCollabGetAsset || typeof TDCollab === "undefined") { return; }
	window.__tdCollabGetAsset = true;

	document.addEventListener("click", function (ev) {
		var inp = ev.target;
		if (inp && inp.tagName === "INPUT" && inp.getAttribute && inp.getAttribute("type") === "file" &&
			inp.hasAttribute("nwsaveas") && inp.hasAttribute("data-collab-asset")) {
			ev.preventDefault();
			ev.stopPropagation();
			try {
				TDCollab.saveAssetAs(inp.getAttribute("data-collab-asset"), inp.getAttribute("nwsaveas") || "asset");
			} catch (e) {}
		}
	}, true);
})();
