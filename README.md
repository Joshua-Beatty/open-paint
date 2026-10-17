# OpenPaint

A browser-based, layer-based raster image editor. TypeScript + React app shell, WebGPU rendering, and Rust/WebAssembly CPU kernels. It is an installable, offline-capable Progressive Web App with no backend. Your images stay in your browser.

License: [MIT](LICENSE). The bundled third-party components and their licenses are listed in [`THIRD-PARTY-NOTICES.txt`](#third-party-notices) and in the About dialog.

## Requirements

- The toolchain pinned in `mise.toml`: Node 26, pnpm 10, Rust stable with the `wasm32-unknown-unknown` target, wasm-pack and wasm-opt. Run `mise install` to get them.
- A browser with WebGPU for the GPU path. Where WebGPU is missing, the engine uses the CPU (WebAssembly) path. The end-to-end suite runs on Chromium, Firefox and WebKit.
- The project is developed on Windows 11 with PowerShell.

## Setup

```sh
mise install
pnpm install
pnpm build:wasm   # builds the Rust/WASM kernels; needed before typecheck and tests
```

## Development

```sh
pnpm dev
```

This starts the Vite dev server for `apps/web` (http://localhost:5173 by default). The dev server sends the same cross-origin isolation headers as production, so threaded WASM behaves as it does when deployed. Its Content-Security-Policy adds the dev-only allowances for the React Refresh preamble and the HMR socket.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm build` | Build the WASM crate, typecheck, then build all packages and the web app into `apps/web/dist` |
| `pnpm build:wasm` | wasm-pack build of `crates/opaint-cpu` (needed before `typecheck` and `test`) |
| `pnpm dev` | Dev server for `apps/web` |
| `pnpm --filter @openpaint/web preview` | Serves the production build from `apps/web/dist` with the production headers |
| `pnpm test` | Vitest unit and integration tests. GPU tests skip when WebGPU is not available |
| `pnpm test:rust` | `cargo test` for the Rust crates |
| `pnpm test:e2e` | Playwright end-to-end tests against the built app. First run `pnpm --filter @openpaint/web exec playwright install chromium` |
| `pnpm test:golden` | Browser golden tests for the WebGPU shaders (skip without an adapter) |
| `pnpm lint` | Biome lint and format check |
| `pnpm lint:rust` | `cargo clippy -D warnings` for the Rust crates |
| `pnpm format` | Format with Biome |
| `pnpm typecheck` | TypeScript project-reference build |
| `pnpm verify` | Everything required before committing: lint, clippy, Rust tests, WASM build, typecheck and unit tests |

## Production build

```sh
pnpm build
```

`apps/web/dist` is the complete static site. It contains:

- `index.html` with the Content-Security-Policy as a `<meta>` tag, so the policy applies even on a host that sends no headers.
- `assets/`: hashed JavaScript, CSS, WASM codecs and the bundled fonts. All of them are self-hosted.
- `sw.js` and `manifest.webmanifest`: the service worker and the web app manifest.
- `icon.svg`, `THIRD-PARTY-NOTICES.txt` and `_headers` (see below).

The build fails if the output would load anything from another origin, or if `index.html` points at a file that is not in the output. The app loads no resources from a CDN. The only remote requests are the ones a user starts, such as dropping an image address into the app.

## Deploying

The app is plain static files. Any host that serves a directory works, with three requirements:

1. **Cross-origin isolation headers on every response.** OpenPaint needs `SharedArrayBuffer` for threaded WASM, and browsers only expose it to a cross-origin isolated page:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   With `require-corp`, every resource the page loads must be same-origin, which is true here because everything is self-hosted. Without these headers the app still runs, but it uses single-threaded WASM (WEB-ENV-05).
2. **HTTPS**, because the service worker (offline use and installation) only runs on a secure origin. `localhost` is exempt.
3. **The Content-Security-Policy header** (optional, since the page already carries it as a `<meta>` tag). Sending the header also enables `frame-ancestors 'none'`, which a meta tag cannot set.

### Hosts that read `_headers` (Netlify, Cloudflare Pages)

The build writes `_headers` into the output root with the isolation and policy headers, plus cache rules. Point the host at `apps/web/dist` and it applies them. The cache rules are:

- `index.html` and `sw.js` use `Cache-Control: no-cache`, so a new deployment is picked up.
- `assets/*` is cached for a year, since file names are content hashes.

### Other hosts

Add the same headers in the server configuration.

nginx:

```nginx
server {
    root /var/www/openpaint;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    # Paste the Content-Security-Policy value from dist/_headers here.
    add_header Content-Security-Policy "<policy from dist/_headers>" always;

    location = /sw.js        { add_header Cache-Control "no-cache" always; }
    location = /index.html   { add_header Cache-Control "no-cache" always; }
    location /assets/        { add_header Cache-Control "public, max-age=31536000, immutable" always; }
    location / { try_files $uri $uri/ /index.html; }
}
```

Apache (with `mod_headers`) can set the same headers in the virtual host or `.htaccess`:

```apache
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
Header always set Content-Security-Policy "<policy from dist/_headers>"
```

Serve `.wasm` as `application/wasm`. Most servers already do.

GitHub Pages cannot set custom headers. The app still loads there, but without cross-origin isolation it runs single-threaded. Use a host that sets headers if threaded WASM matters to you.

### Updates

A new deployment is a new build. The app notices the updated service worker and shows an "Update available" notice. It does not reload while there is unsaved work (WEB-UPD-01). Each build has its own precache, and the old one is removed when the new one activates.

## Offline use

After the first visit, the service worker precaches the app shell, the codec WASM, the fonts and the notices file, so OpenPaint runs without a network connection (WEB-ENV-03). The offline end-to-end test (`apps/web/e2e/offline.spec.ts`) checks this on the production build. Settings, recent files and recoverable sessions are kept locally in the browser.

## Third-party notices

`THIRD-PARTY-NOTICES.txt` is generated at build time. It lists every shipped component whose license asks for its notice, with its version, license, project link and full license text: the npm packages the build loads, the vendored icons and fonts, the C and C++ libraries compiled into the codec WASM (license texts in `apps/web/licenses/vendored/`, with a manifest), and the Rust crates linked into the `opaint-cpu` WASM. The crates are read from Cargo (`cargo tree` and `cargo metadata`) during the build. Where Cargo cannot run, the build uses the checked-in `apps/web/licenses/rust-crates.json` and warns; after changing `crates/Cargo.lock`, refresh it with `pnpm --filter @openpaint/web licenses:rust` (a unit test fails until you do). The About dialog and Settings › Open-Source Licenses show the same list. Ship the notices file with any copy of the built site.

## Repository layout

```
apps/web                 Vite + React app shell (PWA, deployment headers, offline build check)
packages/extension-api   Effect/file-type/tool/shape contracts and registries
packages/properties      Declarative property schema (no UI)
packages/document        Document model, layers, selection, history, .opaint format
packages/engine          Engine worker: tile store, WebGPU compositor, effect runner
packages/effects         Built-in effects and adjustments
packages/tools           Tool runtimes
packages/codecs          Built-in file types (WASM codecs)
packages/storage         IndexedDB, OPFS, settings, session recovery
packages/ui              Shared React components
packages/i18n            Message catalogs
crates/opaint-cpu        Rust CPU kernels, compiled to WASM (npm package @openpaint/cpu)
tests/golden             Golden-image tests shared by the Rust reference and the WebGPU shaders
```

`document`, `properties` and `extension-api` must not depend on the DOM or React.

## Known gaps

The current limitations, and the work still to do, are listed in [`DEVLOG.md`](DEVLOG.md) under the M7.11 entry.
