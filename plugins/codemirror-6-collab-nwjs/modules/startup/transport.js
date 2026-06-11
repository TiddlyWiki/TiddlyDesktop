/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/transport.js
type: application/javascript
module-type: startup

NW.js WebSocket transport for codemirror-6-collab-nwjs.

END-TO-END ENCRYPTION
  Every peer-to-peer message routed through the relay is encrypted client-side
  with AES-256-GCM before it leaves this process, and decrypted only by peers
  who hold the room secret. The relay sees nothing but ciphertext plus the
  minimum routing metadata it needs (sender deviceId and the opaque "enc" type).

  Content key = HKDF-SHA256(secret), where:
    secret = room token   → STRONG E2E. The token is NEVER sent to the relay,
                            so the relay cannot derive the key. Confidential
                            even against a fully malicious relay.
    secret = room code    → fallback when no token is set. Traffic is still
                            encrypted, but the relay knows the room code and can
                            therefore derive this key — so it is private from
                            passive network observers and other peers, but NOT
                            from the relay. The UI labels this "room-code" so the
                            distinction is never hidden from the user.

  WebCrypto (window.crypto.subtle) is used so the same code path works both in
  wiki-folder windows and inside the nwdisable iframe of single-file wikis,
  where Node's crypto module is unavailable. If subtle crypto is missing we
  refuse to transmit rather than fall back to plaintext.

  Anti-downgrade: once connected, peer messages that are not the encrypted "enc"
  envelope are dropped. Only relay-origin control frames (joined / members /
  member_joined / member_left / error) are accepted in cleartext.

Two delivery channels run simultaneously:

  Relay channel  - wss:// with Authorization: Bearer header. Always active.
                   Carries the encrypted envelopes described above plus the
                   cleartext join handshake and relay-origin control frames.

  LAN channel    - direct ws:// between peers on the same network.
                   Encrypted with ChaCha20-Poly1305 (AEAD).
                   Key material: X25519 ECDH mixed with the room content key
                   → HKDF-SHA256 → 32-byte session key.
                   Nonces: 12 random bytes per frame (no counter state needed).
                   LAN endpoints / X25519 pubkeys are announced via the relay,
                   but the announcement is itself E2E-encrypted, so in STRONG
                   mode the relay cannot tamper with the key exchange. Folding
                   the room content key into the session key additionally means
                   a relay that swapped pubkeys still could not compute the
                   session key without the token — MITM is infeasible in strong
                   mode. (In room-code mode the relay knows the key, as above.)

Handshake:
  Client → Server  [TEXT]   {"type":"lan-hello","deviceId":"...","peerId":"..."}
  Server → Client  [BINARY] ChaCha20-Poly1305({type:"lan-hello-ack",confirm:HMAC})
  All further frames [BINARY]: [12-byte nonce][ciphertext][16-byte auth tag]

Both channels deliver the same data messages (Yjs/collab); a msg_id field
deduplicates so each message is processed exactly once regardless of which
channel wins the race.

Config tiddlers (set in the wiki itself):
  $:/config/codemirror-6-collab/relay-url     - relay server URL
  $:/config/codemirror-6-collab/auth-token     - Bearer token
  $:/config/codemirror-6-collab/room-code      - room identifier
  $:/config/codemirror-6-collab/room-token     - E2E secret (NEVER sent to relay)
  $:/config/codemirror-6-collab/device-id      - auto-generated, persisted
  $:/config/codemirror-6-collab/device-name    - display name for this device
  $:/config/codemirror-6-collab/user-name      - display name for the user
  $:/config/codemirror-6-collab/user-color     - hex colour for cursor badge

Status tiddlers:
  $:/temp/collab/status   (fields: status, room-code, lan-peers, e2e)
  $:/temp/collab/members/{deviceId}

RELAY COMPATIBILITY NOTE
  The room token is no longer transmitted to the relay (that is what makes the
  token a true E2E secret). Relay room access must therefore rest on the OAuth
  identity + room code; a relay that hard-requires X-Room-Token will reject
  these clients. Because content is E2E encrypted, an unauthorized peer who
  joins a room only ever receives ciphertext.
\*/

"use strict";

exports.name = "codemirror-6-collab-nwjs-transport";
exports.after = ["startup","rootwidget"];
exports.synchronous = true;
exports.platforms = ["browser"];

var CONFIG_PREFIX = "$:/config/codemirror-6-collab/";

// LAN port range (matches tiddlydesktop-rs LAN sync range)
var LAN_PORT_START    = 45700;
var LAN_PORT_END      = 45710;
var LAN_HANDSHAKE_MS  = 2000;  // max wait for hello/ack exchange
var LAN_CONNECT_MS    = 1000;  // TCP connect timeout per endpoint
var DEDUP_WINDOW      = 1000;  // remember this many recent msg_ids

exports.startup = function() {

	// ── resolve ws ─────────────────────────────────────────────────────────────
	// In wiki-folder wikis and backstage, require("ws") works directly.
	// In single-file wikis (nwdisable iframe), require is blocked; the parent
	// wiki-file-window.js injects _nwjsWsCreate/_nwjsWsSend/_nwjsWsTerminate
	// after the iframe loads and then calls _nwjsWsBridgeReady().

	var WS;
	try {
		var parentTw = window.parent && window.parent.$tw;
		WS = parentTw && parentTw.desktop && parentTw.desktop.utils && parentTw.desktop.utils.ws;
	} catch(_e) {}
	if(!WS) { try { WS = require("ws"); } catch(_e2) {} }

	// Detect TiddlyDesktop context: either we have ws, OR we're an iframe whose
	// parent has $tw.desktop (bridge will arrive via _nwjsWsBridgeReady).
	// exports.platforms = ["browser"] already ensures this never runs in Node.js.
	// In nwdisable iframes, cross-origin restrictions block window.parent access,
	// so we cannot detect the NW.js context from inside the iframe. Always continue:
	// _connect() no-ops until WS is available or the bridge fires _nwjsWsBridgeReady.
	console.log("[collab-transport] WS=" + !!WS + " hasBridge=" + (typeof window._nwjsWsCreate === "function"));

	// ── resolve Node.js built-ins ──────────────────────────────────────────────

	var nodeCrypto, nodeOs;
	try { nodeCrypto = require("crypto"); } catch(_e) {}
	try { nodeOs     = require("os");     } catch(_e) {}

	// ── config ─────────────────────────────────────────────────────────────────

	var relayUrl, roomCode, authToken, roomToken, deviceName, userName, userColor;

	// Persistent base ID (stored in wiki, stable across reconnects)
	// + ephemeral session suffix (NOT persisted, unique per window load).
	// This lets two simultaneously open windows of the same wiki be distinct peers.
	var baseDeviceId  = _ensureDeviceId(nodeCrypto);
	var sessionSuffix = nodeCrypto
		? nodeCrypto.randomBytes(3).toString("hex")          // 6 hex chars, crypto-random
		: Math.random().toString(36).slice(2, 8);
	var deviceId   = baseDeviceId + "." + sessionSuffix;

	var authProvider;

	function _readConfig() {
		relayUrl     = _cfg("relay-url");
		roomCode     = _cfg("room-code");
		authToken    = _cfg("auth-token");
		authProvider = _cfg("auth-provider");
		roomToken    = _cfg("room-token");
		deviceName   = _cfg("device-name") || baseDeviceId;
		userName     = _cfg("user-name") || $tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "") || $tw.wiki.getTiddlerText("$:/status/UserName") || "Anonymous";
		userColor    = _cfg("user-color") || "";
	}

	// ── runtime state ──────────────────────────────────────────────────────────

	// listeners survives reconnects so CM6 plugins don't need to re-register
	var listeners      = {};
	var memberEditing  = {};
	var memberInfo     = {};
	var ws             = null;
	var reconnectDelay = 1000;
	var destroyed      = true;  // _startSession() sets false
	var connected      = false;
	var currentStatus  = "";
	// Set to true only by explicit user action (Connect button / apply-invite).
	// Kept false at startup so the wiki never auto-connects on load.
	var _userWantsConnected = false;
	var connectionGeneration = 0;
	var reconnectTimer = null;
	// Set when the relay sends an error (e.g. wrong room token) - used by the
	// close handler to write a terminal error status instead of retrying.
	var _terminalStatus = null;

	// LAN state - myKeyPair/lanServer/lanPort/lanEndpoints survive reconnects
	var myKeyPair    = null;   // {privateDer: Buffer, pubKeyB64: string}
	var lanPort      = 0;
	var lanEndpoints = [];
	var lanServer    = null;
	// peerSessions[deviceId] = {key: Buffer(32)}
	var peerSessions = {};
	// directPeers[deviceId]  = {ws: WebSocket}
	var directPeers  = {};

	// Deduplication: track recently seen msg_ids (from peers) to absorb relay+LAN duplicates
	var seenMsgIds   = [];     // rolling array (oldest first)
	var seenMsgSet   = {};     // set for O(1) lookup

	// ── end-to-end encryption state ─────────────────────────────────────────────

	// WebCrypto is used for the relay content layer so it works both in
	// wiki-folder windows and in the nwdisable iframe of single-file wikis.
	var _subtle      = (window.crypto && window.crypto.subtle) || null;
	var _e2eKey      = null;     // AES-GCM CryptoKey for the relay content layer
	var _e2eKeyRaw   = null;     // Uint8Array(32) raw key, folded into LAN session keys
	var _e2eStrength = "none";   // "strong" (token) | "room-code" | "none"
	var _e2eReady    = Promise.resolve();  // resolves when the current key is derived
	var _sendChain   = Promise.resolve();  // serialises async relay encryption (preserves order)
	var _recvChain   = Promise.resolve();  // serialises async relay decryption (preserves order)
	var _decryptWarned = false;  // surface a "wrong token" hint at most once per session

	// Relay-origin control frames are produced by the relay itself (which has no
	// key) and are therefore the only message types accepted in cleartext.
	var RELAY_CONTROL = {joined: 1, members: 1, member_joined: 1, member_left: 1, error: 1};

	// ── crypto helpers ─────────────────────────────────────────────────────────

	// HKDF-SHA256 - polyfills older Node.js that lacks hkdfSync
	function _hkdf(ikm, salt, info, len) {
		if(typeof salt === "string") salt = Buffer.from(salt, "utf8");
		if(typeof info === "string") info = Buffer.from(info, "utf8");
		if(nodeCrypto.hkdfSync) {
			return Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, info, len));
		}
		// Manual RFC 5869 HKDF-SHA256
		var prk = nodeCrypto.createHmac("sha256", salt).update(ikm).digest();
		var out = Buffer.alloc(len);
		var t = Buffer.alloc(0);
		var pos = 0;
		for(var i = 1; pos < len; i++) {
			t = nodeCrypto.createHmac("sha256", prk)
				.update(t).update(info).update(Buffer.from([i])).digest();
			var n = Math.min(len - pos, 32);
			t.copy(out, pos, 0, n);
			pos += n;
		}
		return out;
	}

	// ChaCha20-Poly1305 encrypt.
	// Frame format: [12-byte random nonce][ciphertext][16-byte auth tag]
	// Total overhead: 28 bytes. Random nonces → no directional key split needed.
	function _encryptFrame(key, plaintext) {
		var nonce  = nodeCrypto.randomBytes(12);
		var cipher = nodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, {authTagLength: 16});
		var ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		var tag    = cipher.getAuthTag();
		return Buffer.concat([nonce, ct, tag]);
	}

	// ChaCha20-Poly1305 decrypt and authenticate. Throws on auth failure.
	function _decryptFrame(key, frame) {
		if(frame.length < 28) throw new Error("frame too short (" + frame.length + " bytes)");
		var nonce = frame.slice(0, 12);
		var ct    = frame.slice(12, frame.length - 16);
		var tag   = frame.slice(frame.length - 16);
		var dc    = nodeCrypto.createDecipheriv("chacha20-poly1305", key, nonce, {authTagLength: 16});
		dc.setAuthTag(tag);
		return Buffer.concat([dc.update(ct), dc.final()]);
	}

	// HMAC-SHA256(key, label) truncated to 32 hex chars (= 16 bytes) for handshake confirmation.
	function _hmac16hex(key, label) {
		return nodeCrypto.createHmac("sha256", key)
			.update(Buffer.from(label, "utf8")).digest("hex").slice(0, 32);
	}

	// Generate ephemeral X25519 key pair.
	function _generateKeyPair() {
		try {
			var kp = nodeCrypto.generateKeyPairSync("x25519", {
				publicKeyEncoding:  {type: "spki",  format: "der"},
				privateKeyEncoding: {type: "pkcs8", format: "der"}
			});
			// X25519 SPKI DER: fixed 12-byte header, then 32-byte raw key
			var rawPub = Buffer.from(kp.publicKey).slice(12);
			return {
				privateDer: Buffer.from(kp.privateKey),
				pubKeyB64:  rawPub.toString("base64")
			};
		} catch(e) {
			console.error("[collab-lan] X25519 keygen failed:", e.message);
			return null;
		}
	}

	// Derive 32-byte session key from our private key and peer's raw X25519 public key (base64).
	// ECDH shared secret, mixed with the room content key, → HKDF-SHA256.
	// Folding in the room content key means a relay that swapped the announced
	// pubkeys (it cannot, while lan-announce is E2E-encrypted, but defence in
	// depth) still could not compute this key without the room secret.
	function _deriveSessionKey(theirPubKeyB64) {
		if(!myKeyPair || !nodeCrypto) return null;
		try {
			var theirRaw  = Buffer.from(theirPubKeyB64, "base64");
			// Reconstruct peer's SPKI DER (12-byte header + 32 raw bytes)
			var spkiHdr   = Buffer.from("302a300506032b656e032100", "hex");
			var theirSpki = Buffer.concat([spkiHdr, theirRaw]);
			var privKey   = nodeCrypto.createPrivateKey({key: myKeyPair.privateDer, format: "der", type: "pkcs8"});
			var pubKey    = nodeCrypto.createPublicKey( {key: theirSpki,            format: "der", type: "spki"});
			var shared    = nodeCrypto.diffieHellman({privateKey: privKey, publicKey: pubKey});
			var ikm       = _e2eKeyRaw
				? Buffer.concat([Buffer.from(shared), Buffer.from(_e2eKeyRaw)])
				: Buffer.from(shared);
			return _hkdf(ikm, "tiddlydesktop-collab-lan-v1", "session-key", 32);
		} catch(e) {
			console.error("[collab-lan] Session key derivation failed:", e.message);
			return null;
		}
	}

	// ── relay end-to-end encryption (AES-256-GCM via WebCrypto) ─────────────────

	function _b64(u8) {
		var s = "";
		for(var i = 0; i < u8.length; i++) { s += String.fromCharCode(u8[i]); }
		return window.btoa(s);
	}

	function _unb64(b64) {
		var bin = window.atob(b64);
		var u8  = new Uint8Array(bin.length);
		for(var i = 0; i < bin.length; i++) { u8[i] = bin.charCodeAt(i); }
		return u8;
	}

	// (Re)derive the room content key from the current config. Strong when a room
	// token is set (never sent to the relay); room-code-derived otherwise.
	// Stores a promise in _e2eReady that the send/receive paths await.
	function _deriveE2EKey() {
		_e2eReady = (function() {
			_e2eKey = null; _e2eKeyRaw = null; _e2eStrength = "none";
			if(!_subtle) { return Promise.resolve(); }
			var secret, strength;
			if(roomToken) {
				secret = "token:" + roomToken;
				strength = "strong";
			} else if(roomCode) {
				secret = "roomcode:" + roomCode;
				strength = "room-code";
			} else {
				return Promise.resolve();
			}
			var enc  = new TextEncoder();
			var salt = enc.encode("tiddlydesktop-collab-e2e-v1");
			var info = enc.encode("room:" + roomCode);
			return _subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"])
				.then(function(ikm) {
					return _subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt: salt, info: info}, ikm, 256);
				})
				.then(function(bits) {
					_e2eKeyRaw = new Uint8Array(bits);
					return _subtle.importKey("raw", bits, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]);
				})
				.then(function(key) {
					_e2eKey = key;
					_e2eStrength = strength;
				})
				.catch(function(e) {
					console.error("[collab-e2e] key derivation failed:", e && e.message);
					_e2eKey = null; _e2eKeyRaw = null; _e2eStrength = "none";
				});
		})();
		return _e2eReady;
	}

	// Encrypt an arbitrary message object into a relay envelope. The sender
	// deviceId travels in cleartext (the relay routes by it) and is bound as
	// additional authenticated data so it cannot be reattributed.
	function _encryptRelay(obj) {
		return _e2eReady.then(function() {
			if(!_e2eKey) { throw new Error("no E2E key"); }
			var enc = new TextEncoder();
			var iv  = window.crypto.getRandomValues(new Uint8Array(12));
			var aad = enc.encode(deviceId);
			return _subtle.encrypt(
				{name: "AES-GCM", iv: iv, additionalData: aad, tagLength: 128},
				_e2eKey, enc.encode(JSON.stringify(obj))
			).then(function(ctBuf) {
				return {type: "enc", v: 1, deviceId: deviceId, iv: _b64(iv), ct: _b64(new Uint8Array(ctBuf))};
			});
		});
	}

	function _decryptRelay(env) {
		return _e2eReady.then(function() {
			if(!_e2eKey) { throw new Error("no E2E key"); }
			var enc = new TextEncoder();
			var aad = enc.encode(env.deviceId || "");
			return _subtle.decrypt(
				{name: "AES-GCM", iv: _unb64(env.iv), additionalData: aad, tagLength: 128},
				_e2eKey, _unb64(env.ct)
			).then(function(ptBuf) {
				return JSON.parse(new TextDecoder().decode(ptBuf));
			});
		});
	}

	// ── LAN server (listens for incoming peer connections) ─────────────────────

	function _startLanServer() {
		if(!WS.Server || !nodeCrypto) return;
		(function tryPort(p) {
			if(p > LAN_PORT_END) return;
			var srv = new WS.Server({port: p, host: "0.0.0.0", perMessageDeflate: false});
			srv.on("error", function(e) {
				if(e.code === "EADDRINUSE") { tryPort(p + 1); }
				else { console.error("[collab-lan] Server error:", e.message); }
			});
			srv.on("listening", function() {
				lanServer    = srv;
				lanPort      = p;
				lanEndpoints = _getLocalIpEndpoints(p);
				_setupServerHandlers(srv);
			});
		}(LAN_PORT_START));
	}

	function _getLocalIpEndpoints(port) {
		if(!nodeOs) return [];
		var eps = [];
		try {
			var ifaces = nodeOs.networkInterfaces();
			Object.keys(ifaces).forEach(function(name) {
				(ifaces[name] || []).forEach(function(addr) {
					if(addr.family === "IPv4" && !addr.internal) {
						eps.push({ip: addr.address, port: port});
					}
				});
			});
		} catch(_e) {}
		return eps;
	}

	function _setupServerHandlers(srv) {
		srv.on("connection", function(socket) {
			var timer = setTimeout(function() { socket.terminate(); }, LAN_HANDSHAKE_MS);

			socket.once("message", function(data) {
				clearTimeout(timer);
				var hello;
				try {
					hello = JSON.parse(data.toString());
					if(hello.type !== "lan-hello" || !hello.deviceId) throw new Error("bad hello");
				} catch(_e) { socket.terminate(); return; }

				var peerId  = hello.deviceId;
				var session = peerSessions[peerId];
				if(!session)             { socket.terminate(); return; } // unknown peer
				if(directPeers[peerId])  { socket.terminate(); return; } // already connected

				// Send encrypted hello-ack with HMAC confirmation
				try {
					var ackJson = JSON.stringify({
						type:    "lan-hello-ack",
						deviceId: deviceId,
						confirm:  _hmac16hex(session.key, "server-confirm")
					});
					socket.send(_encryptFrame(session.key, Buffer.from(ackJson, "utf8")));
				} catch(e) {
					console.error("[collab-lan] hello-ack send failed:", e.message);
					socket.terminate();
					return;
				}

				directPeers[peerId] = {ws: socket};
				_writeStatus();
				socket.on("message", function(raw) { _handleLanFrame(peerId, session, raw); });
				socket.on("close",   function()    { delete directPeers[peerId]; _writeStatus(); });
				socket.on("error",   function(e)   {
					console.warn("[collab-lan] Server peer error:", e.message);
					delete directPeers[peerId]; _writeStatus();
				});
			});
		});
	}

	// ── LAN client (connects out to a peer's server) ───────────────────────────

	function _tryLanConnect(peerId, endpoints) {
		if(directPeers[peerId]) return;
		var session = peerSessions[peerId];
		if(!session) return;

		var i = 0;
		(function tryNext() {
			if(i >= endpoints.length || directPeers[peerId]) return;
			var ep  = endpoints[i++];
			var url = "ws://" + ep.ip + ":" + ep.port;
			var conn;
			try { conn = new WS(url, {handshakeTimeout: LAN_CONNECT_MS, perMessageDeflate: false}); }
			catch(e) { tryNext(); return; }

			var handshakeDone  = false;
			var handshakeTimer = setTimeout(function() {
				if(!handshakeDone) { conn.terminate(); tryNext(); }
			}, LAN_HANDSHAKE_MS);

			conn.on("open", function() {
				try {
					conn.send(JSON.stringify({type: "lan-hello", deviceId: deviceId, peerId: peerId}));
				} catch(e) { clearTimeout(handshakeTimer); tryNext(); }
			});

			conn.on("message", function(raw) {
				if(handshakeDone) {
					_handleLanFrame(peerId, session, raw);
					return;
				}
				// First message: encrypted hello-ack
				clearTimeout(handshakeTimer);
				try {
					var frame = raw instanceof Buffer ? raw : Buffer.from(raw);
					var plain = _decryptFrame(session.key, frame);
					var ack   = JSON.parse(plain.toString("utf8"));
					if(ack.type !== "lan-hello-ack") throw new Error("bad ack type");
					if(ack.confirm !== _hmac16hex(session.key, "server-confirm"))
						throw new Error("HMAC confirmation mismatch - possible MITM");
					handshakeDone = true;
					directPeers[peerId] = {ws: conn};
					_writeStatus();
					conn.on("close", function()  { delete directPeers[peerId]; _writeStatus(); });
					conn.on("error", function(e) {
						console.warn("[collab-lan] Client peer error:", e.message);
						delete directPeers[peerId]; _writeStatus();
					});
				} catch(e) {
					console.warn("[collab-lan] Handshake failed with", peerId + ":", e.message);
					conn.terminate();
					tryNext();
				}
			});

			conn.on("error", function() { clearTimeout(handshakeTimer); if(!handshakeDone) tryNext(); });
			conn.on("close", function() { clearTimeout(handshakeTimer); });
		}());
	}

	// Decrypt an incoming LAN frame and dispatch to the shared message handler.
	// Terminates the connection on any authentication failure.
	function _handleLanFrame(peerId, session, rawData) {
		try {
			var frame = rawData instanceof Buffer ? rawData : Buffer.from(rawData);
			var plain = _decryptFrame(session.key, frame);
			var msg   = JSON.parse(plain.toString("utf8"));
			_handleMessage(msg);
		} catch(e) {
			// Auth tag mismatch = possible tampering → hard disconnect
			console.warn("[collab-lan] Decrypt/auth failed from", peerId + ":", e.message);
			if(directPeers[peerId]) {
				try { directPeers[peerId].ws.terminate(); } catch(_) {}
				delete directPeers[peerId];
				_writeStatus();
			}
		}
	}

	// ── deduplication ─────────────────────────────────────────────────────────
	// Both relay and LAN can deliver the same message; msg_id prevents double-apply.

	function _markSeen(msgId) {
		if(!msgId || seenMsgSet[msgId]) return false;  // false = already seen
		seenMsgSet[msgId] = 1;
		seenMsgIds.push(msgId);
		if(seenMsgIds.length > DEDUP_WINDOW) {
			delete seenMsgSet[seenMsgIds.shift()];
		}
		return true; // true = first time seen
	}

	// ── helpers ────────────────────────────────────────────────────────────────

	function _emit(name, data) {
		var set = listeners[name];
		if(set) { set.forEach(function(fn) { try { fn(data); } catch(_e) {} }); }
	}

	function _fire(name, detail) {
		try { window.dispatchEvent(new window.CustomEvent(name, {detail: detail || {}})); } catch(_e) {}
	}

	function _writeStatus(status) {
		if(status !== undefined) currentStatus = status;
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/collab/status",
			status: currentStatus,
			"room-code": roomCode,
			"lan-peers": String(Object.keys(directPeers).length),
			e2e: _e2eStrength
		}));
	}

	function _writeMember(dId, info) {
		var t = "$:/temp/collab/members/" + dId;
		if(info) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title:       t,
				"device-id":   dId,
				"device-name": info.deviceName || info.device_name || dId,
				"user-name":   info.userName   || info.user_name   || "",
				"user-color":  info.userColor  || info.user_color  || "",
				editing:       info.editing ? JSON.stringify(info.editing) : ""
			}));
		} else {
			$tw.wiki.deleteTiddler(t);
		}
	}

	// ── inbound relay frame router ──────────────────────────────────────────────
	// Decides what is allowed in cleartext (relay-origin control frames) and
	// decrypts everything else. Enforces anti-downgrade: a peer message that is
	// not the encrypted "enc" envelope is dropped.
	function _handleRelayFrame(msg) {
		if(!msg || typeof msg !== "object") { return; }
		if(msg.type === "enc") {
			_recvChain = _recvChain.then(function() {
				return _decryptRelay(msg).then(function(inner) {
					_handleMessage(inner);
				}).catch(function(e) {
					if(!_decryptWarned) {
						_decryptWarned = true;
						console.warn("[collab-e2e] decrypt failed (room token mismatch?):", e && e.message);
						$tw.wiki.addTiddler(new $tw.Tiddler({
							title: "$:/temp/collab/error",
							text:  "Could not decrypt a message from the room. Make sure every participant uses the same room token."
						}));
					}
				});
			});
			return;
		}
		if(RELAY_CONTROL[msg.type]) {
			_handleMessage(msg);
			return;
		}
		// Anti-downgrade: never act on cleartext peer content.
		console.warn("[collab-e2e] dropping unexpected cleartext message type:", msg.type);
	}

	// ── relay message handler (shared with LAN) ────────────────────────────────

	function _handleMessage(msg) {
		// Deduplicate data messages that travel both channels
		if(msg.msg_id && !_markSeen(msg.msg_id)) return;

		switch(msg.type) {

			case "joined":
			case "members":
				connected = true;
				_writeStatus("connected");
				// Relay sends members as an array of device ID strings.
				(msg.members || []).forEach(function(m) {
					var mId = (typeof m === "string") ? m : (m && m.deviceId);
					if(mId && mId !== deviceId) {
						var existing = memberInfo[mId] || {deviceId: mId, deviceName: mId, userName: "", userColor: ""};
						memberInfo[mId] = existing;
						_writeMember(mId, existing);
					}
				});
				_fire("collab-connected", {members: msg.members || []});
				_sendRelay({type: "request-state", deviceId: deviceId});
				// Broadcast our display info so peers can show our name/color.
				_sendRelay({type: "member-info", deviceId: deviceId, deviceName: deviceName, userName: userName, userColor: userColor});
				// Announce our LAN presence so existing peers can connect to us
				_sendLanAnnounce();
				break;

			case "member_joined":
				// Relay sends {type:"member_joined","deviceId":"..."} - no member object.
				var joinedId = msg.deviceId || (msg.member && msg.member.deviceId);
				if(joinedId && joinedId !== deviceId) {
					var joined = memberInfo[joinedId] || {deviceId: joinedId, deviceName: joinedId, userName: "", userColor: ""};
					memberInfo[joinedId] = joined;
					_writeMember(joinedId, joined);
					_fire("collab-member-joined", {member: joined});
					_emit("member_joined", {member: joined});
					// Reply with our info so the newcomer can show our name/color.
					_sendRelay({type: "member-info", deviceId: deviceId, deviceName: deviceName, userName: userName, userColor: userColor});
				}
				// Re-announce so the new member learns our LAN endpoints
				_sendLanAnnounce();
				break;

			case "member-info":
				if(msg.deviceId && msg.deviceId !== deviceId) {
					var info = memberInfo[msg.deviceId] || {deviceId: msg.deviceId};
					info.deviceName = msg.deviceName || msg.deviceId;
					info.userName   = msg.userName   || "";
					info.userColor  = msg.userColor  || "";
					memberInfo[msg.deviceId] = info;
					_writeMember(msg.deviceId, info);
				}
				break;

			case "member_left":
				var leftId = msg.deviceId;
				if(leftId && leftId !== deviceId) {
					var wasEditing = (memberEditing[leftId] || []).slice();
					delete memberInfo[leftId];
					delete memberEditing[leftId];
					delete peerSessions[leftId];
					if(directPeers[leftId]) {
						try { directPeers[leftId].ws.terminate(); } catch(_) {}
						delete directPeers[leftId];
						_writeStatus();
					}
					_writeMember(leftId, null);
					_fire("collab-member-left", {deviceId: leftId});
					_emit("member_left", {deviceId: leftId});
					wasEditing.forEach(function(title) {
						_emit("editing-stopped", {tiddler_title: title, device_id: leftId});
					});
				}
				break;

			case "lan-announce":
				// Peer has shared their X25519 public key and LAN endpoints via relay.
				// Derive session key and attempt a direct encrypted connection.
				if(msg.deviceId && msg.deviceId !== deviceId && msg.pubkey && msg.endpoints) {
					var sessionKey = _deriveSessionKey(msg.pubkey);
					if(sessionKey) {
						peerSessions[msg.deviceId] = {key: sessionKey};
						_tryLanConnect(msg.deviceId, msg.endpoints);
					}
				}
				break;

			case "editing-started":
				var esId = msg.device_id || msg.deviceId;
				if(esId && esId !== deviceId && msg.tiddler_title) {
					memberEditing[esId] = memberEditing[esId] || [];
					if(memberEditing[esId].indexOf(msg.tiddler_title) === -1) {
						memberEditing[esId].push(msg.tiddler_title);
					}
					if(memberInfo[esId]) {
						memberInfo[esId].editing = memberEditing[esId];
						_writeMember(esId, memberInfo[esId]);
					}
					_emit("editing-started", msg);
				}
				break;

			case "editing-stopped":
				var stId = msg.device_id || msg.deviceId;
				if(stId && msg.tiddler_title) {
					var arr = memberEditing[stId];
					if(arr) {
						var idx = arr.indexOf(msg.tiddler_title);
						if(idx !== -1) arr.splice(idx, 1);
					}
					if(memberInfo[stId]) {
						memberInfo[stId].editing = memberEditing[stId] || [];
						_writeMember(stId, memberInfo[stId]);
					}
					_emit("editing-stopped", msg);
				}
				break;

			case "collab-update":    _emit("collab-update",    msg); break;
			case "collab-awareness": _emit("collab-awareness", msg); break;
			case "peer-saved":       _emit("peer-saved",       msg); break;
			case "request-state":    _emit("request-state",    msg); break;

			case "error":
				// Relay rejected the join (e.g. wrong or missing room token).
				// Stop reconnecting and surface the error message to the user.
				_userWantsConnected = false;
				_terminalStatus = msg.message || "Connection rejected by server";
				break;

			default:
				// Forward unrecognised messages (e.g. sharing protocol) as a window event.
				_fire("collab-sharing-message", msg);
				break;
		}
	}

	// ── sending ────────────────────────────────────────────────────────────────

	// Send cleartext JSON to the relay. Reserved for the join handshake, which the
	// relay must read to route us into a room. Carries no wiki content or secrets.
	// readyState 1 = OPEN for both Node.js ws and the bridge shim.
	function _sendRelayRaw(data) {
		if(ws && ws.readyState === 1) {
			try { ws.send(JSON.stringify(data)); } catch(_e) {}
		}
	}

	// Send an end-to-end-encrypted message to the relay. Used for ALL peer-to-peer
	// content (collab updates, awareness, presence, sharing, chat, lan-announce).
	// Encryption is async (WebCrypto); _sendChain serialises it so wire order is
	// preserved. If no key is available we drop the message rather than leak it.
	function _sendRelay(data) {
		_sendChain = _sendChain.then(function() {
			if(!(ws && ws.readyState === 1)) { return; }
			return _encryptRelay(data).then(function(env) {
				if(ws && ws.readyState === 1) {
					try { ws.send(JSON.stringify(env)); } catch(_e) {}
				}
			}).catch(function(e) {
				console.error("[collab-e2e] encrypt/send failed:", e && e.message);
			});
		});
	}

	// Encrypt and send binary to all established LAN peers.
	function _sendLanAll(data) {
		if(!nodeCrypto) return;
		var json = JSON.stringify(data);
		Object.keys(directPeers).forEach(function(peerId) {
			var peer    = directPeers[peerId];
			var session = peerSessions[peerId];
			if(!peer || !session) return;
			try {
				peer.ws.send(_encryptFrame(session.key, Buffer.from(json, "utf8")));
			} catch(e) {
				console.warn("[collab-lan] Send to", peerId, "failed:", e.message);
				try { peer.ws.terminate(); } catch(_) {}
				delete directPeers[peerId];
				_writeStatus();
			}
		});
	}

	// Primary send: relay (covers non-LAN peers) + LAN fast path (encrypted direct).
	// Adds a msg_id so the receiving end deduplicates when both channels deliver.
	function _send(data) {
		var msg = data.msg_id ? data : _withMsgId(data);
		_sendRelay(msg);
		_sendLanAll(msg);
	}

	function _withMsgId(data) {
		var copy = {};
		var keys = Object.keys(data);
		for(var k = 0; k < keys.length; k++) { copy[keys[k]] = data[keys[k]]; }
		copy.msg_id = Math.random().toString(36).slice(2, 10);
		return copy;
	}

	// Broadcast our X25519 public key and LAN endpoints through the relay so peers
	// can derive the shared session key and attempt a direct connection.
	function _sendLanAnnounce() {
		if(!myKeyPair || !lanPort) return;
		_sendRelay({
			type:      "lan-announce",
			deviceId:  deviceId,
			pubkey:    myKeyPair.pubKeyB64,
			endpoints: lanEndpoints
		});
	}

	// ── relay WebSocket ────────────────────────────────────────────────────────

	function _scheduleReconnect() {
		if(destroyed || !_userWantsConnected) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(_connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 30000);
	}

	// Create a bridge-backed socket that mirrors the Node.js ws API.
	// Used when running in an nwdisable iframe where require("ws") is blocked;
	// wiki-file-window.js injects _nwjsWsCreate/Send/Terminate into this window.
	function _createBridgeSocket(url, headers) {
		var bridgeId = window._nwjsWsCreate(url, headers || {});
		console.log("[collab-transport] _createBridgeSocket id=" + bridgeId + " url=" + url);
		var listeners = {};
		var socket = {
			readyState: 0, // CONNECTING
			on: function(ev, fn) {
				if(!listeners[ev]) listeners[ev] = [];
				listeners[ev].push(fn);
			},
			send: function(data) {
				if(socket.readyState === 1) { window._nwjsWsSend(bridgeId, data); }
			},
			terminate: function() {
				socket.readyState = 3;
				window._nwjsWsTerminate(bridgeId);
			}
		};
		var prev = window._nwjsWsOnEvent;
		window._nwjsWsOnEvent = function(id, type, data) {
			console.log("[collab-transport] _nwjsWsOnEvent id=" + id + " type=" + type + " bridgeId=" + bridgeId);
			if(prev && id !== bridgeId) { prev(id, type, data); return; }
			if(id !== bridgeId) return;
			if(type === "open") {
				socket.readyState = 1;
				(listeners["open"] || []).forEach(function(fn) { try { fn(); } catch(_e) {} });
			} else if(type === "message") {
				(listeners["message"] || []).forEach(function(fn) { try { fn(data); } catch(_e) {} });
			} else if(type === "close") {
				socket.readyState = 3;
				(listeners["close"] || []).forEach(function(fn) { try { fn(); } catch(_e) {} });
			} else if(type === "error") {
				(listeners["error"] || []).forEach(function(fn) { try { fn({message: data}); } catch(_e) {} });
			}
		};
		return socket;
	}

	function _connect() {
		if(destroyed) return;
		var myGen = ++connectionGeneration;
		console.log("[collab-transport] _connect() gen=" + myGen + " hasBridge=" + (typeof window._nwjsWsCreate === "function") + " WS=" + !!WS + " relayUrl=" + relayUrl + " roomCode=" + roomCode + " authToken=" + !!authToken);
		_writeStatus("connecting");

		var wsUrl   = relayUrl.replace(/^http/, "ws").replace(/\/?$/, "") +
		              "/room/" + encodeURIComponent(roomCode);
		var headers = {};
		if(authToken) {
			headers["Authorization"] = "Bearer " + authToken;
			if(authProvider) { headers["X-Auth-Provider"] = authProvider; }
		}
		// The room token is deliberately NOT sent to the relay: it is the E2E
		// secret. Room access rests on the OAuth identity + room code, and content
		// is encrypted, so an unauthorized joiner only ever receives ciphertext.

		var hasBridge = typeof window._nwjsWsCreate === "function";
		if(!WS && !hasBridge) {
			// Bridge not yet injected; _nwjsWsBridgeReady will call _connect() when ready.
			_scheduleReconnect();
			return;
		}

		// Terminate any previous socket AFTER incrementing the generation so its
		// close handler sees a stale generation and returns early without re-triggering
		// reconnect. This prevents the cascade where each stale close spawns a new socket.
		if(ws) { var old = ws; ws = null; try { old.terminate(); } catch(_) {} }

		try {
			ws = WS ? new WS(wsUrl, {headers: headers}) : _createBridgeSocket(wsUrl, headers);
		} catch(e) {
			console.error("[collab-nwjs] WebSocket creation failed:", e.message);
			_scheduleReconnect();
			return;
		}

		ws.on("open", function() {
			if(myGen !== connectionGeneration) return;
			console.log("[collab-transport] relay WS opened, sending join");
			reconnectDelay = 1000;
			// Join is cleartext (the relay routes us by it) and carries no secrets
			// or display names — those are broadcast E2E-encrypted via member-info.
			_sendRelayRaw({type: "join", deviceId: deviceId});
			try { window.dispatchEvent(new CustomEvent("collab-relay-opened")); } catch(_e) {}
		});

		ws.on("message", function(data) {
			if(myGen !== connectionGeneration) return;
			var msg; try { msg = JSON.parse(data.toString()); } catch(_e) { return; }
			_handleRelayFrame(msg);
		});

		ws.on("close", function() {
			if(myGen !== connectionGeneration) return; // stale socket - ignore
			console.log("[collab-transport] relay WS closed, destroyed=" + destroyed);
			connected = false;
			if(_terminalStatus) {
				// Relay sent an error before closing - surface it, don't retry.
				var errMsg = _terminalStatus;
				_terminalStatus = null;
				_writeStatus("error");
				$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/error", text: errMsg}));
				_fire("collab-disconnected", {});
			} else {
				_writeStatus("disconnected");
				_fire("collab-disconnected", {});
				if(!destroyed) { _scheduleReconnect(); }
			}
		});

		ws.on("error", function(err) {
			if(myGen !== connectionGeneration) return; // stale socket - ignore
			var msg = (err && err.message) || "";
			console.error("[collab-nwjs] Relay WebSocket error:", msg);
			if(msg.indexOf("401") !== -1) {
				_writeStatus("auth-failed");
			} else if(msg.indexOf("403") !== -1) {
				_writeStatus("access-denied");
			}
		});
	}

	// ── collab API (used by codemirror-6-collab engine) ───────────────────────

	var collabAPI = {
		on:  function(ev, fn) { if(!listeners[ev]) listeners[ev] = new Set(); listeners[ev].add(fn); },
		off: function(ev, fn) { if(listeners[ev]) listeners[ev].delete(fn); },

		sendUpdate: function(title, b64) {
			_send({type: "collab-update", tiddler_title: title, update_base64: b64, device_id: deviceId});
		},
		sendAwareness: function(title, b64) {
			_send({type: "collab-awareness", tiddler_title: title, update_base64: b64, device_id: deviceId});
		},
		startEditing: function(title) {
			_send({type: "editing-started", tiddler_title: title, device_id: deviceId, device_name: deviceName});
		},
		stopEditing: function(title) {
			_send({type: "editing-stopped", tiddler_title: title, device_id: deviceId});
		},
		getRemoteEditors: function(title) {
			return Object.keys(memberEditing).filter(function(dId) {
				return memberEditing[dId].indexOf(title) !== -1;
			});
		},
		getRemoteEditorsAsync: function(title) {
			return Promise.resolve(this.getRemoteEditors(title));
		},
		getStatus:     function() { return connected ? "connected" : "disconnected"; },
		getMembers:    function() { return Object.keys(memberInfo).map(function(d) { return memberInfo[d]; }); },
		getLanPeers:   function() { return Object.keys(directPeers); },
		getDeviceId:   function() { return deviceId; },
		// Send an arbitrary JSON message through the relay + LAN (adds msg_id).
		send: function(data) { _send(data); }
	};

	window.TiddlyDesktop        = window.TiddlyDesktop || {};
	window.TiddlyDesktop.collab = collabAPI;
	_fire("collab-sync-activated", {});

	// Called by wiki-file-window.js after injecting the WS bridge into this iframe.
	// If the user already clicked Connect before the bridge was ready, retry now.
	window._nwjsWsBridgeReady = function() {
		if(_userWantsConnected && !connected && !destroyed) {
			_connect();
		}
	};

	// ── teardown / reconnect ───────────────────────────────────────────────────

	function _teardown() {
		destroyed = true;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		// close relay connection
		if(ws) { try { ws.terminate(); } catch(_) {} ws = null; }
		// close direct LAN peer connections (but keep the server running)
		Object.keys(directPeers).forEach(function(peerId) {
			try { directPeers[peerId].ws.terminate(); } catch(_) {}
		});
		// reset per-session state
		memberEditing = {}; memberInfo = {};
		peerSessions = {};  directPeers = {};
		seenMsgIds = [];    seenMsgSet = {};
		reconnectDelay = 1000;
		connected = false;  currentStatus = "";
		// reset E2E state (the key is re-derived on the next _startSession)
		_e2eKey = null; _e2eKeyRaw = null; _e2eStrength = "none";
		// clear status tiddlers
		$tw.wiki.deleteTiddler("$:/temp/collab/status");
		$tw.wiki.deleteTiddler("$:/temp/collab/error");
		$tw.wiki.filterTiddlers("[prefix[$:/temp/collab/members/]]").forEach(function(t) {
			$tw.wiki.deleteTiddler(t);
		});
	}

	function _startSession() {
		_readConfig();
		if(!relayUrl || !roomCode) return;
		if(!authToken) {
			_writeStatus("disconnected");
			return;
		}
		// Refuse to operate without content encryption rather than fall back to
		// transmitting wiki content in cleartext.
		if(!_subtle) {
			_writeStatus("error");
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/temp/collab/error",
				text:  "End-to-end encryption is unavailable in this environment (WebCrypto missing); refusing to connect."
			}));
			return;
		}
		destroyed = false;
		reconnectDelay = 1000;
		_decryptWarned = false;
		// Derive the room content key before connecting; the send/receive paths
		// await _e2eReady, so this need not block the connect itself.
		_deriveE2EKey();
		if(nodeCrypto && !lanServer) {
			myKeyPair = _generateKeyPair();
			_startLanServer();
		}
		_connect();
	}

	// Watch config tiddlers - reconnect immediately when settings change, but only
	// when the user has explicitly connected this session.
	$tw.wiki.addEventListener("change", function(changes) {
		var watched = [
			"$:/config/codemirror-6-collab/relay-url",
			"$:/config/codemirror-6-collab/room-code",
			"$:/config/codemirror-6-collab/auth-token",
			"$:/config/codemirror-6-collab/auth-provider",
			"$:/config/codemirror-6-collab/room-token",
			"$:/config/codemirror-6-collab/user-name",
			"$:/config/codemirror-6-collab/user-color",
			"$:/config/codemirror-6-collab/device-name"
		];
		if(_userWantsConnected && watched.some(function(t) { return changes[t]; })) {
			// Changing the room code means leaving the current room - disconnect
			// and require an explicit Connect click rather than auto-joining.
			if(changes["$:/config/codemirror-6-collab/room-code"]) {
				_userWantsConnected = false;
				_teardown();
			} else {
				// A room-token change re-keys the E2E layer for the same room;
				// reconnect transparently. _startSession re-derives the key.
				_teardown();
				_startSession();
			}
		}
	});

	// ── explicit connect / disconnect event handlers ───────────────────────────

	$tw.rootWidget.addEventListener("codemirror-6-collab-connect", function() {
		console.log("[collab-transport] connect event received, relayUrl=" + relayUrl + " hasBridge=" + (typeof window._nwjsWsCreate === "function"));
		_userWantsConnected = true;
		_teardown();
		_startSession();
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-disconnect", function() {
		_userWantsConnected = false;
		_teardown();
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-pagecontrols-click", function() {
		_readConfig();
		if(!relayUrl) {
			$tw.notifier.display("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/ui/notify/MissingRelayUrl");
			return false;
		}
		if(!roomCode) {
			$tw.notifier.display("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/ui/notify/MissingRoomCode");
			return false;
		}
		if(currentStatus === "connected" || currentStatus === "connecting") {
			_userWantsConnected = false;
			_teardown();
		} else {
			_userWantsConnected = true;
			_teardown();
			_startSession();
		}
		return false;
	});

	// ── init ── (no auto-connect; user must click Connect) ────────────────────
};

// ── module-level utilities (no closure needed) ─────────────────────────────────

function _cfg(key) {
	return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/" + key, "");
}

// Returns the persistent base device ID, generating and storing it if absent.
// Uses crypto-random bytes when available for unguessable identifiers.
// The caller appends an ephemeral session suffix so two simultaneously open
// windows of the same wiki file are seen as distinct peers.
function _ensureDeviceId(nodeCrypto) {
	var id = _cfg("device-id");
	if(!id) {
		id = "nwjs-" + (nodeCrypto
			? nodeCrypto.randomBytes(8).toString("hex")      // 64 bits, crypto-random
			: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/device-id", text: id}));
	}
	return id;
}
