/*
Page zoom for TiddlyDesktop wiki windows (single-file + folder; NOT the backstage /
wiki list). NW.js app windows have no browser chrome, so the usual zoom shortcuts aren't
wired up. We bind Ctrl/Cmd + +/-/0 and Ctrl/Cmd + mouse-wheel, and show a small fixed
"reset zoom" control (like the find bar) whenever the zoom isn't 100%, which snaps it back.

We deliberately do NOT use NW.js's native window zoom (win.zoomLevel): that scales the
WHOLE window including the reset control, so it had to be counter-scaled — and because
NW.js applies the window zoom a frame or two after we set it, the counter-scale could never
stay perfectly in step, so the control flickered and changed size while zooming.

Instead we apply a synchronous CSS `zoom` to the wiki CONTENT only, and keep the reset
control in chrome that is never zoomed — so it is absolutely stable at any zoom level:
  • single-file wiki: the content is the iframe's document → we zoom its <html>; the
    control lives in the OUTER document and is untouched.
  • folder wiki: the content is this document's <body> → we zoom <body>; the control is
    parented to <html> (a sibling of <body>), so the body zoom never reaches it.

The zoom factor is 1.2^level (level 0 = 100%), matching the old percentage mapping.
*/

"use strict";

var MIN_LEVEL = -5, MAX_LEVEL = 8, STEP = 0.5;

function levelToPercent(level) { return Math.round(Math.pow(1.2, level) * 100); }

/*
  win_nwjs    - the nw.js Window (kept for signature compatibility; no longer used)
  hostDoc     - the document that hosts the reset control (folder wiki: the window's
                document; single-file wiki: the outer window's document)
  contentDoc  - the single-file iframe's document; its presence means "single-file mode".
                It may be replaced on reload — safe to call install() again then.
*/
exports.install = function(win_nwjs, hostDoc, contentDoc) {
	if(!hostDoc) { return; }

	var isSingleFile = !!contentDoc;

	// The element whose CSS `zoom` we drive: the iframe's <html> (single-file) or this
	// document's <body> (folder). Re-resolved each time so iframe reloads are handled.
	function zoomTarget() {
		if(isSingleFile) { return contentDoc ? contentDoc.documentElement : null; }
		return hostDoc.body || null;
	}
	function applyZoom(level) {
		var el = zoomTarget();
		if(!el) { return; }
		try { el.style.zoom = level ? String(Math.pow(1.2, level)) : ""; } catch(e) {}
	}

	// Level persists on the host document so it survives iframe reloads / a re-install().
	function getLevel() { return Number(hostDoc.__tdZoomLevel) || 0; }
	function setLevel(n) {
		n = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, n));
		hostDoc.__tdZoomLevel = n;
		applyZoom(n);
		update();
	}

	// The reset control is created once per host document and reused across iframe reloads.
	// It is parented OUTSIDE the zoom target so it never scales.
	var btn = hostDoc.__tdZoomBtn;
	if(!btn) {
		injectStyle(hostDoc);
		btn = hostDoc.createElement("button");
		btn.className = "td-zoom-reset";
		btn.setAttribute("hidden", "");
		btn.title = "Reset zoom to 100%";
		btn.addEventListener("click", function() { setLevel(0); });
		// Single-file: the outer document (separate from the zoomed iframe). Folder: <html>,
		// a sibling of the zoomed <body>.
		var parent = isSingleFile ? hostDoc.body : (hostDoc.documentElement || hostDoc.body);
		parent.appendChild(btn);
		hostDoc.__tdZoomBtn = btn;
		bindDoc(hostDoc);
	}

	function update() {
		var lvl = getLevel();
		if(Math.abs(lvl) < 0.001) {
			btn.setAttribute("hidden", "");
		} else {
			btn.textContent = levelToPercent(lvl) + "%  ⟳";
			btn.removeAttribute("hidden");
		}
	}

	function onKey(e) {
		if((!e.ctrlKey && !e.metaKey) || e.altKey) { return; }
		var k = e.key;
		if(k === "=" || k === "+") { e.preventDefault(); setLevel(getLevel() + STEP); }
		else if(k === "-" || k === "_") { e.preventDefault(); setLevel(getLevel() - STEP); }
		else if(k === "0") { e.preventDefault(); setLevel(0); }
	}
	function onWheel(e) {
		if(!e.ctrlKey && !e.metaKey) { return; }
		e.preventDefault();
		setLevel(getLevel() + (e.deltaY < 0 ? STEP : -STEP));
	}
	function bindDoc(d) {
		if(!d || d.__tdZoomBound) { return; }
		d.__tdZoomBound = true;
		try { d.addEventListener("keydown", onKey, true); } catch(e) {}
		try { d.addEventListener("wheel", onWheel, {passive: false, capture: true}); } catch(e) {}
	}

	// (Re)bind the content document and re-apply the current zoom — fresh on each iframe
	// reload for single-file wikis (the old <html> zoom went away with the old document).
	bindDoc(contentDoc);
	applyZoom(getLevel());
	update();
};

function injectStyle(doc) {
	if(doc.getElementById("td-zoom-style")) { return; }
	var s = doc.createElement("style");
	s.id = "td-zoom-style";
	s.textContent = [
		".td-zoom-reset{position:fixed;top:0;left:0;z-index:2147483646;",
		"display:inline-flex;align-items:center;gap:4px;",
		"background:#fff;color:#202124;border:1px solid #c7c7c7;border-top:none;",
		"border-radius:0 0 8px 8px;box-shadow:0 2px 9px rgba(0,0,0,0.25);",
		"padding:5px 11px;cursor:pointer;",
		'font:13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,sans-serif;}',
		".td-zoom-reset[hidden]{display:none;}",
		".td-zoom-reset:hover{background:#f1f3f4;}",
		"@media (prefers-color-scheme:dark){",
		".td-zoom-reset{background:#292a2d;color:#e8eaed;border-color:#5f6368;box-shadow:0 2px 9px rgba(0,0,0,0.55);}",
		".td-zoom-reset:hover{background:#3c4043;}",
		"}"
	].join("");
	(doc.head || doc.documentElement).appendChild(s);
}
