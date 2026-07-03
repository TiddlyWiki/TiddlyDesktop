/*
Android LAN helper process for collab (Route A).

The wiki runs in a WebView with no Node, so — exactly like desktop single-file wikis run
their LAN node in the parent process (source/js/wiki-file-window.js) — Android runs it in a
dedicated Node helper process. This wrapper drives the shared lan-node.js over stdin/stdout
line-delimited JSON, bridged by CollabBridge.kt. Because it reuses lan-node.js unchanged it
stays wire-compatible with transport.js and desktop peers.

Protocol — commands IN (one JSON object per line, on stdin):
  {"cmd":"init","key":"<hex roomKey>","deviceId":"<id>"}
  {"cmd":"addPeer","deviceId":"<id>","pubkey":"<b64>","endpoints":[{"ip":"..","port":N}]}
  {"cmd":"broadcast","json":"<string>"}
  {"cmd":"removePeer","deviceId":"<id>"}
  {"cmd":"close"}
Events OUT (one JSON object per line, on stdout):
  {"ev":"ready","pubkey":"<b64>|null","endpoints":[...]}
  {"ev":"message","peerId":"<id>","json":"<string>"}
  {"ev":"peers","n":N}

Failsafe by design: every path swallows errors. The worst case is that no LAN events are
emitted and the client falls back to relay-only. This process must never crash the way that
would surface an error to the wiki — a missing ws/crypto just means "no LAN".
*/
"use strict";

var createLanNode;
try {
	createLanNode = require("./lan-node.js").createLanNode;
} catch (e) {
	// ws or Node crypto unavailable, or lan-node.js missing: nothing to do. Exit cleanly so the
	// parent's stdin writes fail fast (and are ignored there); the client stays relay-only.
	try { process.stderr.write("[lan-helper] disabled: " + (e && e.message) + "\n"); } catch (_e) {}
	process.exit(0);
}

var node = null;

function emit(obj) {
	try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch (_e) {}
}

function closeNode() {
	try { if (node) { node.close(); } } catch (_e) {}
	node = null;
}

function handle(cmd) {
	if (!cmd || typeof cmd !== "object") { return; }
	switch (cmd.cmd) {
	case "init":
		closeNode();
		try {
			var roomKey = cmd.key ? Buffer.from(String(cmd.key), "hex") : null;
			node = createLanNode({
				deviceId: cmd.deviceId,
				roomKey: roomKey,
				onReady: function (pubKeyB64, endpoints) {
					emit({ ev: "ready", pubkey: pubKeyB64 || null, endpoints: endpoints || [] });
				},
				onMessage: function (peerId, json) {
					emit({ ev: "message", peerId: peerId, json: json });
				},
				onPeerCount: function (n) {
					emit({ ev: "peers", n: n | 0 });
				}
			});
		} catch (_e) { node = null; }
		break;
	case "addPeer":
		try { if (node) { node.addPeer(cmd.deviceId, cmd.pubkey, cmd.endpoints || []); } } catch (_e) {}
		break;
	case "broadcast":
		try { if (node && typeof cmd.json === "string") { node.broadcast(cmd.json); } } catch (_e) {}
		break;
	case "removePeer":
		try { if (node) { node.removePeer(cmd.deviceId); } } catch (_e) {}
		break;
	case "close":
		closeNode();
		break;
	}
}

// A stray socket error must never take the process down (that would just drop LAN while the
// relay keeps working — but we prefer to stay up and keep serving other peers). lan-node.js
// already guards its own paths; this is the last-resort net.
process.on("uncaughtException", function () {});
process.on("unhandledRejection", function () {});

var buf = "";
try { process.stdin.setEncoding("utf8"); } catch (_e) {}
process.stdin.on("data", function (chunk) {
	buf += chunk;
	var idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		var line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (!line) { continue; }
		var cmd = null;
		try { cmd = JSON.parse(line); } catch (_e) { cmd = null; }
		if (cmd) { handle(cmd); }
	}
});
// Parent closed our stdin (activity destroyed / process killed): shut down cleanly.
process.stdin.on("end", function () { closeNode(); try { process.exit(0); } catch (_e) {} });
process.stdin.on("error", function () {});
process.stdout.on("error", function () {}); // parent went away: ignore broken pipe
