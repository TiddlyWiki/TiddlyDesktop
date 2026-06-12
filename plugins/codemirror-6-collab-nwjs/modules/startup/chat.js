/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/chat.js
type: application/javascript
module-type: startup

Real-time chat for codemirror-6-collab-nwjs.

Two conversation modes, both end-to-end encrypted:
  - Everyone: broadcast to the room (encrypted with the shared room key).
  - 1:1: an exclusive private message to a single peer, encrypted with a pairwise
    key (ECDH) so no other room member can read it (transport.sendPrivate).

The active conversation is $:/config/state/collab/chat-target ("" = Everyone, or
a peer deviceId). Messages carry a `peer` field naming their conversation ("" for
room, the other device's id for a DM) so the panel can show one thread at a time.

Messages are transient: cleared at the start of each new session (collab-connected).
\*/

"use strict";

exports.name        = "codemirror-6-collab-nwjs-chat";
exports.after       = ["codemirror-6-collab-nwjs-transport", "startup", "rootwidget"];
exports.synchronous = true;
exports.platforms   = ["browser"];

exports.startup = function() {

	// Always use the transport's ephemeral session ID (this module loads after the
	// transport). Never fall back to the persisted device-id config tiddler — on
	// cloned wikis that holds a stale, shared value that would re-introduce ID
	// collisions between the two copies.
	var collab = (window.TiddlyDesktop && window.TiddlyDesktop.collab) || null;
	var deviceId = collab ? collab.getDeviceId() : "unknown";

	var MSG_PREFIX    = "$:/temp/collab/chat/msg/";
	var UNREAD_TITLE  = "$:/temp/collab/chat/unread";          // total (toggle badge)
	var UNREAD_PREFIX = "$:/temp/collab/chat/unread/";          // per-conversation
	var INPUT_TITLE   = "$:/temp/collab/chat/input";
	var OPEN_TITLE    = "$:/config/state/collab/chat-open";
	var TARGET_TITLE  = "$:/config/state/collab/chat-target";   // "" = Everyone, else peer deviceId
	var msgCounter    = 0;

	function _send(msg)        { if(collab && collab.send) { collab.send(msg); } }
	function _sendPrivate(to, msg) { if(collab && collab.sendPrivate) { return collab.sendPrivate(to, msg); } }
	function _currentTarget()  { return $tw.wiki.getTiddlerText(TARGET_TITLE, "") || ""; }
	function _convKey(peerKey) { return peerKey ? peerKey : "room"; }

	function _myName() {
		return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/device-name", "")
			|| $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/user-name", "")
			|| $tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "")
			|| deviceId;
	}

	function _formatTime(ms) {
		var d = new Date(ms);
		return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	}

	// ── unread bookkeeping (per conversation + a total for the toggle badge) ──────

	function _convUnread(key) { return parseInt($tw.wiki.getTiddlerText(UNREAD_PREFIX + key, "0"), 10) || 0; }

	function _setConvUnread(key, n) {
		if(n > 0) { $tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_PREFIX + key, text: String(n)})); }
		else { $tw.wiki.deleteTiddler(UNREAD_PREFIX + key); }
	}

	function _recomputeTotal() {
		var total = 0;
		$tw.wiki.filterTiddlers("[prefix[" + UNREAD_PREFIX + "]]").forEach(function(t) {
			total += parseInt($tw.wiki.getTiddlerText(t, "0"), 10) || 0;
		});
		$tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_TITLE, text: String(total)}));
	}

	// ── messages ──────────────────────────────────────────────────────────────

	function _addMessage(senderName, text, isLocal, timestamp, peerKey) {
		peerKey = peerKey || "";
		var now = timestamp || Date.now();
		var id  = String(now) + "-" + String(++msgCounter);
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:         MSG_PREFIX + id,
			"sender-name": senderName,
			text:          text,
			"is-local":    isLocal ? "yes" : "",
			"msg-sort":    id,
			"time-label":  _formatTime(now),
			peer:          peerKey
		}));
		if(!isLocal) {
			var panelOpen = $tw.wiki.getTiddlerText(OPEN_TITLE, "no") === "yes";
			// Unread if the panel is closed, or this message is for a conversation
			// other than the one currently in view.
			if(!panelOpen || peerKey !== _currentTarget()) {
				var key = _convKey(peerKey);
				_setConvUnread(key, _convUnread(key) + 1);
				_recomputeTotal();
			}
		}
	}

	function _clearMessages() {
		$tw.wiki.filterTiddlers("[prefix[" + MSG_PREFIX + "]]").forEach(function(t) { $tw.wiki.deleteTiddler(t); });
		$tw.wiki.filterTiddlers("[prefix[" + UNREAD_PREFIX + "]]").forEach(function(t) { $tw.wiki.deleteTiddler(t); });
		$tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_TITLE, text: "0"}));
		$tw.wiki.addTiddler(new $tw.Tiddler({title: TARGET_TITLE, text: ""}));
	}

	// ── events ──────────────────────────────────────────────────────────────────

	window.addEventListener("collab-sharing-message", function(ev) {
		var msg = ev && ev.detail;
		if(!msg || msg.type !== "collab-chat-message") return;
		if(msg.senderDeviceId === deviceId) return;
		// A private (DM) message is tagged by the transport with peerDeviceId; it
		// belongs to the 1:1 conversation with that sender. Room messages have none.
		var peerKey = msg.private ? (msg.peerDeviceId || msg.senderDeviceId) : "";
		_addMessage(msg.senderName || msg.senderDeviceId || "Anonymous", msg.text || "", false, msg.timestamp, peerKey);
	});

	// Clear history at the start of each new session so stale messages don't appear.
	window.addEventListener("collab-connected", _clearMessages);

	// If the peer we're privately chatting with leaves, fall back to Everyone and
	// fold away their (now unreachable) unread count.
	window.addEventListener("collab-member-left", function(ev) {
		var d = ev && ev.detail && ev.detail.deviceId;
		if(!d) return;
		if(_currentTarget() === d) { $tw.wiki.addTiddler(new $tw.Tiddler({title: TARGET_TITLE, text: ""})); }
		if(_convUnread(d) !== 0) { _setConvUnread(_convKey(d), 0); _recomputeTotal(); }
	});

	// ── widget messages ──────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("codemirror-6-collab-chat-send", function() {
		var text = ($tw.wiki.getTiddlerText(INPUT_TITLE, "") || "").trim();
		if(!text) return false;
		var now = Date.now();
		var target = _currentTarget();
		var msg = {
			type:           "collab-chat-message",
			msg_id:         "chat-" + String(now) + "-" + Math.random().toString(36).slice(2, 8),
			senderDeviceId: deviceId,
			senderName:     _myName(),
			text:           text,
			timestamp:      now
		};
		if(target) { _sendPrivate(target, msg); } else { _send(msg); }
		_addMessage(_myName(), text, true, now, target);
		$tw.wiki.addTiddler(new $tw.Tiddler({title: INPUT_TITLE, text: ""}));
		return false;
	});

	// Clear the active conversation's unread when the panel is open and on view, or
	// when switching to a conversation.
	$tw.wiki.addEventListener("change", function(changes) {
		if(!changes[OPEN_TITLE] && !changes[TARGET_TITLE]) return;
		if($tw.wiki.getTiddlerText(OPEN_TITLE, "") !== "yes") return;
		var key = _convKey(_currentTarget());
		if(_convUnread(key) !== 0) { _setConvUnread(key, 0); _recomputeTotal(); }
	});
};
