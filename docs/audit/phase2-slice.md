# Phase 2 Vertical Slice — Reference-Comparison Workspace: Independent Security/Design Review (FINAL)

- **Auditor:** independent critic/security reviewer (read-only; no source files edited)
- **Dates:** first review 2026-09-14; re-review of F1-F4 2026-09-14
- **Scope:** `lib/reference-workspace.js` (store), `/refs/*` routes in `lib/index.js`, `RefCompareSection` in `lib/client.js`, `test/reference-workspace.mjs` + `test/reference-routes.mjs` wire tests
- **Audience:** user / implementation team

## Verdict: pass

All findings from round 1 (1 medium + 3 low) verified **closed in actual code** on re-review — not just in the fix summary. Every fix was traced to its real lines, the workspace↔mounted-copy sync was hash-verified, and all four test suites pass (27/27, 17/17, 7/7, 30/30). No open findings. The slice is cleared for integration.

---

## Findings — round 1 → round 2 status

### F1 (medium) — CLOSED — refs POST routes now use a browser-aware fence (`refGuard`)

- **Verified in code:** `lib/index.js:104-110` defines `refGuard`: always runs `guard()` (loopback address + loopback Host); if the request carries browser-like headers (`Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Mode`) it additionally requires `fence(req, res, false)` → `StreamAccess.isTrustedRequest` (`lib/stream-access.js:202-220`): `Sec-Fetch-Site: cross-site` rejected outright; an `Origin` that does not match the request authority rejected.
- **Applied to all four side-effecting POSTs:** `/refs/import` (line 852), `/refs/capture` (line 868), `/refs/active` (line 901), `/refs/remove` (line 916). Read-only GETs (`/refs` 841, `/refs/compare` 927, `/refs/image` 943) keep plain `guard` — they have no CSRF side effects and responses are unreadable cross-origin without CORS headers.
- **Semantics sound:** cross-site browser POSTs always carry `Sec-Fetch-Site: cross-site` (rejected at `stream-access.js:203`) or a mismatched `Origin` (rejected at `:211`). Same-origin panel POSTs carry `Origin: http://localhost:3080` + `Sec-Fetch-Site: same-origin`, which match the loopback authority → pass. Bare non-browser loopback clients (local tooling, tests) send no browser headers → keep the plain loopback guard, matching the existing `meshGuard` precedent (`index.js:120-131`). The round-1 "no-Origin POST → 403" suggestion was deliberately not adopted and does not need to be: CSRF-relevant browser traffic always carries one of the three headers, and requiring Origin would break legitimate non-browser loopback clients.
- **Tests added and passing:** `test/reference-routes.mjs:73-84` — cross-site `POST /refs/import` → 403, cross-site `POST /refs/capture` → 403, same-origin browser `POST /refs/import` → 201 (proves the fence does not break the panel's own fetches).

### F2 (low) — CLOSED — `meta.json` writes are now atomic

- **Verified in code:** `lib/reference-workspace.js:124-127` writes `metaFile + ".tmp"` then `renameSync(tmp, metaFile)`; `renameSync` imported at line 21. Node `fs.rename` on Windows replaces the target atomically (MoveFileEx replace-existing). Quarantine in `readMeta` remains as last-resort tolerance.

### F3 (low) — CLOSED — `/refs/image` sends `X-Content-Type-Options: nosniff`

- **Verified in code:** `lib/index.js:950` — `res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })`.

### F4 (low) — CLOSED — capture serial validated before the `screenCapture` tmp-filename path

- **Verified in code:** `lib/index.js:873-875` — the resolved serial (caller-supplied or first attached) is checked against `/^[A-Za-z0-9._:-]+$/` and rejected before reaching `DeviceBuild.screenCapture`, closing the latent `..`-escape seam in `screen-${serial}-${Date.now()}.png` (`lib/device-build.js:1244`). Real adb serials (`emulator-5554`, `RFC…`, `ip:port`) all match the pattern.

---

## Still-clean areas (re-confirmed unchanged)

1. **Command execution:** all adb calls on the refs path use argument arrays (`adbRun(serial, ['shell','wm','density'|'size'])`, `['shell','screencap','-p', const]`); `launch()` spawns argv (`.cmd/.bat` shims quoted token-wise). No shell interpolation anywhere.
2. **Path traversal / symlink escape:** record ids are server-generated 16-hex (`crypto.randomBytes(8).toString('hex')`); on-disk name is `${id}${whitelisted-ext}` only. Caller `id` is a lookup key against meta records, never a path. Caller `filename` contributes only `path.extname`, whitelist-checked. No caller string reaches a filesystem path.
3. **Image fence ordering:** byte cap (25 MB `MAX_IMPORT_BYTES`) → ext whitelist → header-only `imageDimensions` → 8192 `MAX_IMAGE_DIMENSION` fence; no pixel decode exists server-side; HTTP body limit 40 MB ≥ base64(25 MB). No decode-before-fence path.
4. **File-write containment:** imports/captures write only under `<HOME>/reference/images/` with generated ids; capture `pngPath` is server-produced; per-project isolation via record keys; meta is metadata-only.
5. **XSS:** `RefCompareSection` renders only through React `createElement` (text/attribute auto-escaped); sole `innerHTML` (`client.js:1478`) is a static icon + static label; image URLs are `encodeURIComponent(record.id)`-based. No `dangerouslySetInnerHTML`, no `javascript:`/`data:` sinks.

---

## Checks actually run (re-review, exact commands + outcomes)

| Command | Outcome |
|---|---|
| `Get-FileHash lib/index.js` workspace vs `~/.dsh/profiles/web/node_modules/dsh-mobilecode/lib/index.js` | **identical** |
| `Get-FileHash lib/reference-workspace.js` workspace vs mounted copy | **identical** |
| `node test/reference-workspace.mjs` | **27 checks passed**, exit 0 |
| `node test/reference-routes.mjs` | **17 checks passed**, exit 0 — incl. new: cross-site import→403, cross-site capture→403, same-origin browser import→201 |
| `node test/selfcheck.mjs` | **7 checks passed**, exit 0 |
| `node test/routes.mjs` | **30 checks passed**, exit 0 (existing baseline incl. `/boot`/`/off` fence) |

All suites run against the mounted copy (byte-identical to the workspace checkout, hash-verified), so the wire tests exercise exactly the code reviewed.

## Summary for the user

- Round-1 verdict `needs_revision` → **`pass`**. All four findings are genuinely fixed in code (traced line-by-line, not trusted from the summary), sync verified, tests green.
- F1's design is the right call: fence only browser-like traffic (which is the CSRF carrier), keep bare loopback clients working — consistent with the plugin's mesh precedent, and proven non-breaking by the new same-origin 201 wire test.
- No open security findings. Recommended next step: proceed to integration; the slice ships.