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
/* 0.9.0 co-op: card + second pane share the panel width side by side. */
.mc-live-section { display: flex; flex-direction: column; gap: 10px; }
.mc-live-section.coop { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
.mc-live-section.coop > .mc-card { flex: 1 1 320px; min-width: 300px; }
.mc-live-section.coop .mc-live-stage img { max-height: 48vh; }
.mc-coop-select { width: auto; padding: 3px 6px; font-size: 12px; }
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
/* ── 0.7.0: toolbar pill, picker popover, device menu, sizes, frames ── */
.mc-toolbar { display: flex; align-items: center; justify-content: center; gap: 2px; padding: 3px; border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.18)); border-radius: 999px; background: light-dark(rgba(0,0,0,.03), rgba(255,255,255,.05)); align-self: center; }
.mc-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 28px; border: 0; background: transparent; color: inherit; border-radius: 999px; cursor: pointer; opacity: .8; }
.mc-toolbar button:hover:not(:disabled) { background: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.12)); opacity: 1; }
.mc-toolbar button:disabled { opacity: .3; cursor: default; }
.mc-toolbar svg { display: block; }
.mc-live-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: #4caf50; }
.mc-picker { position: relative; }
.mc-picker .mc-btn { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-picker-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: 50; min-width: 240px; max-width: 320px; max-height: 320px; overflow: auto; background: light-dark(#fff, #20242b); color: inherit; border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.mc-picker-group { display: flex; flex-direction: column; gap: 2px; }
.mc-picker-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: light-dark(#6b7078, #9aa0a8); padding: 2px 6px; }
.mc-picker-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.mc-picker-row:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-picker-row.on { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.22)); }
.mc-picker-hint { font-size: 11px; color: light-dark(#6b7078, #9aa0a8); padding: 4px 8px; }
.mc-menu-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: 50; min-width: 180px; background: light-dark(#fff, #20242b); color: inherit; border: 1px solid light-dark(rgba(0,0,0,.16), rgba(255,255,255,.2)); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); padding: 4px; display: flex; flex-direction: column; }
.mc-menu-pop button { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.mc-menu-pop button:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)); }
.mc-menu { position: relative; }
.mc-live-sizesel { flex: 0 1 auto; width: 92px; }
.mc-live-size { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mc-seg { display: inline-flex; border: 1px solid light-dark(rgba(0,0,0,.18), rgba(255,255,255,.2)); border-radius: 8px; overflow: hidden; }
.mc-seg button { border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 4px 9px; cursor: pointer; opacity: .6; }
.mc-seg button[data-on] { background: light-dark(rgba(66,133,244,.12), rgba(66,133,244,.22)); color: #4285f4; opacity: 1; }
.mc-live-stage.bezel { padding: 8px; background: #111; border-radius: 16px; }
.mc-live-stage.device { padding: 12px; background: linear-gradient(145deg, #2c2f36, #17191d); border-radius: 26px; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
/* ── 0.7.0: compact conversation cards ── */
.mc-card-compact { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)); border-radius: 10px; font-size: 12px; background: light-dark(rgba(0,0,0,.02), rgba(255,255,255,.03)); }
.mc-card-compact .mc-card-kind { font-weight: 700; }
.mc-badge.ok { background: rgba(76,175,80,.16); color: #4caf50; }
.mc-card-open { font-size: 11px; color: #4285f4; cursor: pointer; border: 0; background: transparent; padding: 2px 4px; font: inherit; }
/* ── 0.7.0: composer status capsule ── */
.mc-capsule { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid rgba(76,175,80,.4); border-radius: 999px; background: rgba(76,175,80,.1); color: #4caf50; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.mc-capsule:hover { background: rgba(76,175,80,.18); }
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
					h(LiveStreamSection, null),
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

		// 0.7.0: the conversation cards (tool.call.toolview) and the composer
		// capsule (conversation.input.dock) live outside our panel tree, so the
		// controller they need to open the panel is a module-level reference set
		// by apply() before the slots register. Auto-open fires exactly once per
		// page load (a settled boot/stream card opens the panel).
		let activeController = null;
		let autoOpenedOnce = false;
		/** Stable stand-in store so the capsule hooks are unconditional even before apply() runs. */
		const DUMMY_STORE = { subscribe: () => () => {}, getSnapshot: () => ({ panelOpen: true }) };

		/** Extract text from a tool-result block (string content or pages of {type,text}). */
		function blockText(block) {
			if (typeof block?.content === "string") return block.content;
			if (Array.isArray(block?.content)) return block.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
			return "";
		}

		/** Compact conversation card for tools that emit android-stream meta.
		 *  ToolCallBlock model (matches the rc.6 runtime): a settled result has
		 *  `kind: "tool-result"` + `isError`; a running block has neither, so it
		 *  resolves here to null and the runtime's own running UI shows. */
		function MobileCodeToolCard(props) {
			const block = props?.block ?? null;
			const toolName = props?.toolName ?? block?.toolName ?? "";
			const settled = block !== null && typeof block === "object" && "kind" in block;
			const error = settled && block.isError === true;
			// block.meta IS the host-projected presentationMeta envelope (see
			// dsh-android parseAndroidMeta). Nested calls that carry no meta fall
			// back to hydrating the serial from the durable text.
			const meta = settled && !error ? block?.meta ?? null : null;
			const kind = meta?.kind ?? null;
			const serial = meta?.device?.serial
				?? (/(emulator-\d+|(?:RFC[0-9A-F]{7,}|[A-Za-z0-9]{6,}))/i.exec(blockText(block))?.[1] ?? "");
			// Auto-open the panel once when a stream settles (boot/stream start).
			useEffect(() => {
				if (settled && kind === "android-stream" && !autoOpenedOnce && activeController) {
					autoOpenedOnce = true;
					activeController.setOpen(true);
				}
			}, [settled, kind]);
			if (!settled || kind !== "android-stream") return null;
			const badge = error ? "failed" : "streaming";
			return h("div", { className: "mc-card-compact" },
				h("span", { className: "mc-card-kind" }, "Android stream"),
				serial !== "" && h("span", { className: "mc-serial" }, serial),
				h("span", { className: "mc-badge" + (error ? " err" : " ok") }, badge),
				h("span", { className: "sp" }),
				activeController && h("button", { className: "mc-card-open", onClick: () => activeController.setOpen(true) }, "⤢ open in panel"),
			);
		}

		/** Composer capsule: green "● <serial>" pill while a device streams and the panel is closed. */
		function MobileCodeStatusCapsule() {
			const [running, setRunning] = useState(false);
			const [status, setStatus] = useState(null);
			const store = activeController ?? DUMMY_STORE;
			const { panelOpen } = useSyncExternalStore(store.subscribe, store.getSnapshot);
			const poll = async () => {
				try {
					const r = await streamPost("/stream/status", {});
					setRunning(r.running === true);
					setStatus(r);
				} catch {
					setRunning(false);
					setStatus(null);
				}
			};
			useEffect(() => {
				poll();
				const timer = setInterval(() => { if (!panelOpen) poll(); }, 5000);
				return () => clearInterval(timer);
			}, [panelOpen]);
			if (!running || panelOpen) return null;
			return h("button", { className: "mc-capsule", onClick: () => activeController?.setOpen(true) },
				h("span", { className: "mc-dot on" }),
				h("span", null, status?.serial ?? "device stream"),
			);
		}

		/** Shared stream lifecycle (0.9.0 co-op): HMAC-granted frame URL with a
		 *  re-mint timer, plus tap/drag pointer mapping for the <img>. Used by
		 *  the full card and by the second co-op pane. */
		function useLiveStream({ serial, onError }) {
			const [streamUrl, setStreamUrl] = useState("");
			const imgRef = useRef(null);
			const dragRef = useRef(null);
			const grantTimer = useRef(null);
			const serialRef = useRef(serial);
			serialRef.current = serial;
			const onErrorRef = useRef(onError);
			onErrorRef.current = onError;

			const grant = async (device) => {
				if (!device) return false;
				try {
					const r = await streamPost("/stream/grant", { device });
					// Absolute URL: the plugin card can be hosted under a different
					// origin/path than the API, and <img> src ignores fetch()'s base.
					setStreamUrl(location.origin + r.streamUrl);
					clearTimeout(grantTimer.current);
					// Re-mint a minute before the 10-minute capability expires.
					const ms = Math.max(30000, (r.expiresAt - Date.now()) - 60000);
					grantTimer.current = setTimeout(() => { grant(r.device).catch(() => {}); }, ms);
					return true;
				} catch (err) {
					onErrorRef.current(err instanceof Error ? err.message : String(err));
					setStreamUrl("");
					return false;
				}
			};
			const reset = () => { clearTimeout(grantTimer.current); setStreamUrl(""); };
			useEffect(() => () => clearTimeout(grantTimer.current), []);

			const control = async (action) => {
				if (serialRef.current === "") return;
				try { await streamPost("/stream/control", { device: serialRef.current, action }); }
				catch (err) { onErrorRef.current(err instanceof Error ? err.message : String(err)); }
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
			// Gesture coalescing: remember the down point + timestamp; on up,
			// taps (<2% travel) vs drags keep the real duration (clamped 0..5s).
			const onDown = (e) => { const p = norm(e.clientX, e.clientY); if (p) dragRef.current = { ...p, t: Date.now() }; };
			const onUp = (e) => {
				const start = dragRef.current;
				dragRef.current = null;
				const end = norm(e.clientX, e.clientY);
				if (!start || !end) return;
				const durationMs = Math.max(0, Math.min(5000, Date.now() - start.t));
				if (Math.hypot(end.x - start.x, end.y - start.y) > 0.02) {
					control({ kind: "drag", fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, durationMs });
				} else {
					control({ kind: "tap", x: end.x, y: end.y });
				}
			};
			return { streamUrl, grant, reset, control, imgProps: { ref: imgRef, draggable: false, onPointerDown: onDown, onPointerUp: onUp } };
		}

		/** Live device stream: picker-popover header, SVG toolbar pill, device
		 *  menu, quick sizes + frame styles, and tap/drag with duration. */
		function LiveDeviceCard({ coopOn, onToggleCoop, onSerial }) {
			const [devices, setDevices] = useState([]);
			const [avds, setAvds] = useState([]);
			const [serial, setSerial] = useState("");
			const [error, setError] = useState("");
			const [pickerOpen, setPickerOpen] = useState(false);
			const [menuOpen, setMenuOpen] = useState(false);
			const [still, setStill] = useState(null);
			const [view, setView] = useState("live"); // 'live' | 'still'
			const [sizeMode, setSizeMode] = useState({ mode: "fit" }); // {mode:'fit'|'pct'|'px', value?}
			const [frame, setFrame] = useState("none"); // 'none' | 'bezel' | 'device'
			const live = useLiveStream({ serial, onError: setError });
			const grant = (device) => live.grant(device).then((ok) => { if (ok) setError(""); });
			const control = live.control;
			useEffect(() => { if (onSerial) onSerial(serial); }, [serial]);

			const refreshDevices = async () => {
				try {
					const r = await streamPost("/stream/devices", {});
					setDevices(r.devices);
					setAvds(r.avds ?? []);
					setSerial((cur) => cur || (r.devices.find((d) => d.streaming)?.serial ?? r.devices[0]?.serial ?? ""));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};

			useEffect(() => {
				refreshDevices();
				const timer = setInterval(refreshDevices, 5000);
				return () => clearInterval(timer);
			}, []);

			// Auto-grant once a serial is known, no stream, and we're in live view.
			useEffect(() => { if (serial !== "" && live.streamUrl === "" && view === "live") grant(serial); }, [serial, live.streamUrl, view]);

			const capture = async () => {
				if (serial === "") return;
				try {
					const r = await streamPost("/stream/still", { device: serial });
					if (r.dataUrl) {
						setStill(r);
						setView("still");
						setError("");
					} else {
						setStill(null);
						setView("live");
						setError("still saved to " + (r.path ?? "a temp file") + " but too large to embed here");
					}
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};

			const menuAction = async (action) => {
				if (serial === "") return;
				try { await streamPost("/stream/device-action", { device: serial, action }); setMenuOpen(false); }
				catch (err) { setError(err instanceof Error ? err.message : String(err)); }
			};

			const pick = (device) => { setSerial(device); live.reset(); setStill(null); setView("live"); setError(""); setPickerOpen(false); };
			const showLive = () => { setView("live"); if (serial !== "" && live.streamUrl === "") grant(serial); };

			const sizeStyle = sizeMode.mode === "pct"
				? { width: sizeMode.value + "%", maxWidth: "100%", maxHeight: "60vh" }
				: sizeMode.mode === "px"
					? { width: sizeMode.value + "px", maxWidth: "100%", maxHeight: "60vh" }
					: {};
			const stageClass = "mc-live-stage" + (frame !== "none" ? " " + frame : "");
			const toolbar = [
				{ title: "Back", icon: "M15 18l-6-6 6-6", run: () => control({ kind: "button", name: "back" }) },
				{ title: "Home", icon: "M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5", run: () => control({ kind: "button", name: "home" }) },
				{ title: "Recents", icon: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5", run: () => control({ kind: "button", name: "recents" }) },
				{ title: "Screenshot", icon: "M4 7h4l2-3h4l2 3h4v13H4zM12 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", run: () => capture() },
				{ title: "Rotate", icon: "M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6", run: () => control({ kind: "rotate" }) },
				{ title: "Refresh", icon: "M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6", run: () => { if (serial !== "") grant(serial); } },
			];
			const menuItems = [
				{ action: "notifications", label: "Notifications" },
				{ action: "quick_settings", label: "Quick settings" },
				{ action: "collapse", label: "Collapse" },
				{ action: "lock", label: "Lock" },
				{ action: "wake", label: "Wake" },
				{ action: "assistant", label: "Assistant" },
			];
			const SIZE_PRESETS = [
				{ label: "Fit", mode: { mode: "fit" } },
				{ label: "100%", mode: { mode: "pct", value: 100 } },
				{ label: "S · 240", mode: { mode: "px", value: 240 } },
				{ label: "M · 320", mode: { mode: "px", value: 320 } },
			];
			const isCurrent = (m) => m.mode === sizeMode.mode && (m.value === undefined || m.value === sizeMode.value);

			return h("div", { className: "mc-card mc-live" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Live device"),
					live.streamUrl !== "" && h("span", { className: "mc-live-badge" }, h("span", { className: "mc-dot on" }), "Live"),
					h("span", { className: "sp" }),
					h("div", { className: "mc-picker" },
						h("button", { className: "mc-btn", onClick: () => setPickerOpen((v) => !v) }, serial || "no device", " ▾"),
						pickerOpen && h("div", { className: "mc-picker-pop" },
							devices.length > 0
								? h("div", { className: "mc-picker-group" },
									h("div", { className: "mc-picker-label" }, "Online devices"),
									devices.map((d) => h("button", { key: d.serial, className: "mc-picker-row" + (d.serial === serial ? " on" : ""), onClick: () => pick(d.serial) },
										h("span", null, d.kind === "emulator" ? "🖥" : "📱"),
										h("span", { className: "mc-serial" }, d.serial),
										d.streaming && h("span", { className: "mc-badge" }, "streaming"),
									)),
								)
								: h("div", { className: "mc-picker-hint" }, "No device attached"),
							avds.length > 0 && h("div", { className: "mc-picker-group" },
								h("div", { className: "mc-picker-label" }, "AVDs — start with device_boot"),
								avds.map((avd) => h("div", { key: avd, className: "mc-picker-hint" }, "▫ " + avd)),
							),
						),
					),
					h("div", { className: "mc-menu" },
						h("button", { className: "mc-btn", disabled: serial === "", title: "Device actions", onClick: () => setMenuOpen((v) => !v) }, "☰"),
						menuOpen && h("div", { className: "mc-menu-pop" },
							menuItems.map((item) => h("button", { key: item.action, onClick: () => menuAction(item.action) }, item.label)),
						),
					),
					// 0.9.0 co-op: side-by-side second pane (needs two online devices).
					devices.length >= 2 && h("button", { className: "mc-btn", "data-on": coopOn || undefined, title: "Co-op: watch two devices side by side", onClick: onToggleCoop }, "⧉"),
				),
				error !== "" && h("div", { className: "mc-error" }, error),
				h("div", { className: "mc-toolbar" },
					toolbar.map((item) => h("button", { key: item.title, title: item.title, disabled: serial === "", onClick: item.run },
						h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
							h("path", { d: item.icon }),
						),
					)),
				),
				h("div", { className: stageClass },
					view === "still" && still?.dataUrl
						? h("img", { src: still.dataUrl, alt: "still capture", draggable: false })
						: live.streamUrl !== ""
							? h("img", { ...live.imgProps, src: live.streamUrl, alt: "device screen", style: sizeStyle, onError: () => grant(serial) })
							: h("div", { className: "mc-live-off" }, devices.length === 0
								? "No device attached. Boot one with device_boot, or press Run app."
								: "Connecting to " + serial + "..."),
				),
				view === "still"
					? h("div", { className: "mc-live-cap" }, "Still captured" + (still?.width ? " (" + still.width + "x" + still.height + ")" : "") + " · ",
						h("a", { className: "mc-log-toggle", onClick: showLive }, "back to Live"))
					: h("div", { className: "mc-live-cap" }, "tap or drag on the screen to drive the device"),
				h("div", { className: "mc-live-size" },
					h("span", { className: "mc-hint" }, "Size"),
					h("div", { className: "mc-seg" }, SIZE_PRESETS.map((p) => h("button", { key: p.label, "data-on": isCurrent(p.mode) || undefined, onClick: () => setSizeMode(p.mode) }, p.label))),
					h("select", { className: "mc-input mc-live-sizesel", value: sizeMode.mode === "pct" ? sizeMode.value + "%" : sizeMode.mode === "px" ? String(sizeMode.value) : "fit", onChange: (e) => {
						const v = e.target.value;
						if (v === "fit") setSizeMode({ mode: "fit" });
						else if (v.endsWith("%")) setSizeMode({ mode: "pct", value: Number(v.slice(0, -1)) });
						else setSizeMode({ mode: "px", value: Number(v) });
					} },
						h("option", { value: "fit" }, "fit"),
						h("option", { value: "50%" }, "50%"),
						h("option", { value: "75%" }, "75%"),
						h("option", { value: "100%" }, "100%"),
						h("option", { value: "125%" }, "125%"),
						h("option", { value: "240" }, "S · 240px"),
						h("option", { value: "320" }, "M · 320px"),
						h("option", { value: "420" }, "L · 420px"),
					),
					h("span", { className: "mc-hint" }, "Frame"),
					h("div", { className: "mc-seg" },
						h("button", { "data-on": frame === "none" || undefined, onClick: () => setFrame("none") }, "none"),
						h("button", { "data-on": frame === "bezel" || undefined, onClick: () => setFrame("bezel") }, "bezel"),
						h("button", { "data-on": frame === "device" || undefined, onClick: () => setFrame("device") }, "device"),
					),
				),
			);
		}
		/** Co-op second pane (0.9.0): a compact stream view for a second device —
		 *  device select, live image, tap/drag. No toolbar/menu/size knobs; the
		 *  full card next to it carries those for whichever device it shows. */
		function CoopPane({ excludeSerial }) {
			const [devices, setDevices] = useState([]);
			const [serial, setSerial] = useState("");
			const [error, setError] = useState("");
			const live = useLiveStream({ serial, onError: setError });
			const grant = (device) => live.grant(device).then((ok) => { if (ok) setError(""); });

			const refresh = async () => {
				try {
					const r = await streamPost("/stream/devices", {});
					setDevices(r.devices);
					// Keep my pick unless it vanished or became the other pane's device.
					setSerial((cur) => {
						if (cur !== "" && cur !== excludeSerial && r.devices.some((d) => d.serial === cur)) return cur;
						const others = r.devices.filter((d) => d.serial !== excludeSerial);
						return (others.find((d) => d.streaming) ?? others[0])?.serial ?? "";
					});
				} catch {
					/* the header keeps the last device list */
				}
			};

			useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 5000);
				return () => clearInterval(timer);
			}, [excludeSerial]);

			useEffect(() => { if (serial !== "" && live.streamUrl === "") grant(serial); }, [serial, live.streamUrl]);

			return h("div", { className: "mc-card mc-live mc-coop-pane" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Player B"),
					live.streamUrl !== "" && h("span", { className: "mc-live-badge" }, h("span", { className: "mc-dot on" }), "Live"),
					h("span", { className: "sp" }),
					h("select", { className: "mc-input mc-coop-select", value: serial, onChange: (e) => { setSerial(e.target.value); live.reset(); } },
						devices.length === 0 && h("option", { value: "" }, "no device"),
						devices.map((d) => h("option", { key: d.serial, value: d.serial }, d.serial + (d.serial === excludeSerial ? " (A)" : d.streaming ? " ●" : ""))),
					),
				),
				error !== "" && h("div", { className: "mc-error" }, error),
				h("div", { className: "mc-live-stage" },
					live.streamUrl !== ""
						? h("img", { ...live.imgProps, src: live.streamUrl, alt: "co-op device screen", onError: () => grant(serial) })
						: h("div", { className: "mc-live-off" }, devices.length === 0 ? "No second device — boot another emulator." : "Connecting to " + serial + "..."),
				),
				h("div", { className: "mc-live-cap" }, "tap or drag on the screen to drive this device"),
			);
		}

		/** Stream section: the classic single card, plus a co-op mode that docks
		 *  a second pane next to it for two-player testing. */
		function LiveStreamSection() {
			const [coop, setCoop] = useState(false);
			const [serialA, setSerialA] = useState("");
			return h("div", { className: "mc-live-section" + (coop ? " coop" : "") },
				h(LiveDeviceCard, { coopOn: coop, onToggleCoop: () => setCoop((v) => !v), onSerial: setSerialA }),
				coop && h(CoopPane, { excludeSerial: serialA }),
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
			activeController = controller;
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
					// 0.7.0: compact conversation card under a settled device_stream /
					// device_boot result (opens the panel on "⤢ open in panel", and
					// auto-opens it once when a stream first settles). One slot per
					// tool name keyed like the reference port (openpencil shape):
					// `key: toolName` scopes the card to that tool's calls, so other
					// tools keep their default card.
					for (const toolName of ["device_stream", "device_boot"]) {
						const disposeCard = ctx.slots.inject("tool.call.toolview", () =>
							ctx.slots.register({
								name: "tool.call.toolview",
								key: toolName,
							}, MobileCodeToolCard),
						);
						disposers.push(disposeCard);
					}
					// 0.7.0: green "● <serial>" composer capsule while a device
					// streams; clicking it opens the panel. Registered unconditionally
					// so the capsule can appear even before any card auto-opens.
					const disposeCapsule = ctx.slots.inject("conversation.input.dock", () =>
						ctx.slots.register({
							name: "conversation.input.dock",
							id: "dsh-mobilecode-status",
							order: 40,
						}, MobileCodeStatusCapsule),
					);
					disposers.push(disposeCapsule);
				}
			} catch (error) {
				console.warn("[dsh-mobilecode] mount failed:", error);
			}
			ctx.effect(() => () => {
				styleGuard.disconnect();
				for (const dispose of disposers.splice(0)) dispose();
				activeController = null;
				autoOpenedOnce = false;
				style.remove();
			}, "dsh-mobilecode: ui mounts");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
