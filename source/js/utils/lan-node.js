/*
Parent-side LAN node for single-file wikis.

The collab transport runs inside the nwdisable iframe, which has no Node, so it
cannot listen on a socket or use Node's crypto for the LAN (X25519 / ChaCha20)
channel. This module runs that LAN node in the parent process on the iframe's
behalf and is driven over the bridge in wiki-file-window.js.

It MIRRORS the LAN protocol in the collab plugin's transport.js exactly so a
single-file wiki and a folder wiki interoperate over LAN:
  - handshake: lan-hello (TEXT) → encrypted lan-hello-ack (BINARY, HMAC confirm)
  - frames: ChaCha20-Poly1305, [12-byte nonce][ciphertext][16-byte tag]
  - keys: X25519 ECDH, mixed with the room content key, → HKDF-SHA256
Keep this wire-compatible with transport.js if either side changes.

One node per wiki window:
  var node = createLanNode({
    deviceId: "...",
    roomKey: <Buffer|Uint8Array|null>,             // 32-byte room content key
    onReady: function(pubKeyB64, endpoints) {},     // announce these via the relay
    onMessage: function(peerDeviceId, jsonString) {}, // a decrypted LAN data message + its authenticated sender
    onPeerCount: function(n) {}
  });
  node.addPeer(deviceId, pubKeyB64, endpoints);     // from a relay lan-announce
  node.broadcast(jsonString);                       // send a data message to all LAN peers
  node.removePeer(deviceId);
  node.close();
*/

"use strict";

var ws         = require("ws"),
	nodeCrypto = require("crypto"),
	nodeOs     = require("os");

var LAN_PORT_START   = 45700,
	LAN_PORT_END     = 45710,
	LAN_HANDSHAKE_MS = 2000,
	LAN_CONNECT_MS   = 1000;

function hkdf(ikm, salt, info, len) {
	if(typeof salt === "string") salt = Buffer.from(salt, "utf8");
	if(typeof info === "string") info = Buffer.from(info, "utf8");
	if(nodeCrypto.hkdfSync) { return Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, info, len)); }
	var prk = nodeCrypto.createHmac("sha256", salt).update(ikm).digest();
	var out = Buffer.alloc(len), t = Buffer.alloc(0), pos = 0;
	for(var i = 1; pos < len; i++) {
		t = nodeCrypto.createHmac("sha256", prk).update(t).update(info).update(Buffer.from([i])).digest();
		var n = Math.min(len - pos, 32); t.copy(out, pos, 0, n); pos += n;
	}
	return out;
}

function encryptFrame(key, plaintext) {
	var nonce  = nodeCrypto.randomBytes(12);
	var cipher = nodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, {authTagLength: 16});
	var ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function decryptFrame(key, frame) {
	if(frame.length < 28) throw new Error("frame too short");
	var nonce = frame.slice(0, 12), ct = frame.slice(12, frame.length - 16), tag = frame.slice(frame.length - 16);
	var dc = nodeCrypto.createDecipheriv("chacha20-poly1305", key, nonce, {authTagLength: 16});
	dc.setAuthTag(tag);
	return Buffer.concat([dc.update(ct), dc.final()]);
}

function hmac16hex(key, label) {
	return nodeCrypto.createHmac("sha256", key).update(Buffer.from(label, "utf8")).digest("hex").slice(0, 32);
}

function createLanNode(options) {
	var deviceId    = options.deviceId,
		roomKey     = options.roomKey ? Buffer.from(options.roomKey) : null,
		onReady     = options.onReady     || function() {},
		onMessage   = options.onMessage   || function() {},
		onPeerCount = options.onPeerCount || function() {};

	var myKeyPair    = null,
		lanServer    = null,
		lanPort      = 0,
		lanEndpoints = [],
		peerSessions = {},   // deviceId -> {key: Buffer(32)}
		directPeers  = {},   // deviceId -> {ws}
		closed       = false;

	function notifyPeers() { try { onPeerCount(Object.keys(directPeers).length); } catch(_e) {} }

	function generateKeyPair() {
		try {
			var kp = nodeCrypto.generateKeyPairSync("x25519", {
				publicKeyEncoding:  {type: "spki",  format: "der"},
				privateKeyEncoding: {type: "pkcs8", format: "der"}
			});
			var rawPub = Buffer.from(kp.publicKey).slice(12); // SPKI: 12-byte header + 32 raw
			return {privateDer: Buffer.from(kp.privateKey), pubKeyB64: rawPub.toString("base64")};
		} catch(e) { console.error("[lan-node] X25519 keygen failed:", e.message); return null; }
	}

	function deriveSessionKey(theirPubKeyB64) {
		if(!myKeyPair) return null;
		try {
			var theirRaw  = Buffer.from(theirPubKeyB64, "base64");
			var theirSpki = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), theirRaw]);
			var privKey   = nodeCrypto.createPrivateKey({key: myKeyPair.privateDer, format: "der", type: "pkcs8"});
			var pubKey    = nodeCrypto.createPublicKey( {key: theirSpki,            format: "der", type: "spki"});
			var shared    = nodeCrypto.diffieHellman({privateKey: privKey, publicKey: pubKey});
			var ikm       = roomKey ? Buffer.concat([Buffer.from(shared), roomKey]) : Buffer.from(shared);
			return hkdf(ikm, "tiddlydesktop-collab-lan-v1", "session-key", 32);
		} catch(e) { console.error("[lan-node] session key derivation failed:", e.message); return null; }
	}

	function getLocalIpEndpoints(port) {
		var eps = [];
		try {
			var ifaces = nodeOs.networkInterfaces();
			Object.keys(ifaces).forEach(function(name) {
				(ifaces[name] || []).forEach(function(addr) {
					if(addr.family === "IPv4" && !addr.internal) { eps.push({ip: addr.address, port: port}); }
				});
			});
		} catch(_e) {}
		return eps;
	}

	function handleFrame(peerId, session, raw) {
		try {
			var frame = raw instanceof Buffer ? raw : Buffer.from(raw);
			// peerId is the authenticated sender (its LAN session key decrypted this
			// frame); pass it through so the client can enforce verified-peer-only.
			onMessage(peerId, decryptFrame(session.key, frame).toString("utf8"));
		} catch(e) {
			if(directPeers[peerId]) { try { directPeers[peerId].ws.terminate(); } catch(_) {} delete directPeers[peerId]; notifyPeers(); }
		}
	}

	function setupServerHandlers(srv) {
		srv.on("connection", function(socket) {
			var timer = setTimeout(function() { socket.terminate(); }, LAN_HANDSHAKE_MS);
			socket.once("message", function(data) {
				clearTimeout(timer);
				var hello;
				try { hello = JSON.parse(data.toString()); if(hello.type !== "lan-hello" || !hello.deviceId) throw new Error("bad hello"); }
				catch(_e) { socket.terminate(); return; }
				var peerId = hello.deviceId, session = peerSessions[peerId];
				if(!session || directPeers[peerId]) { socket.terminate(); return; }
				try {
					var ackJson = JSON.stringify({type: "lan-hello-ack", deviceId: deviceId, confirm: hmac16hex(session.key, "server-confirm")});
					socket.send(encryptFrame(session.key, Buffer.from(ackJson, "utf8")));
				} catch(e) { socket.terminate(); return; }
				directPeers[peerId] = {ws: socket}; notifyPeers();
				socket.on("message", function(raw) { handleFrame(peerId, session, raw); });
				socket.on("close",   function()    { delete directPeers[peerId]; notifyPeers(); });
				socket.on("error",   function()    { delete directPeers[peerId]; notifyPeers(); });
			});
		});
	}

	function startServer() {
		if(!ws.Server) { try { onReady(myKeyPair ? myKeyPair.pubKeyB64 : null, []); } catch(_e) {} return; }
		(function tryPort(p) {
			if(p > LAN_PORT_END || closed) return;
			var srv = new ws.Server({port: p, host: "0.0.0.0", perMessageDeflate: false});
			srv.on("error", function(e) { if(e.code === "EADDRINUSE") { tryPort(p + 1); } else { console.error("[lan-node] server error:", e.message); } });
			srv.on("listening", function() {
				if(closed) { try { srv.close(); } catch(_) {} return; }
				lanServer = srv; lanPort = p; lanEndpoints = getLocalIpEndpoints(p);
				setupServerHandlers(srv);
				try { onReady(myKeyPair ? myKeyPair.pubKeyB64 : null, lanEndpoints); } catch(_e) {}
			});
		}(LAN_PORT_START));
	}

	function tryConnect(peerId, endpoints) {
		if(directPeers[peerId]) return;
		var session = peerSessions[peerId];
		if(!session) return;
		var i = 0;
		(function tryNext() {
			if(i >= endpoints.length || directPeers[peerId] || closed) return;
			var ep = endpoints[i++], url = "ws://" + ep.ip + ":" + ep.port, conn;
			try { conn = new ws(url, {handshakeTimeout: LAN_CONNECT_MS, perMessageDeflate: false}); } catch(e) { tryNext(); return; }
			var done = false;
			var hTimer = setTimeout(function() { if(!done) { conn.terminate(); tryNext(); } }, LAN_HANDSHAKE_MS);
			conn.on("open", function() {
				try { conn.send(JSON.stringify({type: "lan-hello", deviceId: deviceId, peerId: peerId})); }
				catch(e) { clearTimeout(hTimer); tryNext(); }
			});
			conn.on("message", function(raw) {
				if(done) { handleFrame(peerId, session, raw); return; }
				clearTimeout(hTimer);
				try {
					var frame = raw instanceof Buffer ? raw : Buffer.from(raw);
					var ack   = JSON.parse(decryptFrame(session.key, frame).toString("utf8"));
					if(ack.type !== "lan-hello-ack") throw new Error("bad ack");
					if(ack.confirm !== hmac16hex(session.key, "server-confirm")) throw new Error("HMAC mismatch - possible MITM");
					done = true; directPeers[peerId] = {ws: conn}; notifyPeers();
					conn.on("close", function() { delete directPeers[peerId]; notifyPeers(); });
					conn.on("error", function() { delete directPeers[peerId]; notifyPeers(); });
				} catch(e) { conn.terminate(); tryNext(); }
			});
			conn.on("error", function() { clearTimeout(hTimer); if(!done) tryNext(); });
			conn.on("close", function() { clearTimeout(hTimer); });
		}());
	}

	// ── init ──
	myKeyPair = generateKeyPair();
	if(myKeyPair) { startServer(); }
	else { try { onReady(null, []); } catch(_e) {} }

	return {
		addPeer: function(peerDeviceId, pubKeyB64, endpoints) {
			if(closed || !peerDeviceId || peerDeviceId === deviceId || !pubKeyB64 || !endpoints) return;
			var key = deriveSessionKey(pubKeyB64);
			if(!key) return;
			peerSessions[peerDeviceId] = {key: key};
			tryConnect(peerDeviceId, endpoints);
		},
		broadcast: function(jsonString) {
			if(closed) return;
			var buf = Buffer.from(jsonString, "utf8");
			Object.keys(directPeers).forEach(function(pid) {
				var peer = directPeers[pid], session = peerSessions[pid];
				if(!peer || !session) return;
				try { peer.ws.send(encryptFrame(session.key, buf)); }
				catch(e) { try { peer.ws.terminate(); } catch(_) {} delete directPeers[pid]; notifyPeers(); }
			});
		},
		removePeer: function(peerDeviceId) {
			if(directPeers[peerDeviceId]) { try { directPeers[peerDeviceId].ws.terminate(); } catch(_) {} delete directPeers[peerDeviceId]; }
			delete peerSessions[peerDeviceId];
			notifyPeers();
		},
		close: function() {
			closed = true;
			Object.keys(directPeers).forEach(function(pid) { try { directPeers[pid].ws.terminate(); } catch(_) {} });
			directPeers = {}; peerSessions = {};
			if(lanServer) { try { lanServer.close(); } catch(_) {} lanServer = null; }
		}
	};
}

exports.createLanNode = createLanNode;
