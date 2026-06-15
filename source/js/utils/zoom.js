/*
Page zoom for TiddlyDesktop wiki windows (single-file + folder; NOT the backstage /
wiki list). NW.js app windows have no browser chrome, so the usual zoom shortcuts aren't
wired up. We bind Ctrl/Cmd + +/-/0 and Ctrl/Cmd + mouse-wheel to the native window zoom
(win.zoomLevel), and show a small fixed "reset zoom" control (like the find bar) whenever
the zoom isn't 100%, which snaps it back.

NW.js zoomLevel is log-base-1.2 of the zoom factor: 0 = 100%, +1 ≈ 120%, -1 ≈ 83%.
*/

"use strict";

var MIN_LEVEL = -5, MAX_LEVEL = 8, STEP = 0.5;

function levelToPercent(level) { return Math.round(Math.pow(1.2, level) * 100); }

/*
  win_nwjs    - the nw.js Window to zoom
  hostDoc     - the document that hosts the reset control (folder wiki: the window's
                document; single-file wiki: the outer window's document)
  contentDoc  - optional second document to bind shortcuts on (the single-file iframe),
                which may be replaced on reload — safe to call install() again then
*/
exports.install = function(win_nwjs, hostDoc, contentDoc) {
	if(!win_nwjs || !hostDoc) { return; }

	function getLevel() { try { return Number(win_nwjs.zoomLevel) || 0; } catch(e) { return 0; } }
	function setLevel(n) {
		n = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, n));
		try { win_nwjs.zoomLevel = n; } catch(e) {}
		update();
	}

	// The reset control is created once per host document and reused across iframe reloads.
	var btn = hostDoc.__tdZoomBtn;
	if(!btn) {
		injectStyle(hostDoc);
		btn = hostDoc.createElement("button");
		btn.className = "td-zoom-reset";
		btn.setAttribute("hidden", "");
		btn.title = "Reset zoom to 100%";
		btn.addEventListener("click", function() { setLevel(0); });
		hostDoc.body.appendChild(btn);
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
			// win.zoomLevel scales the whole page, including this fixed control. Counter-
			// scale by the inverse zoom factor so the reset panel keeps a constant size and
			// font-size. (transform-origin top-left keeps it pinned in its corner.)
			btn.style.transformOrigin = "top left";
			btn.style.transform = "scale(" + Math.pow(1.2, -lvl) + ")";
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

	// (Re)bind the content document — fresh on each iframe reload for single-file wikis.
	bindDoc(contentDoc);
	update();
};

function injectStyle(doc) {
	if(doc.getElementById("td-zoom-style")) { return; }
	var s = doc.createElement("style");
	s.id = "td-zoom-style";
	s.textContent = [
		".td-zoom-reset{position:fixed;top:0;left:0;z-index:2147483646;transform-origin:top left;",
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
