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

var CONFIG_OWNED      = "$:/config/codemirror-6-collab/owned-tiddlers";
var CONFIG_SUBSCRIBED = "$:/config/codemirror-6-collab/subscribed-tiddlers";
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

	// Titles currently being written from a peer update - suppresses echo.
	var suppressEcho = {};

	// Titles being renamed programmatically (subscriber auto-follow) - prevents
	// th-renaming-tiddler re-entry.
	var suppressRenameHook = {};

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

	function _saveOwned() {
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CONFIG_OWNED,
			text:  JSON.stringify(Object.keys(ownedTiddlers))
		}));
	}

	function _saveSubscribed() {
		var items = Object.keys(subscribedTiddlers)
			.filter(function(title) { return !ownedTiddlers[title]; })
			.map(function(title) {
				var sub   = subscribedTiddlers[title];
				var avail = availableTiddlers[title] || {};
				return {
					title:         title,
					ownerDeviceId: sub.ownerDeviceId || avail.ownerDeviceId || "",
					ownerName:     avail.ownerName || sub.ownerName || ""
				};
			});
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CONFIG_SUBSCRIBED,
			text:  JSON.stringify(items)
		}));
	}

	// ── temp tiddler writers (drive sidebar UI) ────────────────────────────────

	function _writeAvailable(title, info) {
		if(info) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title:             AVAIL_PREFIX + title,
				"tiddler-title":   title,
				"owner-device-id": info.ownerDeviceId || "",
				"owner-name":      info.ownerName || info.ownerDeviceId || "",
				"shared-at":       String(info.sharedAt || 0),
				subscribed:        (subscribedTiddlers[title] || ownedTiddlers[title]) ? "yes" : "",
				asset:             info.assetName ? "yes" : "",
				"asset-name":      info.assetName || "",
				"asset-type":      info.assetType || "",
				"asset-got":       (assetGot[title] || ownedTiddlers[title]) ? "yes" : ""
			}));
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

	// Reuses the existing ConflictDialog.tid / $:/tags/AboveStory overlay.
	// onResolve is called with "use-shared" or "cancel".
	function _showConflict(title, localTiddler, remoteFields, onResolve) {
		var conflictTiddler = "$:/temp/collab/conflict/" + title;
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:            conflictTiddler,
			"tiddler-title":  title,
			"local-content":  (localTiddler.fields.text  || "").slice(0, 2000),
			"remote-content": (remoteFields.text || "").slice(0, 2000),
			resolution:       ""
		}));

		var onChange = function(changes) {
			if(!changes[conflictTiddler]) return;
			var tid = $tw.wiki.getTiddler(conflictTiddler);
			var resolution = tid ? (tid.fields.resolution || "") : "";
			if(!resolution) return;
			$tw.wiki.removeEventListener("change", onChange);
			$tw.wiki.deleteTiddler(conflictTiddler);
			onResolve(resolution, remoteFields);
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
	}

	// Push the current local version of title to the room.
	function _pushLocal(title) {
		var t = $tw.wiki.getTiddler(title);
		if(t && !t.fields["draft.of"]) {
			_send({
				type:           "collab-tiddler-update",
				senderDeviceId: deviceId,
				title:          title,
				fields:         _serialise(t)
			});
		}
	}

	// ── restore persisted state on startup ─────────────────────────────────────

	_safeJson($tw.wiki.getTiddlerText(CONFIG_OWNED, "[]")).forEach(function(title) {
		if(typeof title !== "string" || !title) return;
		var now = Date.now();
		var _oa = _assetInfo(title);
		ownedTiddlers[title]      = {sharedAt: now};
		subscribedTiddlers[title] = {ownerDeviceId: deviceId};
		availableTiddlers[title]  = {ownerDeviceId: deviceId, ownerName: _myName(), sharedAt: now,
			assetName: _oa ? _oa.name : "", assetType: _oa ? _oa.type : ""};
		_writeOwned(title, ownedTiddlers[title]);
		_writeAvailable(title, availableTiddlers[title]);
	});

	_safeJson($tw.wiki.getTiddlerText(CONFIG_SUBSCRIBED, "[]")).forEach(function(item) {
		// Support both old format (plain string) and new format ({title, ownerDeviceId, ownerName}).
		var title         = typeof item === "string" ? item : (item && item.title);
		var ownerDeviceId = (item && typeof item === "object") ? (item.ownerDeviceId || "") : "";
		var ownerName     = (item && typeof item === "object") ? (item.ownerName     || "") : "";
		if(typeof title !== "string" || !title) return;
		if(ownedTiddlers[title]) return; // already restored above
		// Store ownerName in subscribedTiddlers so it survives disconnect/reconnect cycles.
		subscribedTiddlers[title] = {ownerDeviceId: ownerDeviceId, ownerName: ownerName};
		if(!availableTiddlers[title]) {
			availableTiddlers[title] = {ownerDeviceId: ownerDeviceId, ownerName: ownerName, sharedAt: 0};
		}
		_writeAvailable(title, availableTiddlers[title]);
	});

	// ── manifest helpers ───────────────────────────────────────────────────────

	function _myName() {
		return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/device-name", "")
			|| $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/user-name", "")
			|| $tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "")
			|| deviceId;
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
				assetType:     asset ? asset.type : ""
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
			// Title already claimed by a different peer - do not overwrite.
			return false;
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
		// Refresh sender's entries: remove stale, re-add current.
		// Entries owned by other peers are untouched.
		Object.keys(availableTiddlers).forEach(function(title) {
			if(availableTiddlers[title].ownerDeviceId === senderDeviceId) {
				delete availableTiddlers[title];
				if(!ownedTiddlers[title]) { $tw.wiki.deleteTiddler(AVAIL_PREFIX + title); }
			}
		});
		(manifest || []).forEach(function(item) {
			if(!item || !item.title) return;
			_claimAvailable(item.title, {
				ownerDeviceId: senderDeviceId,
				ownerName:     item.ownerName || senderName || senderDeviceId,
				sharedAt:      item.sharedAt  || Date.now(),
				assetName:     item.assetName || "",
				assetType:     item.assetType || ""
			});
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

		// Transfer owned state.
		if(wasOwned) {
			var ownedInfo = ownedTiddlers[fromTitle];
			delete ownedTiddlers[fromTitle];
			ownedTiddlers[toTitle] = ownedInfo;
			_writeOwned(fromTitle, null);
			_writeOwned(toTitle, ownedInfo);
		}

		// Transfer subscribed state.
		var subInfo = subscribedTiddlers[fromTitle] || {ownerDeviceId: deviceId};
		delete subscribedTiddlers[fromTitle];
		subscribedTiddlers[toTitle] = subInfo;

		// Transfer available state.
		var avail = availableTiddlers[fromTitle];
		if(avail) {
			delete availableTiddlers[fromTitle];
			availableTiddlers[toTitle] = avail;
			_writeAvailable(fromTitle, null);
			_writeAvailable(toTitle, availableTiddlers[toTitle]);
		}

		_saveOwned();
		_saveSubscribed();

		// Only the owner broadcasts the rename; subscribers just update locally.
		if(wasOwned) {
			_send({
				type:          "collab-tiddler-rename",
				ownerDeviceId: deviceId,
				fromTitle:     fromTitle,
				toTitle:       toTitle
			});
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
		var inc = incomingAssets[requestId];
		if(inc && inc.timer) { clearTimeout(inc.timer); }
		delete incomingAssets[requestId];
		delete pendingAssetGets[requestId];
		$tw.wiki.deleteTiddler("$:/temp/collab/asset-incoming/" + requestId);
	}

	function _finalizeAsset(requestId) {
		var inc = incomingAssets[requestId], pending = pendingAssetGets[requestId];
		if(inc && inc.timer) { clearTimeout(inc.timer); }
		$tw.wiki.deleteTiddler("$:/temp/collab/asset-incoming/" + requestId);
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

	$tw.wiki.addEventListener("change", function(changes) {
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
			// A rename moves the owned/subscribed entry to the new title before this fires
			// (via the th-renaming-tiddler hook), so this only matches genuine deletions.
			if(changes[title].deleted) {
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
				// Re-request any subscribed tiddlers the sender now advertises.
				(msg.manifest || []).forEach(function(item) {
					if(item && item.title
							&& subscribedTiddlers[item.title]
							&& !ownedTiddlers[item.title]) {
						_requestFromOwner(item.title);
					}
				});
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

			var local = $tw.wiki.getTiddler(msg.title);

			if(!local) {
				// Tiddler does not exist locally - apply unconditionally.
				_applyRemote(msg.title, msg.fields);
			} else {
				var localMs  = _parseMs(local.fields.modified);
				var remoteMs = _parseMs(msg.fields.modified);

				if(remoteMs > localMs) {
					// Remote is strictly newer - apply silently.
					_applyRemote(msg.title, msg.fields);

				} else if(localMs > remoteMs) {
					// Local is strictly newer - keep it and push to room so peers catch up.
					_pushLocal(msg.title);

				} else {
					// Equal (or absent) timestamps. A genuine coarse edit bumps `modified`,
					// so a timestamp tie with divergent text almost always means one side
					// missed the other's Yjs character-level edits (Yjs deliberately does NOT
					// bump `modified`) — i.e. staleness, not a concurrent coarse edit. Popping
					// a conflict dialog here was the "out-of-sync limbo" only escapable via
					// unshare+delete+get. Since a shared tiddler always has an authoritative
					// owner, resolve by ownership instead:
					var localText  = local.fields.text  || "";
					var remoteText = msg.fields.text || "";
					if(localText === remoteText) {
						// Identical content - nothing to do.
						break;
					}
					var ownerId   = availableTiddlers[msg.title] && availableTiddlers[msg.title].ownerDeviceId;
					var iAmOwner  = !!ownedTiddlers[msg.title];
					var fromOwner = msg.senderDeviceId && ownerId && msg.senderDeviceId === ownerId;
					if(fromOwner && !iAmOwner) {
						// The owner answered and we only subscribe → adopt the owner's copy
						// as authoritative, silently. This heals a stale subscriber.
						_applyRemote(msg.title, msg.fields);
					} else if(iAmOwner) {
						// We own it (owner re-sync after reconnect): our copy is the source of
						// truth. Keep it and re-push so subscribers converge onto it.
						_pushLocal(msg.title);
					} else {
						// Ownerless, or the owner is unknown to us (e.g. answered by another
						// subscriber while the owner is offline): we genuinely cannot decide,
						// so fall back to asking the user.
						_showConflict(msg.title, local, msg.fields, function(resolution, remoteFields) {
							if(resolution === "use-shared") {
								_applyRemote(msg.title, remoteFields);
							} else {
								// User keeps local; push it so peers receive the definitive version.
								_pushLocal(msg.title);
							}
						});
					}
				}
			}
			// Ensure the subscription record is up-to-date.
			if(!subscribedTiddlers[msg.title]) {
				subscribedTiddlers[msg.title] = {ownerDeviceId: ""};
			}
			_writeAvailable(msg.title, availableTiddlers[msg.title]);
			break;

		case "collab-tiddler-update":
			// Runtime update from any subscribed peer - last-write-wins.
			// Simultaneous editing is handled by CM6/Yjs; this path is for
			// passive receivers and course-grained saves.
			if(msg.senderDeviceId !== deviceId
					&& msg.title
					&& msg.fields
					&& (subscribedTiddlers[msg.title] || ownedTiddlers[msg.title])) {
				_applyRemote(msg.title, msg.fields);
			}
			break;

		case "collab-tiddler-rename":
			if(msg.ownerDeviceId === deviceId || !msg.fromTitle || !msg.toTitle) break;
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
			break;

		case "collab-asset-chunk":
			var _inc = incomingAssets[msg.requestId];
			if(_inc && typeof msg.index === "number" && _inc.chunks[msg.index] === undefined) {
				_inc.chunks[msg.index] = msg.data || "";
				_inc.received++;
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

	window.addEventListener("collab-disconnected", function() {
		// Clear peer-owned entries; ours stay visible in the sidebar.
		Object.keys(availableTiddlers).forEach(function(title) {
			if(!ownedTiddlers[title]) {
				delete availableTiddlers[title];
				$tw.wiki.deleteTiddler(AVAIL_PREFIX + title);
			}
		});
	});

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
