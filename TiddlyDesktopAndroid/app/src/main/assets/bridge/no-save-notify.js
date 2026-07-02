/*
 * Suppress the "Starting to save wiki…" notification (the put/upload savers display
 * $:/language/Notifications/Save/Starting on every save). The "Saved wiki" done
 * notification is left intact. Injected into every wiki window.
 */
(function () {
	function patch() {
		if (!window.$tw || !$tw.notifier || !$tw.notifier.display) { setTimeout(patch, 150); return; }
		if ($tw.notifier.__tdPatched) { return; }
		$tw.notifier.__tdPatched = true;
		var orig = $tw.notifier.display.bind($tw.notifier);
		$tw.notifier.display = function (title, options) {
			if (title === "$:/language/Notifications/Save/Starting") { return; }
			return orig(title, options);
		};
	}
	patch();
})();
