/*
 * Runs inside each wiki window. Android's WebView has NO built-in PDF plugin, so TiddlyWiki's PDF
 * viewer (from $:/core pdfparser) can't render inline: older cores emit <embed type="application/pdf">
 * (renders blank), and TiddlyWiki 5.4.0 emits an <iframe src="data:application/pdf…"> — which the
 * WebView, having no PDF plugin, treats as a download and pops the "Save file" dialog instead of
 * showing the PDF. This replaces each such embed/iframe with its pages rendered by the bundled
 * pdf.js — served same-origin from /__td/pdfjs/ by WikiActivity's request interceptor, so there's no
 * CORS issue with the loopback-served page. Handles both external attachments (_canonical_uri →
 * same-origin URL, Range-served) and embedded base64 PDFs (data: URI).
 *
 * The replacement runs on a MICROtask (not a timer): a freshly-inserted iframe's resource load is
 * scheduled as a later task, so pulling it out of the DOM in the mutation microtask cancels that
 * load before the WebView can turn it into a download. A 200ms debounce would lose that race.
 */
(function () {
	if (window.__tdPdfViewer) { return; }
	window.__tdPdfViewer = true;

	// A DELIBERATE PDF download (the user clicks a PDF or download link) must still work, even though
	// native onDownload swallows the pdfparser's AUTOMATIC inline-viewer load. So on such a click we
	// "arm" the next download natively (TDWikiUX.armDownload); the auto-load, having no click, stays
	// suppressed. Capture phase, so we run before the click starts the navigation/download.
	try {
		document.addEventListener("click", function (e) {
			if (!window.TDWikiUX || !TDWikiUX.armDownload) { return; }
			var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
			if (!a) { return; }
			var href = a.getAttribute("href") || "";
			var path = href.split(/[?#]/)[0];
			if (a.hasAttribute("download") || href.indexOf("blob:") === 0 ||
				/^data:application\/pdf/i.test(href) || /\.pdf$/i.test(path)) {
				try { TDWikiUX.armDownload(); } catch (e2) {}
			}
		}, true);
	} catch (e) {}

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

	// Is this element a PDF viewer we should take over? Old cores: <embed type="application/pdf">.
	// TiddlyWiki 5.4.0: a bare <iframe> whose src is a data:application/pdf URI (embedded) or a
	// _canonical_uri ending in .pdf (external attachment). Real media embeds (YouTube, …) are http(s)
	// iframes that don't end in .pdf, so they're left to embeds.js.
	function isPdf(el) {
		if (el.tagName === "EMBED") { return (el.getAttribute("type") || "") === "application/pdf"; }
		if (el.tagName !== "IFRAME") { return false; }
		var src = el.getAttribute("src") || "";
		if (/^data:application\/pdf/i.test(src)) { return true; }
		return /\.pdf$/i.test(src.split(/[?#]/)[0]);
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

	function render(el) {
		if (el.__tdPdf) { return; }
		el.__tdPdf = true;
		var src = el.getAttribute("src");
		var box = document.createElement("div");
		box.className = "td-pdf-view";
		box.style.cssText = "display:block;width:100%;";
		// Replace synchronously — this removes the iframe from the DOM, cancelling its pending
		// (would-be-download) load — before we do any async pdf.js work.
		if (el.parentNode) { el.parentNode.replaceChild(box, el); }
		if (!src) { return; }
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
		var list = document.querySelectorAll('embed[type="application/pdf"], iframe');
		for (var i = 0; i < list.length; i++) {
			if (isPdf(list[i])) { render(list[i]); }
		}
	}

	scan();
	var scheduled = false;
	function schedule() {
		if (scheduled) { return; }
		scheduled = true;
		var run = function () { scheduled = false; scan(); };
		// A microtask runs before the browser services a newly-inserted iframe's resource load, so we
		// yank the PDF iframe out of the DOM before it can become a download.
		if (window.queueMicrotask) { queueMicrotask(run); } else { Promise.resolve().then(run); }
	}
	try {
		new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
	} catch (e) {}
})();
