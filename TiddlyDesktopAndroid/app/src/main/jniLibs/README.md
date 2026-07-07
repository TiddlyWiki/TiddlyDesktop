# jniLibs — native binaries (not checked in)

Android only executes binaries that live in the app's **native library dir**, so the
Node.js runtime ships here as `libnode.so`. These `.so` files are **git-ignored** (large,
prebuilt) — you must supply them before building.

## Required for `arm64-v8a/`

Copy a Termux-built Node.js (arm64) and its shared-library deps here, renaming the node
binary to `libnode.so`. Current: **Node v26.3.1** (Termux `nodejs 26.3.1`, ICU 78, OpenSSL 3.6).

```
app/src/main/jniLibs/arm64-v8a/
├── libnode.so          # the `node` executable, renamed
├── libcrypto.so        # from libcrypto.so.3
├── libssl.so           # from libssl.so.3
├── libz.so             # from libz.so.1
├── libicui18n.so       # from libicui18n.so.78
├── libicuuc.so         # from libicuuc.so.78
├── libicudata.so       # from libicudata.so.78
├── libsqlite3.so
├── libcares.so
├── libffi.so           # required since Node 26
└── libc++_shared.so
```

Verify a new node build with `readelf -d libnode.so | grep NEEDED`: every versioned name must
have an entry in `LIB_SYMLINKS` (NodeEnvironment.kt); every unversioned name (libcares.so,
libsqlite3.so, libffi.so, libc++_shared.so) must be present here as a real file. If the ICU or
OpenSSL soname major changes (e.g. `.so.78` → `.so.79`, `.so.3` → `.so.4`), update `LIB_SYMLINKS`.

Versioned names (`.so.3`, `.so.78`, …) are recreated at runtime via symlinks — see
`node/NodeEnvironment.kt` (`prepareLibrarySymlinks`). Android only packages files matching
`lib*.so`, which is why `node` must be renamed to `libnode.so`.

## Where to get them

TiddlyDesktop-RS bundles the same files under
`tiddlydesktop-rs/src-tauri/resources/node-bin/arm64-v8a/` — you can reuse those directly
(copy `node` → `libnode.so`, keep the rest). See
[`../../../README.md`](../../../README.md) → "Node.js integration" for the full rationale.

## Licenses

These are prebuilt binaries from a **Termux** build (`termux-packages`, Apache-2.0); each retains
its upstream license — Node.js (MIT; bundles V8 BSD-3-Clause, libuv MIT, …), OpenSSL
(`libcrypto`/`libssl`, Apache-2.0), ICU (`libicu*`, Unicode-3.0), zlib (`libz`, Zlib), SQLite
(`libsqlite3`, public domain), c-ares (`libcares`, MIT), libffi (`libffi`, MIT), and LLVM libc++
(`libc++_shared`, Apache-2.0 WITH LLVM-exception). Full attribution is in
[`../../../THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).

`packaging { jniLibs.useLegacyPackaging = true }` in `app/build.gradle.kts` ensures these
are extracted to the filesystem (executable) rather than left compressed inside the APK.
