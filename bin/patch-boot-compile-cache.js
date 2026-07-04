#!/usr/bin/env node
/*
Injects a persistent V8 compile cache into a TiddlyWiki boot.js.

TiddlyWiki compiles every module tiddler from source on every boot via vm.runInContext (no code
cache), which dominates Node startup — badly on Android's slower ARM cores. This patch makes that
call reuse V8 cachedData persisted on disk (keyed by module content + V8 version), so after the
first boot each module is deserialized instead of re-parsed/compiled.

Fully fail-safe: enabled only when TW_COMPILE_CACHE_DIR is set; any error (unwritable dir, corrupt
or version-mismatched cache, missing crypto) silently falls back to a plain vm.runInContext, so a
patched boot.js behaves exactly like an unpatched one when caching can't work. Idempotent; if the
anchor strings aren't found (upstream boot.js changed) it warns and leaves the file untouched.

Usage: node bin/patch-boot-compile-cache.js <path/to/boot.js>
*/
"use strict";

var fs = require("fs");

var file = process.argv[2];
if(!file) { console.error("patch-boot-compile-cache: missing boot.js path"); process.exit(1); }

var src = fs.readFileSync(file, "utf8");

if(src.indexOf("runInContextCached") !== -1) {
	console.log("patch-boot-compile-cache: already patched, skipping");
	process.exit(0);
}

var anchorDef = "$tw.utils.evalGlobal = function(code,context,filename,sandbox,allowGlobals) {";
var anchorCall = "fn = vm.runInContext(code,sandbox,filename);";

if(src.indexOf(anchorDef) === -1 || src.indexOf(anchorCall) === -1) {
	console.warn("patch-boot-compile-cache: anchors not found (boot.js changed upstream?) — leaving unpatched; TiddlyWiki will just recompile modules as before");
	process.exit(0);
}

// The injected helper. Node-only, lazy-initialised, and it degrades to vm.runInContext on ANY
// problem so it can never break boot.
var helper = [
	"// --- TiddlyDesktop: persistent V8 compile cache for module tiddlers (see bin/patch-boot-compile-cache.js) ---",
	"var _twCompileCache; // undefined = uninitialised, null = disabled, object = enabled",
	"$tw.utils.runInContextCached = function(code,sandbox,filename) {",
	"\tif(_twCompileCache === undefined) {",
	"\t\t_twCompileCache = null;",
	"\t\ttry {",
	"\t\t\tvar _dir = process.env.TW_COMPILE_CACHE_DIR;",
	"\t\t\tif(_dir && !$tw.browser) {",
	"\t\t\t\tvar _fs = require(\"fs\"), _path = require(\"path\"), _crypto = require(\"crypto\");",
	"\t\t\t\tvar _vdir = _path.join(_dir, \"v8-\" + ((process.versions && process.versions.v8) || \"x\"));",
	"\t\t\t\ttry { _fs.mkdirSync(_vdir, {recursive: true}); } catch(e) {}",
	"\t\t\t\t_twCompileCache = {fs: _fs, path: _path, crypto: _crypto, dir: _vdir};",
	"\t\t\t}",
	"\t\t} catch(e) { _twCompileCache = null; }",
	"\t}",
	"\tif(!_twCompileCache) { return vm.runInContext(code,sandbox,filename); }",
	"\ttry {",
	"\t\tvar _key = _twCompileCache.crypto.createHash(\"sha1\").update(code).digest(\"hex\");",
	"\t\tvar _file = _twCompileCache.path.join(_twCompileCache.dir, _key + \".vmc\");",
	"\t\tvar _cached;",
	"\t\ttry { _cached = _twCompileCache.fs.readFileSync(_file); } catch(e) {}",
	"\t\tvar _script = new vm.Script(code, {filename: filename, cachedData: _cached || undefined, produceCachedData: !_cached});",
	"\t\tvar _result = _script.runInContext(sandbox);",
	"\t\tif(!_cached && _script.cachedDataProduced && _script.cachedData) {",
	"\t\t\ttry { _twCompileCache.fs.writeFileSync(_file, _script.cachedData); } catch(e) {}",
	"\t\t}",
	"\t\treturn _result;",
	"\t} catch(e) {",
	"\t\treturn vm.runInContext(code,sandbox,filename);",
	"\t}",
	"};",
	""
].join("\n");

src = src.replace(anchorDef, helper + anchorDef);
src = src.replace(anchorCall, "fn = $tw.utils.runInContextCached(code,sandbox,filename);");

fs.writeFileSync(file, src);
console.log("patch-boot-compile-cache: injected compile cache into " + file);
