/**
 * dsh-mobilecode — browser half. Runs inside the dsh web GUI.
 *
 * Renders the device pane, the DSH equivalent of mobilecode's embedded
 * device-preview UI:
 *   - sidebar entry row toggling the pane (DOM-level injection, self-healing),
 *   - directory input (remembers the last one) + platform pills from detect,
 *   - per platform: start/stop the preview server, run/stop the app,
 *   - embedded iframe of the serve-sim / serve-avd stream,
 *   - build status, error and expandable log tail,
 *   - polls GET /api/dsh-mobilecode every ~2s while open.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` (lazy CJS) —
 * the only client bundle format the web shell materializes.
 */
window.__ModuleLoader__.load({
	id: "dsh-mobilecode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require("react");
		const { createRoot } = require("react-dom/client");

		//#region styles
		const STYLE = `
[data-dsh-mobilecode-entry] {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; margin: 2px 0; border: 0; border-radius: 8px;
  background: transparent; color: inherit; font: inherit; cursor: pointer;
  text-align: left;
}
[data-dsh-mobilecode-entry]:hover { background: rgba(128,128,128,.14); }
[data-dsh-mobilecode-entry][data-active] { background: rgba(128,128,128,.22); }
[data-dsh-mobilecode-entry] .mc-entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
[data-dsh-mobilecode-entry] .mc-entry-label { font-size: 13px; line-height: 1.2; opacity: .92; }
.dsh-mobilecode-view { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 94vw); z-index: 999999; left: auto; }
.dsh-mobilecode-view[hidden] { display: none !important; }
.dsh-mobilecode-panel {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: light-dark(#ffffff, #171a1f);
  color: light-dark(#1a1d23, #dfe3ea);
  border-left: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
  box-shadow: -10px 0 28px rgba(0,0,0,.22);
}
.dsh-mobilecode-resize { position: absolute; left: -6px; top: 0; bottom: 0; width: 12px; cursor: col-resize; z-index: 2; display: flex; align-items: center; justify-content: center; }
.dsh-mobilecode-resize::before { content: ""; width: 3px; height: 48px; border-radius: 2px; background: light-dark(rgba(0,0,0,.3), rgba(255,255,255,.35)); transition: background .15s, height .15s; }
.dsh-mobilecode-resize:hover::before, .dsh-mobilecode-resize[data-drag]::before { background: light-dark(rgba(0,0,0,.6), rgba(255,255,255,.75)); height: 72px; }
.mc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.mc-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; }
.mc-title { font-size: 15px; font-weight: 700; margin: 0; letter-spacing: .2px; flex: 1; }
.mc-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; font-size: 13px; }
.mc-close:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.mc-row { display: flex; align-items: center; gap: 8px; }
.mc-input { flex: 1; min-width: 0; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)); border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 6px 9px; }
.mc-input:focus { outline: 2px solid rgba(66,133,244,.35); border-color: rgba(66,133,244,.5); }
.mc-btn { border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 7px; cursor: pointer; transition: background .12s; white-space: nowrap; }
.mc-btn:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-btn[data-on] { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.22)); border-color: rgba(66,133,244,.45); color: #4285f4; }
.mc-btn:disabled { opacity: .45; cursor: default; }
.mc-btn.primary { background: #4285f4; border-color: #4285f4; color: #fff; }
.mc-btn.primary:hover { background: #3b78e7; }
.mc-btn.danger { color: #ef5350; }
.mc-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.mc-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 999px; cursor: pointer; }
.mc-pill:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-pill[data-on] { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.22)); border-color: rgba(66,133,244,.45); color: #4285f4; }
.mc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.mc-dot.on { background: #4caf50; box-shadow: 0 0 6px rgba(76,175,80,.6); }
.mc-dot.off { background: #9e9e9e; }
.mc-dot.warn { background: #ff9800; }
.mc-dot.err { background: #ef5350; }
.mc-card { border: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.mc-card-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
.mc-card-head .sp { flex: 1; }
.mc-status { font-size: 12px; color: light-dark(#4a4f58, #b9bec7); display: flex; flex-direction: column; gap: 2px; }
.mc-status b { font-weight: 600; color: inherit; }
.mc-error { font-size: 12px; color: #ef5350; background: rgba(239,83,80,.1); border: 1px solid rgba(239,83,80,.3); border-radius: 7px; padding: 7px 9px; white-space: pre-wrap; word-break: break-all; }
.mc-log-toggle { font-size: 11px; color: #4285f4; cursor: pointer; border: 0; background: transparent; padding: 2px 0; text-align: left; font: inherit; }
.mc-log { max-height: 180px; overflow: auto; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.06)); border-radius: 7px; padding: 8px; margin: 0; font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-all; font-family: Consolas, "Cascadia Mono", monospace; }
.mc-frame { width: 100%; height: 300px; border: 1px solid light-dark(rgba(0,0,0,.15), rgba(255,255,255,.18)); border-radius: 10px; background: #000; display: block; }
.mc-empty { color: light-dark(#9aa0a8, #7c838d); font-size: 12px; padding: 8px 0; }
.mc-footer { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-top: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; font-size: 11px; color: light-dark(#6b7078, #9aa0a8); flex-wrap: wrap; }
/* ── welcome modal ── */
.mc-overlay { position: fixed; inset: 0; z-index: 1000000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); backdrop-filter: blur(2px); padding: 24px; }
.mc-modal { width: min(680px, 100%); max-height: 88vh; overflow: auto; background: light-dark(#ffffff, #1b1f26); color: light-dark(#1a1d23, #e3e7ee); border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)); border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,.4); display: flex; flex-direction: column; }
.mc-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; }
.mc-modal-title { font-size: 16px; font-weight: 700; margin: 0; flex: 1; }
.mc-modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 1.55; }
.mc-modal-foot { padding: 12px 18px; border-top: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; }
.mc-modal-foot .sp { flex: 1; }
.mc-modal h3 { margin: 0; font-size: 13px; }
.mc-prompt { position: relative; }
.mc-prompt pre { margin: 0; max-height: 220px; overflow: auto; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)); border: 1px solid light-dark(rgba(0,0,0,.14), rgba(255,255,255,.18)); border-radius: 8px; padding: 10px 12px; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; font-family: Consolas, "Cascadia Mono", monospace; }
.mc-copy { position: absolute; top: 8px; right: 8px; }
.mc-tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); flex: none; }
.mc-tab { border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; padding: 9px 12px; cursor: pointer; border-bottom: 2px solid transparent; opacity: .65; }
.mc-tab[data-on] { opacity: 1; border-bottom-color: #4285f4; color: #4285f4; }
.mc-check { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.13)); border-radius: 8px; font-size: 12px; line-height: 1.5; }
.mc-check .mc-check-ico { flex: none; font-weight: 700; width: 18px; text-align: center; }
.mc-check .mc-check-detail { flex: 1; min-width: 0; word-break: break-all; }
.mc-check .mc-check-name { font-weight: 700; }
.mc-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(128,128,128,.35); border-top-color: #4285f4; border-radius: 50%; animation: mc-spin .8s linear infinite; vertical-align: -2px; }
@keyframes mc-spin { to { transform: rotate(360deg); } }
.mc-logline { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.06)); border-radius: 8px; padding: 8px 10px; margin: 0; }
.mc-hint { font-size: 11px; color: light-dark(#6b7078, #9aa0a8); }
/* ── DSH Settings page contribution ── */
.mc-section { display: flex; flex-direction: column; gap: 4px; padding: 4px 6px 16px; }
.mc-section-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 0 10px; }
.mc-section-head .mc-hint { flex: 1; min-width: 200px; }
.mc-section .mc-tabs { padding: 0; margin-bottom: 4px; }
/* ── live device stream ── */
.mc-live { display: flex; flex-direction: column; gap: 8px; }
.mc-live-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mc-live-bar select { background: light-dark(#fff, #20242b); color: inherit; border: 1px solid light-dark(rgba(0,0,0,.18), rgba(255,255,255,.18)); border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 12px; max-width: 200px; }
.mc-live-stage { position: relative; align-self: center; background: #000; border-radius: 10px; overflow: hidden; line-height: 0; box-shadow: inset 0 0 0 1px light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); }
.mc-live-stage img { display: block; max-width: 100%; max-height: 60vh; width: auto; height: auto; cursor: crosshair; touch-action: none; user-select: none; }
.mc-live-stage .mc-live-off { display: flex; align-items: center; justify-content: center; width: 260px; height: 460px; color: #9aa0a8; font-size: 13px; line-height: 1.5; text-align: center; }
.mc-live-nav { display: flex; align-items: center; justify-content: center; gap: 8px; }
.mc-live-nav button { border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.18)); background: light-dark(#fff, #20242b); color: inherit; border-radius: 999px; width: 40px; height: 32px; cursor: pointer; font-size: 14px; }
.mc-live-nav button:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-live-cap { font-size: 11px; color: light-dark(#6b7078, #9aa0a8); text-align: center; }
.mc-device-list { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.mc-device-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 8px; }
.mc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: #9e9e9e; }
.mc-dot[data-on="true"] { background: #4caf50; box-shadow: 0 0 6px rgba(76,175,80,.6); }
.mc-serial { font-weight: 600; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.mc-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: light-dark(rgba(0,0,0,.07), rgba(255,255,255,.12)); }
.mc-conn-form { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.mc-conn-row { display: flex; align-items: center; gap: 6px; }
.mc-input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid light-dark(rgba(0,0,0,.2), rgba(255,255,255,.25)); border-radius: 6px; background: light-dark(#fff, #1f2228); color: inherit; font: inherit; font-size: 12px; }
.mc-input-sm { flex: 0 0 72px; }
.mc-qr { margin: 8px 0; padding: 8px; border: 1px dashed light-dark(rgba(0,0,0,.25), rgba(255,255,255,.3)); border-radius: 8px; }
.mc-qr-text { user-select: all; font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; margin: 4px 0 0; }
.mc-warn { color: #b3261e; font-size: 12px; margin: 6px 0; }
`;
		//#endregion

		const API_BASE = "/api/dsh-mobilecode";
		const PLATFORMS = ["ios", "android"];
		const label = (p) => (p === "ios" ? "iOS" : "Android");

		function PanelController() {
			let panelOpen = false;
			const listeners = new Set();
			return {
				getSnapshot: () => ({ panelOpen }),
				subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
				setOpen: (value) => { if (panelOpen === value) return; panelOpen = value; for (const fn of listeners) fn(); },
				toggle: () => { const value = !panelOpen; panelOpen = value; for (const fn of listeners) fn(); },
			};
		}

		const getInfo = async (directory) => {
			const url = location.origin + API_BASE + (directory ? "?directory=" + encodeURIComponent(directory) : "");
			const response = await fetch(url);
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		};
		const post = async (path, body) => {
			const response = await fetch(location.origin + API_BASE + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		};
		const apiGet = async (path) => {
			const response = await fetch(location.origin + API_BASE + path);
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		};
		// POST that surfaces the server's JSON error copy (stream routes return
		// human-readable 4xx bodies the generic post() would flatten to "HTTP 409").
		const streamPost = async (path, body) => {
			const response = await fetch(location.origin + API_BASE + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			const text = await response.text();
			let json;
			try { json = JSON.parse(text); } catch { json = {}; }
			if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
			return json;
		};
		const copyText = async (text) => {
			try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
		};

		const readDir = () => { try { return localStorage.getItem("dsh-mobilecode-directory") ?? ""; } catch { return ""; } };
		const writeDir = (value) => { try { localStorage.setItem("dsh-mobilecode-directory", value); } catch { /* private mode */ } };

		function MobileCodePanel({ controller }) {
			const [directory, setDirectory] = useState(readDir);
			const [info, setInfo] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [openLogs, setOpenLogs] = useState({});
			const [frameKey, setFrameKey] = useState(0);
			const [settingsOpen, setSettingsOpen] = useState(false);

			// Poll while the panel is open.
			const open = controller.getSnapshot().panelOpen;
			useEffect(() => {
				if (!open) return;
				let stopped = false;
				let timer;
				const poll = async () => {
					try {
						const current = await getInfo(readDir());
						if (!stopped) { setInfo(current); setError(""); }
					} catch (err) {
						if (!stopped) setError(err instanceof Error ? err.message : String(err));
					}
					if (!stopped) timer = setTimeout(poll, 2000);
				};
				poll();
				return () => { stopped = true; clearTimeout(timer); };
			}, [open]);

			const act = async (name, path, body) => {
				setBusy(name);
				setError("");
				try {
					const current = await post(path, { directory, ...body });
					setInfo(current);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy("");
				}
			};

			const detect = async () => {
				setBusy("detect");
				setError("");
				try {
					const current = await getInfo(directory);
					setInfo(current);
					writeDir(directory);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy("");
				}
			};

			const server = (platform) => info?.servers?.find((s) => s.platform === platform);
			const build = (platform) => info?.builds?.find((b) => b.platform === platform);
			const platforms = info?.platforms?.length > 0 ? info.platforms : PLATFORMS;

			const statusClass = (status) =>
				status === "running" ? "on" : status === "starting" ? "warn" : status === "exited" ? "off" : "err";

			const toggleLog = (key) => setOpenLogs((prev) => ({ ...prev, [key]: !prev[key] }));

			const logsOf = (entries) => {
				const lines = [];
				for (const entry of entries ?? []) {
					lines.push(`[${entry.platform}] ${entry.status}${entry.step ? " — " + entry.step : ""}`);
					if (entry.error) lines.push(`  error: ${entry.error}`);
				}
				return lines.join("\n");
			};

			return h("div", { className: "mc-panel" },
				h("div", { className: "mc-header" },
					h("h2", { className: "mc-title" }, "Devices"),
					h("button", {
						className: "mc-close",
						title: "Settings — doctor, PaddleOCR, AI prompt",
						onClick: () => setSettingsOpen(true),
					}, "⚙"),
					h("button", { className: "mc-close", onClick: () => controller.setOpen(false) }, "✕"),
				),
				h("div", { className: "mc-body" },
					h("div", { className: "mc-row" },
						h("input", {
							className: "mc-input",
							placeholder: "Project directory (leave empty for the session default)",
							value: directory,
							onChange: (e) => setDirectory(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") detect(); },
						}),
						h("button", { className: "mc-btn primary", disabled: busy !== "", onClick: detect }, "Detect"),
					),
					error !== "" && h("div", { className: "mc-error" }, error),
					h("div", { className: "mc-pills" },
						platforms.map((platform) => {
							const running = server(platform)?.status === "running";
							return h("span", { key: platform, className: "mc-pill", "data-on": running ? "true" : undefined },
								h("span", { className: "mc-dot " + (running ? "on" : "off") }),
								label(platform),
							);
						}),
					),
					h(LiveDeviceCard, null),
					platforms.map((platform) => {
						const srv = server(platform);
						const bld = build(platform);
						const busyHere = busy !== "" && busy.startsWith(platform);
						return h("div", { key: platform, className: "mc-card" },
							h("div", { className: "mc-card-head" },
								h("span", null, label(platform)),
								h("span", { className: "sp" }),
								srv
									? h("button", { className: "mc-btn", disabled: busy !== "", onClick: () => act(platform + "-stop-server", "/stop", { platform }) },
										srv.status === "running" ? "Stop server" : "Server " + srv.status)
									: h("button", { className: "mc-btn primary", disabled: busy !== "", onClick: () => act(platform + "-start-server", "/start", { platform }) }, "Start server"),
							),
							srv?.url
								? h("iframe", {
									key: frameKey,
									className: "mc-frame",
									src: srv.url,
									sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads",
									title: label(platform) + " preview",
								})
								: srv?.status === "starting"
									? h("div", { className: "mc-status" }, h("span", null, h("span", { className: "mc-dot warn" }), " Starting preview server…"))
									: null,
							h("div", { className: "mc-row" },
								h("button", {
									className: "mc-btn primary",
									disabled: busy !== "",
									onClick: () => { act(platform + "-run", "/run", { platform }); setFrameKey((k) => k + 1); },
								}, "Run app"),
								h("button", { className: "mc-btn danger", disabled: busy !== "", onClick: () => act(platform + "-stop", "/run/stop", { platform }) }, "Stop app"),
							),
							bld
								? h("div", { className: "mc-status" },
									h("span", null,
										h("span", { className: "mc-dot " + statusClass(bld.status) }),
										" Build: ", h("b", null, bld.status),
										bld.step ? " — " + bld.step : "",
										bld.target ? " · target " + bld.target : "",
										bld.appID ? " · " + bld.appID : "",
									),
									bld.error !== undefined && bld.error !== "" && h("div", { className: "mc-error" }, bld.error),
									bld.log.length > 0 &&
										h("button", { className: "mc-log-toggle", onClick: () => toggleLog(platform + "-build") },
											openLogs[platform + "-build"] ? "Hide log" : "Show log (" + bld.log.length + ")"),
									openLogs[platform + "-build"] && h("pre", { className: "mc-log" }, bld.log.join("\n")),
								)
								: h("div", { className: "mc-empty" }, "Nothing built yet."),
						);
					}),
					info?.bundler &&
						h("div", { className: "mc-card" },
							h("div", { className: "mc-card-head" },
								h("span", null, "Metro"),
								h("span", { className: "mc-dot " + statusClass(info.bundler.status) }),
								h("span", { className: "sp" }),
								h("span", null, info.bundler.status + (info.bundler.url ? " · " + info.bundler.url : "")),
							),
							info.bundler.log.length > 0 &&
								h("button", { className: "mc-log-toggle", onClick: () => toggleLog("bundler") },
									openLogs["bundler"] ? "Hide log" : "Show log (" + info.bundler.log.length + ")"),
							openLogs["bundler"] && h("pre", { className: "mc-log" }, info.bundler.log.join("\n")),
						),
					info?.servers?.length === 0 && info?.builds?.length === 0 &&
						h("div", { className: "mc-empty" }, "No preview server running. Pick a project directory and press Run app."),
				),
				h("div", { className: "mc-footer" },
					h("span", null, "dsh-mobilecode · polls every 2s"),
					info && info.platforms.length > 0 && h("span", null, "detected: " + info.platforms.map(label).join(", ")),
				),
				settingsOpen && h(SettingsDialog, { onClose: () => setSettingsOpen(false) }),
			);
		}

		/** Live device stream: an <img> fed by the in-process multipart route, with
		 *  tap/drag control and the Back/Home/Recents/rotate/power nav bar. */
		function LiveDeviceCard() {
			const [devices, setDevices] = useState([]);
			const [serial, setSerial] = useState("");
			const [streamUrl, setStreamUrl] = useState("");
			const [error, setError] = useState("");
			const imgRef = useRef(null);
			const dragRef = useRef(null);
			const grantTimer = useRef(null);

			const grant = async (device) => {
				if (!device) return;
				try {
					const r = await streamPost("/stream/grant", { device });
					// Absolute URL: the plugin card can be hosted under a different
					// origin/path than the API, and <img> src ignores fetch()'s base.
					setStreamUrl(location.origin + r.streamUrl);
					setSerial(r.device);
					setError("");
					clearTimeout(grantTimer.current);
					// Re-mint a minute before the 10-minute capability expires.
					const ms = Math.max(30000, (r.expiresAt - Date.now()) - 60000);
					grantTimer.current = setTimeout(() => { grant(r.device).catch(() => {}); }, ms);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					setStreamUrl("");
				}
			};

			const refreshDevices = async () => {
				try {
					const r = await streamPost("/stream/devices", {});
					setDevices(r.devices);
					setSerial((cur) => cur || (r.devices.find((d) => d.streaming)?.serial ?? r.devices[0]?.serial ?? ""));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};

			useEffect(() => {
				refreshDevices();
				const timer = setInterval(refreshDevices, 5000);
				return () => { clearInterval(timer); clearTimeout(grantTimer.current); };
			}, []);

			// Auto-grant once a serial is known but no stream is up yet.
			useEffect(() => { if (serial !== "" && streamUrl === "") grant(serial).catch(() => {}); }, [serial, streamUrl]);

			const control = async (action) => {
				if (serial === "") return;
				try { await streamPost("/stream/control", { device: serial, action }); }
				catch (err) { setError(err instanceof Error ? err.message : String(err)); }
			};

			const norm = (clientX, clientY) => {
				const el = imgRef.current;
				if (!el) return null;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return null;
				return {
					x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
					y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
				};
			};
			const onDown = (e) => { const p = norm(e.clientX, e.clientY); if (p) dragRef.current = p; };
			const onUp = (e) => {
				const start = dragRef.current;
				dragRef.current = null;
				const end = norm(e.clientX, e.clientY);
				if (!start || !end) return;
				if (Math.hypot(end.x - start.x, end.y - start.y) > 0.02) {
					control({ kind: "drag", fromX: start.x, fromY: start.y, toX: end.x, toY: end.y });
				} else {
					control({ kind: "tap", x: end.x, y: end.y });
				}
			};

			return h("div", { className: "mc-card mc-live" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Live device"),
					h("span", { className: "sp" }),
					devices.length > 0
						? h("select", {
							value: serial,
							onChange: (e) => { setSerial(e.target.value); setStreamUrl(""); setError(""); },
						}, devices.map((d) => h("option", { key: d.serial, value: d.serial }, d.serial + (d.kind === "emulator" ? " · emu" : " · phone"))))
						: h("span", { className: "mc-hint" }, "no device"),
					h("button", { className: "mc-btn", disabled: serial === "", onClick: () => grant(serial) }, "Reconnect"),
				),
				error !== "" && h("div", { className: "mc-error" }, error),
				h("div", { className: "mc-live-stage" },
					streamUrl !== ""
						? h("img", { ref: imgRef, src: streamUrl, alt: "device screen", draggable: false, onPointerDown: onDown, onPointerUp: onUp, onError: () => grant(serial) })
						: h("div", { className: "mc-live-off" }, devices.length === 0
							? "No device attached. Boot one with device_boot, or press Run app."
							: "Connecting to " + serial + "…"),
				),
				h("div", { className: "mc-live-nav" },
					h("button", { title: "Back", disabled: serial === "", onClick: () => control({ kind: "button", name: "back" }) }, "◁"),
					h("button", { title: "Home", disabled: serial === "", onClick: () => control({ kind: "button", name: "home" }) }, "○"),
					h("button", { title: "Recents", disabled: serial === "", onClick: () => control({ kind: "button", name: "recents" }) }, "▢"),
					h("button", { title: "Rotate", disabled: serial === "", onClick: () => control({ kind: "rotate" }) }, "⟳"),
					h("button", { title: "Power", disabled: serial === "", onClick: () => control({ kind: "button", name: "power" }) }, "⏻"),
				),
				h("div", { className: "mc-live-cap" }, "tap or drag on the screen to drive the device"),
			);
		}

		//#region setup UI (welcome + settings)

		/** PaddleOCR status card: fetch /ocr, Install button, log tail. */
		function OcrCard({ compact }) {
			const [status, setStatus] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);

			const refresh = async () => {
				try { setStatus(await apiGet("/ocr")); } catch (err) { setError(err.message); }
			};
			useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 3000); // follow a running install
				return () => clearInterval(timer);
			}, []);

			const install = async () => {
				setBusy(true);
				setError("");
				try { await post("/ocr/install"); } catch (err) { setError(err.message); }
				setBusy(false);
				refresh();
			};

			const state = status?.state ?? "idle";
			const ok = status?.working === true;
			const installing = state === "installing";
			const failed = state === "failed";
			const badge = ok ? "Ready" : failed ? "Failed" : installing ? "Installing…" : "Not installed";

			return h("div", { className: "mc-card" },
				h("div", { className: "mc-card-head" },
					h("span", null, "PaddleOCR"),
					h("span", { className: "mc-dot " + (ok ? "on" : failed ? "err" : installing ? "warn" : "off") }),
					h("b", null, badge),
					h("span", { className: "sp" }),
					!ok && !installing && h("button", { className: "mc-btn primary", disabled: busy, onClick: install }, "Install"),
				),
				h("div", { className: "mc-status" },
					ok
						? h("span", null, "device_screen reads text from screenshots with local OCR.")
						: h("span", null, "Without it, device_screen returns the screenshot and UI tree but no OCR text — install to make the plugin work perfectly."),
					h("span", { className: "mc-hint" }, "PaddleOCR 2.x · fully local · one-time install (~2 min, needs network once)"),
				),
				error !== "" && h("div", { className: "mc-error" }, error),
				(installing || failed) && (status?.log?.length > 0) && h("pre", { className: "mc-logline" }, status.log.join("\n")),
				!compact && h("div", { className: "mc-status" },
					h("span", null, ok ? "OCR is available to every AI via device_screen." : "Run the doctor after installing to confirm everything works."),
				),
			);
		}

		/** Doctor view: run /doctor checks, show ✓/✗ with detail, Fix buttons. */
		function DoctorView({ onFixed }) {
			const [checks, setChecks] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [fixResult, setFixResult] = useState("");

			const run = async () => {
				setChecks(null);
				setError("");
				setFixResult("");
				try { setChecks((await apiGet("/doctor")).checks); } catch (err) { setError(err.message); }
			};
			useEffect(() => { run(); }, []);

			const fix = async (id) => {
				setBusy(id);
				setFixResult("");
				try {
					const result = await post("/doctor/fix", { id });
					setFixResult(result.message ?? "Fix requested.");
					await new Promise((r) => setTimeout(r, 1500));
					await run();
					onFixed?.();
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy("");
				}
			};

			return h("div", { className: "mc-body", style: { padding: "12px 0 0" } },
				h("div", { className: "mc-row" },
					h("button", { className: "mc-btn primary", disabled: checks === null, onClick: run }, "Re-run checks"),
					checks !== null && h("span", { className: "mc-hint" },
						checks.filter((c) => c.ok).length + "/" + checks.length + " checks passing"),
				),
				error !== "" && h("div", { className: "mc-error" }, error),
				fixResult !== "" && h("div", { className: "mc-status" }, fixResult),
				checks === null && !error && h("div", { className: "mc-row" }, h("span", { className: "mc-spin" }), " Running checks…"),
				checks?.map((check) =>
					h("div", { key: check.name, className: "mc-check" },
						h("span", { className: "mc-check-ico", style: { color: check.ok ? "#4caf50" : "#ef5350" } }, check.ok ? "✓" : "✗"),
						h("span", { className: "mc-check-detail" },
							h("span", { className: "mc-check-name" }, check.name),
							" — ", check.detail,
							check.fix && !check.ok && h("span", null,
								" ", h("button", { className: "mc-btn", disabled: busy !== "", onClick: () => fix(check.fix) },
									busy === check.fix ? "Fixing…" : "Fix")),
						),
					),
				),
			);
		}

		/** Settings dialog: tabs for Doctor / PaddleOCR / AI prompt. */
		/** Shared settings tabs (Doctor / PaddleOCR / AI Prompt / Connection) — used by both the ⚙ dialog and the DSH Settings page. */
		function SettingsTabs() {
			const [tab, setTab] = useState("doctor");
			const [prompt, setPrompt] = useState("");
			const [copied, setCopied] = useState(false);
			const [conn, setConn] = useState(null);
			const [connError, setConnError] = useState("");
			const [wifiHost, setWifiHost] = useState("");
			const [wifiPort, setWifiPort] = useState("5555");
			const [pairCode, setPairCode] = useState("");
			const [pairPort, setPairPort] = useState("37000");
			const [connBusy, setConnBusy] = useState("");
			const [connMsg, setConnMsg] = useState("");
			const [qrText, setQrText] = useState("");
			useEffect(() => {
				apiGet("/welcome").then((w) => setPrompt(w.prompt ?? "")).catch(() => {});
			}, []);
			useEffect(() => {
				if (tab !== "connection") return;
				setConn(null); setConnError("");
				apiGet("/connection").then(setConn).catch((e) => setConnError(e instanceof Error ? e.message : String(e)));
			}, [tab]);

			const refreshConn = () => {
				setConnError("");
				apiGet("/connection").then(setConn).catch((e) => setConnError(e instanceof Error ? e.message : String(e)));
			};

			const doConnect = async () => {
				const host = wifiHost.trim();
				if (!host) { setConnMsg(""); setConnError("Enter the device IP first."); return; }
				setConnBusy("connecting"); setConnError(""); setConnMsg("");
				try {
					const r = await streamPost("/connect", {
						host,
						port: parseInt(wifiPort, 10) || 5555,
						pairing_code: pairCode.trim() || undefined,
						pairing_port: parseInt(pairPort, 10) || 37000,
					});
					setConnMsg(`Connected ${r.serial}${r.paired ? " (paired)" : ""}.`);
					setPairCode("");
					refreshConn();
				} catch (e) {
					setConnError(e instanceof Error ? e.message : String(e));
				} finally {
					setConnBusy("");
				}
			};

			const doPairQr = async () => {
				setConnBusy("qr"); setConnError(""); setConnMsg("");
				try {
					const r = await streamPost("/pair-qr", { timeout_ms: 60000 });
					setQrText(r.qr_text ?? "");
					if (r.status === "connected") setConnMsg(`Paired & connected ${r.serial}.`);
					else if (r.status === "paired-not-connected") setConnMsg(`Paired with ${r.serial} but connect failed — try Connect with the same IP.`);
					else setConnMsg("QR generated. Scan it with the phone (Settings → Connected devices → Pair by QR) and keep this dialog open — pairing completes automatically.");
					refreshConn();
				} catch (e) {
					setConnError(e instanceof Error ? e.message : String(e));
				} finally {
					setConnBusy("");
				}
			};

			const copy = async () => {
				const done = await copyText(prompt);
				setCopied(done);
				setTimeout(() => setCopied(false), 2000);
			};

			const tabButton = (id, label) =>
				h("button", { className: "mc-tab", "data-on": tab === id ? "true" : undefined, onClick: () => setTab(id) }, label);

			return [
				h("div", { className: "mc-tabs" },
					tabButton("doctor", "Doctor"),
					tabButton("ocr", "PaddleOCR"),
					tabButton("prompt", "AI Prompt"),
					tabButton("connection", "Connection"),
				),
				tab === "doctor" && h("div", { className: "mc-modal-body" }, h(DoctorView, { onFixed: () => {} })),
				tab === "ocr" && h("div", { className: "mc-modal-body" }, h(OcrCard, {})),
				tab === "prompt" && h("div", { className: "mc-modal-body" },
					h("div", null,
						h("h3", null, "Prompt for any AI"),
						h("div", { className: "mc-hint" }, "Copy this into any AI model to tell it how to fully control this plugin."),
					),
					h("div", { className: "mc-prompt" },
						h("pre", null, prompt || "Loading…"),
						h("button", { className: "mc-btn mc-copy", onClick: copy }, copied ? "Copied ✓" : "Copy"),
					),
				),
				tab === "connection" && h("div", { className: "mc-modal-body" },
					h("div", null,
						h("h3", null, "adb connection"),
						connError !== "" && h("div", { className: "mc-warn" }, connError),
						connMsg !== "" && h("div", { className: "mc-hint", style: { color: "#2f9e44" } }, connMsg), 						h("div", { className: "mc-conn-form" }, 							h("div", { className: "mc-conn-row" }, 								h("input", { className: "mc-input", placeholder: "device IP, e.g. 192.168.1.23", value: wifiHost, onChange: (e) => setWifiHost(e.target.value) }), 								h("input", { className: "mc-input mc-input-sm", placeholder: "port", value: wifiPort, onChange: (e) => setWifiPort(e.target.value) }), 								h("button", { className: "mc-btn", onClick: doConnect, disabled: connBusy !== "" }, connBusy === "connecting" ? "Connecting…" : "Connect"), 							), 							h("div", { className: "mc-conn-row" }, 								h("input", { className: "mc-input", placeholder: "pairing code (first-time only)", value: pairCode, onChange: (e) => setPairCode(e.target.value) }), 								h("input", { className: "mc-input mc-input-sm", placeholder: "pair port", value: pairPort, onChange: (e) => setPairPort(e.target.value) }), 								h("button", { className: "mc-btn", onClick: doPairQr, disabled: connBusy !== "" }, connBusy === "qr" ? "Waiting for scan…" : "Pair by QR"), 							), 						), 						qrText !== "" && h("div", { className: "mc-qr" }, 							h("div", { className: "mc-hint" }, "WIFI:T:ADB — render as a QR code and scan with the phone (Settings → Connected devices → Pair by QR):"), 							h("pre", { className: "mc-qr-text" }, qrText), 						),
						conn && h("div", null,
							h("div", { className: "mc-hint" }, `adb: ${conn.adb}`),
							h("div", { className: "mc-device-list" },
								conn.devices.length === 0 && h("div", { className: "mc-hint" }, "No devices attached. Plug a phone (USB debug) or boot an emulator."),
								conn.devices.map((d) => h("div", { className: "mc-device-row", key: d.serial },
									h("span", { className: "mc-dot", "data-on": d.state === "device" ? "true" : undefined }),
									h("span", { className: "mc-serial" }, d.serial),
									d.model && h("span", { className: "mc-hint" }, d.model),
									h("span", { className: "mc-badge" }, d.wifi ? "Wi-Fi" : "USB"),
									h("span", { className: "mc-hint" }, d.state),
								)),
							),
							h("div", { className: "mc-hint" }, "Wi-Fi serials look like 192.168.1.23:5555 — attach with `adb connect <ip>:5555`. A dropped Wi-Fi link is reconnected once automatically; read-only probes then replay, taps never do."),
						),
					),
				),
			];
		}

		/** Settings dialog (⚙ in the Devices pane header). */
		function SettingsDialog({ onClose }) {
			return h("div", { className: "mc-overlay", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h("div", { className: "mc-modal" },
					h("div", { className: "mc-modal-head" },
						h("h2", { className: "mc-modal-title" }, "dsh-mobilecode · Settings"),
						h("button", { className: "mc-close", onClick: onClose }, "✕"),
					),
					h(SettingsTabs, {}),
					h("div", { className: "mc-modal-foot" },
						h("span", { className: "mc-hint" }, "Settings live in ~/.dsh/mobilecode/"),
						h("span", { className: "sp" }),
						h("button", { className: "mc-btn primary", onClick: onClose }, "Done"),
					),
				),
			);
		}

		/** The DSH Settings page contribution (registered into settings.section). */
		function SettingsSection({ close }) {
			return h("div", { className: "mc-section" },
				h("div", { className: "mc-section-head" },
					h("h2", { className: "mc-modal-title" }, "dsh-mobilecode"),
					h("span", { className: "mc-hint" }, "Detect iOS/Android projects, run them on the Simulator/Emulator, and let AI agents control the device."),
					close !== undefined && h("button", { className: "mc-btn", onClick: close }, "Close"),
				),
				h(SettingsTabs, {}),
			);
		}

		/** First-run welcome modal: how-to + copyable prompt + PaddleOCR install. */
		function WelcomeModal({ onClose }) {
			const [prompt, setPrompt] = useState("");
			const [copied, setCopied] = useState(false);
			useEffect(() => {
				apiGet("/welcome").then((w) => setPrompt(w.prompt ?? "")).catch(() => {});
			}, []);

			const copy = async () => {
				const done = await copyText(prompt);
				setCopied(done);
				setTimeout(() => setCopied(false), 2000);
			};

			const dismiss = async () => {
				try { await post("/welcome/dismiss"); } catch { /* keep modal in-memory */ }
				onClose();
			};

			return h("div", { className: "mc-overlay" },
				h("div", { className: "mc-modal" },
					h("div", { className: "mc-modal-head" },
						h("h2", { className: "mc-modal-title" }, "Welcome to dsh-mobilecode 🚀"),
						h("button", { className: "mc-close", onClick: dismiss }, "✕"),
					),
					h("div", { className: "mc-modal-body" },
						h("div", null,
							h("h3", null, "How to use it"),
							h("div", { className: "mc-status" },
								h("span", null, "1. Open the Devices pane (sidebar) and pick a project directory, or let an AI do it for you."),
								h("span", null, "2. Press Run app (or ask the AI) — it builds, installs and launches on the Simulator/Emulator."),
								h("span", null, "3. AI agents get device_detect / device_run / device_screen / device_input / device_log / device_status — full build, see, tap, log control."),
								h("span", null, "4. The ⚙ Settings button (Devices pane) has the doctor, PaddleOCR and this prompt."),
							),
						),
						h("div", { className: "mc-prompt" },
							h("pre", null, prompt || "Loading…"),
							h("button", { className: "mc-btn mc-copy", onClick: copy }, copied ? "Copied ✓" : "Copy prompt"),
						),
						h(OcrCard, { compact: true }),
						h("div", { className: "mc-hint" },
							"Tip: install PaddleOCR above so device_screen can read text from the screen — the plugin still works without it, just without OCR."),
					),
					h("div", { className: "mc-modal-foot" },
						h("span", { className: "mc-hint" }, "The ⚙ in the Devices pane opens Settings (Doctor / PaddleOCR / AI Prompt) anytime."),
						h("span", { className: "sp" }),
						h("button", { className: "mc-btn primary", onClick: dismiss }, "Got it — let's go"),
					),
				),
			);
		}
		//#endregion

		//#region DOM mounts
		const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="2" y="1.5" width="12" height="13" rx="2"/><path d="M4.5 4h7M4.5 6.5h7M4.5 9h4" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.8" fill="currentColor" stroke="none"/></svg>';

		function sidebarRoot() {
			const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (column === null) return undefined;
			const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
			return logoOwner ?? (column.firstElementChild ?? undefined);
		}

		function newSessionButton(root) {
			const nested = root.querySelector('button[class*="newSession"]');
			if (nested !== null) return nested;
			for (const child of root.children) {
				if (child.tagName === "BUTTON") return child;
			}
			return undefined;
		}

		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshMobilecodeEntry = "";
			entry.setAttribute("aria-label", "Devices (mobilecode)");
			entry.setAttribute("title", "Devices — run the mobile app in the Simulator/Emulator");
			entry.innerHTML = '<span class="mc-entry-icon">' + ICON + '</span><span class="mc-entry-label">Devices</span>';
			entry.addEventListener("click", () => { controller.toggle(); });
			return entry;
		}

		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === undefined) return false;
			if (entry.parentElement !== root) {
				const row = button.closest('[class*="logoRow"]');
				const base = (row !== null && row.parentElement === root) ? row : button;
				const family = Array.from(root.children).filter(
					(el) => el instanceof HTMLElement && el.matches("[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-logcat-entry], [data-dsh-mobilecode-entry]"),
				);
				const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}

		function mountSidebarEntry(controller) {
			const entry = createEntry(controller);
			let root;
			let placed = false;
			let rootObserver;

			const tryPlace = () => {
				if (root !== undefined && !root.isConnected) {
					rootObserver?.disconnect();
					root = undefined;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver?.disconnect();
					root = undefined;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === undefined) return;
				placed = placeEntry(root, entry);
				if (placed) {
					rootObserver = new MutationObserver(() => {
						if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
						if (!root.contains(entry)) placed = placeEntry(root, entry);
					});
					rootObserver.observe(root, { childList: true, subtree: true });
				}
			};

			const waitObserver = new MutationObserver(() => { tryPlace(); });
			waitObserver.observe(document.body, { childList: true, subtree: true });

			const syncActive = () => {
				if (controller.getSnapshot().panelOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			tryPlace();

			return () => {
				waitObserver.disconnect();
				rootObserver?.disconnect();
				unsubscribe();
				entry.remove();
			};
		}

		function mountPanel(controller) {
			let root;
			let container;
			let handle;
			let drag = null;

			const MIN_WIDTH = 320;
			const DEFAULT_WIDTH = 560;
			const readWidth = () => {
				try {
					const w = Number(localStorage.getItem("dsh-mobilecode-width"));
					if (Number.isFinite(w) && w >= MIN_WIDTH && w <= window.innerWidth - 40) return w;
				} catch { /* private mode */ }
				return Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80));
			};

			const onMove = (e) => {
				if (drag === null || container === undefined) return;
				const width = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 40, drag.startWidth + (drag.startX - e.clientX)));
				container.style.width = width + "px";
			};
			const onUp = () => {
				if (drag === null) return;
				handle?.removeAttribute("data-drag");
				try {
					const w = container.style.width.replace("px", "");
					localStorage.setItem("dsh-mobilecode-width", w);
				} catch { /* private mode */ }
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				drag = null;
			};
			const onDown = (e) => {
				e.preventDefault();
				if (drag !== null) return;
				const now = Date.now();
				if (now - (handle?._lastClick ?? 0) < 350) {
					handle._lastClick = 0;
					container.style.width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80)) + "px";
					try { localStorage.setItem("dsh-mobilecode-width", String(Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80)))); } catch { /* private */ }
					return;
				}
				handle._lastClick = now;
				drag = { startX: e.clientX, startWidth: container.getBoundingClientRect().width };
				handle?.setAttribute("data-drag", "");
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			const ensure = () => {
				if (container !== undefined && container.isConnected) return;
				root?.unmount();
				root = undefined;
				container?.remove();
				handle = undefined;
				container = document.createElement("div");
				container.dataset.dshMobilecodeView = "";
				container.className = "dsh-mobilecode-view";
				container.style.cssText += "position:fixed;top:0;right:0;bottom:0;left:auto;z-index:999999;";
				container.style.width = readWidth() + "px";
				container.hidden = true;
				handle = document.createElement("div");
				handle.className = "dsh-mobilecode-resize";
				handle.title = "Drag to resize (double-click to reset)";
				handle.addEventListener("mousedown", onDown);
				container.appendChild(handle);
				const panel = document.createElement("div");
				panel.className = "dsh-mobilecode-panel";
				panel.style.cssText += "position:absolute;inset:0;display:flex;flex-direction:column;";
				container.appendChild(panel);
				document.body.appendChild(container);
				root = createRoot(panel);
				root.render(h(MobileCodePanel, { controller }));
			};

			ensure();

			const applyOpen = () => {
				if (container !== undefined) container.hidden = !controller.getSnapshot().panelOpen;
			};
			const unsubscribe = controller.subscribe(applyOpen);
			applyOpen();

			return () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				unsubscribe();
				root?.unmount();
				root = undefined;
				container?.remove();
				container = undefined;
				handle = undefined;
			};
		}
		//#endregion

		//#region entry
		/** Required services (fiber inject waiting — the runtime must be up first). */
		const inject = ["slots"];

		/**
		 * First-run welcome: ask the host whether to show it, and if so mount the
		 * modal over everything. The host remembers dismissal in settings.json.
		 */
		function mountWelcome() {
			let root;
			let container;
			const render = (show) => {
				if (!show) return;
				container = document.createElement("div");
				container.dataset.dshMobilecodeWelcome = "";
				document.body.appendChild(container);
				root = createRoot(container);
				root.render(h(WelcomeModal, { onClose: () => { root?.unmount(); container?.remove(); root = undefined; container = undefined; } }));
			};
			apiGet("/welcome").then((w) => render(w.show === true)).catch(() => { /* host older than this feature — no welcome */ });
			return () => { root?.unmount(); container?.remove(); root = undefined; container = undefined; };
		}

		/**
		 * Mount the device pane.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = STYLE;
			style.dataset.dshMobilecodeStyle = "";
			document.head.appendChild(style);
			const styleGuard = new MutationObserver(() => {
				if (!document.head.contains(style)) document.head.appendChild(style);
			});
			styleGuard.observe(document.head, { childList: true });

			const controller = new PanelController();
			const disposers = [];
			try {
				disposers.push(mountSidebarEntry(controller));
				disposers.push(mountPanel(controller));
				disposers.push(mountWelcome());
				// DSH Settings page: register our own section (doctor / PaddleOCR / AI prompt),
				// like the other installed plugins' settings pages.
				if (typeof ctx.slots?.inject === "function") {
					const disposeSlot = ctx.slots.inject("settings.section", () =>
						ctx.slots.register({
							name: "settings.section",
							id: "mobilecode",
							order: 200,
							label: "MobileCode",
						}, SettingsSection),
					);
					disposers.push(disposeSlot);
				}
			} catch (error) {
				console.warn("[dsh-mobilecode] mount failed:", error);
			}
			ctx.effect(() => () => {
				styleGuard.disconnect();
				for (const dispose of disposers.splice(0)) dispose();
				style.remove();
			}, "dsh-mobilecode: ui mounts");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
