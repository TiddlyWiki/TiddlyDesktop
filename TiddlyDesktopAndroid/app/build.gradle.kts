import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing reads from a git-ignored keystore.properties (local dev) OR environment
// variables (CI), falling back to no release signing (→ debug-signed) when neither is present,
// so forks/PRs/CI-without-secrets still build. See RELEASE.md for the keytool command + CI secrets.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply { if (keystorePropsFile.exists()) FileInputStream(keystorePropsFile).use { load(it) } }
fun signingProp(key: String, env: String): String? =
    (keystoreProps.getProperty(key) ?: System.getenv(env))?.takeIf { it.isNotBlank() }

android {
    namespace = "com.tiddlywiki.tiddlydesktop"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tiddlywiki.tiddlydesktop"
        minSdk = 24
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.0"

        // We ship a prebuilt arm64 Node.js binary (libnode.so). Restrict ABIs to
        // those we actually provide native libs for. Add more only with matching binaries.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        create("release") {
            val storePath = signingProp("storeFile", "ANDROID_KEYSTORE_FILE")
            if (storePath != null) {
                storeFile = file(storePath)
                storePassword = signingProp("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingProp("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingProp("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            // Keep native debug symbols in debug builds.
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Sign with the release key when a keystore is configured; otherwise fall back to the
            // debug key so forks/PRs/CI-without-secrets still produce an installable APK (Play only
            // accepts the real release key, so a debug-signed build can't be uploaded anyway).
            val releaseSigning = signingConfigs.getByName("release")
            signingConfig = if (releaseSigning.storeFile != null) releaseSigning else signingConfigs.getByName("debug")
        }
    }

    // CRITICAL: extract native libs to the filesystem so libnode.so exists as a
    // real, executable file (you cannot exec() a lib packed inside the APK).
    packaging {
        jniLibs.useLegacyPackaging = true
        // The Termux node build links against versioned lib names; keep the first
        // match if multiple copies appear during merge.
        jniLibs.pickFirsts.add("**/libnode.so")
        jniLibs.pickFirsts.add("**/libc++_shared.so")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

// ── Asset packaging ─────────────────────────────────────────────────────────────
// Zips the TiddlyWiki engine and the WikiList folder wiki into src/main/assets so they
// can be extracted on first run (see node/NodeEnvironment.kt). Both are git-ignored.
//
// The engine location defaults to this repo's `source/tiddlywiki`; override with:
//   ./gradlew :app:assembleDebug -PtdEngineDir=/abs/path/to/tiddlywiki
val tdEngineDir = (findProperty("tdEngineDir") as String?) ?: "../../source/tiddlywiki"
val tdAssetsDir = layout.projectDirectory.dir("src/main/assets")

val packageTiddlyWikiAssets = tasks.register<Zip>("packageTiddlyWikiAssets") {
    val engine = file(tdEngineDir)
    onlyIf {
        val ok = engine.isDirectory && File(engine, "tiddlywiki.js").exists()
        if (!ok) logger.warn("packageTiddlyWikiAssets: engine not found at $engine — set -PtdEngineDir")
        ok
    }
    archiveFileName.set("tiddlywiki.zip")
    destinationDirectory.set(tdAssetsDir)
    // Entries become "tiddlywiki/…"; NodeEnvironment strips that prefix on extraction.
    from(engine) { into("tiddlywiki") }
    exclude("**/.git/**", "**/node_modules/**", "**/editions/*/output/**")
}

val packageWikiListAsset = tasks.register<Zip>("packageWikiListAsset") {
    val wikilist = layout.projectDirectory.dir("../packaging/wikilist").asFile
    onlyIf {
        val ok = wikilist.isDirectory
        if (!ok) logger.warn("packageWikiListAsset: ${wikilist} missing")
        ok
    }
    archiveFileName.set("wikilist.zip")
    destinationDirectory.set(tdAssetsDir)
    // Entries become "wikilist/…"; NodeEnvironment strips that prefix on extraction.
    from(wikilist) { into("wikilist") }
}

// The collab LAN fast-path helper (Route A): the shared lan-node.js + its only dependency `ws`
// + the Android stdin/stdout wrapper, run in a dedicated Node helper process (see
// node/LanNodeHelper.kt). Assembled from the single sources so lan-node.js never drifts from the
// desktop copy it must stay wire-compatible with. Absent → the app simply runs relay-only.
val packageLanHelper = tasks.register<Zip>("packageLanHelper") {
    val lanSrc = layout.projectDirectory.dir("lan").asFile          // lan-helper.js (this project)
    val lanNode = file("../../source/js/utils/lan-node.js")          // shared with desktop
    val wsDir = file("../../node_modules/ws")                        // dependency-free
    onlyIf {
        val ok = File(lanSrc, "lan-helper.js").exists() && lanNode.isFile && wsDir.isDirectory
        if (!ok) logger.warn("packageLanHelper: sources missing (lan/lan-helper.js, source/js/utils/lan-node.js, node_modules/ws) — collab LAN fast path will be absent; relay-only still works")
        ok
    }
    archiveFileName.set("lan.zip")
    destinationDirectory.set(tdAssetsDir)
    // Entries: lan-helper.js, lan-node.js, node_modules/ws/… (require("ws") resolves via node_modules).
    from(lanSrc) { include("lan-helper.js") }
    from(lanNode)
    from(wsDir) { into("node_modules/ws") }
    exclude("**/.git/**")
}

tasks.named("preBuild") {
    dependsOn(packageTiddlyWikiAssets, packageWikiListAsset, packageLanHelper)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("com.google.android.material:material:1.12.0")

    // Native HTTP + WebSocket client for the collab bridge (custom headers, CORS-free).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // ZIP extraction of the bundled TiddlyWiki resources on first run (java.util.zip
    // from the JDK is enough; no extra dep needed).
}
