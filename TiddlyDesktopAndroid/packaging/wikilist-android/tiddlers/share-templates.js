/*\
title: $:/TiddlyDesktop/startup/share-templates.js
type: application/javascript
module-type: startup

Runs in the WikiList. Turns the native-enriched share metadata (window.TDHost.getShareData) into
a finished tiddler using a per-kind wikitext template, so shares become rich tiddlers (YouTube
embed, Wikipedia summary+image, Open-Graph article card, …). Templates are editable config
tiddlers ($:/config/TiddlyDesktop/ShareTemplates/<kind>) with {{$placeholders}}; users can also map
domains to a template kind via .../rules. Seeds sensible defaults on first run.

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
			"share-tags": "video shared"
		},
		wikipedia: {
			text: '<$reveal type="nomatch" text="" default="{{$image}}">[img width=220 [{{$image}}]]\n\n</$reveal>' +
				'{{$description}}\n\n[[Read on Wikipedia|{{$url}}]]\n',
			"share-tags": "reference shared"
		},
		generic: {
			text: '<$reveal type="nomatch" text="" default="{{$image}}">[img width=320 [{{$image}}]]\n\n</$reveal>' +
				'{{$description}}\n\n<<< {{$siteName}}\n[[{{$url}}]]\n',
			"share-tags": "shared"
		},
		image: { text: '[img[{{$url}}]]\n\n[[Source|{{$url}}]]\n', "share-tags": "image shared" },
		text: { text: '{{$text}}\n', "share-tags": "shared" }
	};

	// Seed editable defaults (persisted; edit them in the Share Templates settings tab).
	Object.keys(DEFAULTS).forEach(function (kind) {
		var title = PREFIX + kind;
		if (!$tw.wiki.tiddlerExists(title)) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: title, text: DEFAULTS[kind].text,
				"share-tags": DEFAULTS[kind]["share-tags"], "share-kind": kind,
				tags: "$:/tags/TiddlyDesktop/ShareTemplate"
			}));
		}
	});

	function subst(tpl, data) {
		return String(tpl).replace(/\{\{\$(\w+)\}\}/g, function (_, k) {
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
		var text = subst((tpl && tpl.fields.text) || "{{$text}}", data);
		var tags = (tpl && tpl.fields["share-tags"]) || "shared";
		var title = data.title || data.url || "Shared";
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
