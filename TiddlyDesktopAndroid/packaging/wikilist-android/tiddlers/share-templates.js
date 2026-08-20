/*\
title: $:/TiddlyDesktop/startup/share-templates.js
type: application/javascript
module-type: startup

Runs in the WikiList. Turns the native-enriched share metadata (window.TDHost.getShareData) into
a finished tiddler using a per-kind wikitext template, so shares become rich tiddlers (YouTube
embed, Wikipedia summary+image, Open-Graph article card, …). Templates are editable config
tiddlers ($:/config/TiddlyDesktop/ShareTemplates/<kind>) with {{$placeholders}}; users can also map
domains to a template kind via .../rules. Seeds sensible defaults on first run.

A template supplies the tiddler's title (share-title) as well as its body, both through the same
placeholders. Beside the shared page's own metadata there are GENERATED placeholders — a timestamp
and a random id — which exist mainly for the title: without one, sharing the same page twice makes
two tiddlers with the same title, and the importing wiki can only tell them apart by appending
" 2", " 3", … See generated().

\*/
"use strict";

exports.name = "td-share-templates";
exports.platforms = ["browser"]; // uses window.*; must NOT run on the Node --listen server
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function () {
	var PREFIX = "$:/config/TiddlyDesktop/ShareTemplates/";
	var DEFAULTS = {
		youtube: {
			text: '<iframe width="100%" height="315" src="{{$embed}}" frameborder="0" ' +
				'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
				'allowfullscreen></iframe>\n\n[[Watch on YouTube|{{$url}}]]\n',
			"share-title": "{{$title}}",
			"share-tags": "video shared"
		},
		wikipedia: {
			text: '<$reveal type="nomatch" text="" default="{{$image}}">[img width=220 [{{$image}}]]\n\n</$reveal>' +
				'{{$description}}\n\n[[Read on Wikipedia|{{$url}}]]\n',
			"share-title": "{{$title}}",
			"share-tags": "reference shared"
		},
		generic: {
			text: '<$reveal type="nomatch" text="" default="{{$image}}">[img width=320 [{{$image}}]]\n\n</$reveal>' +
				'{{$description}}\n\n<<< {{$siteName}}\n[[{{$url}}]]\n',
			"share-title": "{{$title}}",
			"share-tags": "shared"
		},
		image: { text: '[img[{{$url}}]]\n\n[[Source|{{$url}}]]\n', "share-title": "{{$title}}", "share-tags": "image shared" },
		text: { text: '{{$text}}\n', "share-title": "{{$title}}", "share-tags": "shared" }
	};

	// Seed editable defaults (persisted; edit them in the Share Templates settings tab).
	Object.keys(DEFAULTS).forEach(function (kind) {
		var title = PREFIX + kind;
		if (!$tw.wiki.tiddlerExists(title)) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: title, text: DEFAULTS[kind].text,
				"share-title": DEFAULTS[kind]["share-title"],
				"share-tags": DEFAULTS[kind]["share-tags"], "share-kind": kind,
				tags: "$:/tags/TiddlyDesktop/ShareTemplate"
			}));
		}
	});

	/*
	Placeholder values that don't come from the shared page. Computed ONCE per share so every
	placeholder in one tiddler — title and body alike — agrees on the same instant, and so a title
	and its body quote the same id.

	  timestamp  the TiddlyWiki UTC stamp (YYYYMMDDhhmmssmmm), identical in form to a tiddler's
	             created/modified field: unique to the millisecond and sorts chronologically as
	             plain text. The one to reach for when a title must not collide.
	  date/time  local, human-readable, for titles meant to be read rather than sorted. NOT unique
	             on their own — two shares in the same minute produce the same title.
	  uuid       12 random hex characters, for a title that must be unique without carrying a date.
	*/
	function generated() {
		var now = new Date(), id = "";
		try {
			var bytes = new Uint8Array(6);
			window.crypto.getRandomValues(bytes);
			for (var i = 0; i < bytes.length; i++) { id += ("0" + bytes[i].toString(16)).slice(-2); }
		} catch (e) {
			// No crypto (very old WebView): still unique enough to separate two shares.
			id = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
		}
		return {
			$now: now,
			timestamp: $tw.utils.stringifyDate(now),
			date: $tw.utils.formatDateString(now, "YYYY-0MM-0DD"),
			time: $tw.utils.formatDateString(now, "0hh:0mm"),
			uuid: id
		};
	}

	// {{$name}}, plus {{$now:FORMAT}} for any TiddlyWiki date format (e.g. {{$now:DDth MMM YYYY}}).
	// Generated values are looked up before the shared metadata, so what a template means by
	// {{$date}} cannot change if the native enricher ever grows a field of the same name.
	function subst(tpl, data, gen) {
		return String(tpl).replace(/\{\{\$(\w+)(?::([^}]*))?\}\}/g, function (_, k, fmt) {
			if (k === "now") { return $tw.utils.formatDateString(gen.$now, fmt || "YYYY-0MM-0DD 0hh:0mm"); }
			// gen also carries $now (the Date itself), but \w+ cannot match a $, so only the
			// string values are reachable from a placeholder.
			if (Object.prototype.hasOwnProperty.call(gen, k)) { return gen[k]; }
			return (data[k] != null) ? String(data[k]) : "";
		});
	}
	function domainOf(url) {
		var m = /^https?:\/\/([^\/]+)/.exec(url || "");
		return m ? m[1] : "";
	}
	function ruleKind(url) {
		var rules = $tw.wiki.getTiddlerText(PREFIX + "rules", ""), dom = domainOf(url), kind = null;
		rules.split("\n").forEach(function (line) {
			var eq = line.indexOf("=");
			if (eq > 0) {
				var d = line.slice(0, eq).trim(), k = line.slice(eq + 1).trim();
				if (d && k && dom.indexOf(d) !== -1) { kind = k; }
			}
		});
		return kind;
	}

	// Build the finished tiddler(s) for a share. Returns a JSON array string.
	window.__tdApplyShareTemplate = function (dataJson) {
		var data;
		try { data = JSON.parse(dataJson); } catch (e) { data = {}; }
		var kind = ruleKind(data.url) || data.kind || "generic";
		var tpl = $tw.wiki.getTiddler(PREFIX + kind) || $tw.wiki.getTiddler(PREFIX + "generic");
		var gen = generated();
		var text = subst((tpl && tpl.fields.text) || "{{$text}}", data, gen);
		var tags = (tpl && tpl.fields["share-tags"]) || "shared";
		// The title template is optional: templates seeded before it existed have no share-title,
		// and a template whose placeholders all resolve empty (a plain-text share has no title)
		// would otherwise produce a blank title. Both fall back to what this always used to do.
		var title = subst((tpl && tpl.fields["share-title"]) || "", data, gen).trim();
		if (!title) { title = data.title || data.url || "Shared"; }
		return JSON.stringify([{ title: title, text: text, tags: tags }]);
	};

	// Refresh the share picker's preview from the (possibly just-enriched) native data.
	window.__tdShareEnriched = function () {
		try {
			if (!window.TDHost) { return; }
			var data = JSON.parse(window.TDHost.getShareData() || "{}");
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/temp/TiddlyDesktop/share/title", text: data.title || "" }));
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/temp/TiddlyDesktop/share/image", text: data.image || "" }));
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/temp/TiddlyDesktop/share/kind", text: data.kind || "" }));
		} catch (e) {}
	};
};
