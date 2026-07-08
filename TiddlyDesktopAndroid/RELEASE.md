# Releasing TiddlyDesktop (Android)

## Signing

The release build is signed by a keystore you own. **The same keystore + alias + passwords must be
reused for every release forever** — signing an update with a different key is rejected by Play and
breaks sideload updates. Never commit the keystore or its passwords.

`app/build.gradle.kts` reads the signing config from **`keystore.properties` (local)** or, if that
is absent, from **environment variables (CI)**. If neither is present the release build falls back to
debug signing, so forks/PRs still build.

### 1. Create the keystore (once)

Pick a strong password and keep it somewhere safe (a password manager). Run:

```sh
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias tiddlydesktop \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass 'YOUR_PASSWORD' -keypass 'YOUR_PASSWORD' \
  -dname "CN=TiddlyDesktop, O=TiddlyDesktop, C=US"
```

Store `release.keystore` outside the repo (it's git-ignored anyway).

### 2. Local signing — `keystore.properties`

Create `TiddlyDesktopAndroid/keystore.properties` (git-ignored):

```properties
storeFile=/absolute/path/to/release.keystore
storePassword=YOUR_PASSWORD
keyAlias=tiddlydesktop
keyPassword=YOUR_PASSWORD
```

### 3. CI signing — GitHub Actions

Base64-encode the keystore and add these **repository secrets**:

```sh
base64 -w0 release.keystore    # → paste as ANDROID_KEYSTORE_BASE64
```

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of `release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `tiddlydesktop` |
| `ANDROID_KEY_PASSWORD` | key password |

Workflow step (decode, then Gradle reads the env vars — note `ANDROID_KEYSTORE_FILE`):

```yaml
      - name: Decode keystore
        run: echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > "$RUNNER_TEMP/release.keystore"

      - name: Build signed release AAB
        env:
          ANDROID_KEYSTORE_FILE: ${{ runner.temp }}/release.keystore
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: ./gradlew :app:bundleRelease
```

## Build outputs

Prerequisites for a clean checkout (all git-ignored, so must be regenerated):

```sh
packaging/fetch-node-libs.sh     # downloads the Termux Node.js arm64 runtime → jniLibs/ (once, or to upgrade)
../bld.sh                        # repacks source/tiddlywiki (engine + plugins + translations)
sh packaging/build-wikilist.sh   # reassembles the WikiList folder wiki
```

Then:

```sh
./gradlew :app:assembleRelease   # signed APK  → app/build/outputs/apk/release/
./gradlew :app:bundleRelease     # signed AAB  → app/build/outputs/bundle/release/   (Play upload)
```

## CI

`.github/workflows/ci.yml` runs on `v*.*.*` tags. The **`build-android`** job builds the signed
AAB + APK in a separate step (fetches the Node runtime, builds the engine + WikiList, signs from the
CI secrets below) and uploads them as artifacts; the `release` job attaches the APK to the draft
GitHub release. Required repo **secrets** (see §3 above): `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them the
`build-android` job (and therefore the release) fails — set all four before tagging.

## Versioning

Bump both in `app/build.gradle.kts`:
- `versionName` — user-facing (e.g. `0.1.0`)
- `versionCode` — integer, **must strictly increase** every Play upload

## Native runtime

Node.js ships as prebuilt Termux binaries in `app/src/main/jniLibs/arm64-v8a/` (git-ignored) —
see that folder's `README.md`. Current: **Node v26.3.1**. arm64-v8a only.
