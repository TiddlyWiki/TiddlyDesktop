/*
Register `tiddlydesktop://` as a custom URL-scheme handler for THIS app binary, so the OAuth
relay's post-login redirect (tiddlydesktop://auth?state=…) opens/focuses TiddlyDesktop.

NW.js has no cross-platform "set as default protocol client" API, so we do it per-OS:
  • Linux   — a NoDisplay .desktop file with MimeType=x-scheme-handler/tiddlydesktop, registered
              as the default via xdg-mime. Written at runtime so it points at the current binary
              (portable builds move around).
  • Windows — HKCU\Software\Classes\tiddlydesktop registry keys pointing at the current exe.
  • macOS   — declared in the app bundle's Info.plist (CFBundleURLTypes); LaunchServices picks it
              up from the bundle, so there is nothing to do at runtime.

All of this is best-effort and idempotent: failures are swallowed (the relay page still shows a
"return to the app" link, and sign-in completes via the relay result-polling regardless).
*/

"use strict";

var fs   = require("fs"),
	os   = require("os"),
	path = require("path"),
	cp   = require("child_process");

var DESKTOP_FILE_NAME = "tiddlydesktop-url-handler.desktop";

function registerLinux() {
	var exec = process.execPath;
	var appsDir = path.join(os.homedir(), ".local", "share", "applications");
	var file = path.join(appsDir, DESKTOP_FILE_NAME);
	var content = [
		"[Desktop Entry]",
		"Type=Application",
		"Name=TiddlyDesktop (URL handler)",
		"Exec=\"" + exec + "\" %u",
		"NoDisplay=true",
		"StartupNotify=false",
		"MimeType=x-scheme-handler/tiddlydesktop;",
		""
	].join("\n");
	fs.mkdirSync(appsDir, {recursive: true});
	var current = "";
	try { current = fs.readFileSync(file, "utf8"); } catch(e) {}
	if(current !== content) { fs.writeFileSync(file, content); }
	// Make it the default handler and refresh the desktop database. execFile (not a shell) so the
	// binary path can't be misinterpreted; ignore errors (tools may be absent).
	try { cp.execFile("xdg-mime", ["default", DESKTOP_FILE_NAME, "x-scheme-handler/tiddlydesktop"], function() {}); } catch(e) {}
	try { cp.execFile("update-desktop-database", [appsDir], function() {}); } catch(e) {}
}

function registerWindows() {
	var exec = process.execPath;
	var command = "\"" + exec + "\" \"%1\"";
	var base = "HKCU\\Software\\Classes\\tiddlydesktop";
	function reg(args) { try { cp.execFile("reg", args, {windowsHide: true}, function() {}); } catch(e) {} }
	reg(["add", base, "/ve", "/d", "URL:TiddlyDesktop Protocol", "/f"]);
	reg(["add", base, "/v", "URL Protocol", "/d", "", "/f"]);
	reg(["add", base + "\\shell\\open\\command", "/ve", "/d", command, "/f"]);
}

// Best-effort, idempotent. Safe to call on every startup.
exports.register = function() {
	try {
		if(process.platform === "linux") { registerLinux(); }
		else if(process.platform === "win32") { registerWindows(); }
		// macOS: handled by the bundle Info.plist (CFBundleURLTypes) — nothing to do.
	} catch(e) {
		try { console.error("[TiddlyDesktop] protocol registration failed:", e); } catch(_e) {}
	}
};
