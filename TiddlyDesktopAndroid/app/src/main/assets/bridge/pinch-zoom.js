/*
 * Runs inside each wiki window. Makes pinch-zoom work for single-file wikis, which often ship a
 * viewport meta with user-scalable=no / maximum-scale=1 (older TW5 & Classic templates) that the
 * WebView honours, blocking the gesture. Folder wikis already zoom; this is harmless for them.
 *
 * We rewrite (or create) the <meta name="viewport"> so it permits user scaling, keeping
 * width=device-width so the layout stays responsive.
 */
(function () {
	if (window.__tdPinchZoom) { return; }
	window.__tdPinchZoom = true;

	function permit(content) {
		// Drop any directive that blocks/limits zoom, then re-add generous scaling limits.
		var parts = (content || "").split(",")
			.map(function (s) { return s.trim(); })
			.filter(function (s) {
				if (!s) { return false; }
				var key = s.split("=")[0].trim().toLowerCase();
				return key !== "user-scalable" && key !== "maximum-scale" && key !== "minimum-scale";
			});
		if (parts.indexOf("width=device-width") === -1) { parts.unshift("width=device-width"); }
		parts.push("user-scalable=yes");
		parts.push("minimum-scale=1");
		parts.push("maximum-scale=10");
		return parts.join(", ");
	}

	try {
		var meta = document.querySelector('meta[name="viewport"]');
		if (!meta) {
			meta = document.createElement("meta");
			meta.setAttribute("name", "viewport");
			(document.head || document.documentElement).appendChild(meta);
		}
		meta.setAttribute("content", permit(meta.getAttribute("content")));
	} catch (e) {}
})();
