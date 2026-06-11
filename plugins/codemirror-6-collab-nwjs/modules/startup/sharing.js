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

	var deviceId = (window.TiddlyDesktop && window.TiddlyDesktop.collab)
		? window.TiddlyDesktop.collab.getDeviceId()
		: ($tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/device-id", "") || "unknown");

	// ── utilities ──────────────────────────────────────────────────────────────

	function _send(msg) {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collab;
		if(api && api.send) { api.send(msg); }
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
	function _serialise(tiddler) {
		var out = {};
		Object.keys(tiddler.fields).forEach(function(f) {
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
				subscribed:        (subscribedTiddlers[title] || ownedTiddlers[title]) ? "yes" : ""
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

	// Apply remote fields, suppressing the echo on the change listener.
	function _applyRemote(title, fields) {
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
		ownedTiddlers[title]      = {sharedAt: now};
		subscribedTiddlers[title] = {ownerDeviceId: deviceId};
		availableTiddlers[title]  = {ownerDeviceId: deviceId, ownerName: _myName(), sharedAt: now};
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
			return {
				title:         title,
				ownerDeviceId: deviceId,
				ownerName:     _myName(),
				sharedAt:      ownedTiddlers[title].sharedAt
			};
		});
		if(!manifest.length) return;
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
				sharedAt:      item.sharedAt  || Date.now()
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
		ownedTiddlers[title]      = {sharedAt: now};
		subscribedTiddlers[title] = {ownerDeviceId: deviceId};
		availableTiddlers[title]  = {ownerDeviceId: deviceId, ownerName: _myName(), sharedAt: now};
		_writeOwned(title, ownedTiddlers[title]);
		_writeAvailable(title, availableTiddlers[title]);
		_saveOwned();
		_saveSubscribed();
		_send({
			type:          "collab-share-new",
			ownerDeviceId: deviceId,
			ownerName:     _myName(),
			title:         title,
			sharedAt:      now
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
		subscribedTiddlers[title] = {ownerDeviceId: info.ownerDeviceId, ownerName: info.ownerName || ""};
		_writeAvailable(title, availableTiddlers[title]);
		_saveSubscribed();
		_requestFromOwner(title);
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
			if(!ownedTiddlers[title] && !subscribedTiddlers[title]) return;
			var tiddler = $tw.wiki.getTiddler(title);
			if(!tiddler || tiddler.fields["draft.of"]) return;
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
					sharedAt:      msg.sharedAt  || Date.now()
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
			// Only the owner responds to get requests.
			if(msg.requesterDeviceId !== deviceId
					&& msg.title
					&& ownedTiddlers[msg.title]) {
				var tiddler = $tw.wiki.getTiddler(msg.title);
				if(tiddler && !tiddler.fields["draft.of"]) {
					_send({
						type:           "collab-tiddler-response",
						targetDeviceId: msg.requesterDeviceId,
						title:          msg.title,
						requestId:      msg.requestId,
						fields:         _serialise(tiddler)
					});
				}
			}
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
					// Same (or absent) timestamp: compare text to detect a true conflict.
					var localText  = local.fields.text  || "";
					var remoteText = msg.fields.text || "";
					if(localText === remoteText) {
						// Identical content - nothing to do.
						break;
					}
					// Genuinely diverged with equal timestamps - ask the user.
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
		}
	});

	// ── session lifecycle ─────────────────────────────────────────────────────

	window.addEventListener("collab-connected", function() {
		// Restore owned tiddlers in the available map.
		Object.keys(ownedTiddlers).forEach(function(title) {
			availableTiddlers[title] = {
				ownerDeviceId: deviceId,
				ownerName:     _myName(),
				sharedAt:      ownedTiddlers[title].sharedAt
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
