/*
 * Runs inside each wiki window. Android's WebView has NO built-in PDF plugin, so TiddlyWiki's
 * <embed type="application/pdf"> (from $:/core pdfparser) renders blank. This replaces each such
 * embed with its pages rendered by the bundled pdf.js — served same-origin from /__td/pdfjs/ by
 * WikiActivity's request interceptor, so there's no CORS issue with the loopback-served page.
 * Handles both external attachments (_canonical_uri → same-origin URL, Range-served) and embedded
 * base64 PDFs (data: URI). New PDFs in later-opened tiddlers are caught via a MutationObserver.
 */
(function () {
	if (window.__tdPdfViewer) { return; }
	window.__tdPdfViewer = true;

	var BASE = "/__td/pdfjs/";
	var MAX_PAGES = 50; // guard against a huge PDF janking the page

	function libReady(cb) {
		if (window.pdfjsLib) { cb(); return; }
		if (window.__tdPdfLibQueue) { window.__tdPdfLibQueue.push(cb); return; }
		window.__tdPdfLibQueue = [cb];
		var s = document.createElement("script");
		s.src = BASE + "pdf.min.js";
		s.onload = function () {
			try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + "pdf.worker.min.js"; } catch (e) {}
			var q = window.__tdPdfLibQueue; window.__tdPdfLibQueue = null;
			q.forEach(function (fn) { try { fn(); } catch (e) {} });
		};
		s.onerror = function () { window.__tdPdfLibQueue = null; };
		document.head.appendChild(s);
	}

	// pdf.js takes a URL for real fetches (attachments), or {data: Uint8Array} for data: URIs.
	function toSource(src) {
		if (src.indexOf("data:") !== 0) { return src; }
		try {
			var bin = atob(src.slice(src.indexOf(",") + 1));
			var arr = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
			return { data: arr };
		} catch (e) { return src; }
	}

	function render(embed) {
		if (embed.__tdPdf) { return; }
		embed.__tdPdf = true;
		var src = embed.getAttribute("src");
		if (!src) { return; }
		var box = document.createElement("div");
		box.className = "td-pdf-view";
		box.style.cssText = "display:block;width:100%;";
		if (embed.parentNode) { embed.parentNode.replaceChild(box, embed); }
		libReady(function () {
			if (!window.pdfjsLib) { fallbackLink(box, src); return; }
			pdfjsLib.getDocument(toSource(src)).promise.then(function (pdf) {
				var n = Math.min(pdf.numPages, MAX_PAGES);
				var dpr = window.devicePixelRatio || 1;
				var width = box.clientWidth || 600;
				(function page(i) {
					if (i > n) { return; }
					pdf.getPage(i).then(function (pg) {
						var scale = (width / pg.getViewport({ scale: 1 }).width) * dpr;
						var vp = pg.getViewport({ scale: scale });
						var canvas = document.createElement("canvas");
						canvas.width = vp.width; canvas.height = vp.height;
						canvas.style.cssText = "width:100%;height:auto;display:block;margin:0 auto 6px;";
						box.appendChild(canvas);
						pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise
							.then(function () { page(i + 1); }, function () { page(i + 1); });
					}, function () {});
				})(1);
			}).catch(function () { fallbackLink(box, src); });
		});
	}

	function fallbackLink(box, src) {
		var a = document.createElement("a");
		a.href = src; a.textContent = "Open PDF"; a.setAttribute("target", "_blank");
		box.appendChild(a);
	}

	function scan() {
		var list = document.querySelectorAll('embed[type="application/pdf"]');
		for (var i = 0; i < list.length; i++) { render(list[i]); }
	}

	scan();
	var pending = false;
	try {
		new MutationObserver(function () {
			if (pending) { return; }
			pending = true;
			setTimeout(function () { pending = false; scan(); }, 200);
		}).observe(document.body, { childList: true, subtree: true });
	} catch (e) {}
})();
