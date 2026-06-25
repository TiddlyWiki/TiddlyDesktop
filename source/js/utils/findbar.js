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

var HL_ALL = "td-find-all", HL_CUR = "td-find-current";
var MAX_MATCHES = 10000;

// Elements that introduce a visual line/box break. A query must not match across
// one of these (the browser's own find-in-page doesn't either), so we insert a
// separator between their text when flattening the DOM. Everything else (notably
// the <span>s a syntax highlighter wraps each token in) counts as inline, so a
// query like "$tw." still matches when it's split across adjacent inline spans.
var BLOCK_TAGS = {
	ADDRESS:1, ARTICLE:1, ASIDE:1, BLOCKQUOTE:1, BR:1, CANVAS:1, DD:1, DETAILS:1,
	DIALOG:1, DIV:1, DL:1, DT:1, FIELDSET:1, FIGCAPTION:1, FIGURE:1, FOOTER:1,
	FORM:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, HEADER:1, HR:1, LI:1, MAIN:1,
	NAV:1, OL:1, P:1, PRE:1, SECTION:1, SUMMARY:1, TABLE:1, TBODY:1, TD:1, TFOOT:1,
	TH:1, THEAD:1, TR:1, UL:1, VIDEO:1
};

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

	// allRanges holds "hit" objects, each either {kind:"range", range, pos} for normal DOM
	// text or {kind:"field", el, start, end, pos} for a match inside a <textarea>/<input>
	// (whose text lives in .value, not the DOM). Only range hits can be painted with the CSS
	// Custom Highlight API; field hits are revealed via the control's native selection.
	function applyHighlights() {
		var w = cwin();
		if(!highlightSupported()) { return; }
		try {
			var hlAll = new w.Highlight();
			for(var i = 0; i < allRanges.length; i++) {
				var hit = allRanges[i];
				if(hit && hit.kind === "range" && hit.range) { hlAll.add(hit.range); }
			}
			w.CSS.highlights.set(HL_ALL, hlAll);
			var cur = curIndex >= 0 ? allRanges[curIndex] : null;
			if(cur && cur.kind === "range" && cur.range) {
				var hlCur = new w.Highlight(cur.range);
				try { hlCur.priority = 1; } catch(e) {}
				w.CSS.highlights.set(HL_CUR, hlCur);
			} else {
				// Current match is a form field (or none) — no range to paint, so drop any
				// stale "current" highlight rather than leaving it on a previous match.
				try { w.CSS.highlights.delete(HL_CUR); } catch(e) {}
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

	// Reveal a match inside a form control: scroll it into view and select it natively (the
	// Highlight API can't paint inside <textarea>/<input>). Selecting needs focus, so we focus
	// the control, set the selection, then hand focus back to the find input so Enter/arrows
	// keep navigating — the control keeps its (inactive) selection visible.
	function scrollToField(hit) {
		try {
			var el = hit.el;
			if(el && el.scrollIntoView) { el.scrollIntoView({block: "center", inline: "nearest"}); }
			if(el && el.setSelectionRange) {
				try { el.focus({preventScroll: true}); el.setSelectionRange(hit.start, hit.end); } catch(e) {}
			}
		} catch(e) {}
		try { input.focus(); } catch(e) {}
	}

	function scrollToCurrent() {
		var hit = allRanges[curIndex];
		if(!hit) { return; }
		if(hit.kind === "field") { scrollToField(hit); return; }
		var r = hit.range;
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
	//
	// We flatten the visible text into one string and search that, rather than each
	// text node on its own, so a query that spans element boundaries still matches —
	// e.g. "$tw." rendered by a syntax highlighter as <span>$tw</span><span>.</span>
	// lives in two text nodes and would otherwise never be found. Block-level
	// elements insert a separator so we don't match across unrelated lines/blocks.
	function collectRanges(query) {
		var d = cdoc();
		if(!d || !d.body) { return []; }
		var q = query.toLowerCase();
		if(!q) { return []; }

		// Flatten body text in document order. `segments` records, for each text
		// node, where its text starts in the combined string, so a match position
		// can be mapped back to a node + offset. `sepPending` collapses runs of
		// block boundaries into a single separator and avoids a leading one.
		var hits = [];
		var segments = [], parts = [], gLen = 0, sepPending = false;
		var SEP = "\n";
		function addSep() {
			if(gLen > 0 && !sepPending) { parts.push(SEP); gLen += SEP.length; sepPending = true; }
		}
		function skippable(el) {
			var tag = el.nodeName;
			if(tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") { return true; }
			if(el.classList) {
				// Skip the find bar's own UI (matters for folder wikis, where the panel shares
				// the document with the wiki being searched).
				if(el.classList.contains("td-findbar")) { return true; }
				// Skip the minimap (tiddlywiki-minimap): it's a miniature duplicate of the
				// document — including an iframe copy we'd otherwise descend into — so matching
				// inside it just produces phantom, unscrollable duplicates of every real hit.
				if(el.classList.contains("tc-minimap-wrapper") || el.classList.contains("tc-minimap")) { return true; }
			}
			return false;
		}
		function isTextInput(el) {
			if(el.nodeName === "TEXTAREA") { return true; }
			if(el.nodeName !== "INPUT") { return false; }
			var t = (el.getAttribute("type") || "text").toLowerCase();
			return t === "text" || t === "search" || t === "url" || t === "email" || t === "tel";
		}
		// A form control's live text is in .value, not the DOM, so flatten-and-search can't
		// see it. Search the value and record "field" hits (one per match), tagged with the
		// stream offset of the control so they sort into document order with the text hits.
		function addFieldHits(el, pos) {
			var value = el.value;
			if(!value) { return; }
			var lv = value.toLowerCase(), from = 0, p;
			while((p = lv.indexOf(q, from)) !== -1) {
				hits.push({ kind: "field", el: el, start: p, end: p + q.length, pos: pos });
				from = p + q.length;
				if(hits.length >= MAX_MATCHES) { break; }
			}
		}
		function iframeBody(el) {
			try { return el.contentDocument && el.contentDocument.body; } catch(e) { return null; }
		}
		// Same-origin nested iframe (e.g. TiddlyWiki's "framed" editor wraps its textarea in
		// one): collect ONLY its field hits — we don't pull its normal text into this
		// document's single highlight set, but the editor's textarea must still be findable.
		function walkFields(node, pos) {
			for(var child = node.firstChild; child; child = child.nextSibling) {
				if(child.nodeType !== 1 || skippable(child)) { continue; }
				if(isTextInput(child)) { addFieldHits(child, pos); continue; }
				if(child.nodeName === "IFRAME") { var b = iframeBody(child); if(b) { walkFields(b, pos); } continue; }
				walkFields(child, pos);
			}
		}
		function walk(el) {
			for(var child = el.firstChild; child; child = child.nextSibling) {
				var nt = child.nodeType;
				if(nt === 3) {
					var v = child.nodeValue;
					if(v) {
						segments.push({ node: child, gStart: gLen, len: v.length });
						parts.push(v); gLen += v.length; sepPending = false;
					}
				} else if(nt === 1) {
					if(skippable(child)) { continue; }
					if(isTextInput(child)) { addFieldHits(child, gLen); continue; }
					if(child.nodeName === "IFRAME") { var b = iframeBody(child); if(b) { walkFields(b, gLen); } continue; }
					var block = BLOCK_TAGS[child.nodeName] === 1;
					if(block) { addSep(); }
					walk(child);
					if(block) { addSep(); }
				}
			}
		}
		walk(d.body);

		// Map a position in the combined string to a {node, offset}. Binary search
		// over segments; positions that fall on a separator return null (a match can
		// only land there if the query itself contains the separator char).
		function locate(p) {
			var lo = 0, hi = segments.length - 1;
			while(lo <= hi) {
				var mid = (lo + hi) >> 1, seg = segments[mid];
				if(p < seg.gStart) { hi = mid - 1; }
				else if(p >= seg.gStart + seg.len) { lo = mid + 1; }
				else { return { node: seg.node, offset: p - seg.gStart }; }
			}
			return null;
		}

		var hay = parts.join("").toLowerCase(), from = 0, pos;
		while((pos = hay.indexOf(q, from)) !== -1) {
			// Start at the first matched char; end after the last one, so a match that
			// spans two adjacent inline text nodes yields a range across both.
			var startLoc = locate(pos), endLoc = locate(pos + q.length - 1);
			if(startLoc && endLoc) {
				try {
					var r = d.createRange();
					r.setStart(startLoc.node, startLoc.offset);
					r.setEnd(endLoc.node, endLoc.offset + 1);
					hits.push({ kind: "range", range: r, pos: pos });
				} catch(e) {}
			}
			from = pos + q.length;
			if(hits.length >= MAX_MATCHES) { break; }
		}

		// Order all hits by their offset in the flattened stream so next/prev follow document
		// order across both kinds (a field hit sits at the stream offset of its control).
		hits.sort(function(a, b) { return a.pos - b.pos; });
		if(hits.length > MAX_MATCHES) { hits.length = MAX_MATCHES; }
		return hits;
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
	// the region a match was in). Keep the user on the SAME physical match and do
	// NOT scroll, so live edits underneath the bar don't yank the viewport around.
	//
	// We anchor to the current match's start position, not its numeric index: a
	// re-render that inserts or removes a match ABOVE the current one shifts every
	// index after it, so keeping the old number (Math.min(prev,len-1)) would silently
	// jump the highlight onto a different match and desync the "n/N" counter. Instead
	// we relocate the range whose start is at-or-after the old current's start, so the
	// highlight stays put and the counter always reflects true document order — making
	// next/prev consistent (1 = first match, N = last) even while the DOM churns.
	// Document-order comparison of a new hit against the old current ("anchor"): >=0 if the new
	// hit is at or after the anchor, or null when the two can't be compared (different kinds, a
	// detached anchor range, or field hits in different controls).
	function compareHitToAnchor(h, anchor) {
		if(h.kind === "range" && anchor.kind === "range") {
			// START_TO_START (0): is this new range at or after the old current's start?
			try { return h.range.compareBoundaryPoints(0, anchor.range); } catch(e) { return null; }
		}
		if(h.kind === "field" && anchor.kind === "field" && h.el === anchor.el) {
			return h.start - anchor.start;
		}
		return null;
	}

	function reSearch() {
		if(!isOpen() || !lastQuery) { return; }
		injectContentStyleOnce();
		var anchor = (curIndex >= 0 && allRanges[curIndex]) ? allRanges[curIndex] : null;
		var newHits = collectRanges(lastQuery);
		if(!newHits.length) { clearHighlights(); renderCount(); return; }
		var idx = 0;
		if(anchor) {
			idx = -1;
			// First new hit at-or-after the old current. Incomparable hits (e.g. a field hit
			// when the anchor is a range) are skipped, not treated as a stop, so a range anchor
			// still lands on the right range even with editor matches interspersed.
			for(var i = 0; i < newHits.length; i++) {
				var cmp = compareHitToAnchor(newHits[i], anchor);
				if(cmp !== null && cmp >= 0) { idx = i; break; }
			}
			// Nothing comparable at-or-after (anchor detached / was the last match): clamp.
			if(idx === -1) { idx = Math.min(curIndex < 0 ? 0 : curIndex, newHits.length - 1); }
		}
		allRanges = newHits;
		curIndex = idx;
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
