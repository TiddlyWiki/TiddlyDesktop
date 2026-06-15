/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/sharing.js
type: application/javascript
module-type: startup

Tiddler sharing protocol for codemirror-6-collab-nwjs.

Sharing model:
  - Any room member can "share" one of their tiddlers to the room.
  - A shared title is a room-level resource: the first peer to share a given
    title claims ownership of it. Subsequent peers cannot re-share the same
    title while that claim is active.
  - Other members see a list of available tiddlers in the collab sidebar.
  - Clicking "Get" subscribes to that tiddler: the current content is fetched
    from the owner and future changes propagate automatically via a $tw.wiki
    change listener.
  - Draft tiddlers (draft.of field set) are never broadcast.
  - Yjs / CM6 collab continues to handle real-time character-level sync for
    tiddlers open in a CodeMirror 6 editor.
  - If the owner is offline, new peers cannot fetch the tiddler. Existing
    subscribers keep their last-synced local copy and resume when the owner
    reconnects.

Catch-up conflict resolution (on collab-tiddler-response):
  - Remote modified > local modified → apply remote silently.
  - Local modified > remote modified → keep local, proactively push to room.
  - Same/missing timestamp but different text → show ConflictDialog:
      "use-shared"  → apply remote fields.
      "cancel"      → keep local, proactively push local version to room.

Title uniqueness:
  - A title already claimed by peer A cannot be claimed by peer B.
  - Duplicate claims arriving via manifests or collab-share-new are silently
    dropped. The original owner must unshare before anyone else can claim it.

Persistence:
  - Owned tiddlers:       $:/config/codemirror-6-collab/owned-tiddlers  (JSON)
  - Subscribed tiddlers:  $:/config/codemirror-6-collab/subscribed-tiddlers (JSON)
  These survive wiki saves and reloads.

Message types (sent via transport's _send → relay + LAN, all carry msg_id):
  collab-manifest-request  {requesterDeviceId}
  collab-share-manifest    {senderDeviceId, senderName, manifest:[{title,ownerDeviceId,ownerName,sharedAt}]}
  collab-share-new         {ownerDeviceId, ownerName, title, sharedAt}
  collab-unshare           {ownerDeviceId, title}
  collab-get-tiddler       {requesterDeviceId, title, requestId}
  collab-tiddler-response  {targetDeviceId, title, requestId, fields}
  collab-tiddler-update    {senderDeviceId, title, fields}
  collab-tiddler-rename    {ownerDeviceId, fromTitle, toTitle}
\*/

"use strict";

exports.name        = "codemirror-6-collab-nwjs-sharing";
exports.after       = ["codemirror-6-collab-nwjs-transport", "startup", "rootwidget"];
exports.synchronous = true;
exports.platforms   = ["browser"];

var CONFIG_OWNED      = "$:/config/codemirror-6-collab/owned-tiddlers";        // legacy (pre per-room), migrated on first run
var CONFIG_SUBSCRIBED = "$:/config/codemirror-6-collab/subscribed-tiddlers";   // legacy
// Per-room share state: JSON { "<roomCode>": { owned:[titles], subscribed:[{title,...}] } }.
// Owned/subscribed are scoped to the room they were made in, so switching rooms doesn't
// carry your shares/subscriptions across. (Manifests + temp tiddlers are already per
// connection, hence per room.)
var CONFIG_ROOMS      = "$:/config/codemirror-6-collab/rooms";
var AVAIL_PREFIX      = "$:/temp/collab/share/available/";
var OWNED_PREFIX      = "$:/temp/collab/share/owned/";

exports.startup = function() {

	// ── state ──────────────────────────────────────────────────────────────────

	// Tiddlers this session owns (we shared them).
	// title → {sharedAt: ms}
	var ownedTiddlers = {};

	// Tiddlers we have subscribed to (Got from a peer).
	// title → {ownerDeviceId: string}
	var subscribedTiddlers = {};

	// All tiddlers available in the current room session (including ours).
	// title → {ownerDeviceId, ownerName, sharedAt}
	// Invariant: for any title, exactly one ownerDeviceId can hold the claim.
	var availableTiddlers = {};

	// The room code the current in-memory owned/subscribed sets belong to (so we persist
	// them under the right room even after $:/config room-code has already changed).
	var _stateRoom = "";

	// Titles currently being written from a peer update - suppresses echo.
	var suppressEcho = {};

	// Titles being renamed programmatically (subscriber auto-follow) - prevents
	// th-renaming-tiddler re-entry.
	var suppressRenameHook = {};

	// Last content we were in agreement on, per title — the "base" for 3-way conflict
	// detection. In-memory (re-established on the next sync after a reload). Lets us tell
	// "I didn't change it, so adopt theirs" from "we both changed it → real conflict".
	var syncedText = {};

	// title -> remote fields, kept while a tiddler is flagged diverged so Resolve can
	// apply "theirs" without re-fetching.
	var divergedRemote = {};

	// requestId -> title for a user-triggered Re-sync, so we can resolve its response
	// the same way as a background catch-up (it just guarantees a round-trip).
	var manualResync = {};

	// Record the content we're now in sync on (the 3-way base) for `title`.
	function _markSynced(title) {
		var t = $tw.wiki.getTiddler(title);
		syncedText[title] = t ? _contentString(_serialise(t)) : "";
	}

	// Flag/unflag a tiddler as diverged (both sides edited since the last common base).
	// Drives the "Resolve" affordance in the Get list; remembers the remote version.
	function _setDiverged(title, remoteFields) {
		divergedRemote[title] = remoteFields;
		if(availableTiddlers[title]) {
			availableTiddlers[title].diverged = true;
			_writeAvailable(title, availableTiddlers[title]);
		}
	}
	function _clearDiverged(title) {
		delete divergedRemote[title];
		if(availableTiddlers[title] && availableTiddlers[title].diverged) {
			delete availableTiddlers[title].diverged;
			_writeAvailable(title, availableTiddlers[title]);
		}
	}

	// Always use the transport's ephemeral session ID (this module loads after the
	// transport). Never fall back to the persisted device-id config tiddler — on
	// cloned wikis that holds a stale, shared value that would re-introduce ID
	// collisions between the two copies.
	var deviceId = (window.TiddlyDesktop && window.TiddlyDesktop.collab)
		? window.TiddlyDesktop.collab.getDeviceId()
		: "unknown";

	// ── utilities ──────────────────────────────────────────────────────────────

	function _send(msg) {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collab;
		if(api && api.send) { api.send(msg); }
	}

	// True while we have a live relay connection. Used to gate base advancement: an edit
	// made while disconnected reached no one, so it must NOT become the 3-way base — else
	// on reconnect "local == base" makes us silently adopt a peer's concurrent edit instead
	// of flagging the genuine conflict.
	function _isConnected() {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collab;
		try { return !!(api && api.getStatus && api.getStatus() === "connected"); } catch(e) { return false; }
	}

	// Pairwise (1:1) send for asset bytes — encrypted exclusively for the recipient
	// (pairwise ECDH) so megabytes aren't broadcast to the whole room. Falls back to
	// a room send if the pairwise channel isn't available.
	function _sendPrivate(to, msg) {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collab;
		if(to && api && api.sendPrivate) { return api.sendPrivate(to, msg); }
		_send(msg);
	}

	var assetUtil = require("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/asset-util.js");

	// Asset chunking, paced under the relay's rate limit (~512 KB/s) so streaming a
	// large file never trips the server's flood protection and drops the connection.
	var ASSET_CHUNK_B64 = 256 * 1024;   // base64 chars per chunk
	var ASSET_CHUNK_MS  = 1300;         // ms between chunks

	// pendingAssetGets[requestId] = {title, dest}   (dest "" = embed inline)
	// incomingAssets[requestId]   = {meta, chunks[], received}
	var pendingAssetGets = {};
	var incomingAssets   = {};
	var assetGot         = {};   // titles whose asset we've fetched (UI "Saved" marker)

	// Asset metadata for a tiddler we could share: {name, type} if it is a binary
	// asset whose bytes a receiver may want to land on disk. Two forms qualify:
	//   - a LOCAL _canonical_uri (external on our side) → bytes come from the file;
	//   - an embedded binary tiddler (base64 text, no _canonical_uri) → bytes are
	//     the text itself, so a receiver who prefers external attachments can still
	//     re-materialise it as a file.
	// The owner's storage form and the receiver's are independent.
	function _assetInfo(title) {
		var t = $tw.wiki.getTiddler(title);
		if(!t) { return null; }
		var uri = t.fields._canonical_uri;
		if(uri && assetUtil.isLocalCanonicalUri(uri)) {
			return {name: assetUtil.basename(uri), type: t.fields.type || ""};
		}
		if(!uri && assetUtil.isBinaryType(t.fields.type)) {
			return {name: assetUtil.assetFileName(title, t.fields.type), type: t.fields.type};
		}
		return null;
	}

	function _safeJson(text) {
		try { return JSON.parse(text || "[]"); } catch(_e) { return []; }
	}

	// Parse any date representation to milliseconds (0 on failure).
	function _parseMs(val) {
		if(!val) return 0;
		if(val instanceof Date) return isNaN(val.getTime()) ? 0 : val.getTime();
		var d = new Date(val);
		return isNaN(d.getTime()) ? 0 : d.getTime();
	}

	// Serialise tiddler fields for wire transmission (Date → ISO string).
	// _canonical_uri is never transmitted: it is a per-machine external reference with no
	// meaning on another peer, and sending it would let a viewer be pointed at a local
	// file (file://) or an outbound URL (http:// → SSRF). The asset bytes travel through
	// the explicit Get-attachment flow instead; receivers set their own _canonical_uri.
	function _serialise(tiddler) {
		var out = {};
		Object.keys(tiddler.fields).forEach(function(f) {
			if(f === "_canonical_uri") { return; }
			var v = tiddler.fields[f];
			out[f] = (v instanceof Date) ? v.toISOString() : v;
		});
		return out;
	}

	// ── persistence ────────────────────────────────────────────────────────────

	function _currentRoom() {
		return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/room-code", "") || "";
	}

	function _loadRoomsStore() {
		var obj = _safeJson($tw.wiki.getTiddlerText(CONFIG_ROOMS, "{}"));
		return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
	}

	function _writeRoomsStore(store) {
		// Idempotent: skip the write (and the change event that would dirty the wiki) when
		// the persisted JSON is unchanged — manifests can call _saveSubscribed frequently.
		var text = JSON.stringify(store);
		if($tw.wiki.getTiddlerText(CONFIG_ROOMS, "") === text) { return; }
		$tw.wiki.addTiddler(new $tw.Tiddler({title: CONFIG_ROOMS, text: text}));
	}

	// Persist the current in-memory owned/subscribed sets under the room they belong to
	// (_stateRoom). Both _saveOwned and _saveSubscribed funnel here.
	function _persistRoomState() {
		var store = _loadRoomsStore();
		var owned = Object.keys(ownedTiddlers);
		var subscribed = Object.keys(subscribedTiddlers)
			.filter(function(title) { return !ownedTiddlers[title]; })
			.map(function(title) {
				var sub = subscribedTiddlers[title], avail = availableTiddlers[title] || {};
				return {
					title:         title,
					ownerDeviceId: sub.ownerDeviceId || avail.ownerDeviceId || "",
					ownerName:     avail.ownerName || sub.ownerName || ""
				};
			});
		if(owned.length || subscribed.length) { store[_stateRoom] = {owned: owned, subscribed: subscribed}; }
		else { delete store[_stateRoom]; }
		_writeRoomsStore(store);
	}

	function _saveOwned()      { _persistRoomState(); }
	function _saveSubscribed() { _persistRoomState(); }

	// Drop all in-memory share state and its temp projections (used when switching rooms).
	function _resetSharingState() {
		ownedTiddlers = {}; subscribedTiddlers = {}; availableTiddlers = {};
		syncedText = {}; divergedRemote = {}; assetGot = {};
		$tw.wiki.filterTiddlers("[prefix[" + OWNED_PREFIX + "]] [prefix[" + AVAIL_PREFIX + "]]").forEach(function(t) {
			$tw.wiki.deleteTiddler(t);
		});
	}

	// Load a room's persisted owned/subscribed sets into memory and write their UI
	// projections. One-time migration: if there's no per-room store yet but the legacy
	// global config exists, adopt it for this room (it was the last room used).
	function _loadRoomState(room) {
		var store = _loadRoomsStore();
		var entry = store[room];
		if(!entry && Object.keys(store).length === 0) {
			var oldOwned = _safeJson($tw.wiki.getTiddlerText(CONFIG_OWNED, "[]"));
			var oldSub   = _safeJson($tw.wiki.getTiddlerText(CONFIG_SUBSCRIBED, "[]"));
			if((oldOwned && oldOwned.length) || (oldSub && oldSub.length)) {
				entry = {owned: oldOwned || [], subscribed: oldSub || []};
				store[room] = entry; _writeRoomsStore(store);
				$tw.wiki.deleteTiddler(CONFIG_OWNED);
				$tw.wiki.deleteTiddler(CONFIG_SUBSCRIBED);
			}
		}
		entry = entry || {owned: [], subscribed: []};
		(entry.owned || []).forEach(function(title) {
			if(typeof title !== "string" || !title) return;
			var now = Date.now(), _oa = _assetInfo(title);
			ownedTiddlers[title]      = {sharedAt: now};
			subscribedTiddlers[title] = {ownerDeviceId: deviceId};
			availableTiddlers[title]  = {ownerDeviceId: deviceId, ownerName: _myName(), sharedAt: now,
				assetName: _oa ? _oa.name : "", assetType: _oa ? _oa.type : ""};
			_writeOwned(title, ownedTiddlers[title]);
			_writeAvailable(title, availableTiddlers[title]);
		});
		(entry.subscribed || []).forEach(function(item) {
			var title         = typeof item === "string" ? item : (item && item.title);
			var ownerDeviceId = (item && typeof item === "object") ? (item.ownerDeviceId || "") : "";
			var ownerName     = (item && typeof item === "object") ? (item.ownerName     || "") : "";
			if(typeof title !== "string" || !title) return;
			if(ownedTiddlers[title]) return;
			subscribedTiddlers[title] = {ownerDeviceId: ownerDeviceId, ownerName: ownerName};
			if(!availableTiddlers[title]) {
				availableTiddlers[title] = {ownerDeviceId: ownerDeviceId, ownerName: ownerName, sharedAt: 0};
			}
			_writeAvailable(title, availableTiddlers[title]);
		});
	}

	// ── temp tiddler writers (drive sidebar UI) ────────────────────────────────

	// Write a generated tiddler only if it actually changed, so repeated identical writes
	// (e.g. from the periodic manifest) don't churn change events and dirty the wiki.
	function _addIfChanged(fields) {
		var existing = $tw.wiki.getTiddler(fields.title);
		if(existing) {
			var same = true, keys = Object.keys(fields), i, k, ev, nv;
			for(i = 0; i < keys.length; i++) {
				k = keys[i];
				ev = existing.fields[k]; ev = (ev === undefined || ev === null) ? "" : String(ev);
				nv = fields[k];          nv = (nv === undefined || nv === null) ? "" : String(nv);
				if(ev !== nv) { same = false; break; }
			}
			if(same) {
				var ek = Object.keys(existing.fields);   // existing must not carry extra fields
				for(i = 0; i < ek.length; i++) {
					if(ek[i] === "created" || ek[i] === "modified") { continue; }
					if(fields[ek[i]] === undefined) { same = false; break; }
				}
			}
			if(same) { return; }
		}
		$tw.wiki.addTiddler(new $tw.Tiddler(fields));
	}

	function _writeAvailable(title, info) {
		if(info) {
			_addIfChanged({
				title:             AVAIL_PREFIX + title,
				"tiddler-title":   title,
				"owner-device-id": info.ownerDeviceId || "",
				"owner-name":      info.ownerName || info.ownerDeviceId || "",
				"shared-at":       String(info.sharedAt || 0),
				subscribed:        (subscribedTiddlers[title] || ownedTiddlers[title]) ? "yes" : "",
				// Whether we ACTUALLY hold the content (vs merely subscribed/intending to):
				// owned, an attachment we've fetched, or a subscribed tiddler that exists
				// locally. Lets the UI show "Got" only when the content arrived — clicking
				// Get on a tiddler whose owner is offline stays "Getting…", not "Got".
				have:              (ownedTiddlers[title] || assetGot[title]
				                     || (subscribedTiddlers[title] && $tw.wiki.tiddlerExists(title))) ? "yes" : "",
				asset:             info.assetName ? "yes" : "",
				"asset-name":      info.assetName || "",
				"asset-type":      info.assetType || "",
				"asset-got":       (assetGot[title] || ownedTiddlers[title]) ? "yes" : "",
				diverged:          info.diverged ? "yes" : ""
			});
		} else {
			$tw.wiki.deleteTiddler(AVAIL_PREFIX + title);
		}
	}

	function _writeOwned(title, info) {
		if(info) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title:           OWNED_PREFIX + title,
				"tiddler-title": title,
				"shared-at":     String(info.sharedAt || 0)
			}));
		} else {
			$tw.wiki.deleteTiddler(OWNED_PREFIX + title);
		}
	}

	// ── conflict dialog ────────────────────────────────────────────────────────

	// Display string for a single field value (arrays joined, dates ISO).
	function _fieldValStr(v) {
		if(v === undefined || v === null) { return ""; }
		if(Array.isArray(v)) { return v.join(" "); }
		if(v instanceof Date) { return v.toISOString(); }
		return String(v);
	}

	// Drives ConflictDialog.tid ($:/tags/AboveStory). Shows a text diff of local vs remote
	// AND a table of any non-text fields that differ (so a field-only conflict isn't an
	// empty diff), and resolves to "use-mine" | "use-theirs" | "merge" (with an edited
	// merged-text). onResolve(resolution, remoteFields, merged).
	var CONFLICT_TEXT_CAP = 50000;
	var CONFLICT_FIELD_EXCLUDE = {text:1, title:1, modified:1, created:1, _canonical_uri:1, bag:1, revision:1};
	function _showConflict(title, localTiddler, remoteFields, onResolve) {
		var conflictTiddler = "$:/temp/collab/conflict/" + title;
		var fieldsTiddler   = "$:/temp/collab/conflict-fields/" + title;
		var localText  = (localTiddler.fields.text || "").slice(0, CONFLICT_TEXT_CAP);
		var remoteText = (remoteFields.text       || "").slice(0, CONFLICT_TEXT_CAP);
		// Collect non-text fields that differ, for the field-diff table.
		var names = {}, fieldDiffs = [];
		Object.keys(localTiddler.fields).forEach(function(k) { names[k] = 1; });
		Object.keys(remoteFields).forEach(function(k) { names[k] = 1; });
		Object.keys(names).sort().forEach(function(k) {
			if(CONFLICT_FIELD_EXCLUDE[k]) { return; }
			var mine = _fieldValStr(localTiddler.fields[k]), theirs = _fieldValStr(remoteFields[k]);
			if(mine !== theirs) { fieldDiffs.push({field: k, mine: mine, theirs: theirs}); }
		});
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:            conflictTiddler,
			"tiddler-title":  title,
			"local-content":  localText,
			"remote-content": remoteText,
			"merged-text":    localText,   // seed the merge editor with the local version
			"text-differs":   localText !== remoteText ? "yes" : "",
			"field-count":    String(fieldDiffs.length),
			resolution:       ""
		}));
		if(fieldDiffs.length) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: fieldsTiddler, type: "application/json", text: JSON.stringify(fieldDiffs)
			}));
		} else {
			$tw.wiki.deleteTiddler(fieldsTiddler);
		}

		var onChange = function(changes) {
			if(!changes[conflictTiddler]) return;
			var tid = $tw.wiki.getTiddler(conflictTiddler);
			var resolution = tid ? (tid.fields.resolution || "") : "";
			if(!resolution) return;
			$tw.wiki.removeEventListener("change", onChange);
			var mergedText = tid ? (tid.fields["merged-text"] || "") : "";
			$tw.wiki.deleteTiddler(conflictTiddler);
			$tw.wiki.deleteTiddler(fieldsTiddler);
			onResolve(resolution, remoteFields, mergedText);
		};
		$tw.wiki.addEventListener("change", onChange);
	}

	// ── safety: what we will accept from a peer ────────────────────────────────
	// Folder wikis run with full Node access, so applying a peer-provided tiddler
	// that carries executable content is remote code execution — and executable-ness
	// can be introduced after the fact (a tag, a field, a type change). The single
	// source of truth lives in collab-safety.js and is shared with collab.js's
	// live field sync, so no write path can re-open the hole.

	var SYSTEM_PREFIX = "$:/";
	var ALLOW_SYSTEM  = "$:/config/codemirror-6-collab/allow-system-tiddlers";
	var _safety       = require("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/collab-safety.js");

	function _acceptTiddler(title, fields) {
		return _safety.acceptTiddler(title, fields);
	}

	// Apply remote fields, suppressing the echo on the change listener.
	function _applyRemote(title, fields) {
		if(!_acceptTiddler(title, fields)) {
			console.warn("[collab-sharing] refused remote tiddler (executable or disallowed system tiddler):", title);
			return;
		}
		// Never let a peer plant a _canonical_uri on our copy (local-file read / SSRF on
		// render). A legitimate attachment arrives only via the Get-attachment flow.
		_safety.sanitizeIncomingFields(fields);
		// Preserve OUR locally-set _canonical_uri (e.g. an attachment we saved to disk): a
		// peer never provides ours, and applying a full field set would otherwise drop it,
		// breaking the saved-attachment reference on every subsequent update/catch-up.
		var _localCu = $tw.wiki.getTiddler(title);
		if(_localCu && _localCu.fields._canonical_uri && !fields._canonical_uri) {
			fields._canonical_uri = _localCu.fields._canonical_uri;
		}
		suppressEcho[title] = true;
		try {
			$tw.wiki.addTiddler(new $tw.Tiddler(fields));
		} finally {
			setTimeout(function() { delete suppressEcho[title]; }, 0);
		}
		// We now hold the remote content — that's the new common base, and any prior
		// divergence is resolved.
		_markSynced(title);
		_clearDiverged(title);
	}

	// Push the current local version of title to the room.
	function _pushLocal(title) {
		var t = $tw.wiki.getTiddler(title);
		// Never live-broadcast a binary asset (would flood the room with base64); peers
		// fetch it on demand via the pairwise asset flow.
		if(t && !t.fields["draft.of"] && !_assetInfo(title)) {
			_send({
				type:           "collab-tiddler-update",
				senderDeviceId: deviceId,
				title:          title,
				fields:         _serialise(t)
			});
			// Our pushed content is now the common base; clears any prior divergence.
			_markSynced(title);
			_clearDiverged(title);
		}
	}

	// ── restore persisted state on startup (for the current room) ───────────────

	_stateRoom = _currentRoom();
	_loadRoomState(_stateRoom);

	// Switching rooms swaps the persisted share state: the old room's sets are already
	// saved (on every mutation), so persist once more under it, drop the in-memory state
	// and its projections, then load the new room's. The transport reconnects separately;
	// manifests/temp tiddlers repopulate from the new room on connect.
	$tw.wiki.addEventListener("change", function(changes) {
		if(!changes["$:/config/codemirror-6-collab/room-code"]) return;
		var newRoom = _currentRoom();
		if(newRoom === _stateRoom) return;
		_persistRoomState();
		_resetSharingState();
		_stateRoom = newRoom;
		_loadRoomState(newRoom);
	});

	// ── manifest helpers ───────────────────────────────────────────────────────

	function _myName() {
		return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/device-name", "")
			|| $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/user-name", "")
			|| $tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "")
			|| deviceId;
	}

	// Canonical string over a tiddler's full SERIALISED field set (sorted keys, arrays
	// joined, dates already normalised to ISO by _serialise, _canonical_uri already
	// excluded as a per-machine ref). This is the single definition of a tiddler's
	// "content identity" — both the checksum and _reconcile's equality test use it, so
	// they can never disagree. Includes every shared field (text, tags, type, modified,
	// custom fields…), so divergence in ANY field is detected.
	function _contentString(serialised) {
		if(!serialised) { return ""; }
		var keys = Object.keys(serialised).sort(), parts = [];
		for(var i = 0; i < keys.length; i++) {
			var v = serialised[keys[i]];
			parts.push(keys[i] + "\x00" + (Array.isArray(v) ? v.join("\x01") : String(v)));
		}
		return parts.join("\x02");
	}

	// Cheap checksum (djb2 xor + length) of a content string.
	function _fp(s) {
		s = s || "";
		var h = 5381, i = s.length;
		while(i) { h = (h * 33) ^ s.charCodeAt(--i); }
		return (h >>> 0).toString(36) + ":" + s.length;
	}

	// Content fingerprint of a live tiddler (or "" if absent / an asset, which sync via
	// the pairwise byte flow, not by text).
	function _tiddlerFp(title) {
		if(_assetInfo(title)) { return ""; }
		var t = $tw.wiki.getTiddler(title);
		return t ? _fp(_contentString(_serialise(t))) : "";
	}

	function _sendManifest() {
		var manifest = Object.keys(ownedTiddlers).map(function(title) {
			var asset = _assetInfo(title);
			return {
				title:         title,
				ownerDeviceId: deviceId,
				ownerName:     _myName(),
				sharedAt:      ownedTiddlers[title].sharedAt,
				assetName:     asset ? asset.name : "",
				assetType:     asset ? asset.type : "",
				// Content checksum so subscribers detect drift without a full re-fetch.
				fp:            _tiddlerFp(title)
			};
		});
		// Send even when empty. A peer treats our manifest as authoritative for the
		// tiddlers we own (_applyManifest removes any of our entries not listed), so
		// an EMPTY manifest is how a peer that has unshared/deleted everything tells
		// others to drop its stale entries. Without this, unshares done while a peer
		// was offline could never be reconciled on reconnect (manifests were additive
		// for the all-unshared case). The extra traffic for share-nothing peers is a
		// single tiny message per connect/join/request.
		_send({
			type:           "collab-share-manifest",
			senderDeviceId: deviceId,
			senderName:     _myName(),
			manifest:       manifest
		});
	}

	// Register a single available entry - respects the title-uniqueness invariant.
	// Returns true if the claim was accepted, false if title is already claimed
	// by a different peer.
	// An existing entry with empty ownerDeviceId is a startup stub and is always
	// overwritten so that the real manifest can populate owner-name.
	function _claimAvailable(title, info) {
		var existing = availableTiddlers[title];
		if(existing && existing.ownerDeviceId && existing.ownerDeviceId !== info.ownerDeviceId) {
			// Title claimed by a different peer. Refuse only if that peer is actually
			// PRESENT; deviceIds are ephemeral, so a title can otherwise get stuck under a
			// dead id (an owner that reconnected with a new id, or a peer that has left) and
			// the live owner could never re-advertise it. A live claimant takes it over.
			if(_isMemberPresent(existing.ownerDeviceId)) { return false; }
		}
		availableTiddlers[title] = info;
		_writeAvailable(title, info);
		// Keep subscribedTiddlers in sync with the fresh manifest info.
		if(subscribedTiddlers[title] && !ownedTiddlers[title]) {
			if(!subscribedTiddlers[title].ownerDeviceId) {
				subscribedTiddlers[title].ownerDeviceId = info.ownerDeviceId;
			}
			subscribedTiddlers[title].ownerName = info.ownerName || "";
			// Persist ownerName so the "Shared by" banner has a name immediately on
			// the next startup, before any manifest arrives.
			_saveSubscribed();
		}
		return true;
	}

	function _applyManifest(manifest, senderDeviceId, senderName) {
		// Diff against the sender's current entries — only REMOVE titles that left the
		// manifest and only (idempotently) write the rest. Re-deleting + re-adding every
		// entry on each periodic manifest would otherwise churn temp tiddlers and dirty the
		// wiki every interval. Entries owned by other peers are untouched.
		var listed = {};
		(manifest || []).forEach(function(item) { if(item && item.title) { listed[item.title] = item; } });
		Object.keys(availableTiddlers).forEach(function(title) {
			if(availableTiddlers[title].ownerDeviceId === senderDeviceId && !listed[title]) {
				delete availableTiddlers[title];
				if(!ownedTiddlers[title]) { $tw.wiki.deleteTiddler(AVAIL_PREFIX + title); }
			}
		});
		Object.keys(listed).forEach(function(title) {
			var item = listed[title];
			_claimAvailable(title, {
				ownerDeviceId: senderDeviceId,
				ownerName:     item.ownerName || senderName || senderDeviceId,
				sharedAt:      item.sharedAt  || 0,
				assetName:     item.assetName || "",
				assetType:     item.assetType || ""
			});
		});
	}

	// Drop advertised entries whose owner is no longer present and that we neither own nor
	// subscribe to, so the Get list never shows a tiddler no present peer is sharing.
	// Subscribed entries are kept (we want to resume automatically when the owner returns).
	function _pruneAbsentAvailable() {
		Object.keys(availableTiddlers).forEach(function(title) {
			if(ownedTiddlers[title] || subscribedTiddlers[title]) { return; }
			if(!_isMemberPresent(availableTiddlers[title].ownerDeviceId)) {
				delete availableTiddlers[title];
				$tw.wiki.deleteTiddler(AVAIL_PREFIX + title);
			}
		});
	}

	// ── share / unshare ────────────────────────────────────────────────────────

	function _shareTiddler(title) {
		if(ownedTiddlers[title]) return; // already own it
		var tiddler = $tw.wiki.getTiddler(title);
		if(!tiddler || tiddler.fields["draft.of"]) return;
		// Enforce title uniqueness: another peer already holds the claim.
		var existing = availableTiddlers[title];
		if(existing && existing.ownerDeviceId !== deviceId) {
			console.warn("[collab-sharing] Cannot share '" + title + "' - already claimed by " + existing.ownerName);
			return;
		}
		var now = Date.now();
		var asset = _assetInfo(title);
		_markSynced(title);
		ownedTiddlers[title]      = {sharedAt: now};
		subscribedTiddlers[title] = {ownerDeviceId: deviceId};
		availableTiddlers[title]  = {ownerDeviceId: deviceId, ownerName: _myName(), sharedAt: now,
			assetName: asset ? asset.name : "", assetType: asset ? asset.type : ""};
		_writeOwned(title, ownedTiddlers[title]);
		_writeAvailable(title, availableTiddlers[title]);
		_saveOwned();
		_saveSubscribed();
		_send({
			type:          "collab-share-new",
			ownerDeviceId: deviceId,
			ownerName:     _myName(),
			title:         title,
			sharedAt:      now,
			assetName:     asset ? asset.name : "",
			assetType:     asset ? asset.type : ""
		});
	}

	function _unshareTiddler(title) {
		if(!ownedTiddlers[title]) return;
		delete ownedTiddlers[title];
		delete subscribedTiddlers[title];
		delete availableTiddlers[title];
		_writeOwned(title, null);
		_writeAvailable(title, null);
		_saveOwned();
		_saveSubscribed();
		_send({type: "collab-unshare", ownerDeviceId: deviceId, title: title});
	}

	function _renameTiddler(fromTitle, toTitle) {
		var wasOwned      = !!ownedTiddlers[fromTitle];
		var wasSubscribed = !wasOwned && !!subscribedTiddlers[fromTitle];
		if(!wasOwned && !wasSubscribed) return;

		if(wasOwned) {
			// The OWNER renamed the shared tiddler: carry all share state to the new title
			// and tell the room, so it stays shared under the new name.
			var ownedInfo = ownedTiddlers[fromTitle];
			delete ownedTiddlers[fromTitle];
			ownedTiddlers[toTitle] = ownedInfo;
			_writeOwned(fromTitle, null);
			_writeOwned(toTitle, ownedInfo);

			var subInfo = subscribedTiddlers[fromTitle] || {ownerDeviceId: deviceId};
			delete subscribedTiddlers[fromTitle];
			subscribedTiddlers[toTitle] = subInfo;

			var avail = availableTiddlers[fromTitle];
			if(avail) {
				delete availableTiddlers[fromTitle];
				availableTiddlers[toTitle] = avail;
				_writeAvailable(fromTitle, null);
				_writeAvailable(toTitle, availableTiddlers[toTitle]);
			}
			if(typeof syncedText[fromTitle] === "string") { syncedText[toTitle] = syncedText[fromTitle]; }
			delete syncedText[fromTitle];
			_clearDiverged(fromTitle);

			_saveOwned();
			_saveSubscribed();

			_send({
				type:          "collab-tiddler-rename",
				ownerDeviceId: deviceId,
				ownerName:     _myName(),
				fromTitle:     fromTitle,
				toTitle:       toTitle
			});
			// The new-title tiddler was created before it became owned, so its content
			// change wasn't broadcast; push it now so a rename-with-edits stays in sync.
			_pushLocal(toTitle);
		} else {
			// A SUBSCRIBER renamed a tiddler it Got. It can't rename someone else's shared
			// tiddler for them, so treat this as a LOCAL FORK: unsubscribe the original
			// (it returns to the Get list, still advertised by its owner and fully
			// functional — including the Get-attachment button) and leave the new title as
			// an ordinary local tiddler.
			delete syncedText[fromTitle];
			_clearDiverged(fromTitle);
			_unsubscribeTiddler(fromTitle);
		}
	}

	// ── subscribe / unsubscribe ────────────────────────────────────────────────

	function _requestFromOwner(title) {
		_send({
			type:              "collab-get-tiddler",
			requesterDeviceId: deviceId,
			title:             title,
			requestId:         Math.random().toString(36).slice(2)
		});
	}

	function _getTiddler(title) {
		if(ownedTiddlers[title] || subscribedTiddlers[title]) return;
		var info = availableTiddlers[title];
		if(!info) return;
		if(title.indexOf(SYSTEM_PREFIX) === 0 && $tw.wiki.getTiddlerText(ALLOW_SYSTEM, "no") !== "yes") {
			console.warn("[collab-sharing] system-tiddler sharing is off; ignoring Get for:", title);
			return;
		}
		subscribedTiddlers[title] = {ownerDeviceId: info.ownerDeviceId, ownerName: info.ownerName || ""};
		_writeAvailable(title, availableTiddlers[title]);
		_saveSubscribed();
		_requestFromOwner(title);
	}

	// ── reconciliation / conflict resolution ───────────────────────────────────

	// The live editor text for a tiddler open in CM6 (or null if not being edited).
	function _editingTextOf(title) {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collabEditor;
		try { return (api && api.editingTextOf) ? api.editingTextOf(title) : null; } catch(_e) { return null; }
	}

	// A coarse update arrived for a tiddler we're editing and it differs from our live
	// text. Don't decide immediately: a co-editor's normal save also sends a coarse
	// update, and its final Yjs delta may land a tick later — so re-check shortly. Then:
	// editor closed → reconcile against the saved tiddler; now matches → adopt; still
	// differs → flag diverged so saving prompts to Resolve instead of silently winning.
	var editingConflictTimers = {};
	function _scheduleEditingConflict(title, remoteFields) {
		if(editingConflictTimers[title]) { clearTimeout(editingConflictTimers[title]); }
		editingConflictTimers[title] = setTimeout(function() {
			delete editingConflictTimers[title];
			var et = _editingTextOf(title);
			if(et === null) { _reconcile(title, remoteFields); return; }
			if((remoteFields.text || "") === et) { _applyRemote(title, remoteFields); return; }
			if(!divergedRemote[title]) { _setDiverged(title, remoteFields); }
		}, 800);
	}

	// Decide what to do with a peer's copy of `title`, using the 3-way base in
	// syncedText so we never silently clobber edits: adopt the side that changed when
	// only one did, and flag a true both-sides-changed divergence for the user to
	// Resolve. Ownership is irrelevant here — what matters is who actually edited.
	function _reconcile(title, remoteFields) {
		var local = $tw.wiki.getTiddler(title);
		if(!local) { _applyRemote(title, remoteFields); return; }
		var localMs    = _parseMs(local.fields.modified),
			remoteMs   = _parseMs(remoteFields.modified),
			localC     = _contentString(_serialise(local)),
			remoteC    = _contentString(remoteFields);
		if(localC === remoteC) { _markSynced(title); _clearDiverged(title); return; }
		// Once flagged diverged, NOTHING auto-applies or auto-pushes — not even another
		// peer's newer version or resolution. A diverged peer holds un-pushed edits, and
		// with 3+ peers silently adopting someone else's copy would lose them (and could
		// flip-flop between several divergent answers). We only track the newest competing
		// remote for the Resolve dialog; divergence clears when the user resolves, or when
		// a remote equal to our local arrives (handled above — the room converged on ours).
		if(divergedRemote[title]) {
			if(remoteMs >= _parseMs(divergedRemote[title].modified)) { divergedRemote[title] = remoteFields; }
			return;
		}
		// If this tiddler is open in an editor, a coarse change must not silently overwrite
		// our live edits (we'd lose it on save). Matches what we're editing (e.g. a
		// co-editor's save we already have via Yjs) → adopt; otherwise flag for Resolve.
		var editingText = _editingTextOf(title);
		if(editingText !== null) {
			if((remoteFields.text || "") === editingText) { _applyRemote(title, remoteFields); }
			else { _scheduleEditingConflict(title, remoteFields); }
			return;
		}
		// Consult the 3-way base BEFORE timestamps: it's authoritative about WHO changed.
		// If only one side changed since the last common base, adopt that side; if BOTH
		// changed it's a genuine conflict — regardless of which has the newer `modified`
		// (e.g. two peers editing the same tiddler while disconnected). A resolution still
		// propagates: an in-sync recipient has localC==base, so it adopts the pushed copy.
		var base = syncedText[title];
		if(typeof base === "string") {
			if(localC === base)  { _applyRemote(title, remoteFields); return; }  // we didn't change it → take theirs
			if(remoteC === base) { _pushLocal(title); return; }                  // they didn't change it → keep ours
			_setDiverged(title, remoteFields); return;                            // both changed → conflict
		}
		// No base (e.g. after a reload, so we can't tell who changed): fall back to
		// last-write-wins by modified, flagging a conflict only on a timestamp tie.
		if(remoteMs > localMs) { _applyRemote(title, remoteFields); return; }
		if(localMs > remoteMs) { _pushLocal(title); return; }
		_setDiverged(title, remoteFields);
	}

	// User asked to re-pull a shared tiddler from the room (the owner answers, or any
	// holder while the owner is offline). The response runs through _reconcile.
	function _resyncTiddler(title) {
		if(!subscribedTiddlers[title] && !ownedTiddlers[title]) { return; }
		var requestId = Math.random().toString(36).slice(2);
		manualResync[requestId] = title;
		// Don't leak the marker if nobody answers (owner offline and no holder).
		setTimeout(function() { delete manualResync[requestId]; }, 15000);
		_send({type: "collab-get-tiddler", requesterDeviceId: deviceId, title: title, requestId: requestId});
	}

	// Open the diff/merge dialog for a diverged tiddler and apply the chosen resolution.
	function _openResolveDialog(title) {
		var remoteFields = divergedRemote[title];
		var local = $tw.wiki.getTiddler(title);
		if(!remoteFields || !local) { return; }
		_showConflict(title, local, remoteFields, function(resolution, rf, mergedText) {
			if(resolution === "use-theirs")    { _applyRemote(title, rf); }
			else if(resolution === "use-mine") { _resolveWithText(title, (local.fields.text || "")); }
			else if(resolution === "merge")    { _resolveWithText(title, mergedText); }
			_clearDiverged(title);
		});
	}

	// Write `text` locally with a bumped `modified` (so peers adopt this as the newest)
	// and broadcast it, making the chosen resolution the room's definitive version.
	function _resolveWithText(title, text) {
		var t = $tw.wiki.getTiddler(title);
		var fields = t ? _serialise(t) : {title: title};
		fields.title    = title;
		fields.text     = text;
		fields.modified = new Date();
		suppressEcho[title] = true;
		try { $tw.wiki.addTiddler(new $tw.Tiddler(fields)); }
		finally { setTimeout(function() { delete suppressEcho[title]; }, 0); }
		_pushLocal(title);   // broadcasts and marks synced
	}

	// ── asset transfer (external-attachment _canonical_uri files) ───────────────

	function _assetError(text) {
		// Tag it so we only clear OUR errors — $:/temp/collab/error is shared with the
		// transport (connection/relay errors) and must not be wiped by an attachment retry.
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/error", text: text, source: "asset"}));
	}

	// Clear the shared error tiddler only if the current error is an attachment error.
	function _clearAssetError() {
		var err = $tw.wiki.getTiddler("$:/temp/collab/error");
		if(err && err.fields.source === "asset") { $tw.wiki.deleteTiddler("$:/temp/collab/error"); }
	}

	// Getter: request the asset for `title`. destPath "" → embed inline; otherwise
	// the bytes are saved there and _canonical_uri points at it.
	function _getAsset(title, destPath) {
		if(!availableTiddlers[title]) return;
		if(title.indexOf(SYSTEM_PREFIX) === 0 && $tw.wiki.getTiddlerText(ALLOW_SYSTEM, "no") !== "yes") {
			console.warn("[collab-asset] system-tiddler sharing off; not getting:", title);
			return;
		}
		// Clear any error from a previous failed attempt; it reappears only if this one fails.
		_clearAssetError();
		var requestId = Math.random().toString(36).slice(2);
		pendingAssetGets[requestId] = {title: title, dest: destPath || ""};
		_send({type: "collab-get-asset", requesterDeviceId: deviceId, title: title, requestId: requestId});
	}

	// ── owner consent gate ──────────────────────────────────────────────────────
	// No file ever leaves this machine without the user's explicit OK. A collab-get-asset
	// request does NOT serve immediately: it raises a prompt (the AssetRequestPrompt
	// overlay) showing who is asking, which tiddler, and the exact local file path that
	// would be sent. Allow → _doServeAsset streams it; Deny or timeout → declined.
	var pendingServes   = {};        // requestId → {title, requesterId, timer}
	var SERVE_CONSENT_MS = 120000;

	function _requestAssetConsent(title, requesterId, requestId) {
		if(!requesterId || requesterId === deviceId || !requestId) { return; }
		if(!ownedTiddlers[title]) { return; }          // only the owner holds the original
		var t = $tw.wiki.getTiddler(title);
		if(!t) { return; }
		var info = _assetInfo(title);
		if(!info) { return; }
		if(!_isMemberPresent(requesterId)) { return; } // must be a present (verified) member
		if(pendingServes[requestId]) { return; }       // ignore duplicate request ids
		var member = $tw.wiki.getTiddler("$:/temp/collab/members/" + requesterId);
		var requesterName = (member && (member.fields["user-name"] || member.fields["device-name"])) || requesterId;
		var uri = t.fields._canonical_uri;
		var pathLabel = (uri && assetUtil.isLocalCanonicalUri(uri))
			? assetUtil.resolveCanonical(uri)
			: ("(embedded image in tiddler — " + info.name + ")");
		var timer = setTimeout(function() { _denyAsset(requestId, true); }, SERVE_CONSENT_MS);
		pendingServes[requestId] = {title: title, requesterId: requesterId, timer: timer};
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:            "$:/temp/collab/asset-request/" + requestId,
			"request-id":     requestId,
			"requester-id":   requesterId,
			"requester-name": requesterName,
			"tiddler-title":  title,
			"asset-name":     info.name,
			"asset-path":     pathLabel
		}));
	}

	function _clearServeRequest(requestId) {
		var pend = pendingServes[requestId];
		if(pend && pend.timer) { clearTimeout(pend.timer); }
		delete pendingServes[requestId];
		$tw.wiki.deleteTiddler("$:/temp/collab/asset-request/" + requestId);
	}

	function _denyAsset(requestId, timedOut) {
		var pend = pendingServes[requestId];
		if(!pend) { return; }
		var requesterId = pend.requesterId;
		_clearServeRequest(requestId);
		_sendPrivate(requesterId, {type: "collab-asset-error", requestId: requestId,
			message: timedOut ? "The owner did not respond to the attachment request" : "The owner declined the attachment request"});
	}

	function _doServeAsset(requestId) {
		var pend = pendingServes[requestId];
		if(!pend) { return; }
		var title = pend.title, requesterId = pend.requesterId;
		_clearServeRequest(requestId);
		_serveAsset(title, requesterId, requestId);    // the user approved — stream it
	}

	// Owner: stream the asset bytes pairwise to the requester (metadata + chunks).
	// Bytes come from the file (local _canonical_uri) or straight from the base64
	// text (embedded binary tiddler) — either way the receiver decides how to store.
	// Only ever reached after explicit user consent (_doServeAsset).
	function _serveAsset(title, requesterId, requestId) {
		if(!requesterId || requesterId === deviceId) return;
		if(!ownedTiddlers[title]) return;            // only the owner holds the original
		var t = $tw.wiki.getTiddler(title);
		if(!t) return;
		var info = _assetInfo(title);
		if(!info) return;
		var uri = t.fields._canonical_uri;
		if(uri && assetUtil.isLocalCanonicalUri(uri)) {
			assetUtil.readAsset(uri, function(err, base64) {
				if(err || !base64) {
					console.warn("[collab-asset] read failed for " + title + ": " + err);
					_sendPrivate(requesterId, {type: "collab-asset-error", requestId: requestId, message: "Owner could not read the asset file"});
					return;
				}
				_serveAssetBytes(t, info, requesterId, requestId, base64);
			});
		} else {
			_serveAssetBytes(t, info, requesterId, requestId, t.fields.text || "");
		}
	}

	function _serveAssetBytes(t, info, requesterId, requestId, base64) {
		if(Math.floor(base64.length * 3 / 4) > assetUtil.maxAssetBytes()) {
			_sendPrivate(requesterId, {type: "collab-asset-error", requestId: requestId, message: "Asset exceeds the size limit"});
			return;
		}
		var fields = _serialise(t);
		delete fields._canonical_uri;   // the receiver records its own
		delete fields.text;
		var chunks = [];
		for(var i = 0; i < base64.length; i += ASSET_CHUNK_B64) { chunks.push(base64.slice(i, i + ASSET_CHUNK_B64)); }
		_sendPrivate(requesterId, {
			type:        "collab-asset-meta",
			requestId:   requestId,
			title:       t.fields.title,
			fields:      fields,
			name:        info.name,
			assetType:   t.fields.type || "",
			size:        Math.floor(base64.length * 3 / 4),
			totalChunks: chunks.length
		});
		_sendAssetChunks(requesterId, requestId, chunks, 0);
	}

	function _sendAssetChunks(to, requestId, chunks, i) {
		if(i >= chunks.length) return;
		_sendPrivate(to, {type: "collab-asset-chunk", requestId: requestId, index: i, data: chunks[i]});
		setTimeout(function() { _sendAssetChunks(to, requestId, chunks, i + 1); }, ASSET_CHUNK_MS);
	}

	// Getter: all chunks in → save to disk (external) or embed (inline), then write
	// the tiddler. Runs through the same safety guard as any other remote write.
	// Receiver-side inspection gate. When all bytes are in we DON'T write yet: we raise a
	// prompt (the AssetRequestPrompt overlay) showing exactly what arrived — tiddler title,
	// file name, type, size, where it will land (a disk path or inline), and which extra
	// fields the sender attached — so the user can reject anything unexpected before it
	// touches their wiki or disk. Accept → _finalizeAsset; Reject / timeout → _discardIncoming.
	var RECV_CONSENT_MS = 120000;

	function _raiseIncomingPrompt(requestId) {
		var inc = incomingAssets[requestId], pending = pendingAssetGets[requestId];
		if(!inc || !pending) { return; }
		var meta = inc.meta || {};
		var willStore = !!(pending.dest && assetUtil.storeExternally());
		var fieldNames = Object.keys(meta.fields || {})
			.filter(function(f) { return f !== "title" && f !== "text"; }).join(", ");
		inc.timer = setTimeout(function() { _discardIncoming(requestId, true); }, RECV_CONSENT_MS);
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:           "$:/temp/collab/asset-incoming/" + requestId,
			"request-id":     requestId,
			"tiddler-title":  pending.title,
			"asset-name":     meta.name || "",
			"asset-type":     meta.assetType || (meta.fields && meta.fields.type) || "",
			"asset-size":     String(meta.size || 0),
			"asset-dest":     willStore ? (pending.dest || "") : "embedded inline in the tiddler",
			"asset-fields":   fieldNames
		}));
	}

	function _discardIncoming(requestId, silent) {
		var inc = incomingAssets[requestId], pending = pendingAssetGets[requestId];
		if(inc && inc.timer) { clearTimeout(inc.timer); }
		if(pending) { _clearAssetProgress(pending.title); }
		delete incomingAssets[requestId];
		delete pendingAssetGets[requestId];
		$tw.wiki.deleteTiddler("$:/temp/collab/asset-incoming/" + requestId);
	}

	// Live download progress for an incoming attachment, keyed by its tiddler title so the
	// Get list can show a bar while bytes stream in (chunks arrive ~1/s). Cleared when the
	// transfer finishes, is rejected, or fails.
	var ASSET_PROGRESS_PREFIX = "$:/temp/collab/asset-progress/";
	function _writeAssetProgress(title, received, total) {
		var pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:           ASSET_PROGRESS_PREFIX + title,
			"tiddler-title":  title,
			received:        String(received),
			total:           String(total),
			pct:             String(pct)
		}));
	}
	function _clearAssetProgress(title) {
		$tw.wiki.deleteTiddler(ASSET_PROGRESS_PREFIX + title);
	}

	function _finalizeAsset(requestId) {
		var inc = incomingAssets[requestId], pending = pendingAssetGets[requestId];
		if(inc && inc.timer) { clearTimeout(inc.timer); }
		$tw.wiki.deleteTiddler("$:/temp/collab/asset-incoming/" + requestId);
		if(pending) { _clearAssetProgress(pending.title); }
		delete incomingAssets[requestId];
		delete pendingAssetGets[requestId];
		if(!inc || !pending) return;
		var base64 = inc.chunks.join("");
		var meta   = inc.meta;
		var title  = pending.title;
		var fields = meta.fields || {};
		fields.title = title;
		// Strip any _canonical_uri the sender included; only OUR locally-chosen path
		// (set below for external storage) may end up on the tiddler.
		_safety.sanitizeIncomingFields(fields);

		function write() {
			if(!_acceptTiddler(title, fields)) { console.warn("[collab-asset] refused:", title); return; }
			// A freshly dropped external attachment often carries neither created nor
			// modified, so the received tiddler would have none. Keep the owner's
			// timestamps if they sent them; otherwise stamp now so the tiddler is dated.
			fields.modified = fields.modified ? new Date(fields.modified) : new Date();
			fields.created  = fields.created  ? new Date(fields.created)  : fields.modified;
			suppressEcho[title] = true;
			try { $tw.wiki.addTiddler(new $tw.Tiddler(fields)); }
			finally { setTimeout(function() { delete suppressEcho[title]; }, 0); }
			assetGot[title] = true;
			_clearAssetError();   // a success clears any prior attachment error
			// Getting an attachment also subscribes you to the tiddler (so it shows as "Got"
			// and survives reconnects), unless you already own or subscribe to it. The
			// tiddler was just written above with our locally-chosen _canonical_uri.
			if(!ownedTiddlers[title] && !subscribedTiddlers[title]) {
				var _av = availableTiddlers[title] || {};
				subscribedTiddlers[title] = {ownerDeviceId: _av.ownerDeviceId || "", ownerName: _av.ownerName || ""};
				_saveSubscribed();
			}
			if(availableTiddlers[title]) { _writeAvailable(title, availableTiddlers[title]); }
		}

		if(pending.dest && assetUtil.storeExternally()) {
			assetUtil.writeAsset(pending.dest, base64, function(err, absPath) {
				if(err) { console.warn("[collab-asset] write failed:", err); _assetError("Could not save the attachment: " + err); return; }
				delete fields.text;
				fields._canonical_uri = assetUtil.canonicalUriForPath(absPath || pending.dest);
				write();
			});
		} else {
			delete fields._canonical_uri;
			fields.text = base64;
			if(meta.assetType) { fields.type = meta.assetType; }
			write();
		}
	}

	// ── serving fetch requests (ownerless serving + owner re-sync) ──────────────

	function _isMemberPresent(id) {
		return !!(id && $tw.wiki.getTiddler("$:/temp/collab/members/" + id));
	}

	// Send our copy of `title` to a requester.
	function _serveTiddler(title, requesterId, requestId) {
		var tiddler = $tw.wiki.getTiddler(title);
		if(tiddler && !tiddler.fields["draft.of"]) {
			_send({
				type:           "collab-tiddler-response",
				targetDeviceId: requesterId,
				senderDeviceId: deviceId,   // lets the requester tell an owner's answer from a subscriber's
				title:          title,
				requestId:      requestId,
				fields:         _serialise(tiddler)
			});
		}
	}

	// Decide whether to answer a collab-get-tiddler:
	//   - We own it → answer (authoritative).
	//   - We're a subscriber and the OWNER is the requester → answer, so a
	//     returning owner can adopt the latest state we hold (owner re-sync).
	//   - We're a subscriber and the owner is ABSENT → answer, so a new joiner
	//     can still fetch with the owner offline (ownerless serving).
	//   - Otherwise (owner present, someone else asking) → stay quiet; the owner
	//     answers.
	// Subscriber answers are jittered so several holders don't all reply at once;
	// the requester resolves duplicate/competing responses by timestamp anyway.
	function _maybeServeTiddler(title, requesterId, requestId) {
		if(!title || !requesterId || requesterId === deviceId) return;
		if(!$tw.wiki.getTiddler(title)) return;
		if(ownedTiddlers[title]) { _serveTiddler(title, requesterId, requestId); return; }
		if(!subscribedTiddlers[title]) return;
		var avail   = availableTiddlers[title];
		var ownerId = avail && avail.ownerDeviceId;
		var requesterIsOwner = ownerId && requesterId === ownerId;
		if(!requesterIsOwner && ownerId && _isMemberPresent(ownerId)) { return; }
		setTimeout(function() { _serveTiddler(title, requesterId, requestId); }, 120 + Math.floor(Math.random() * 380));
	}

	function _unsubscribeTiddler(title) {
		if(!subscribedTiddlers[title] || ownedTiddlers[title]) return;
		delete subscribedTiddlers[title];
		_writeAvailable(title, availableTiddlers[title]);
		_saveSubscribed();
	}

	// ── change listener ───────────────────────────────────────────────────────

	// draft.of -> draft.title, learned from live drafts. A rename saves as "create new
	// title + delete old title"; the th-renaming-tiddler hook only fires when relink runs
	// (relinkOnRename), so on the default path the old-title deletion would otherwise be
	// mistaken for an unshare. Watching the draft (which carries both fields and updates as
	// the user types the new title) lets us detect the rename independent of hook/event order.
	var pendingRenames = {};

	$tw.wiki.addEventListener("change", function(changes) {
		// First pass: learn rename intents from any draft present in this change batch.
		Object.keys(changes).forEach(function(title) {
			var dt = $tw.wiki.getTiddler(title);
			if(dt && dt.fields["draft.of"] && dt.fields["draft.title"]
					&& dt.fields["draft.of"] !== dt.fields["draft.title"]) {
				pendingRenames[dt.fields["draft.of"]] = dt.fields["draft.title"];
			}
		});
		Object.keys(changes).forEach(function(title) {
			if(suppressEcho[title]) return;
			// Deletions NEVER propagate as deletions — a peer removing a tiddler must not
			// delete it on anyone else. No inbound message type deletes a content tiddler
			// (_applyRemote/asset writes only ever addTiddler), and locally:
			//   - Owner deletes a tiddler they shared → unshare it: drops it from the shared
			//     list and the persisted owned set (so it leaves future manifests) and
			//     broadcasts collab-unshare, which only removes the entry on peers — their
			//     copy of the tiddler is kept.
			//   - Subscriber deletes their local copy → unsubscribe, so a later manifest or
			//     reconnect catch-up doesn't silently re-fetch and resurrect it.
			if(changes[title].deleted) {
				// Self-heal our temp UI projections if a user deletes one: the in-memory
				// maps are the source of truth, so re-write whatever entry they still hold.
				if(title.indexOf(AVAIL_PREFIX) === 0) {
					var _at = title.slice(AVAIL_PREFIX.length);
					if(availableTiddlers[_at]) { _writeAvailable(_at, availableTiddlers[_at]); }
					return;
				}
				if(title.indexOf(OWNED_PREFIX) === 0) {
					var _ot = title.slice(OWNED_PREFIX.length);
					if(ownedTiddlers[_ot]) { _writeOwned(_ot, ownedTiddlers[_ot]); }
					return;
				}
				// A rename (create new + delete old) must KEEP the tiddler shared: move the
				// owned/subscribed entry to the new title (the owner also broadcasts the
				// rename) instead of unsharing. The new title must actually exist, else this
				// was a cancelled-rename draft and the deletion is genuine.
				if(pendingRenames[title]) {
					var newTitle = pendingRenames[title];
					delete pendingRenames[title];
					if((ownedTiddlers[title] || subscribedTiddlers[title]) && $tw.wiki.tiddlerExists(newTitle)) {
						_renameTiddler(title, newTitle);
						return;
					}
				}
				if(ownedTiddlers[title]) { _unshareTiddler(title); }
				else if(subscribedTiddlers[title]) { _unsubscribeTiddler(title); }
				return;
			}
			if(!ownedTiddlers[title] && !subscribedTiddlers[title]) return;
			var tiddler = $tw.wiki.getTiddler(title);
			if(!tiddler || tiddler.fields["draft.of"]) return;
			// Binary assets aren't live-broadcast — they'd flood the room with base64
			// and subscribers fetch them on demand (pairwise) via the asset flow.
			if(_assetInfo(title)) return;
			_send({
				type:           "collab-tiddler-update",
				senderDeviceId: deviceId,
				title:          title,
				fields:         _serialise(tiddler)
			});
			// Our edit is the common base ONLY if it actually went out — peers converge on
			// what they received. While disconnected the send is a no-op, so we must keep the
			// prior base: a concurrent peer edit then surfaces as a conflict on reconnect
			// (both sides differ from base) instead of being silently adopted.
			if(_isConnected()) { _markSynced(title); }
		});
	});

	// ── incoming message handler ──────────────────────────────────────────────

	window.addEventListener("collab-sharing-message", function(ev) {
		var msg = ev && ev.detail;
		if(!msg || !msg.type) return;

		switch(msg.type) {

		case "collab-manifest-request":
			if(msg.requesterDeviceId !== deviceId) { _sendManifest(); }
			break;

		case "collab-share-manifest":
			if(msg.senderDeviceId !== deviceId) {
				_applyManifest(msg.manifest, msg.senderDeviceId, msg.senderName);
				// For each tiddler we subscribe to, compare the owner's content checksum
				// with our local one — only re-fetch (→ _reconcile, which auto-detects/flags
				// divergence) when they differ. A match means we're in sync, so just record
				// the base. This is how silent drift is caught cheaply on every manifest.
				(msg.manifest || []).forEach(function(item) {
					if(!item || !item.title) return;
					if(!subscribedTiddlers[item.title] || ownedTiddlers[item.title]) return;
					if(item.assetName) return;   // assets sync via the pairwise byte flow
					if(item.fp && _tiddlerFp(item.title) === item.fp) {
						_markSynced(item.title); _clearDiverged(item.title);   // in sync with the owner
						return;
					}
					_requestFromOwner(item.title);
				});
				// A present peer just told us authoritatively what it shares; drop any
				// now-orphaned advertisements (owner left, never subscribed) so the Get
				// list stays current.
				_pruneAbsentAvailable();
			}
			break;

		case "collab-share-new":
			// Enforce title uniqueness: drop the claim if title is already taken.
			if(msg.ownerDeviceId !== deviceId && msg.title) {
				_claimAvailable(msg.title, {
					ownerDeviceId: msg.ownerDeviceId,
					ownerName:     msg.ownerName || msg.ownerDeviceId,
					sharedAt:      msg.sharedAt  || Date.now(),
					assetName:     msg.assetName || "",
					assetType:     msg.assetType || ""
				});
			}
			break;

		case "collab-unshare":
			if(msg.ownerDeviceId !== deviceId && msg.title) {
				delete availableTiddlers[msg.title];
				_writeAvailable(msg.title, null);
				// Subscription is kept: if the owner re-shares later, we auto-resubscribe.
			}
			break;

		case "collab-get-tiddler":
			_maybeServeTiddler(msg.title, msg.requesterDeviceId, msg.requestId);
			break;

		case "collab-tiddler-response":
			// Only the intended recipient resolves this.
			if(msg.targetDeviceId !== deviceId || !msg.title || !msg.fields) break;
			var wasManual = !!manualResync[msg.requestId];
			if(wasManual) { delete manualResync[msg.requestId]; }
			// Base-aware 3-way reconcile: adopt the side that changed, or flag a true
			// conflict for the user to resolve (never silently clobber).
			_reconcile(msg.title, msg.fields);
			// A user-triggered Re-sync that turned up a genuine conflict opens the diff
			// dialog straight away (a background catch-up just leaves the Resolve badge).
			if(wasManual && divergedRemote[msg.title]) { _openResolveDialog(msg.title); }
			// Ensure the subscription record is up-to-date.
			if(!subscribedTiddlers[msg.title]) {
				subscribedTiddlers[msg.title] = {ownerDeviceId: ""};
			}
			_writeAvailable(msg.title, availableTiddlers[msg.title]);
			break;

		case "collab-tiddler-update":
			// Runtime update from any subscribed peer. Goes through the same base-aware
			// reconcile so a coarse save while we hold un-pushed edits flags a conflict
			// instead of clobbering us. (Live character editing is handled by CM6/Yjs.)
			if(msg.senderDeviceId !== deviceId
					&& msg.title
					&& msg.fields
					&& (subscribedTiddlers[msg.title] || ownedTiddlers[msg.title])) {
				_reconcile(msg.title, msg.fields);
			}
			break;

		case "collab-tiddler-rename":
			if(msg.ownerDeviceId === deviceId || !msg.fromTitle || !msg.toTitle) break;
			// Only a title's known owner may rename it. If we already track an owner for
			// fromTitle, the rename's claimed owner must match it — defence-in-depth so a
			// member can't rename a tiddler it doesn't own. (All senders are already
			// OAuth+cert verified by the transport; this guards intent, not authentication.)
			if(availableTiddlers[msg.fromTitle] && availableTiddlers[msg.fromTitle].ownerDeviceId
					&& availableTiddlers[msg.fromTitle].ownerDeviceId !== msg.ownerDeviceId) {
				console.warn("[collab-sharing] ignoring rename of '" + msg.fromTitle + "' from a non-owner");
				break;
			}
			// Never let a rename move a shared tiddler into disallowed system space
			// (e.g. clobbering $:/DefaultTiddlers or our protected collab config).
			{
				var _renameLocal = $tw.wiki.getTiddler(msg.fromTitle);
				if(_renameLocal && !_acceptTiddler(msg.toTitle, _renameLocal.fields)) {
					console.warn("[collab-sharing] refused rename into disallowed title:", msg.toTitle);
					break;
				}
			}
			// Update available entry regardless of whether we subscribed.
			if(availableTiddlers[msg.fromTitle]) {
				var renameAvail = availableTiddlers[msg.fromTitle];
				delete availableTiddlers[msg.fromTitle];
				availableTiddlers[msg.toTitle] = renameAvail;
				_writeAvailable(msg.fromTitle, null);
				_writeAvailable(msg.toTitle, renameAvail);
			}
			// If we subscribed, rename the local tiddler too.
			if(subscribedTiddlers[msg.fromTitle]) {
				var renameSub = subscribedTiddlers[msg.fromTitle];
				delete subscribedTiddlers[msg.fromTitle];
				subscribedTiddlers[msg.toTitle] = renameSub;
				// Carry the 3-way base to the new title so post-rename updates reconcile
				// correctly instead of looking like a fresh divergence.
				if(typeof syncedText[msg.fromTitle] === "string") { syncedText[msg.toTitle] = syncedText[msg.fromTitle]; }
				delete syncedText[msg.fromTitle];
				_clearDiverged(msg.fromTitle);
				_saveSubscribed();
				suppressEcho[msg.fromTitle] = true;
				suppressEcho[msg.toTitle]   = true;
				suppressRenameHook[msg.fromTitle] = true;
				try {
					$tw.wiki.renameTiddler(msg.fromTitle, msg.toTitle);
				} finally {
					delete suppressRenameHook[msg.fromTitle];
					setTimeout(function() {
						delete suppressEcho[msg.fromTitle];
						delete suppressEcho[msg.toTitle];
					}, 0);
				}
				// Tell the user their Got tiddler was renamed by the owner (it stays
				// subscribed and keeps syncing under the new title — shown as "Got").
				try {
					$tw.notifier.display("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/ui/notify/RenamedTiddler", {
						variables: {
							renameBy:   msg.ownerName || "A collaborator",
							renameFrom: msg.fromTitle,
							renameTo:   msg.toTitle
						}
					});
				} catch(_e) {}
			}
			break;

		case "collab-get-asset":
			// Don't serve straight away — ask the user first (owner consent gate).
			_requestAssetConsent(msg.title, msg.requesterDeviceId, msg.requestId);
			break;

		case "collab-asset-meta":
			if(!pendingAssetGets[msg.requestId]) break;   // not our request
			if(msg.size > assetUtil.maxAssetBytes()) {
				delete pendingAssetGets[msg.requestId];
				_assetError("Incoming attachment exceeds the size limit (" + Math.round((msg.size || 0) / 1048576) + " MB).");
				break;
			}
			incomingAssets[msg.requestId] = {meta: msg, chunks: new Array(msg.totalChunks || 0), received: 0};
			_writeAssetProgress(pendingAssetGets[msg.requestId].title, 0, msg.totalChunks || 0);
			break;

		case "collab-asset-chunk":
			var _inc = incomingAssets[msg.requestId];
			if(_inc && typeof msg.index === "number" && _inc.chunks[msg.index] === undefined) {
				_inc.chunks[msg.index] = msg.data || "";
				_inc.received++;
				var _pend = pendingAssetGets[msg.requestId];
				if(_pend) { _writeAssetProgress(_pend.title, _inc.received, _inc.meta.totalChunks || 0); }
				// All bytes in — don't write yet. Let the receiver inspect what arrived
				// (name, type, size, destination, fields) and accept/reject it first.
				if(_inc.received >= _inc.meta.totalChunks) { _raiseIncomingPrompt(msg.requestId); }
			}
			break;

		case "collab-asset-error":
			if(pendingAssetGets[msg.requestId]) {
				_discardIncoming(msg.requestId, true);
				_assetError("Attachment transfer failed: " + (msg.message || "unknown error"));
			}
			break;
		}
	});

	// ── session lifecycle ─────────────────────────────────────────────────────

	window.addEventListener("collab-connected", function() {
		// Restore owned tiddlers in the available map.
		Object.keys(ownedTiddlers).forEach(function(title) {
			var _ca = _assetInfo(title);
			availableTiddlers[title] = {
				ownerDeviceId: deviceId,
				ownerName:     _myName(),
				sharedAt:      ownedTiddlers[title].sharedAt,
				assetName:     _ca ? _ca.name : "",
				assetType:     _ca ? _ca.type : ""
			};
			_writeAvailable(title, availableTiddlers[title]);
		});
		// Restore subscribed tiddlers that were cleared by collab-disconnected so
		// the "Shared by" banner shows the persisted owner name while we wait for
		// a fresh manifest from the owner.
		Object.keys(subscribedTiddlers).forEach(function(title) {
			if(!ownedTiddlers[title] && !availableTiddlers[title]) {
				var sub = subscribedTiddlers[title];
				availableTiddlers[title] = {
					ownerDeviceId: sub.ownerDeviceId || "",
					ownerName:     sub.ownerName     || "",
					sharedAt:      0
				};
				_writeAvailable(title, availableTiddlers[title]);
			}
		});
		// Ask all current peers for their manifests.
		_send({type: "collab-manifest-request", requesterDeviceId: deviceId});
		// Also announce our own shares to everyone already in the room. Without
		// this, a peer that connects *after* us (and already has shared tiddlers)
		// would never push its manifest to us — the member-joined handler only
		// pushes manifests from existing peers to the newcomer, not the reverse —
		// so its shares wouldn't appear until we reconnect.
		_sendManifest();
		// Owner re-sync: pull the latest of our OWN shared tiddlers from the room.
		// While we were offline, present peers may have advanced them (edits sync
		// peer-to-peer even without the owner). Holders answer because the requester
		// is the owner; our collab-tiddler-response handler then adopts the newest
		// via the usual catch-up resolution (newer-remote wins; conflict → dialog).
		Object.keys(ownedTiddlers).forEach(function(title) {
			_requestFromOwner(title);
		});
		// Catch-up: directly re-request every tiddler we subscribe to. A peer joining
		// a room where the owner is already online (with a tiddler modified since) must
		// pull the latest now, not wait for the manifest round-trip — which can race or
		// be missed, especially over LAN. The owner answers immediately; conflicting
		// states resolve by timestamp in the collab-tiddler-response handler.
		Object.keys(subscribedTiddlers).forEach(function(title) {
			if(!ownedTiddlers[title]) { _requestFromOwner(title); }
		});
	});

	window.addEventListener("collab-member-joined", function() {
		// A new peer arrived - send them our manifest.
		_sendManifest();
	});

	window.addEventListener("collab-member-left", function() {
		// A peer left — drop any advertisements only it was offering (that we don't own
		// or subscribe to) so the Get list doesn't keep showing unshareable tiddlers.
		_pruneAbsentAvailable();
	});

	window.addEventListener("collab-disconnected", function() {
		// Clear peer-owned entries; ours stay visible in the sidebar.
		Object.keys(availableTiddlers).forEach(function(title) {
			if(!ownedTiddlers[title]) {
				delete availableTiddlers[title];
				$tw.wiki.deleteTiddler(AVAIL_PREFIX + title);
			}
		});
	});

	// Periodic backstop. Live edits sync instantly and connect/join already exchange
	// manifests; this only re-advertises our owned tiddlers' checksums so a peer that
	// SILENTLY drifted (a lost, never-redelivered update) catches up within one interval.
	// Cheap: recipients just compare checksums and re-fetch only on a mismatch. Gated to
	// when we're connected, actually own something, and a peer is present — so a quiet or
	// solo session sends nothing. 20s is a safety net, not the sync path (don't shorten to
	// sub-second: it would recompute+broadcast every owned checksum many times a second
	// through the relay's rate limit for an event that's already handled instantly live).
	var MANIFEST_REVERIFY_MS = 20000;
	setInterval(function() {
		var st = $tw.wiki.getTiddler("$:/temp/collab/status");
		if(!st || st.fields.status !== "connected") { return; }
		if(!Object.keys(ownedTiddlers).length) { return; }
		if($tw.wiki.filterTiddlers("[prefix[$:/temp/collab/members/]first[]]").length === 0) { return; }
		_sendManifest();
	}, MANIFEST_REVERIFY_MS);

	// ── widget message handlers ───────────────────────────────────────────────

	$tw.rootWidget.addEventListener("codemirror-6-collab-share-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _shareTiddler(title); }
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-unshare-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _unshareTiddler(title); }
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-get-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _getTiddler(title); }
		return false;
	});

	// Re-pull a shared tiddler from the room (heals "Got but missing changes").
	$tw.rootWidget.addEventListener("codemirror-6-collab-resync-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _resyncTiddler(title); }
		return false;
	});

	// Open the diff/merge dialog for a tiddler flagged diverged.
	$tw.rootWidget.addEventListener("codemirror-6-collab-resolve-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _openResolveDialog(title); }
		return false;
	});

	// Get an external-attachment asset. From a $browse "save as" the chosen path
	// arrives on the event's file input; with no path we embed it inline.
	$tw.rootWidget.addEventListener("codemirror-6-collab-get-asset", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		var dest = "";
		// From a $browse "save as", the chosen path arrives as ev.files[0].path;
		// the inline $button has no files (dest stays "" → embed).
		try {
			if(ev.files && ev.files[0] && ev.files[0].path) { dest = ev.files[0].path; }
		} catch(e) {}
		if(title) { _getAsset(title, dest); }
		return false;
	});

	// Owner consent prompt actions: allow → stream the file; deny → decline.
	$tw.rootWidget.addEventListener("codemirror-6-collab-allow-asset", function(ev) {
		var id = ev.param || (ev.paramObject && ev.paramObject.requestId);
		if(id) { _doServeAsset(id); }
		return false;
	});
	$tw.rootWidget.addEventListener("codemirror-6-collab-deny-asset", function(ev) {
		var id = ev.param || (ev.paramObject && ev.paramObject.requestId);
		if(id) { _denyAsset(id, false); }
		return false;
	});

	// Receiver inspection prompt actions: accept → write it; reject → discard.
	$tw.rootWidget.addEventListener("codemirror-6-collab-accept-incoming", function(ev) {
		var id = ev.param || (ev.paramObject && ev.paramObject.requestId);
		if(id) { _finalizeAsset(id); }
		return false;
	});
	$tw.rootWidget.addEventListener("codemirror-6-collab-reject-incoming", function(ev) {
		var id = ev.param || (ev.paramObject && ev.paramObject.requestId);
		if(id) { _discardIncoming(id, false); }
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-unsubscribe-tiddler", function(ev) {
		var title = ev.param || (ev.paramObject && ev.paramObject.title);
		if(title) { _unsubscribeTiddler(title); }
		return false;
	});

	// ── rename hook ──────────────────────────────────────────────────────────

	$tw.hooks.addHook("th-renaming-tiddler", function(toTitle, fromTitle) {
		if(!suppressRenameHook[fromTitle]) {
			_renameTiddler(fromTitle, toTitle);
		}
		return toTitle;
	});

	// ── public API ────────────────────────────────────────────────────────────

	window.TiddlyDesktop = window.TiddlyDesktop || {};
	window.TiddlyDesktop.collabSharing = {
		share:         _shareTiddler,
		unshare:       _unshareTiddler,
		get:           _getTiddler,
		unsubscribe:   _unsubscribeTiddler,
		getOwned:      function() { return Object.keys(ownedTiddlers); },
		getAvailable:  function() { return Object.assign({}, availableTiddlers); },
		getSubscribed: function() { return Object.keys(subscribedTiddlers); }
	};
};
