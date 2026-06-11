/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/chat.js
type: application/javascript
module-type: startup

Real-time chat for codemirror-6-collab-nwjs.
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
	var deviceId = (window.TiddlyDesktop && window.TiddlyDesktop.collab)
		? window.TiddlyDesktop.collab.getDeviceId()
		: "unknown";

	var MSG_PREFIX   = "$:/temp/collab/chat/msg/";
	var UNREAD_TITLE = "$:/temp/collab/chat/unread";
	var INPUT_TITLE  = "$:/temp/collab/chat/input";
	var msgCounter   = 0;

	function _send(msg) {
		var api = window.TiddlyDesktop && window.TiddlyDesktop.collab;
		if(api && api.send) { api.send(msg); }
	}

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

	function _addMessage(senderName, text, isLocal, timestamp) {
		var now = timestamp || Date.now();
		var id  = String(now) + "-" + String(++msgCounter);
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title:         MSG_PREFIX + id,
			"sender-name": senderName,
			text:          text,
			"is-local":    isLocal ? "yes" : "",
			"msg-sort":    id,
			"time-label":  _formatTime(now)
		}));
		if(!isLocal) {
			var panelOpen = $tw.wiki.getTiddlerText("$:/config/state/collab/chat-open", "no");
			if(panelOpen !== "yes") {
				var count = parseInt($tw.wiki.getTiddlerText(UNREAD_TITLE, "0"), 10) || 0;
				$tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_TITLE, text: String(count + 1)}));
			}
		}
	}

	function _clearMessages() {
		$tw.wiki.filterTiddlers("[prefix[" + MSG_PREFIX + "]]").forEach(function(t) {
			$tw.wiki.deleteTiddler(t);
		});
		$tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_TITLE, text: "0"}));
	}

	// ── events ──────────────────────────────────────────────────────────────────

	window.addEventListener("collab-sharing-message", function(ev) {
		var msg = ev && ev.detail;
		if(!msg || msg.type !== "collab-chat-message") return;
		if(msg.senderDeviceId === deviceId) return;
		_addMessage(msg.senderName || msg.senderDeviceId || "Anonymous", msg.text || "", false, msg.timestamp);
	});

	// Clear history at the start of each new session so stale messages don't appear.
	window.addEventListener("collab-connected", _clearMessages);

	// ── widget messages ──────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("codemirror-6-collab-chat-send", function() {
		var text = ($tw.wiki.getTiddlerText(INPUT_TITLE, "") || "").trim();
		if(!text) return false;
		var now = Date.now();
		_send({
			type:           "collab-chat-message",
			msg_id:         "chat-" + String(now) + "-" + Math.random().toString(36).slice(2, 8),
			senderDeviceId: deviceId,
			senderName:     _myName(),
			text:           text,
			timestamp:      now
		});
		_addMessage(_myName(), text, true, now);
		$tw.wiki.addTiddler(new $tw.Tiddler({title: INPUT_TITLE, text: ""}));
		return false;
	});

	// Clear unread count when the panel is opened.
	$tw.wiki.addEventListener("change", function(changes) {
		if(!changes["$:/config/state/collab/chat-open"]) return;
		if($tw.wiki.getTiddlerText("$:/config/state/collab/chat-open", "") === "yes") {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: UNREAD_TITLE, text: "0"}));
		}
	});
};
