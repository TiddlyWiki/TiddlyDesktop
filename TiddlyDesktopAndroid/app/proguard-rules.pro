# Keep @JavascriptInterface members reachable from the WebView bridge.
-keepclassmembers class com.tiddlywiki.tiddlydesktop.collab.CollabBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# OkHttp ships with these optional platform integrations; silence the warnings.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
