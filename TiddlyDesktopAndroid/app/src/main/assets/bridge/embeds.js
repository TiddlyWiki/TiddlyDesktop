/*
 * Safe embedding of external media (YouTube, Vimeo, maps, …) in wiki windows — the Android
 * counterpart of TiddlyDesktopOverhaul's source/js/utils/embeds.js.
 *
 * Android differs from the desktop (NW.js) case: our wiki windows are served over
 * http://127.0.0.1, so an external iframe already has an http origin/Referer — there is NO
 * file:// referer problem (YouTube error 153), so no loopback shim is needed. What we DO need
 * is to grant allowlisted embeds the right Permissions-Policy via allow= (fullscreen, autoplay,
 * encrypted-media, picture-in-picture) so their players work fully; fullscreen is then presented
 * natively by WikiActivity's WebChromeClient.onShowCustomView.
 *
 * Non-allowlisted external iframes are left exactly as the author wrote them. Local / relative /
 * blob: / data: iframes (TiddlyWiki's own frames) are left alone. Allowlist editable per-wiki via
 * $:/config/TiddlyDesktop/EmbedHosts (added to the defaults).
 */
(function () {
	if (window.__tdEmbeds) { return; }
	window.__tdEmbeds = true;

	var DEFAULT_HOSTS = [
		"youtube.com", "youtube-nocookie.com", "youtu.be",
		"player.vimeo.com", "vimeo.com", "dailymotion.com",
		"open.spotify.com", "soundcloud.com", "w.soundcloud.com", "bandcamp.com",
		"player.twitch.tv", "clips.twitch.tv", "embed.music.apple.com",
		"openstreetmap.org", "google.com", "codepen.io", "codesandbox.io", "jsfiddle.net", "archive.org"
	];
	var EMBED_ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write";

	function hostAllowed(hostname, list) {
		hostname = (hostname || "").toLowerCase();
		for (var i = 0; i < list.length; i++) {
			var h = list[i];
			if (hostname === h || hostname.slice(-(h.length + 1)) === ("." + h)) { return true; }
		}
		return false;
	}
	function allowedHosts() {
		var list = DEFAULT_HOSTS.slice();
		try {
			var txt = (window.$tw && $tw.wiki) ? $tw.wiki.getTiddlerText("$:/config/TiddlyDesktop/EmbedHosts", "") : "";
			if (txt) {
				txt.split(/[\s,]+/).forEach(function (h) {
					h = (h || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
					if (h) { list.push(h); }
				});
			}
		} catch (e) {}
		return list;
	}

	function harden(iframe) {
		if (!iframe || iframe.__tdEmbed) { return; }
		var src = iframe.getAttribute("src") || "";
		if (!/^https?:\/\//i.test(src)) { return; } // only real external embeds
		var host;
		try { host = new URL(src).hostname; } catch (e) { return; }
		if (!hostAllowed(host, allowedHosts())) { iframe.__tdEmbed = true; return; }
		iframe.setAttribute("allow", EMBED_ALLOW);
		iframe.setAttribute("allowfullscreen", "true");
		iframe.setAttribute("referrerpolicy", "origin-when-cross-origin");
		iframe.__tdEmbed = true;
	}

	function scan(root) {
		var f = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
		for (var i = 0; i < f.length; i++) { harden(f[i]); }
	}
	function observe() {
		try {
			var MO = window.MutationObserver || window.WebKitMutationObserver;
			if (!MO) { return; }
			new MO(function (muts) {
				for (var m = 0; m < muts.length; m++) {
					var mut = muts[m];
					if (mut.type === "attributes" && mut.target && mut.target.tagName === "IFRAME") {
						mut.target.__tdEmbed = false; harden(mut.target); continue;
					}
					for (var a = 0; a < mut.addedNodes.length; a++) {
						var n = mut.addedNodes[a];
						if (n.nodeType !== 1) { continue; }
						if (n.tagName === "IFRAME") { harden(n); } else if (n.querySelectorAll) { scan(n); }
					}
				}
			}).observe(document.documentElement || document.body, {
				childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
			});
		} catch (e) {}
	}
	function go() {
		if (!(window.$tw && $tw.wiki)) { setTimeout(go, 300); return; }
		scan(document); observe();
	}
	go();
})();
