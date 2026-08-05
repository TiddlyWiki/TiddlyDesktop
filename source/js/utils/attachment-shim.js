/*
The attachment shim: rewrite an attachment's URL BEFORE the browser ever fetches it.

Why this exists as well as attachments.js
-----------------------------------------
attachments.js rewrites `src` attributes in the DOM, from the parent, after the wiki's load event.
That is always a SECOND attempt: TiddlyWiki has already rendered the tiddler, Chromium has already
tried the original `file://` or escaping-relative URL, and it has already failed — measured, on a
wiki whose images render at 253ms and whose rewrite could not run until 284ms, by which point both
images carried `tc-image-error` and `naturalWidth: 0`. The picture then appears when the rewritten
`src` loads. That flash of broken images is what this removes.

Nothing running in the parent can be early enough, because the parent's first hook on a document is
its load event. So the shim is injected into the wiki's HTML as it is SERVED, ahead of TiddlyWiki's
own scripts, and patches the two places a URL can be set:

  setAttribute("src"/"data")   what TiddlyWiki's image/audio/video/pdf widgets call
  the src/data IDL properties  what anything assigning el.src = … goes through

Both are synchronous and run before the element is inserted, so the original URL is never requested.

What it does NOT do
-------------------
It is not a security control, exactly as attachments.js is not. It runs inside the wiki, so a wiki
can uninstall it, and gains nothing by doing so: the attachment server trust-checks every request.
Its only job is to get the URL right the first time.

It also deliberately resolves NOTHING itself. It base64s the raw `_canonical_uri` and lets the
server resolve it against the wiki directory, so `..` handling, Windows drive letters and URI
decoding stay in one place (utils/attachments.js) rather than being reimplemented in browser JS
where they would drift.
*/

"use strict";

/*
	options.origin   the attachment origin
	options.base     the raw-URI route's base path, including its token

Returns JavaScript source for an inline <script>. ES5 only: it runs in the wiki's document, which
may be any vintage of TiddlyWiki, and it must not depend on anything the page provides.
*/
exports.source = function(options) {
	var origin = JSON.stringify(String(options.origin || "")),
		base = JSON.stringify(String(options.base || ""));

	return "(function(){\n" +
	"var ORIGIN=" + origin + ",BASE=" + base + ";\n" +
	"if(!ORIGIN||!BASE){return;}\n" +
	// src-bearing attribute per element, matching utils/attachments.js
	"var TAGS={IMG:'src',VIDEO:'src',AUDIO:'src',SOURCE:'src',EMBED:'src',IFRAME:'src',OBJECT:'data'};\n" +
	"function b64(s){try{\n" +
	"var b='',i,by;\n" +
	"if(typeof TextEncoder!=='undefined'){by=new TextEncoder().encode(s);for(i=0;i<by.length;i++){b+=String.fromCharCode(by[i]);}}\n" +
	"else{b=unescape(encodeURIComponent(s));}\n" +
	"return btoa(b);}catch(e){return null;}}\n" +
	/*
	Which values belong to the attachment server. A leading "/" is the wiki server's own routes
	(TiddlyWiki's /recipes/, /status, /files/) and must be left alone; so must anything already
	carrying a scheme, EXCEPT file:, which is the case that cannot load at all from an http page.
	Everything else is a wiki-relative attachment. Relative paths that stay inside the wiki would
	resolve on their own, but they are sent through the server too: it resolves them to the same
	file, and one rule is worth more here than a saved request.
	*/
	"function map(v){\n" +
	"if(v===null||v===undefined){return null;}\n" +
	"var s=String(v);\n" +
	"if(!s||s.charAt(0)==='/'||s.charAt(0)==='#'||s.charAt(0)==='?'){return null;}\n" +
	"if(s.indexOf(ORIGIN)===0){return null;}\n" +
	"if(!(/^file:\\/\\//i).test(s)&&(/^[a-z][a-z0-9+.-]*:/i).test(s)){return null;}\n" +
	"var enc=b64(s);\n" +
	"return enc?(ORIGIN+BASE+enc):null;}\n" +
	// 1. setAttribute — the path TiddlyWiki's widgets actually take
	"try{\n" +
	"var sa=Element.prototype.setAttribute;\n" +
	"Element.prototype.setAttribute=function(name,value){\n" +
	"try{var a=TAGS[this.tagName];\n" +
	"if(a&&String(name).toLowerCase()===a){var m=map(value);if(m){return sa.call(this,name,m);}}\n" +
	"}catch(e){}\n" +
	"return sa.apply(this,arguments);};\n" +
	"}catch(e){}\n" +
	// 2. the IDL properties, for anything that assigns el.src directly
	"try{\n" +
	"var props=[[window.HTMLImageElement,'src'],[window.HTMLMediaElement,'src'],\n" +
	"[window.HTMLIFrameElement,'src'],[window.HTMLEmbedElement,'src'],\n" +
	"[window.HTMLSourceElement,'src'],[window.HTMLObjectElement,'data']];\n" +
	"for(var i=0;i<props.length;i++){(function(ctor,name){\n" +
	"if(!ctor||!ctor.prototype){return;}\n" +
	"var d=Object.getOwnPropertyDescriptor(ctor.prototype,name);\n" +
	"if(!d||!d.set||!d.configurable){return;}\n" +
	"Object.defineProperty(ctor.prototype,name,{configurable:true,enumerable:d.enumerable,\n" +
	"get:d.get,set:function(v){var m=null;try{m=map(v);}catch(e){}return d.set.call(this,m||v);}});\n" +
	"})(props[i][0],props[i][1]);}\n" +
	"}catch(e){}\n" +
	/*
	3. Text attachments (.tid/.txt) never reach the DOM — wikiparser calls loadRemoteTiddler ->
	httpRequest -> XHR. Only file: URLs are redirected here: a RELATIVE XHR is how TiddlyWiki's own
	sync layer talks to its server (recipes/…, status), and sending those to the attachment origin
	would break saving.
	*/
	"try{\n" +
	"var xo=XMLHttpRequest.prototype.open;\n" +
	"XMLHttpRequest.prototype.open=function(method,url){\n" +
	"try{if((/^file:\\/\\//i).test(String(url))){var m=map(url);if(m){arguments[1]=m;}}}catch(e){}\n" +
	"return xo.apply(this,arguments);};\n" +
	"}catch(e){}\n" +
	"})();";
};

/*
Insert a <script> into an HTML document so it runs before anything already in the page.

Right after <head> when there is one, because a script placed before <head> is hoisted into the body
by the parser and would then run AFTER the head's own scripts — which is exactly what must not
happen. Falls back to after <html>, then to the very start.

Returns a Buffer. A document with no recognisable insertion point is returned untouched rather than
guessed at, which costs the flash but never a corrupted wiki.
*/
exports.inject = function(html, scriptSource) {
	var text = html.toString("utf8"),
		tag = "<script>" + scriptSource + "</script>",
		at = -1;
	var head = (/<head\b[^>]*>/i).exec(text);
	if(head) {
		at = head.index + head[0].length;
	} else {
		var htmlTag = (/<html\b[^>]*>/i).exec(text);
		if(htmlTag) {
			at = htmlTag.index + htmlTag[0].length;
		} else if((/<!doctype/i).test(text) === false) {
			at = 0;
		}
	}
	if(at < 0) { return html; }
	return Buffer.from(text.slice(0, at) + tag + text.slice(at), "utf8");
};
