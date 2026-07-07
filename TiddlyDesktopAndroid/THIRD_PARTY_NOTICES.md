# Third-party notices — TiddlyDesktopAndroid

TiddlyDesktopAndroid redistributes the following third-party components. Each retains its own
license; the relevant copyright/permission notices are reproduced or referenced below. The app
itself is licensed under [`LICENSE`](LICENSE) (BSD-3-Clause — © Jeremy Ruston and TiddlyDesktop
contributors).

License texts referenced by SPDX id: **Apache-2.0**, **MIT**, **BSD-3-Clause**, **ISC**, **Zlib**,
**Unicode-3.0**, **Apache-2.0 WITH LLVM-exception**, and **public domain** are the standard,
unmodified texts of those licenses (see e.g. <https://spdx.org/licenses/>).

## Native runtime — `app/src/main/jniLibs/arm64-v8a/` (prebuilt `.so` files)

The Node.js runtime and its shared-library dependencies are compiled binaries taken from a
**Termux** build (the [`termux-packages`](https://github.com/termux/termux-packages) project,
Apache-2.0). Only the compiled binaries are redistributed; the Termux build scripts are not. Each
binary retains its upstream license:

| File | Component | Version | License |
| --- | --- | --- | --- |
| `libnode.so` | **Node.js** (the `node` executable, renamed) | 26.3.1 | **MIT**. Bundles, among others, **V8** (BSD-3-Clause), **libuv** (MIT), **llhttp** (MIT), **ada**/**simdutf** (Apache-2.0/MIT), **nghttp2** (MIT), **base64** (BSD-2-Clause). See Node's own `LICENSE`. |
| `libcrypto.so`, `libssl.so` | **OpenSSL** | 3.6 | **Apache-2.0** — © The OpenSSL Project Authors |
| `libicui18n.so`, `libicuuc.so`, `libicudata.so` | **ICU** | 78 | **Unicode-3.0** (ICU License) — © Unicode, Inc. |
| `libz.so` | **zlib** | — | **Zlib** — © Jean-loup Gailly and Mark Adler |
| `libsqlite3.so` | **SQLite** | — | **Public domain** |
| `libcares.so` | **c-ares** | — | **MIT** — © Daniel Stenberg and contributors |
| `libffi.so` | **libffi** | — | **MIT** (libffi license) — © Anthony Green and contributors |
| `libc++_shared.so` | **LLVM libc++** (Android NDK) | — | **Apache-2.0 WITH LLVM-exception** |

> Node itself is MIT; it embeds V8 (BSD-3-Clause) and other components under the licenses listed in
> the Node.js source `LICENSE` file — reproduced upstream at
> <https://github.com/nodejs/node/blob/main/LICENSE>.

## Bundled TiddlyWiki + JavaScript

| Component | Where | License |
| --- | --- | --- |
| **TiddlyWiki 5** — engine, plugins, themes, languages | `assets/tiddlywiki.zip`, `assets/wikilist.zip` (built from `../source/tiddlywiki`, `../plugins`, `../themes`) | **BSD-3-Clause** — © Jeremy Ruston, UnaMesa Association |
| **pdf.js** — inline PDF rendering | `app/src/main/assets/pdfjs/pdf.min.js`, `pdf.worker.min.js` (v3.11.174) | **Apache-2.0** — © Mozilla Foundation. The full notice is retained in the file headers. |
| **ws** — WebSocket (Node) | bundled into `lan.zip` with the LAN collab helper | **MIT** — © Einar Otto Stangvik and contributors |
| **CodeMirror 6**, **Yjs** and related collab/editor libraries | inside the bundled TiddlyWiki plugins (when installed in a wiki) | **MIT** |

## Android / Kotlin libraries (compiled into the APK)

| Library | License |
| --- | --- |
| Kotlin standard library | **Apache-2.0** — © JetBrains s.r.o. and contributors |
| AndroidX `core-ktx`, `appcompat`, `activity-ktx`, `webkit`, `documentfile` | **Apache-2.0** — © The Android Open Source Project |
| Google Android **Material Components** | **Apache-2.0** |
| **OkHttp** (+ **Okio**) | **Apache-2.0** — © Square, Inc. |

## Notes

- **Apache-2.0 components** (pdf.js, OpenSSL, libc++, OkHttp, AndroidX, Kotlin, Material) require
  their license and any `NOTICE` to be preserved: pdf.js keeps its header in the bundled `.js`; the
  others are standard published binaries whose license/NOTICE files are distributed with the
  upstream artifacts.
- **No source modifications** are made to any of the above — they are used as-is.
- Full, unmodified license texts are available from each project and via SPDX
  (<https://spdx.org/licenses/>).
