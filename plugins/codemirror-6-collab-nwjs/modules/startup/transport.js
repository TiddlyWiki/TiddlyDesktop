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

  Replay protection: each encrypted frame carries a monotonic per-sender sequence
  number, bound into the AES-GCM AAD (so the relay can't forge or renumber it).
  The receiver tracks the highest seq seen per sender and drops any frame at or
  below it, so a malicious relay cannot replay old frames — closing the gap left
  by the (bounded) msg_id dedup window for non-idempotent traffic like chat.

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
  (device id is random + ephemeral per window session, never persisted)
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

PEER AUTHENTICATION (relay-signed membership certificates)
  The relay validates an OAuth Bearer token at the WS upgrade, so every socket is
  an authenticated user. To let peers verify that end-to-end — instead of merely
  trusting the relay's routing — the relay also hands each connection a signed
  membership certificate: a compact JWS (ES256 over P-256) binding
  {room, user_id, username, provider, deviceId, iat, exp}. It travels in the
  relay-origin "identity" frame along with the relay's public verification key.

  Each client attaches its cert to the E2E-encrypted member-info it broadcasts;
  peers verify the relay's signature and that room/deviceId/exp match the sender,
  then mark that peer as a verified OAuth identity. When a room token is set
  (strong E2E mode), collaboration traffic from a peer is DROPPED until that peer
  is verified: a frame's sender deviceId is authenticated (relay AAD / LAN session
  key), and only a holder of the room token can produce valid AEAD content, so a
  malicious relay can neither forge a cert it could use nor splice in an
  unauthenticated participant. In room-code-only mode the relay holds the content
  key anyway, so certs are advisory (identities shown, not enforced); against an
  older relay that issues no cert, enforcement transparently disables.
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

	var relayUrl, roomCode, authToken, roomToken, deviceName, userName, userColor, relayOnly;

	// Fully-random, ephemeral device ID — generated fresh each time the wiki is
	// opened and NEVER persisted into the wiki. This is deliberate: the ID used to
	// be stored in $:/config/codemirror-6-collab/device-id, but single-file wikis
	// save that tiddler into the HTML, so cloning a wiki (copying its .html) made
	// both copies share the same ID. A relay that keys a room member by that ID
	// then conflates the two clients and misroutes messages, breaking sync in one
	// direction. A per-session random ID can never collide across clones or
	// windows. It is computed once here, so it stays stable across reconnects
	// within this window (reconnecting rejoins as the same member, not a new one).
	var deviceId = _generateDeviceId(nodeCrypto);
	// Our collaboration plugin version, broadcast in member-info so peers can warn
	// when versions differ (the wire protocol can change between builds).
	var pluginVersion = (($tw.wiki.getTiddler("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs") || {fields: {}}).fields.version) || "";
	// Expose our ephemeral device ID for the diagnostics panel. Temp tiddler →
	// not persisted, so it never gets saved into (and cloned with) the wiki.
	$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/device-id", text: deviceId}));

	// One-time cleanup: older builds (and clones of them) could leave a device id
	// stranded in the PERSISTED display-name config. That made every clone broadcast
	// the same "nwjs-…" name, so peers appeared identical in the member list even
	// though their real (routing) ids differ. A device id is never a valid name, so
	// drop it — the name then falls back to this session's unique id.
	(function() {
		var dn = $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/device-name", "");
		if(/^nwjs-[0-9a-f]{6,}$/i.test(dn)) {
			$tw.wiki.deleteTiddler("$:/config/codemirror-6-collab/device-name");
		}
	}());

	// The device-id tiddler and the member tiddlers are only DISPLAY mirrors of the
	// in-memory state (routing uses the deviceId variable / memberInfo map), so
	// deleting them can't break sync. But keep them honest: re-assert them if
	// something deletes them, from the authoritative in-memory state.
	$tw.wiki.addEventListener("change", function(changes) {
		if(changes["$:/temp/collab/device-id"] && changes["$:/temp/collab/device-id"].deleted) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/device-id", text: deviceId}));
		}
		Object.keys(changes).forEach(function(t) {
			if(!changes[t].deleted || t.indexOf("$:/temp/collab/members/") !== 0) { return; }
			var mId = t.slice("$:/temp/collab/members/".length);
			if(memberInfo[mId]) { _writeMember(mId, memberInfo[mId]); }
		});
	});

	var authProvider;

	// A stable, human-meaningful name for THIS machine — the OS hostname (from Node
	// in folder wikis, or the parent bridge in single-file wikis). Distinct across
	// machines even when the same wiki file is copied to both, and NOT stored in the
	// wiki, so it can never be cloned. Empty if unavailable.
	function _machineName() {
		try { if(nodeOs && nodeOs.hostname) { return nodeOs.hostname(); } } catch(e) {}
		try { if(window._nwjsHostname) { return String(window._nwjsHostname); } } catch(e) {}
		return "";
	}

	function _readConfig() {
		relayUrl     = _cfg("relay-url");
		roomCode     = _cfg("room-code");
		authToken    = _cfg("auth-token");
		authProvider = _cfg("auth-provider");
		roomToken    = _cfg("room-token");
		deviceName   = _cfg("device-name");
		// Never let a stranded device id masquerade as a display name (see cleanup
		// above). Fall back to the machine hostname — stable and distinct per machine
		// — and only to the opaque session id as a last resort.
		if(/^nwjs-[0-9a-f]{6,}$/i.test(deviceName)) { deviceName = ""; }
		deviceName   = deviceName || _machineName() || deviceId;
		userName     = _cfg("user-name") || $tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "") || $tw.wiki.getTiddlerText("$:/status/UserName") || "Anonymous";
		userColor    = _cfg("user-color") || "";
		relayOnly    = _cfg("relay-only") === "yes";
	}

	// ── runtime state ──────────────────────────────────────────────────────────

	// listeners survives reconnects so CM6 plugins don't need to re-register
	var listeners      = {};
	var memberEditing  = {};
	var memberInfo     = {};
	var ws             = null;
	var reconnectDelay = 1000;
	// Consecutive relay rejections (HTTP 401 at the WS upgrade). Reset to 0 on a
	// successful open. Used to break the "reconnect forever with a dead OAuth token"
	// loop after a machine sleep/long idle: past a few failures we stop and ask the
	// user to sign in again instead of hammering the relay.
	var _authFailures  = 0;
	var destroyed      = true;  // _startSession() sets false
	var connected      = false;
	var currentStatus  = "";
	// Wall-clock ms of the last frame/ping/pong heard from the relay. The liveness
	// watchdog uses it to detect a dead half-open socket (no close event) and reconnect.
	var lastRelayActivity = 0;
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
	// Single-file wikis (nwdisable iframe) run the LAN node in the parent process
	// via the bridge in wiki-file-window.js. _lanBridge true once we've handed the
	// parent our room key; _bridgeLanPeers mirrors the parent's LAN peer count.
	var _lanBridge      = false;
	var _bridgeLanPeers = 0;
	// Throttle for reflex (counter-)announces, which re-establish the LAN handshake
	// when we (re)join the LAN after a peer has already announced — e.g. after
	// turning "Relay only" back off. peerId -> last reflex time.
	var _lanReflexAt    = {};

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

	// Replay protection for the relay channel: a monotonic per-sender sequence
	// number, authenticated in the AES-GCM AAD so the relay cannot forge or
	// renumber it. _sendSeq increments for every encrypted frame we send and is
	// NOT reset across reconnects (deviceId is stable for the window's lifetime,
	// so the counter stays monotonic). _peerSeq tracks the highest seq accepted
	// from each sender; a frame at or below it is a replay and is dropped. This
	// closes the gap left by the msg_id dedup window (which only covers the last
	// DEDUP_WINDOW messages) against a relay replaying old chat/sharing frames.
	var _sendSeq = 0;
	var _peerSeq = {};

	// ── peer authentication (relay-signed membership certificates) ──────────────
	// The relay validates an OAuth token at the WS upgrade, so every socket is an
	// authenticated user. To let peers verify that *without* trusting the relay's
	// routing, the relay also issues each connection a signed certificate binding
	// {room, user, deviceId} (ES256 over P-256). We attach ours to member-info and
	// verify peers' certs against the relay's public key. In strong (room-token)
	// mode the relay cannot forge a cert AND valid AEAD content, so this makes
	// "only OAuth-authenticated peers exchange traffic" cryptographic, not trust.
	var _myCert         = null;  // our cert (header.payload.sig), from the relay
	var _relayVerifyKey = null;  // imported ECDSA P-256 WebCrypto key, or null
	var _relayJwkRaw    = null;  // JSON of the imported JWK, to skip re-imports
	var _relaySupportsCerts = false;            // relay issued an identity frame
	var _relayKeyReady  = Promise.resolve();    // resolves once the key is imported

	// ── private (1:1) messaging keys ────────────────────────────────────────────
	// Room-wide traffic is E2E-encrypted with the shared room key. For exclusive
	// 1:1 chat we additionally derive a PAIRWISE key via ECDH (P-256) between just
	// the two devices, so only the addressee can decrypt — other room members,
	// despite holding the room key, physically cannot read it. Each device makes an
	// ephemeral ECDH keypair and advertises its public half in member-info.
	var _dmKeyPair    = null;   // {privateKey: CryptoKey, publicJwk: {...}}
	var _dmReady      = Promise.resolve();
	var _dmGenerating = false;
	var _dmKeys       = {};     // peerDeviceId -> Promise<AES-GCM CryptoKey>

	// Message types exempt from the verified-sender requirement: relay-origin
	// control frames, and the bootstrap frames that *establish* verification
	// (member-info carries the cert; lan-announce only exchanges public keys).
	var AUTH_EXEMPT = {
		joined: 1, members: 1, member_joined: 1, member_left: 1, error: 1,
		identity: 1, "member-info": 1, "lan-announce": 1
	};

	// Relay-origin control frames are produced by the relay itself (which has no
	// key) and are therefore the only message types accepted in cleartext.
	var RELAY_CONTROL = {joined: 1, members: 1, member_joined: 1, member_left: 1, error: 1, identity: 1};

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

	// base64url (no padding) → Uint8Array, for the JWS-style membership certs.
	function _unb64url(s) {
		s = String(s).replace(/-/g, "+").replace(/_/g, "/");
		while(s.length % 4) { s += "="; }
		return _unb64(s);
	}

	// ── peer authentication helpers ─────────────────────────────────────────────

	// Import the relay's public verification key (JWK, ECDSA P-256). Idempotent —
	// only re-imports when the JWK actually changes.
	function _importRelayKey(jwk) {
		if(!jwk || !_subtle) { return; }
		_relaySupportsCerts = true;
		var serialized = JSON.stringify(jwk);
		if(serialized === _relayJwkRaw && _relayVerifyKey) { return; }
		_relayJwkRaw = serialized;
		_relayKeyReady = _subtle.importKey("jwk", jwk, {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"])
			.then(function(key) { _relayVerifyKey = key; })
			.catch(function(e) {
				console.warn("[collab-auth] relay key import failed:", e && e.message);
				_relayVerifyKey = null;
			});
	}

	// Verify a relay-issued membership certificate (compact JWS, ES256). Resolves
	// with the decoded payload when the signature and claims (room, deviceId, exp)
	// are valid, else null. The relay's room id is base64url(roomCode), which is
	// exactly what we put in the WS path, so we compare against _roomId(roomCode).
	function _verifyCert(cert, expectDeviceId) {
		if(!cert || !_subtle) { return Promise.resolve(null); }
		var parts = String(cert).split(".");
		if(parts.length !== 3) { return Promise.resolve(null); }
		var payload, sig;
		try {
			payload = JSON.parse(new TextDecoder().decode(_unb64url(parts[1])));
			sig = _unb64url(parts[2]);
		} catch(_e) { return Promise.resolve(null); }
		var data = new TextEncoder().encode(parts[0] + "." + parts[1]);
		// Wait for the key import so verification never races the relay's identity
		// frame, then verify the signature and the bound claims.
		return _relayKeyReady.then(function() {
			if(!_relayVerifyKey) { return null; }
			return _subtle.verify({name: "ECDSA", hash: "SHA-256"}, _relayVerifyKey, sig, data)
				.then(function(ok) {
					if(!ok) { return null; }
					var now = Math.floor(Date.now() / 1000);
					if(payload.room !== _roomId(roomCode)) { return null; }
					if(expectDeviceId && payload.did !== expectDeviceId) { return null; }
					if(typeof payload.exp === "number" && payload.exp < now) { return null; }
					return payload;
				});
		}).catch(function() { return null; });
	}

	// Enforce verified-peer-only traffic when we are in strong (room-token) E2E
	// mode AND the relay issues certs. In room-code-only mode the relay holds the
	// content key anyway, so dropping unverified traffic adds friction without
	// real security; against an older relay (no cert) _relayVerifyKey is null, so
	// enforcement transparently disables and behaviour is unchanged.
	function _enforceAuth() { return !!roomToken && _relaySupportsCerts; }

	function _isVerified(sid) { return !!(sid && memberInfo[sid] && memberInfo[sid].verified); }

	// True if a message of this type from `sid` must be dropped because the sender
	// is not (yet) a verified OAuth-authenticated peer.
	function _blockUnverified(type, sid) {
		return _enforceAuth() && !AUTH_EXEMPT[type] && !_isVerified(sid);
	}

	// Broadcast our display info, our membership cert, and our DM public key so
	// peers can show/verify our identity and set up an exclusive 1:1 channel.
	function _sendMemberInfo() {
		_sendRelay({type: "member-info", deviceId: deviceId, deviceName: deviceName, userName: userName, userColor: userColor, cert: _myCert, dmPub: _dmKeyPair && _dmKeyPair.publicJwk, ver: pluginVersion});
	}

	// ── private (1:1) end-to-end messaging ──────────────────────────────────────

	// Generate our ephemeral ECDH keypair once. Idempotent, so it survives
	// reconnects (our advertised DM public key stays stable for the window).
	function _initDmKeys() {
		if(_dmKeyPair || _dmGenerating || !_subtle) { return _dmReady; }
		_dmGenerating = true;
		_dmReady = _subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"])
			.then(function(kp) {
				return _subtle.exportKey("jwk", kp.publicKey).then(function(jwk) {
					_dmKeyPair = {privateKey: kp.privateKey, publicJwk: {kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y}};
					// If a peer already joined before our key was ready, re-announce.
					if(connected) { _sendMemberInfo(); }
				});
			})
			.catch(function(e) { console.warn("[collab-dm] keygen failed:", e && e.message); })
			.then(function() { _dmGenerating = false; });
		return _dmReady;
	}

	// Derive (and cache) the pairwise AES-GCM key shared with a peer: ECDH over the
	// two devices' DM keys → HKDF (bound to the room). Only the two holders of the
	// respective private keys can compute it. Resolves null if the peer hasn't
	// advertised a DM key yet.
	function _dmKeyFor(peerId) {
		if(_dmKeys[peerId]) { return _dmKeys[peerId]; }
		var info = memberInfo[peerId];
		var theirJwk = info && info.dmPub;
		if(!theirJwk || !_dmKeyPair || !_subtle) { return Promise.resolve(null); }
		var enc = new TextEncoder();
		var p = _subtle.importKey("jwk", theirJwk, {name: "ECDH", namedCurve: "P-256"}, false, [])
			.then(function(theirPub) { return _subtle.deriveBits({name: "ECDH", public: theirPub}, _dmKeyPair.privateKey, 256); })
			.then(function(shared) { return _subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]); })
			.then(function(ikm) { return _subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt: enc.encode("tiddlydesktop-collab-dm-v1"), info: enc.encode("room:" + roomCode)}, ikm, 256); })
			.then(function(bits) { return _subtle.importKey("raw", bits, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]); })
			.catch(function(e) { console.warn("[collab-dm] key derivation failed for " + peerId + ":", e && e.message); delete _dmKeys[peerId]; return null; });
		_dmKeys[peerId] = p;
		return p;
	}

	// Send a message encrypted exclusively for one peer. The pairwise ciphertext is
	// wrapped in the usual relay+LAN E2E layer too, so the relay sees only double
	// ciphertext. Resolves true if it was sent. The from/to pair is bound as AAD.
	function _sendPrivate(toDeviceId, obj) {
		if(!_subtle) { return Promise.resolve(false); }
		return _dmReady.then(function() { return _dmKeyFor(toDeviceId); }).then(function(key) {
			if(!key) { return false; }
			var enc = new TextEncoder();
			var iv  = window.crypto.getRandomValues(new Uint8Array(12));
			var aad = enc.encode(deviceId + ">" + toDeviceId);
			return _subtle.encrypt({name: "AES-GCM", iv: iv, additionalData: aad, tagLength: 128}, key, enc.encode(JSON.stringify(obj)))
				.then(function(ct) {
					_send({type: "dm", to: toDeviceId, from: deviceId, iv: _b64(iv), ct: _b64(new Uint8Array(ct))});
					return true;
				});
		}).catch(function(e) { console.warn("[collab-dm] send failed:", e && e.message); return false; });
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
	// The sender deviceId AND the monotonic sequence number both travel in
	// cleartext (the relay routes by deviceId) and are bound into the AAD, so the
	// relay can neither reattribute a frame nor renumber it to bypass the replay
	// check without breaking authentication.
	function _encryptRelay(obj) {
		var seq = _sendSeq++;   // grabbed synchronously, in _sendChain order
		return _e2eReady.then(function() {
			if(!_e2eKey) { throw new Error("no E2E key"); }
			var enc = new TextEncoder();
			var iv  = window.crypto.getRandomValues(new Uint8Array(12));
			var aad = enc.encode(deviceId + ":" + seq);
			return _subtle.encrypt(
				{name: "AES-GCM", iv: iv, additionalData: aad, tagLength: 128},
				_e2eKey, enc.encode(JSON.stringify(obj))
			).then(function(ctBuf) {
				return {type: "enc", v: 2, deviceId: deviceId, seq: seq, iv: _b64(iv), ct: _b64(new Uint8Array(ctBuf))};
			});
		});
	}

	function _decryptRelay(env) {
		return _e2eReady.then(function() {
			if(!_e2eKey) { throw new Error("no E2E key"); }
			var enc = new TextEncoder();
			var aad = enc.encode((env.deviceId || "") + ":" + env.seq);
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
				// If the server came up after the session was already connected (e.g.
				// "Relay only" was just switched off), announce so peers can re-handshake
				// the direct channel. At startup we aren't connected yet, so the normal
				// members/member_joined announce covers it.
				if(connected) { _sendLanAnnounce(); }
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
			// peerId is the authenticated sender (its LAN session key decrypted this).
			if(_blockUnverified(msg.type, peerId)) {
				console.warn("[collab-auth] dropping LAN " + msg.type + " from unverified peer " + peerId);
				return;
			}
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
			"lan-peers": String(nodeCrypto ? Object.keys(directPeers).length : _bridgeLanPeers),
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
				editing:       info.editing ? JSON.stringify(info.editing) : "",
				// Relay-verified OAuth identity (empty until the cert verifies).
				verified:      info.verified ? "yes" : "",
				"auth-user":   info.authUser   || "",
				version:       info.ver || ""
			}));
		} else {
			$tw.wiki.deleteTiddler(t);
		}
	}

	// Warn (once, in the sidebar) when any connected peer runs a different plugin
	// version than us — the wire protocol can change between builds.
	function _updateVersionWarning() {
		if(!pluginVersion) { return; }
		var bad = [];
		Object.keys(memberInfo).forEach(function(id) {
			var v = memberInfo[id].ver;
			if(v && v !== pluginVersion) {
				bad.push((memberInfo[id].userName || memberInfo[id].deviceName || id) + " (v" + v + ")");
			}
		});
		if(bad.length) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/temp/collab/version-warning",
				text:  "Version mismatch — you have v" + pluginVersion + " but these peers differ: " + bad.join(", ") + ". Sync may be unreliable; update everyone to the same build."
			}));
		} else {
			$tw.wiki.deleteTiddler("$:/temp/collab/version-warning");
		}
	}

	// Maintain $:/temp/collab/editing/<title> listing the OTHER members currently
	// editing that tiddler, so the edit-view banner can show "also editing: …"
	// without parsing per-member JSON. memberEditing only tracks peers (never
	// self), so these names are exactly the co-editors.
	function _writeEditingTitle(title) {
		var names = [];
		Object.keys(memberEditing).forEach(function(mId) {
			if((memberEditing[mId] || []).indexOf(title) === -1) { return; }
			var info = memberInfo[mId] || {};
			names.push(info.userName || info.deviceName || mId);
		});
		var t = "$:/temp/collab/editing/" + title;
		if(names.length) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: t, "tiddler-title": title, names: names.join(", "), count: String(names.length)}));
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
					// Replay protection: msg.seq was authenticated by the AAD during
					// decryption, so it genuinely belongs to this sender. Reject any
					// frame at or below the highest seq already accepted from them.
					var sid = msg.deviceId, seq = msg.seq;
					if(typeof seq === "number") {
						var last = _peerSeq[sid];
						if(last !== undefined && seq <= last) {
							console.warn("[collab-e2e] dropping replayed/stale frame from " + sid + " seq=" + seq + " (last seen " + last + ")");
							return;
						}
						_peerSeq[sid] = seq;
					}
					// Authenticated-peer enforcement: sid was bound into the AAD, so it
					// genuinely identifies the sender. Drop collaboration traffic from a
					// peer we have not verified as an OAuth-authenticated user.
					if(_blockUnverified(inner.type, sid)) {
						console.warn("[collab-auth] dropping relay " + inner.type + " from unverified peer " + sid);
						return;
					}
					// Returned promise (member-info cert verification) is awaited by the
					// chain, so a peer is verified before their next frame is gated.
					return _handleMessage(inner);
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
				var liveIds = {};
				(msg.members || []).forEach(function(m) {
					var mId = (typeof m === "string") ? m : (m && m.deviceId);
					if(mId && mId !== deviceId) {
						liveIds[mId] = true;
						var existing = memberInfo[mId] || {deviceId: mId, deviceName: mId, userName: "", userColor: ""};
						if(!existing.addedAt) { existing.addedAt = Date.now(); }
						memberInfo[mId] = existing;
						_writeMember(mId, existing);
					}
				});
				// Reconcile against the relay's authoritative member list: drop any
				// local entries that are no longer present (stale sessions that left
				// without a member_left, e.g. abrupt disconnects). Only prune when
				// the relay actually sent a members array, so a memberless "joined"
				// frame can't wipe everyone.
				if(Array.isArray(msg.members)) {
					Object.keys(memberInfo).forEach(function(mId) {
						if(!liveIds[mId]) {
							delete memberInfo[mId];
							delete memberEditing[mId];
							if(directPeers[mId]) { try { directPeers[mId].ws.terminate(); } catch(_) {} delete directPeers[mId]; }
							delete peerSessions[mId];
							delete _dmKeys[mId];
							_writeMember(mId, null);
						}
					});
				}
				_fire("collab-connected", {members: msg.members || []});
				// Send member-info (carrying our membership cert) FIRST, so peers can
				// verify us before our request-state arrives — an enforcing peer would
				// otherwise drop request-state from an as-yet-unverified sender.
				_sendMemberInfo();
				_sendRelay({type: "request-state", deviceId: deviceId});
				// Announce our LAN presence so existing peers can connect to us
				_sendLanAnnounce();
				break;

			case "member_joined":
				// Relay sends {type:"member_joined","deviceId":"..."} - no member object.
				var joinedId = msg.deviceId || (msg.member && msg.member.deviceId);
				if(joinedId && joinedId !== deviceId) {
					var joined = memberInfo[joinedId] || {deviceId: joinedId, deviceName: joinedId, userName: "", userColor: ""};
					if(!joined.addedAt) { joined.addedAt = Date.now(); }
					memberInfo[joinedId] = joined;
					_writeMember(joinedId, joined);
					_fire("collab-member-joined", {member: joined});
					_emit("member_joined", {member: joined});
					// Reply with our info + cert so the newcomer can show & verify us.
					_sendMemberInfo();
				}
				// Re-announce so the new member learns our LAN endpoints
				_sendLanAnnounce();
				break;

			case "identity":
				// The relay handed us our own membership cert and its public
				// verification key. Import the key (to verify peers) and re-broadcast
				// member-info so peers receive our now-available cert.
				if(msg.jwk) { _importRelayKey(msg.jwk); }
				if(msg.cert) {
					_myCert = msg.cert;
					if(connected) { _sendMemberInfo(); }
				}
				break;

			case "member-info":
				if(msg.deviceId && msg.deviceId !== deviceId) {
					var info = memberInfo[msg.deviceId] || {deviceId: msg.deviceId};
					info.heard      = true;   // a real, live peer (ghosts never send this)
					info.deviceName = msg.deviceName || msg.deviceId;
					info.userName   = msg.userName   || "";
					info.userColor  = msg.userColor  || "";
					info.ver        = msg.ver || "";
					_updateVersionWarning();
					// Peer's DM public key for exclusive 1:1 chat. If it changed (peer
					// reconnected with a fresh key), drop the cached pairwise key.
					if(msg.dmPub) {
						if(JSON.stringify(info.dmPub || null) !== JSON.stringify(msg.dmPub)) {
							delete _dmKeys[msg.deviceId];
						}
						info.dmPub = msg.dmPub;
					}
					memberInfo[msg.deviceId] = info;
					_writeMember(msg.deviceId, info);
					// Verify the relay-signed membership cert. Returned to the caller so
					// the relay recv-chain awaits it: the peer is marked verified before
					// any later frame from them is gated, closing the async-verify race.
					if(msg.cert) {
						var mId = msg.deviceId;
						return _verifyCert(msg.cert, mId).then(function(payload) {
							var cur = memberInfo[mId];
							if(!cur) { return; }
							cur.verified = !!payload;
							cur.authUser = payload ? (payload.prov + ":" + payload.name) : "";
							if(!payload) {
								console.warn("[collab-auth] membership cert from " + mId + " did not verify");
							}
							_writeMember(mId, cur);
						});
					}
				}
				break;

			case "member_left":
				var leftId = msg.deviceId;
				if(leftId && leftId !== deviceId) {
					var wasEditing = (memberEditing[leftId] || []).slice();
					delete memberInfo[leftId];
					delete memberEditing[leftId];
					delete peerSessions[leftId];
					delete _dmKeys[leftId];
					if(directPeers[leftId]) {
						try { directPeers[leftId].ws.terminate(); } catch(_) {}
						delete directPeers[leftId];
						_writeStatus();
					}
					_writeMember(leftId, null);
					_updateVersionWarning();
					_fire("collab-member-left", {deviceId: leftId});
					_emit("member_left", {deviceId: leftId});
					wasEditing.forEach(function(title) {
						_writeEditingTitle(title);
						_emit("editing-stopped", {tiddler_title: title, device_id: leftId});
					});
				}
				break;

			case "lan-announce":
				// Peer has shared their X25519 public key and LAN endpoints via relay.
				// Derive session key and attempt a direct encrypted connection.
				if(msg.deviceId && msg.deviceId !== deviceId && msg.pubkey && msg.endpoints) {
					if(nodeCrypto) {
						var sessionKey = _deriveSessionKey(msg.pubkey);
						if(sessionKey) {
							peerSessions[msg.deviceId] = {key: sessionKey};
							_tryLanConnect(msg.deviceId, msg.endpoints);
						}
					} else if(_lanBridge && typeof window._nwjsLanAddPeer === "function") {
						// Single-file wiki: the parent LAN node connects on our behalf.
						try { window._nwjsLanAddPeer(msg.deviceId, msg.pubkey, msg.endpoints); } catch(_e) {}
					}
					// Counter-announce so the peer gets our key too (needed when we just
					// (re)joined the LAN, e.g. after switching "Relay only" back off).
					_maybeReflexAnnounce(msg.deviceId);
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
					_writeEditingTitle(msg.tiddler_title);
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
					_writeEditingTitle(msg.tiddler_title);
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

			case "dm":
				// Exclusive 1:1 message, pairwise-encrypted so only the addressee can
				// read it. If it isn't for us we can't (and shouldn't) decrypt it.
				if(msg.to !== deviceId) { break; }
				var dmFrom = msg.from;
				return _dmKeyFor(dmFrom).then(function(key) {
					if(!key) { console.warn("[collab-dm] no key to decrypt DM from " + dmFrom); return; }
					var aad = new TextEncoder().encode(dmFrom + ">" + deviceId);
					return _subtle.decrypt({name: "AES-GCM", iv: _unb64(msg.iv), additionalData: aad, tagLength: 128}, key, _unb64(msg.ct))
						.then(function(pt) {
							var inner = JSON.parse(new TextDecoder().decode(pt));
							inner.private = true;
							inner.peerDeviceId = dmFrom;
							_fire("collab-sharing-message", inner);
						})
						.catch(function(e) { console.warn("[collab-dm] decrypt failed from " + dmFrom + ":", e && e.message); });
				});

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
		if(!nodeCrypto) {
			// Single-file wiki: hand the message to the parent LAN node.
			if(_lanBridge && typeof window._nwjsLanBroadcast === "function") {
				try { window._nwjsLanBroadcast(JSON.stringify(data)); } catch(_e) {}
			}
			return;
		}
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

	// On hearing a peer's announce, make sure they have OUR key too: the LAN server
	// handshake only accepts a peer once we hold their session key, so both sides
	// must announce. Peers that announced before we joined the LAN (e.g. because we
	// had "Relay only" on) won't re-announce on their own, so we counter-announce.
	// Throttled per peer, and skipped once a direct connection exists, to bound the
	// announce/counter-announce exchange.
	function _maybeReflexAnnounce(peerId) {
		if(relayOnly || !peerId) return;
		if(nodeCrypto && directPeers[peerId]) return;   // already connected (folder)
		var now = Date.now();
		if(_lanReflexAt[peerId] && now - _lanReflexAt[peerId] < 3000) return;
		_lanReflexAt[peerId] = now;
		_sendLanAnnounce();
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
			} else if(type === "ping") {
				(listeners["ping"] || []).forEach(function(fn) { try { fn(); } catch(_e) {} });
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
		// Set by this socket's error handler on a 401 upgrade rejection, read by its
		// close handler so we route a dead token through re-verification instead of
		// blindly reconnecting. Scoped to this _connect() call (one socket).
		var authFailedThisSocket = false;
		console.log("[collab-transport] _connect() gen=" + myGen + " hasBridge=" + (typeof window._nwjsWsCreate === "function") + " WS=" + !!WS + " relayUrl=" + relayUrl + " roomCode=" + roomCode + " authToken=" + !!authToken);
		_writeStatus("connecting");

		var wsUrl   = relayUrl.replace(/^http/, "ws").replace(/\/?$/, "") +
		              "/room/" + _roomId(roomCode);
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
			lastRelayActivity = Date.now();
			reconnectDelay = 1000;
			_authFailures = 0;   // a clean open clears any prior auth-failure streak
			// Join is cleartext (the relay routes us by it) and carries no secrets
			// or display names — those are broadcast E2E-encrypted via member-info.
			_sendRelayRaw({type: "join", deviceId: deviceId});
			try { window.dispatchEvent(new CustomEvent("collab-relay-opened")); } catch(_e) {}
		});

		ws.on("message", function(data) {
			if(myGen !== connectionGeneration) return;
			lastRelayActivity = Date.now();
			var msg; try { msg = JSON.parse(data.toString()); } catch(_e) { return; }
			_handleRelayFrame(msg);
		});

		// Liveness signals. The relay pings us periodically; ws auto-replies with a
		// pong and emits these events (bridge sockets forward "ping" too). Tracking
		// them lets the watchdog tell a live-but-idle link from a dead half-open one.
		ws.on("ping", function() { if(myGen === connectionGeneration) { lastRelayActivity = Date.now(); } });
		ws.on("pong", function() { if(myGen === connectionGeneration) { lastRelayActivity = Date.now(); } });

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
			} else if(authFailedThisSocket) {
				// The relay rejected our OAuth token (401) at the upgrade. Reconnecting
				// with the same dead token just spins (this is the post-sleep loop), so
				// don't. Hand off to the auth layer: it re-verifies the token over HTTP
				// and either reconnects (the 401 was transient) or signs out and prompts
				// re-login (the token genuinely expired). After a few consecutive auth
				// failures, stop entirely so a persistent problem can't loop forever.
				_writeStatus("auth-failed");
				_fire("collab-disconnected", {});
				if(_authFailures <= 3) {
					try { window.dispatchEvent(new CustomEvent("collab-auth-expired")); } catch(_e) {}
				} else {
					_userWantsConnected = false;
					$tw.wiki.addTiddler(new $tw.Tiddler({
						title: "$:/temp/collab/error",
						text:  "Session expired — please sign in again via the Account section."
					}));
				}
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
				authFailedThisSocket = true;
				_authFailures++;
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
		send: function(data) { _send(data); },
		// Send a message encrypted exclusively for one peer (pairwise E2E). Returns
		// a promise resolving true if it was delivered (the peer must have advertised
		// a DM key). Falls back to no-op false otherwise.
		sendPrivate: function(toDeviceId, data) { return _sendPrivate(toDeviceId, data); },
		// True if we have (or can derive) an exclusive channel with this peer.
		canDm: function(toDeviceId) { var m = memberInfo[toDeviceId]; return !!(m && m.dmPub && _dmKeyPair); }
	};

	window.TiddlyDesktop        = window.TiddlyDesktop || {};
	window.TiddlyDesktop.collab = collabAPI;
	_fire("collab-sync-activated", {});

	// Ghost-member reaper. The relay keeps a member in the room until its socket is
	// reaped, so a session that ended uncleanly lingers and is handed to every new
	// joiner — appearing as a peer that is really long gone (and, with ephemeral ids,
	// never reused). A REAL peer always sends its E2E member-info within a second of
	// joining; a ghost never can. So prune any member we've heard nothing from (no
	// member-info, no LAN session) after a grace period.
	var GHOST_GRACE_MS = 20000;
	setInterval(function() {
		if(!connected) { return; }
		var now = Date.now();
		Object.keys(memberInfo).forEach(function(id) {
			var m = memberInfo[id];
			if(m.heard || directPeers[id] || peerSessions[id]) { return; }
			if(m.addedAt && (now - m.addedAt) > GHOST_GRACE_MS) {
				console.warn("[collab] pruning ghost member (no member-info after grace): " + id);
				delete memberInfo[id]; delete memberEditing[id];
				delete peerSessions[id]; delete _dmKeys[id];
				if(directPeers[id]) { try { directPeers[id].ws.terminate(); } catch(_) {} delete directPeers[id]; }
				_writeMember(id, null);
				_writeStatus();
			}
		});
	}, 10000);

	// ── liveness watchdog: detect dead/half-open links and machine sleep ───────
	// The relay idle-closes us after 60s of silence and pings every 20s; ws auto-pongs
	// keep a live peer alive. But if the link goes half-open (sleep, NAT rebind, a brief
	// network drop) our pongs stop reaching the relay AND we may never get the close
	// event — leaving us "connected" with all sync dead and no reconnect. So we reconnect
	// ourselves when (a) the relay's pings stop arriving, or (b) the machine clearly slept.
	function _forceReconnect(reason) {
		if(destroyed || !_userWantsConnected) { return; }
		console.warn("[collab-transport] forcing reconnect: " + reason);
		connected = false;
		// _connect() bumps the generation and terminates the current socket (its stale
		// close handler no-ops), then opens a fresh one — healing both coarse and Yjs
		// sync, and re-firing collab-connected so subscriptions catch up.
		clearTimeout(reconnectTimer);
		reconnectDelay = 1000;
		_connect();
	}

	var WATCHDOG_MS = 15000;
	var STALE_MS    = 50000;             // <60s relay idle timeout; >2× the 20s ping
	var SLEEP_GAP_MS = WATCHDOG_MS + 30000;
	var lastWatchdogTick = Date.now();
	setInterval(function() {
		var now = Date.now();
		// If far more wall-clock elapsed than our interval, the machine was suspended;
		// sockets are very likely dead even without a close event. Reconnect on resume.
		var slept = (now - lastWatchdogTick) > SLEEP_GAP_MS;
		lastWatchdogTick = now;
		if(destroyed || !_userWantsConnected) { return; }
		if(slept && connected) { _forceReconnect("resumed from sleep/suspend"); return; }
		// A live relay pings us every ~20s; total silence past STALE_MS = dead link.
		if(connected && lastRelayActivity && (now - lastRelayActivity) > STALE_MS) {
			_forceReconnect("no relay activity for " + Math.round((now - lastRelayActivity) / 1000) + "s");
		}
	}, WATCHDOG_MS);

	// ── LAN heal: re-announce while any live peer still has no direct link ──────
	// A single lan-announce can be missed — the relay hiccups, a peer's LAN server
	// wasn't listening yet when we announced, a reconnect dropped the handshake, or
	// "Relay only" was toggled off after peers had already announced. Without a retry
	// the affected pair stays relay-only forever (issue #11). So while our LAN channel
	// is up, periodically re-announce as long as some known live peer is still not
	// directly connected. It self-limits: a fully meshed room has nothing pending and
	// sends nothing, and _tryLanConnect/_maybeReflexAnnounce no-op for peers already
	// connected, so this can't storm.
	var LAN_HEAL_MS = 12000;
	setInterval(function() {
		if(destroyed || !_userWantsConnected || relayOnly || !connected) { return; }
		// LAN must be up: folder wikis need a listening server; single-file the bridge.
		var lanUp = nodeCrypto ? (!!lanServer && !!lanPort) : _lanBridge;
		if(!lanUp) { return; }
		// Count live peers (those that sent member-info) and how many we have a direct
		// link to. Folder wikis track sockets in directPeers; single-file wikis run the
		// LAN node in the parent and only know the peer count (_bridgeLanPeers).
		var liveMembers = 0, connectedDirect = 0;
		Object.keys(memberInfo).forEach(function(id) {
			if(id === deviceId) { return; }
			var m = memberInfo[id];
			if(m && m.heard) { liveMembers++; if(directPeers[id]) { connectedDirect++; } }
		});
		if(liveMembers === 0) { return; }
		var pending = nodeCrypto ? (connectedDirect < liveMembers) : (_bridgeLanPeers < liveMembers);
		if(pending) { _sendLanAnnounce(); }
	}, LAN_HEAL_MS);

	// Network came back (e.g. after a drop or resume): the old socket is almost
	// certainly stale, so reconnect promptly rather than waiting for the watchdog.
	try {
		window.addEventListener("online", function() {
			if(_userWantsConnected && !destroyed) { _forceReconnect("network back online"); }
		});
	} catch(_e) {}

	// Called by wiki-file-window.js after injecting the WS bridge into this iframe.
	// If the user already clicked Connect before the bridge was ready, retry now.
	window._nwjsWsBridgeReady = function() {
		if(_userWantsConnected && !connected && !destroyed) {
			_connect();
		}
	};

	// ── LAN bridge (single-file wikis) ─────────────────────────────────────────
	// The iframe can't listen or run Node crypto, so the parent runs the LAN node
	// (wiki-file-window.js / lan-node.js). We hand it the room key and relay the
	// announce/peer/data plumbing. Failsafe: any problem just leaves us relay-only.
	function _initLanBridge() {
		if(nodeCrypto) return;                                  // folder wikis use _startLanServer
		if(destroyed || _lanBridge) return;
		if(typeof window._nwjsLanInit !== "function") return;   // bridge not injected yet
		if(!_e2eKeyRaw) return;                                 // need the room key first
		_lanBridge = true;
		var hex = "";
		for(var i = 0; i < _e2eKeyRaw.length; i++) { hex += ("0" + _e2eKeyRaw[i].toString(16)).slice(-2); }
		// Parent reports our pubkey + endpoints once its LAN server is listening.
		window._nwjsLanOnReady = function(pubKeyB64, endpoints) {
			if(!pubKeyB64) return;
			myKeyPair    = {pubKeyB64: pubKeyB64};
			lanEndpoints = endpoints || [];
			lanPort      = (lanEndpoints[0] && lanEndpoints[0].port) || 1;
			_sendLanAnnounce();
		};
		// A decrypted LAN data message from a peer (peerId = authenticated sender).
		window._nwjsLanOnMessage = function(peerId, json) {
			try {
				var msg = JSON.parse(json);
				if(_blockUnverified(msg.type, peerId)) {
					console.warn("[collab-auth] dropping LAN " + msg.type + " from unverified peer " + peerId);
					return;
				}
				_handleMessage(msg);
			} catch(_e) {}
		};
		// LAN peer count changed.
		window._nwjsLanOnPeers = function(n) {
			_bridgeLanPeers = n | 0;
			_writeStatus();
		};
		try { window._nwjsLanInit(hex, deviceId); } catch(_e) { _lanBridge = false; }
	}

	// Retry once the parent injects the LAN bridge (if Connect was clicked first).
	window._nwjsLanBridgeReady = function() {
		if(_userWantsConnected && !destroyed) { _e2eReady.then(_initLanBridge); }
	};

	// Start the LAN channel unless relay-only mode is enabled. Folder wikis run the
	// server in-process; single-file wikis run it in the parent via the bridge.
	function _startLanIfEnabled() {
		if(relayOnly) { return; }
		if(nodeCrypto) {
			if(!lanServer) { myKeyPair = _generateKeyPair(); _startLanServer(); }
		} else {
			_e2eReady.then(_initLanBridge);
		}
	}

	// Stop the LAN channel entirely (relay-only mode toggled on): close the server,
	// drop direct peers, and tear down the single-file parent LAN node.
	function _stopLan() {
		if(lanServer) { try { lanServer.close(); } catch(_) {} lanServer = null; }
		Object.keys(directPeers).forEach(function(pid) { try { directPeers[pid].ws.terminate(); } catch(_) {} });
		directPeers = {}; peerSessions = {};
		if(_lanBridge && typeof window._nwjsLanClose === "function") { try { window._nwjsLanClose(); } catch(_e) {} }
		_lanBridge = false; _bridgeLanPeers = 0;
		myKeyPair = null; lanPort = 0; lanEndpoints = [];
		_lanReflexAt = {};
		_writeStatus();
	}

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
		// close the parent-hosted LAN node (single-file wikis); re-created with the
		// fresh room key on the next _startSession.
		if(_lanBridge && typeof window._nwjsLanClose === "function") {
			try { window._nwjsLanClose(); } catch(_e) {}
		}
		_lanBridge = false; _bridgeLanPeers = 0;
		// reset per-session state
		memberEditing = {}; memberInfo = {};
		peerSessions = {};  directPeers = {};
		seenMsgIds = [];    seenMsgSet = {};
		// Drop our membership cert + relay key; the relay reissues/re-advertises on
		// the next connect, so capability is re-evaluated per session.
		_myCert = null; _relaySupportsCerts = false; _relayVerifyKey = null;
		_relayJwkRaw = null; _relayKeyReady = Promise.resolve();
		// Drop cached pairwise DM keys (peers differ next session); keep our own
		// keypair, which is ephemeral for the window's lifetime.
		_dmKeys = {};
		reconnectDelay = 1000;
		connected = false;  currentStatus = "";
		// reset E2E state (the key is re-derived on the next _startSession)
		_e2eKey = null; _e2eKeyRaw = null; _e2eStrength = "none";
		// clear status tiddlers
		$tw.wiki.deleteTiddler("$:/temp/collab/status");
		$tw.wiki.deleteTiddler("$:/temp/collab/error");
		$tw.wiki.filterTiddlers("[prefix[$:/temp/collab/members/]] [prefix[$:/temp/collab/editing/]]").forEach(function(t) {
			$tw.wiki.deleteTiddler(t);
		});
	}

	function _startSession() {
		_readConfig();
		if(!relayUrl || !roomCode) return;
		if(!authToken) {
			// Can't connect without an OAuth session. Surface it instead of failing
			// silently: a transient notification plus a persistent sidebar error.
			_writeStatus("disconnected");
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/temp/collab/error",
				text:  "Not signed in — sign in via the Account section before connecting."
			}));
			try { $tw.notifier.display("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/ui/notify/NotSignedIn"); } catch(_e) {}
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
		// Generate our pairwise (1:1) keypair so its public half rides along in the
		// member-info we broadcast on connect.
		_initDmKeys();
		_startLanIfEnabled();
		_connect();
	}

	// Watch config tiddlers - react when settings change, but only when the user
	// has explicitly connected this session. Connection-critical settings trigger
	// a reconnect; display-only settings (name/colour) just re-announce presence.
	$tw.wiki.addEventListener("change", function(changes) {
		if(!_userWantsConnected) { return; }
		var P = CONFIG_PREFIX;
		var roomChanged    = !!changes[P + "room-code"];
		var connChanged    = !!(changes[P + "relay-url"] || changes[P + "auth-token"]
			|| changes[P + "auth-provider"] || changes[P + "room-token"]);
		var displayChanged = !!(changes[P + "user-name"] || changes[P + "user-color"]
			|| changes[P + "device-name"]);

		// Relay-only toggle: start/stop the LAN channel in place, without dropping
		// the relay connection. Handled independently of the reconnect branches.
		if(changes[P + "relay-only"]) {
			relayOnly = _cfg("relay-only") === "yes";
			if(relayOnly) {
				_stopLan();
			} else if(connected || currentStatus === "connecting") {
				_startLanIfEnabled();
			}
		}

		if(roomChanged) {
			// Changing the room code means leaving the current room - disconnect
			// and require an explicit Connect click rather than auto-joining.
			_userWantsConnected = false;
			_teardown();
		} else if(connChanged) {
			// Relay URL / auth / room token affect the connection or the E2E key,
			// so reconnect transparently to the same room (_startSession re-reads
			// config and re-derives the key).
			_teardown();
			_startSession();
		} else if(displayChanged) {
			// Display name / colour are cosmetic — do NOT disconnect. Just re-read
			// config and re-announce our presence so peers' member lists update.
			// (Yjs cursor names update separately via collab.js's own user-name
			// watcher.)
			_readConfig();
			if(connected) {
				_sendMemberInfo();
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
		if(!authToken) {
			$tw.notifier.display("$:/plugins/tiddlywiki/codemirror-6-collab-nwjs/ui/notify/NotSignedIn");
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

// Derive the relay room identifier from the human-readable room code: base64url
// of its UTF-8 bytes. This is deterministic and identical on every client, so any
// room code — spaces, apostrophes, unicode, "Simon's Room", emoji — maps to a
// path segment the relay always accepts, regardless of the relay's own naming
// rules. The readable code is still used for display and E2E key derivation.
function _roomId(code) {
	try {
		var bytes = new TextEncoder().encode(String(code)), bin = "";
		for(var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
		return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	} catch(_e) {
		return encodeURIComponent(String(code));
	}
}

// Generate a fresh, fully-random, ephemeral device ID (128 bits). NOT persisted:
// a new ID is minted every time the wiki is opened, so two clones of the same
// wiki file can never share an ID. Prefers Node crypto, then WebCrypto (available
// even in the nwdisable iframe of single-file wikis), then Math.random.
function _generateDeviceId(nodeCrypto) {
	var hex;
	if(nodeCrypto && nodeCrypto.randomBytes) {
		hex = nodeCrypto.randomBytes(16).toString("hex");
	} else if(window.crypto && window.crypto.getRandomValues) {
		var arr = new Uint8Array(16);
		window.crypto.getRandomValues(arr);
		hex = Array.prototype.map.call(arr, function(b) { return ("0" + b.toString(16)).slice(-2); }).join("");
	} else {
		hex = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	}
	return "nwjs-" + hex;
}
