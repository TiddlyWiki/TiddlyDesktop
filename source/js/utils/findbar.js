/*
Browser-style "find in page" panel for wiki windows.

Lives in the wiki WINDOW (outside the wiki document) and searches the wiki
content. For single-file wikis the content is the iframe and the panel renders in
the outer window that hosts it. Opened with Ctrl/Cmd+F. It highlights every match
and the current one via the CSS Custom Highlight API (no DOM mutation), shows a
match count, and navigates with Enter / Shift+Enter / the arrows / Esc — looking
and behaving like the browser's own find bar.

It deliberately does NOT take Ctrl/Cmd+F when focus is inside a CodeMirror 6
editor (which has its own search): the keypress is left to propagate to CM6.

installFindBar({ hostWindow, hostDocument, getContentWindow, getContentDocument })
  getContentWindow / getContentDocument are functions so the bar keeps working if
  the wiki iframe is reloaded.
*/

"use strict";

var SHOW_TEXT = 4, FILTER_ACCEPT = 1, FILTER_REJECT = 3;
var HL_ALL = "td-find-all", HL_CUR = "td-find-current";
var MAX_MATCHES = 10000;

exports.installFindBar = function(options) {
	var hostWindow         = options.hostWindow,
		hostDocument       = options.hostDocument,
		getContentWindow   = options.getContentWindow,
		getContentDocument = options.getContentDocument;
	if(!hostWindow || !hostDocument || !getContentWindow || !getContentDocument) { return; }

	// Re-point on a second call (e.g. the iframe reloaded) rather than duplicating.
	if(hostWindow.__tdFindBar) { try { hostWindow.__tdFindBar.refresh(); } catch(e) {} return; }

	var allRanges = [], curIndex = -1, lastQuery = "", contentKeyDoc = null, styledDoc = null,
		observer = null, observedDoc = null, reSearchTimer = null;

	function cwin() { try { return getContentWindow(); } catch(e) { return null; } }
	function cdoc() { try { return getContentDocument(); } catch(e) { return null; } }
	function highlightSupported() { var w = cwin(); return !!(w && w.CSS && w.CSS.highlights && w.Highlight); }

	// ── styles ──
	injectHostStyle(hostDocument);

	function injectContentStyleOnce() {
		var d = cdoc();
		if(!d || styledDoc === d) { return; }
		styledDoc = d;
		try {
			var s = d.createElement("style");
			s.setAttribute("data-td-findbar", "");
			s.textContent =
				"::highlight(" + HL_ALL + "){background:#ffe066;color:#000;}" +
				"::highlight(" + HL_CUR + "){background:#ff9a3c;color:#000;}";
			(d.head || d.documentElement).appendChild(s);
		} catch(e) {}
	}

	// ── panel ──
	var panel = hostDocument.createElement("div");
	panel.className = "td-findbar";
	panel.setAttribute("hidden", "");
	panel.innerHTML =
		'<input class="td-findbar-input" type="text" placeholder="Find in page" spellcheck="false" autocomplete="off" />' +
		'<span class="td-findbar-count"></span>' +
		'<span class="td-findbar-sep"></span>' +
		'<button class="td-findbar-btn td-findbar-prev" tabindex="-1" title="Previous match (Shift+Enter)"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg></button>' +
		'<button class="td-findbar-btn td-findbar-next" tabindex="-1" title="Next match (Enter)"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg></button>' +
		'<button class="td-findbar-btn td-findbar-close" tabindex="-1" title="Close (Esc)"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg></button>';
	hostDocument.body.appendChild(panel);

	var input    = panel.querySelector(".td-findbar-input"),
		countEl  = panel.querySelector(".td-findbar-count"),
		prevBtn  = panel.querySelector(".td-findbar-prev"),
		nextBtn  = panel.querySelector(".td-findbar-next"),
		closeBtn = panel.querySelector(".td-findbar-close");

	function isOpen() { return !panel.hasAttribute("hidden"); }

	function clearHighlights() {
		allRanges = []; curIndex = -1;
		var w = cwin();
		try { if(w && w.CSS && w.CSS.highlights) { w.CSS.highlights.delete(HL_ALL); w.CSS.highlights.delete(HL_CUR); } } catch(e) {}
	}

	function applyHighlights() {
		var w = cwin();
		if(!highlightSupported()) { return; }
		try {
			var hlAll = new w.Highlight();
			for(var i = 0; i < allRanges.length; i++) { hlAll.add(allRanges[i]); }
			w.CSS.highlights.set(HL_ALL, hlAll);
			if(curIndex >= 0 && allRanges[curIndex]) {
				var hlCur = new w.Highlight(allRanges[curIndex]);
				try { hlCur.priority = 1; } catch(e) {}
				w.CSS.highlights.set(HL_CUR, hlCur);
			}
		} catch(e) {}
	}

	function renderCount() {
		if(!lastQuery) { countEl.textContent = ""; panel.classList.remove("td-findbar-nomatch"); }
		else if(!allRanges.length) { countEl.textContent = "No results"; panel.classList.add("td-findbar-nomatch"); }
		else { countEl.textContent = (curIndex + 1) + "/" + allRanges.length; panel.classList.remove("td-findbar-nomatch"); }
		var noMatches = allRanges.length < 1;
		prevBtn.disabled = noMatches; nextBtn.disabled = noMatches;
	}

	// The nearest ancestor that is itself a scroll container (overflow auto/scroll
	// and actually overflowing). Returns null when the only scroller is the document
	// (body/html) — that case is handled by the window-scroll branch below. A match
	// can live inside a scrollable pane (the story river, a sidebar, a scrollable
	// <pre>), where scrolling the window does nothing; we must scroll that pane.
	function nearestScrollable(el, w) {
		var d = cdoc();
		for(var node = el; node && node.nodeType === 1; node = node.parentElement) {
			if((d && node === d.body) || (d && node === d.documentElement)) { return null; }
			var style; try { style = w.getComputedStyle(node); } catch(e) { continue; }
			var oy = style.overflowY, ox = style.overflowX;
			var scrollableY = (oy === "auto" || oy === "scroll" || oy === "overlay") && node.scrollHeight > node.clientHeight + 2;
			var scrollableX = (ox === "auto" || ox === "scroll" || ox === "overlay") && node.scrollWidth  > node.clientWidth  + 2;
			if(scrollableY || scrollableX) { return node; }
		}
		return null;
	}

	function scrollToCurrent() {
		var r = allRanges[curIndex];
		if(!r) { return; }
		var w = cwin();
		if(!w) { return; }
		var el = r.startContainer.nodeType === 1 ? r.startContainer : (r.startContainer.parentElement || r.startContainer.parentNode);
		// 1) Centre the match inside its nearest scrolling container, if any. Scrolling
		//    the container directly (vs scrollIntoView on the match's parent) avoids
		//    reflowing a huge block like <pre><code>, which is what used to freeze the UI.
		var sc = null;
		try { sc = nearestScrollable(el, w); } catch(e) {}
		if(sc) {
			try {
				var scRect = sc.getBoundingClientRect(), mRect = r.getBoundingClientRect();
				sc.scrollTop  += (mRect.top  + mRect.height / 2) - (scRect.top  + sc.clientHeight / 2);
				sc.scrollLeft += (mRect.left + mRect.width  / 2) - (scRect.left + sc.clientWidth  / 2);
			} catch(e) {}
			// Having scrolled the pane, only touch the document if the match is STILL
			// outside the viewport (e.g. the pane itself is partly off-screen). A match in
			// a scrollable sidebar — which TiddlyWiki positions `fixed` — is now visible, so
			// we stop here instead of scrolling the page body for nothing.
			try {
				var vr = r.getBoundingClientRect();
				if(vr.top >= 0 && vr.left >= 0 && vr.bottom <= w.innerHeight && vr.right <= w.innerWidth) { return; }
			} catch(e) { return; }
		}
		// 2) No scrolling pane (or the match is still off-screen): centre it in the window,
		//    so a match that scrolls the document still ends up in view.
		try {
			var rect = r.getBoundingClientRect();
			if(rect && (rect.height || rect.width || rect.top || rect.left)) {
				var targetY = (w.scrollY || w.pageYOffset || 0) + rect.top - (w.innerHeight / 2) + (rect.height / 2);
				w.scrollTo(w.scrollX || w.pageXOffset || 0, targetY > 0 ? targetY : 0);
				return;
			}
		} catch(e) {}
		// Fallback only when the range has no layout box (e.g. zero-size/hidden).
		try {
			var pel = r.startContainer.parentElement || r.startContainer.parentNode;
			if(pel && pel.scrollIntoView) { pel.scrollIntoView({block: "center", inline: "nearest"}); }
		} catch(e) {}
	}

	function setCurrent(i) {
		if(!allRanges.length) { curIndex = -1; renderCount(); return; }
		curIndex = ((i % allRanges.length) + allRanges.length) % allRanges.length;
		applyHighlights();
		scrollToCurrent();
		renderCount();
	}

	// Walk the current content and build a Range for every match. Pure — it reads
	// the live DOM and returns fresh ranges, so it can be re-run whenever the
	// content changes underneath us.
	function collectRanges(query) {
		var d = cdoc();
		if(!d || !d.body) { return []; }
		var q = query.toLowerCase(), ranges = [];
		var walker = d.createTreeWalker(d.body, SHOW_TEXT, function(node) {
			var p = node.parentNode;
			if(!p || !node.nodeValue) { return FILTER_REJECT; }
			var tag = p.nodeName;
			if(tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") { return FILTER_REJECT; }
			// Skip the find bar's own UI (matters for folder wikis, where the panel
			// shares the document with the wiki being searched).
			if(p.closest && p.closest(".td-findbar")) { return FILTER_REJECT; }
			return FILTER_ACCEPT;
		});
		var node;
		outer: while((node = walker.nextNode())) {
			var lower = node.nodeValue.toLowerCase(), from = 0, pos;
			while((pos = lower.indexOf(q, from)) !== -1) {
				try {
					var r = d.createRange();
					r.setStart(node, pos); r.setEnd(node, pos + q.length);
					ranges.push(r);
				} catch(e) {}
				from = pos + q.length;
				if(ranges.length >= MAX_MATCHES) { break outer; }
			}
		}
		return ranges;
	}

	// Fresh search from the input: reset to the first match and scroll to it.
	function search(query) {
		clearHighlights();
		lastQuery = query || "";
		if(!lastQuery) { renderCount(); return; }
		injectContentStyleOnce();
		allRanges = collectRanges(lastQuery);
		if(allRanges.length) { setCurrent(0); }
		else { renderCount(); }
	}

	// Re-run the active search after the content changed (e.g. the wiki re-rendered
	// the region a match was in). Keep the user on roughly the same match and do
	// NOT scroll, so live edits underneath the bar don't yank the viewport around.
	function reSearch() {
		if(!isOpen() || !lastQuery) { return; }
		injectContentStyleOnce();
		var prev = curIndex;
		allRanges = collectRanges(lastQuery);
		if(!allRanges.length) { clearHighlights(); renderCount(); return; }
		curIndex = prev >= 0 ? Math.min(prev, allRanges.length - 1) : 0;
		applyHighlights();
		renderCount();
	}

	// Watch the content for changes while the bar is open and re-run the search
	// (debounced) so highlights and the count stay correct when the wiki re-renders.
	// Highlights use the CSS Custom Highlight API and never touch the DOM, so this
	// can't feed back into itself.
	function startObserving() {
		stopObserving();
		var d = cdoc(), w = cwin();
		if(!d || !d.body) { return; }
		var MO = (w && w.MutationObserver) || hostWindow.MutationObserver;
		if(!MO) { return; }
		try {
			observer = new MO(function(mutations) {
				// Ignore mutations inside our own panel — for folder wikis it shares
				// the document, and updating the match count would otherwise re-trigger
				// the observer in an endless loop.
				var relevant = false;
				for(var i = 0; i < mutations.length; i++) {
					var t = mutations[i].target,
						el = t && (t.nodeType === 1 ? t : t.parentNode);
					if(!el || !el.closest || !el.closest(".td-findbar")) { relevant = true; break; }
				}
				if(!relevant) { return; }
				if(reSearchTimer) { clearTimeout(reSearchTimer); }
				reSearchTimer = setTimeout(function() { reSearchTimer = null; reSearch(); }, 200);
			});
			observer.observe(d.body, {subtree: true, childList: true, characterData: true});
			observedDoc = d;
		} catch(e) {}
	}

	function stopObserving() {
		if(reSearchTimer) { clearTimeout(reSearchTimer); reSearchTimer = null; }
		if(observer) { try { observer.disconnect(); } catch(e) {} observer = null; }
		observedDoc = null;
	}

	function open() {
		panel.removeAttribute("hidden");
		input.focus(); input.select();
		startObserving();
		if(input.value) { search(input.value); }
	}

	function close() {
		panel.setAttribute("hidden", "");
		if(searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
		stopObserving();
		clearHighlights();
		renderCount();
		try { var w = cwin(); if(w && w.focus) { w.focus(); } } catch(e) {}
	}

	// ── events ──
	// Debounce the per-keystroke scan: on a long page (e.g. a big <pre><code>) walking
	// the DOM and lower-casing huge text nodes on every keystroke causes visible stalls.
	var searchDebounce = null;
	input.addEventListener("input", function() {
		var v = input.value;
		if(searchDebounce) { clearTimeout(searchDebounce); }
		searchDebounce = setTimeout(function() { searchDebounce = null; search(v); }, 120);
	});
	input.addEventListener("keydown", function(e) {
		if(e.key === "Escape") { e.preventDefault(); close(); }
		else if(e.key === "Enter") { e.preventDefault(); if(allRanges.length) { setCurrent(curIndex + (e.shiftKey ? -1 : 1)); } }
	});
	prevBtn.addEventListener("click", function() { if(allRanges.length) { setCurrent(curIndex - 1); } input.focus(); });
	nextBtn.addEventListener("click", function() { if(allRanges.length) { setCurrent(curIndex + 1); } input.focus(); });
	closeBtn.addEventListener("click", close);

	// Ctrl/Cmd+F — open the bar. Layout-independent via e.code, with an e.key
	// fallback. We listen in the BUBBLE phase so any focused input or editor that
	// defines this shortcut for its own purpose runs first; if it claimed the key
	// (called preventDefault), we defer to it. This is generic — CodeMirror 6,
	// CodeMirror 5, Monaco, ACE, or any custom widget that handles Ctrl/Cmd+F is
	// honoured automatically, while a plain field (no handler) falls through to us.
	function onFindKey(e) {
		if(e.defaultPrevented) { return; }   // an editor/input already claimed it
		var isF = (e.code === "KeyF") || (e.key && e.key.toLowerCase() === "f");
		if(!isF || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) { return; }
		e.preventDefault();
		if(isOpen()) { input.focus(); input.select(); } else { open(); }
	}
	hostDocument.addEventListener("keydown", onFindKey, false);

	function attachContentKey() {
		var d = cdoc();
		if(!d || d === contentKeyDoc) { return; }
		try { d.addEventListener("keydown", onFindKey, false); contentKeyDoc = d; } catch(e) {}
	}
	attachContentKey();

	hostWindow.__tdFindBar = {
		open: open,
		close: close,
		// Re-bind to the content after an iframe reload.
		refresh: function() { styledDoc = null; if(isOpen()) { close(); } attachContentKey(); }
	};
};

function injectHostStyle(doc) {
	if(doc.getElementById("td-findbar-style")) { return; }
	var s = doc.createElement("style");
	s.id = "td-findbar-style";
	s.textContent = [
		".td-findbar{position:fixed;top:0;right:18px;z-index:2147483646;display:flex;align-items:center;gap:1px;",
		"background:#fff;color:#202124;border:1px solid #c7c7c7;border-top:none;border-radius:0 0 8px 8px;",
		"box-shadow:0 2px 9px rgba(0,0,0,0.25);padding:4px 6px;",
		'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,sans-serif;user-select:none;}',
		".td-findbar[hidden]{display:none;}",
		".td-findbar-input{border:none;outline:none;background:transparent;color:inherit;font:inherit;width:210px;padding:5px 4px;}",
		".td-findbar-count{color:#5f6368;font-size:12px;min-width:48px;text-align:right;white-space:nowrap;padding:0 6px 0 2px;}",
		".td-findbar.td-findbar-nomatch .td-findbar-input{color:#d93025;}",
		".td-findbar.td-findbar-nomatch .td-findbar-count{color:#d93025;}",
		".td-findbar-sep{width:1px;height:20px;background:#e0e0e0;margin:0 3px;}",
		".td-findbar-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;",
		"background:transparent;color:#5f6368;border-radius:4px;cursor:pointer;padding:0;}",
		".td-findbar-btn:hover:not(:disabled){background:rgba(0,0,0,0.08);}",
		".td-findbar-btn:disabled{opacity:0.35;cursor:default;}",
		"@media (prefers-color-scheme:dark){",
		".td-findbar{background:#292a2d;color:#e8eaed;border-color:#5f6368;box-shadow:0 2px 9px rgba(0,0,0,0.55);}",
		".td-findbar-count{color:#9aa0a6;}.td-findbar-sep{background:#5f6368;}.td-findbar-btn{color:#9aa0a6;}",
		".td-findbar-btn:hover:not(:disabled){background:rgba(255,255,255,0.1);}",
		".td-findbar.td-findbar-nomatch .td-findbar-input,.td-findbar.td-findbar-nomatch .td-findbar-count{color:#f28b82;}",
		"}"
	].join("");
	(doc.head || doc.documentElement).appendChild(s);
}
