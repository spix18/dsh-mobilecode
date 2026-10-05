/**
 * dsh-mobilecode — browser half. Runs inside the dsh web GUI.
 *
 * Renders the device pane, the DSH equivalent of mobilecode's embedded
 * device-preview UI:
 *   - sidebar entry row toggling the pane (DOM-level injection, self-healing),
 *   - directory input (remembers the last one) + platform pills from detect,
 *   - per platform: run/stop the app + build status (iOS only: start/stop
 *     the serve-sim preview server with its embedded iframe),
 *   - Device 1 card (the live stream): 0.10.0 merged the Android
 *     "Start server" into it (serve-avd retired; picker ⏻ boot → POST /boot),
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

		const { createElement: h, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require("react");
		const { createRoot } = require("react-dom/client");

		//#region styles
		const STYLE = `
/* ── design tokens ──
   Declared on :root, not on our own containers. Two reasons: the compact
   conversation cards (tool.call.toolview) and the composer capsule render
   OUTSIDE .dsh-mobilecode-view, and the inline styles they use already read
   var(--mc-border, #2a3340) — a token that was never declared anywhere, so the
   dark-only literal fallback painted a navy border on white in light mode.
   Everything is mc- prefixed, so nothing can collide with the host shell.

   Every colour below is measured, not eyeballed. The accents clear 4.5:1 as
   SMALL TEXT in both themes — --mc-accent paints the 14px label inside
   .mc-log-toggle, .mc-card-open and every [data-on] state, so 3:1 would not
   have been enough. That is why the light accent is a deep blue and the dark
   one a light blue, and why --mc-on-accent flips to near-black in dark.

   The hues are this palette's own, not a Material tonal ramp: accent 222deg
   (indigo-leaning azure, to sit with the cool slate neutrals), ok 158, warn 28,
   err 358. Each role's lightness is then SOLVED against the pair table in
   test/tokens.mjs. The binding constraint is the role on its OWN alpha tint,
   not the role on the page — a 12-18% tint of a colour sits well below the
   page's luminance, so a value picked to clear 4.5:1 on the page alone fails on
   its own chip. Change a hue and re-solve; do not hand-edit the hex — that
   goes for the alphas too, because a tint and a line are both measured against
   the surface they land on, not against the page.

   --mc-field-border exists separately from --mc-border-strong because a text
   field's boundary is the only thing that identifies it (WCAG 1.4.11, 3:1),
   whereas a button's border is decorative — its label already identifies it.
   Neutrals carry a slight cool cast; pure gray next to a blue accent reads
   washed out. */
:root {
  color-scheme: light dark;
  --mc-bg: light-dark(#fdfdff, #171a1f);
  --mc-bg-raised: light-dark(#ffffff, #1b1f26);
  --mc-bg-pop: light-dark(#ffffff, #20242b);
  --mc-bg-inset: light-dark(rgba(16,24,40,.05), rgba(226,232,240,.07));
  --mc-hover: light-dark(rgba(16,24,40,.06), rgba(226,232,240,.11));
  --mc-hover-soft: rgba(100,116,139,.14);
  --mc-active: rgba(100,116,139,.22);
  --mc-border: light-dark(rgba(16,24,40,.13), rgba(226,232,240,.14));
  --mc-border-strong: light-dark(rgba(16,24,40,.18), rgba(226,232,240,.2));
  --mc-field-border: light-dark(rgba(16,24,40,.48), rgba(226,232,240,.48));
  --mc-text: light-dark(#1a1d23, #dfe3ea);
  --mc-text-strong: light-dark(#1a1d23, #e3e7ee);
  --mc-text-dim: light-dark(#4a4f58, #b9bec7);
  --mc-text-mute: light-dark(#5f646c, #9aa0a8);
  --mc-text-faint: light-dark(#6e737b, #7c838d);
  --mc-accent: light-dark(#245ada, #7d9eea);
  --mc-accent-hover: light-dark(#1e4cb7, #9cb5ef);
  --mc-accent-weak: light-dark(rgba(36,90,218,.12), rgba(125,158,234,.18));
  --mc-accent-line: light-dark(rgba(36,90,218,.75), rgba(125,158,234,.75));
  --mc-on-accent: light-dark(#ffffff, #10151c);
  --mc-ok: light-dark(#186649, #30cf95);
  --mc-ok-weak: light-dark(rgba(24,102,73,.12), rgba(48,207,149,.16));
  --mc-ok-hover: light-dark(rgba(24,102,73,.22), rgba(48,207,149,.26));
  --mc-ok-line: light-dark(rgba(24,102,73,.85), rgba(48,207,149,.85));
  --mc-ok-glow: light-dark(rgba(24,102,73,.45), rgba(48,207,149,.6));
  /* 4.5:1, not 3.0. This role paints TEXT (the preview-gallery freshness
     note), so it is floored like --mc-err rather than like a dot
     background. Hue 28.1 and sat 85.7 are unchanged; L was solved down
     until the ratio cleared the text floor with headroom. */
  --mc-warn: light-dark(#aa570d, #ed7812);
  --mc-err: light-dark(#c61e23, #ea7276);
  --mc-err-weak: light-dark(rgba(198,30,35,.1), rgba(234,114,118,.14));
  --mc-err-line: light-dark(rgba(198,30,35,.75), rgba(234,114,118,.75));
  --mc-idle: light-dark(#8a9099, #9aa0a8);
  --mc-grip: light-dark(rgba(16,24,40,.47), rgba(226,232,240,.47));
  --mc-grip-hover: light-dark(rgba(16,24,40,.7), rgba(226,232,240,.75));
  --mc-scrim: rgba(15,23,42,.45);
  --mc-spin-track: rgba(100,116,139,.35);
  --mc-focus: light-dark(#245ada, #7d9eea);
  --mc-stage: #000;
  --mc-stage-fg: #ffffff; /* the stage is dark in BOTH themes, so its content is fixed */
  --mc-bezel: #111;
  --mc-bevel: linear-gradient(145deg, #2c2f36, #17191d);
  --mc-shadow-panel: -10px 0 28px rgba(15,23,42,.22);
  --mc-shadow-modal: 0 18px 60px rgba(15,23,42,.4);
  --mc-shadow-pop: 0 8px 30px rgba(15,23,42,.35);
  --mc-shadow-device: 0 10px 30px rgba(15,23,42,.45);
  /* Space scale. Padding/margin/gap had drifted to 16 distinct lengths —
     1,2,3,4,5,6,7,8,9,10,12,14,16,18,24 — including four pairs one pixel
     apart, which is a ladder rather than a scale. Everything now lands on
     2/4/6/8/10/12/16/24; radius stays a separate axis. */
  --mc-s1: 2px; --mc-s2: 4px; --mc-s3: 6px; --mc-s4: 8px; --mc-s5: 10px;
  --mc-s6: 12px; --mc-s7: 16px; --mc-s9: 24px;
  --mc-r-xs: 2px; --mc-r-sm: 6px; --mc-r-ctl: 7px; --mc-r-md: 8px;
  --mc-r-lg: 10px; --mc-r-xl: 14px; --mc-r-pill: 999px;
  /* the phone shell is deliberately rounder than --mc-r-xl so the bezel reads
     as a physical casing rather than a card; 26px is a shape, not a step */
  --mc-r-bezel: 26px;
  /* --mc-sans is inherit, not a system stack of our own. The panel lives
     inside the DSH shell, which already picks the family; declaring
     -apple-system/"Segoe UI" here overrode it and was also the single most
     recognisable generic-AI font tell in this stylesheet. --mc-mono stays a
     real stack because log and identifier alignment is a functional need. */
  --mc-sans: inherit;
  --mc-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* One scale, four roles, ~1.2 ratio. All rem, so it follows the host root
     size and the user's browser font setting instead of being pinned in px.
     The previous layer had seven steps at 10/11/12/13/14/15/16px — a 1px
     ladder, not a scale, and muddy: nothing read as clearly subordinate.
     Hierarchy here comes from weight and colour as much as size. */
  --mc-fs-caption: 0.75rem;   /* 12px @16 — micro labels only: badges, picker section labels */
  --mc-fs-label: 0.875rem;    /* 14px @16 — controls and secondary reading text: hints, captions, logs */
  --mc-fs-body: 1rem;         /* 16px @16 — reading text: status, errors, prose */
  --mc-fs-title: 1.25rem;     /* 20px @16 — panel and modal titles */
  /* Two weights, two roles. 700 is headings only; 600 is every other
     emphasis. Several small labels used to be 700 next to a 700 heading. */
  --mc-fw-medium: 600;
  --mc-fw-bold: 700;
  --mc-lh-tight: 1.2;  /* titles and single-line chrome */
  --mc-lh-body: 1.5;   /* reading text */
  --mc-lh-code: 1.6;   /* monospace blocks */
  /* One duration, one curve, used by every transition. The panel had .12s in
     one rule and .15s in another with no easing declared at all — the browser
     default 'ease' is symmetric, which reads as a sluggish start on a 150ms
     UI transition. This curve is ease-out-quart: fast out of the gate, long
     soft landing. No bounce or elastic anywhere. */
  --mc-dur: 150ms;
  --mc-ease: cubic-bezier(.2, 0, 0, 1);
  /* The panel floats above the whole shell and a modal floats above the panel.
     Named so the two numbers are not magic in three separate places. */
  /* stacking tiers: local handle < popover < panel < modal. The panel sits far
     above the rest because it has to clear the DSH host's own chrome. */
  --mc-z-handle: 2;
  --mc-z-pop: 50;
  --mc-z-panel: 999999;
  --mc-z-modal: 1000000;
}

[data-dsh-mobilecode-entry] {
  display: flex; align-items: center; gap: var(--mc-s4); width: 100%;
  padding: var(--mc-s4) var(--mc-s6); margin: var(--mc-s1) 0; border: 0; border-radius: var(--mc-r-md);
  background: transparent; color: inherit; font: inherit; cursor: pointer;
  text-align: left;
}
[data-dsh-mobilecode-entry]:hover { background: var(--mc-hover-soft); }
[data-dsh-mobilecode-entry][data-active] { background: var(--mc-active); }
[data-dsh-mobilecode-entry] .mc-entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
[data-dsh-mobilecode-entry] .mc-entry-label { font-size: var(--mc-fs-title); line-height: var(--mc-lh-tight); opacity: .92; }
.dsh-mobilecode-view { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 94vw); z-index: var(--mc-z-panel); left: auto; }
.dsh-mobilecode-view[hidden] { display: none !important; }
.dsh-mobilecode-panel {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: var(--mc-bg);
  color: var(--mc-text);
  border-left: 1px solid var(--mc-border);
  box-shadow: var(--mc-shadow-panel);
}
.dsh-mobilecode-resize { position: absolute; left: -6px; top: 0; bottom: 0; width: 12px; cursor: col-resize; z-index: var(--mc-z-handle); display: flex; align-items: center; justify-content: center; }
.dsh-mobilecode-resize::before { content: ""; width: 3px; height: 48px; border-radius: var(--mc-r-xs); background: var(--mc-grip); transition: background var(--mc-dur) var(--mc-ease), transform var(--mc-dur) var(--mc-ease); }
.dsh-mobilecode-resize:hover::before, .dsh-mobilecode-resize[data-drag]::before { background: var(--mc-grip-hover); transform: scaleY(1.5); }
.mc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-family: var(--mc-sans); font-kerning: normal; }
/* The drawer is dragged between 320px and innerWidth-40, so its width has
   nothing to do with the viewport: a 1600px window can hold a 340px pane.
   This wrapper is the query container the narrow-pane rules resolve against.
   The modal is a SIBLING of it on purpose — container-type implies layout
   containment, which would make this element the containing block for the
   fixed-position .mc-overlay and trap the dialog inside the drawer. */
.mc-panel-col { container-type: inline-size; display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mc-header { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s5) var(--mc-s6); border-bottom: 1px solid var(--mc-border); flex: none; }
.mc-title { font-size: var(--mc-fs-title); font-weight: var(--mc-fw-bold); margin: 0; letter-spacing: -0.01em; flex: 1; line-height: var(--mc-lh-tight); }
.mc-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; gap: var(--mc-s2); padding: var(--mc-s2) var(--mc-s4); border-radius: var(--mc-r-sm); font-size: var(--mc-fs-label); }
.mc-close:hover { background: var(--mc-hover); }
.mc-body { flex: 1; min-height: 0; overflow: auto; padding: var(--mc-s6) var(--mc-s6); display: flex; flex-direction: column; gap: var(--mc-s6); }
.mc-row { display: flex; align-items: center; gap: var(--mc-s4); }
.mc-input { flex: 1; min-width: 0; background: var(--mc-bg-inset); border: 1px solid var(--mc-field-border); border-radius: var(--mc-r-ctl); color: inherit; font: inherit; font-size: var(--mc-fs-label); padding: var(--mc-s3) var(--mc-s4); }
/* :focus, not :focus-visible, and deliberately: a text field shows a caret the
   moment it is clicked, so its ring has to appear then too. Every other control
   here uses :focus-visible, because a mouse click on a button is not a state a
   sighted keyboard user needs painted. */
.mc-input:focus { outline: 2px solid var(--mc-focus); outline-offset: 1px; border-color: var(--mc-focus); }
.mc-btn { border: 1px solid var(--mc-border-strong); background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); padding: var(--mc-s3) var(--mc-s5); border-radius: var(--mc-r-ctl); cursor: pointer; transition: background var(--mc-dur) var(--mc-ease); white-space: nowrap; }
.mc-btn:hover { background: var(--mc-hover); }
.mc-btn[data-on] { background: var(--mc-accent-weak); border-color: var(--mc-accent-line); color: var(--mc-accent); }
.mc-btn:disabled { opacity: .45; cursor: default; }
.mc-btn.primary { background: var(--mc-accent); border-color: var(--mc-accent); color: var(--mc-on-accent); }
.mc-btn.primary:hover { background: var(--mc-accent-hover); }
.mc-btn.danger { color: var(--mc-err); }
.mc-pills { display: flex; gap: var(--mc-s3); flex-wrap: wrap; }
.mc-pill { display: inline-flex; align-items: center; gap: var(--mc-s3); border: 1px solid var(--mc-border-strong); background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); padding: var(--mc-s2) var(--mc-s5); border-radius: var(--mc-r-pill); cursor: pointer; }
.mc-pill:hover { background: var(--mc-hover); }
.mc-pill[data-on] { background: var(--mc-accent-weak); border-color: var(--mc-accent-line); color: var(--mc-accent); }
.mc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--mc-idle); }
.mc-dot.on { background: var(--mc-ok); box-shadow: 0 0 6px var(--mc-ok-glow); }
.mc-dot.off { background: var(--mc-idle); }
.mc-dot.warn { background: var(--mc-warn); }
.mc-dot.err { background: var(--mc-err); }
.mc-card { border: 1px solid var(--mc-border); border-radius: var(--mc-r-lg); padding: var(--mc-s5) var(--mc-s6); display: flex; flex-direction: column; gap: var(--mc-s4); }
.mc-card-head { display: flex; align-items: center; gap: var(--mc-s4); font-size: var(--mc-fs-title); font-weight: var(--mc-fw-bold); line-height: var(--mc-lh-tight); }
.mc-card-head .sp { flex: 1; }
.mc-status { font-size: var(--mc-fs-body); color: var(--mc-text-dim); display: flex; flex-direction: column; gap: var(--mc-s1); }
.mc-status b { font-weight: var(--mc-fw-medium); color: inherit; }
.mc-error { font-size: var(--mc-fs-body); color: var(--mc-err); background: var(--mc-err-weak); border: 1px solid var(--mc-err-line); border-radius: var(--mc-r-ctl); padding: var(--mc-s4) var(--mc-s4); white-space: pre-wrap; word-break: break-all; }
.mc-log-toggle { color: var(--mc-accent); cursor: pointer; border: 0; background: transparent; padding: var(--mc-s1) 0; text-align: left; font: inherit; font-size: var(--mc-fs-label); min-height: 24px; }
.mc-log-toggle, .mc-card-open { transition: color var(--mc-dur) var(--mc-ease); }
.mc-log-toggle:hover, .mc-card-open:hover { color: var(--mc-accent-hover); text-decoration: underline; }
.mc-log, .mc-logline { max-height: 180px; overflow: auto; background: var(--mc-bg-inset); border-radius: var(--mc-r-md); padding: var(--mc-s4) var(--mc-s5); margin: 0; font-size: var(--mc-fs-label); line-height: var(--mc-lh-code); white-space: pre-wrap; word-break: break-all; font-family: var(--mc-mono); font-variant-numeric: tabular-nums; }
.mc-frame { width: 100%; height: clamp(180px, 38vh, 300px); border: 1px solid var(--mc-border); border-radius: var(--mc-r-lg); background: var(--mc-stage); display: block; }
.mc-empty { color: var(--mc-text-faint); font-size: var(--mc-fs-body); padding: var(--mc-s4) 0; }
.mc-footer { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s3) var(--mc-s6); border-top: 1px solid var(--mc-border); flex: none; font-size: var(--mc-fs-label); color: var(--mc-text-mute); flex-wrap: wrap; }
/* ── welcome modal ── */
.mc-overlay { position: fixed; inset: 0; z-index: var(--mc-z-modal); display: flex; align-items: center; justify-content: center; background: var(--mc-scrim); backdrop-filter: blur(2px); padding: var(--mc-s9); }
.mc-modal { width: min(680px, 100%); max-height: 88vh; overflow: auto; background: var(--mc-bg-raised); color: var(--mc-text-strong); border: 1px solid var(--mc-border); border-radius: var(--mc-r-xl); box-shadow: var(--mc-shadow-modal); display: flex; flex-direction: column; }
.mc-modal-head { display: flex; align-items: center; gap: var(--mc-s5); padding: var(--mc-s6) var(--mc-s7); border-bottom: 1px solid var(--mc-border); flex: none; }
.mc-modal-title { font-size: var(--mc-fs-title); font-weight: var(--mc-fw-bold); margin: 0; flex: 1; line-height: var(--mc-lh-tight); }
.mc-modal-body { padding: var(--mc-s7) var(--mc-s7); display: flex; flex-direction: column; gap: var(--mc-s6); font-size: var(--mc-fs-body); line-height: var(--mc-lh-body); }
.mc-modal-foot { padding: var(--mc-s6) var(--mc-s7); border-top: 1px solid var(--mc-border); display: flex; align-items: center; gap: var(--mc-s4); flex-wrap: wrap; flex: none; }
.mc-modal-foot .sp { flex: 1; }
.mc-modal h3 { margin: 0; font-size: var(--mc-fs-title); }
.mc-prompt { position: relative; }
.mc-prompt pre { margin: 0; max-height: 220px; overflow: auto; background: var(--mc-bg-inset); border: 1px solid var(--mc-border); border-radius: var(--mc-r-md); padding: var(--mc-s5) var(--mc-s6); font-size: var(--mc-fs-label); line-height: var(--mc-lh-code); white-space: pre-wrap; word-break: break-word; font-family: var(--mc-mono); }
.mc-copy { position: absolute; top: 8px; right: 8px; }
.mc-tabs { display: flex; gap: var(--mc-s2); padding: 0 var(--mc-s7); border-bottom: 1px solid var(--mc-border); flex: none; }
.mc-tab { border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); padding: var(--mc-s4) var(--mc-s6); cursor: pointer; border-bottom: 2px solid transparent; opacity: .65; transition: opacity var(--mc-dur) var(--mc-ease); }
.mc-tab[data-on] { opacity: 1; border-bottom-color: var(--mc-accent); color: var(--mc-accent); }
/* :not([data-on]) keeps the selected tab at full opacity — both selectors would
   otherwise have equal specificity and the hover rule would win. */
.mc-tab:not([data-on]):hover { opacity: .85; }
.mc-check { display: flex; align-items: flex-start; gap: var(--mc-s4); padding: var(--mc-s4) var(--mc-s5); border: 1px solid var(--mc-border); border-radius: var(--mc-r-md); font-size: var(--mc-fs-body); line-height: var(--mc-lh-body); }
.mc-check .mc-check-ico { flex: none; font-weight: var(--mc-fw-medium); width: 18px; text-align: center; }
.mc-check .mc-check-detail { flex: 1; min-width: 0; word-break: break-all; }
.mc-check .mc-check-name { font-weight: var(--mc-fw-medium); }
.mc-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--mc-spin-track); border-top-color: var(--mc-accent); border-radius: 50%; animation: mc-spin .8s linear infinite; vertical-align: -2px; }
@keyframes mc-spin { to { transform: rotate(360deg); } }
.mc-hint { font-size: var(--mc-fs-label); color: var(--mc-text-mute); }
/* ── DSH Settings page contribution ── */
.mc-section { display: flex; flex-direction: column; gap: var(--mc-s2); padding: var(--mc-s2) var(--mc-s3) var(--mc-s7); }
.mc-section-head { display: flex; align-items: center; gap: var(--mc-s5); flex-wrap: wrap; padding: var(--mc-s1) 0 var(--mc-s5); }
.mc-section-head .mc-hint { flex: 1; min-width: 200px; }
.mc-section .mc-tabs { padding: 0; margin-bottom: var(--mc-s2); }
/* ── live device stream ── */
.mc-live { display: flex; flex-direction: column; gap: var(--mc-s4); }
.mc-live-stage { position: relative; align-self: center; background: var(--mc-stage); border-radius: var(--mc-r-lg); overflow: hidden; line-height: 0; box-shadow: inset 0 0 0 1px var(--mc-border); }
.mc-live-stage img { display: block; max-width: 100%; max-height: 60vh; width: auto; height: auto; cursor: crosshair; touch-action: none; user-select: none; }
.mc-live-stage .mc-live-off { display: flex; align-items: center; justify-content: center; width: 260px; max-width: 100%; height: 460px; color: var(--mc-text-mute); font-size: var(--mc-fs-body); line-height: var(--mc-lh-body); text-align: center; }
/* 0.9.1 co-op: two forced columns — side-by-side MUST survive a narrow drawer. */
.mc-live-section { display: flex; flex-direction: column; gap: var(--mc-s5); }
.mc-live-section.coop { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: var(--mc-s5); align-items: start; }
.mc-live-section.coop > .mc-card { min-width: 0; }
/* 0.11.6: the co-op head must NEVER wrap to a second row — a wrapped
   head offsets one pane's stage ~38px lower than its sibling's, which
   read as "the bars in Device 1 make the heights differ". Children
   shrink instead (picker/select ellipsize). 0.11.7: the button must
   also TRACK its shrinking .mc-picker container — at intrinsic width
   it overflowed sideways under the ☰/⧉ buttons. */
.mc-live-section.coop .mc-card-head { flex-wrap: nowrap; min-width: 0; }
.mc-card-head .mc-picker { flex: 1 1 auto; min-width: 0; }
.mc-card-head .mc-picker > .mc-btn { width: 100%; min-width: 0; }
/* No coop-specific height cap: both panes must share Device 1's 60vh rule so
   they match at every size, Fit included (0.11.2). */
.mc-coop-select { width: auto; min-width: 0; flex: 0 1 auto; padding: var(--mc-s2) var(--mc-s3); font-size: var(--mc-fs-label); }
.mc-live-cap { font-size: var(--mc-fs-label); color: var(--mc-text-mute); text-align: center; }
.mc-device-list { display: flex; flex-direction: column; gap: var(--mc-s2); margin: var(--mc-s4) 0; }
.mc-device-row { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s3) var(--mc-s4); border: 1px solid var(--mc-border); border-radius: var(--mc-r-md); }
.mc-dot[data-on="true"] { background: var(--mc-ok); box-shadow: 0 0 6px var(--mc-ok-glow); }
.mc-serial { font-weight: var(--mc-fw-medium); font-family: var(--mc-mono); font-size: var(--mc-fs-label); font-variant-numeric: tabular-nums; }
.mc-badge { font-size: var(--mc-fs-caption); padding: var(--mc-s1) var(--mc-s4); border-radius: var(--mc-r-pill); background: var(--mc-bg-inset); }
.mc-conn-form { display: flex; flex-direction: column; gap: var(--mc-s3); margin: var(--mc-s4) 0; }
/* Content-driven reflow, not a breakpoint: the row wraps as soon as the text
   field can no longer be given 140px, which is what happens at ~320px inside
   the 680px modal (there the IP field used to squeeze to ~84px). */
.mc-conn-row { display: flex; align-items: center; gap: var(--mc-s3); flex-wrap: wrap; }
.mc-conn-row .mc-input:not(.mc-input-sm) { flex: 1 1 140px; }
.mc-conn-row .mc-input-sm { flex: 0 1 72px; }
.mc-conn-row .mc-btn { flex: 0 0 auto; }
.mc-qr { margin: var(--mc-s4) 0; padding: var(--mc-s4); border: 1px dashed var(--mc-border-strong); border-radius: var(--mc-r-md); }
.mc-qr-text { user-select: all; font-family: var(--mc-mono); font-size: var(--mc-fs-label); word-break: break-all; margin: var(--mc-s2) 0 0; }
.mc-warn { color: var(--mc-err); font-size: var(--mc-fs-body); margin: var(--mc-s3) 0; }
/* ── 0.7.0: toolbar pill, picker popover, device menu, sizes, frames ── */
.mc-toolbar { display: flex; align-items: center; justify-content: center; gap: var(--mc-s1); row-gap: var(--mc-s1); flex-wrap: wrap; max-width: 100%; padding: var(--mc-s2); border: 1px solid var(--mc-border-strong); border-radius: var(--mc-r-pill); background: var(--mc-bg-inset); align-self: center; }
.mc-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 28px; border: 0; background: transparent; color: inherit; border-radius: var(--mc-r-pill); cursor: pointer; opacity: .8; }
.mc-toolbar button:hover:not(:disabled) { background: var(--mc-hover); opacity: 1; }
.mc-toolbar button:disabled { opacity: .3; cursor: default; }
/* A press state, because these two families start work that takes a second or
   more: without it the click looks unregistered for the whole round trip. It is
   a transform rather than a colour so it reads the same on a primary button, a
   quiet one and an icon button — and transform is compositor-only, so the press
   lands on the next frame instead of easing in. Deliberately left off the
   selection controls (.mc-tab, .mc-seg button): their [data-on] state IS the
   feedback and it lands on the same frame, so a press state would be a second
   answer to the same question. */
.mc-btn:active:not(:disabled), .mc-toolbar button:active:not(:disabled) { transform: translateY(1px); }
.mc-toolbar svg { display: block; }
.mc-live-badge { display: inline-flex; align-items: center; gap: var(--mc-s2); font-size: var(--mc-fs-caption); font-weight: var(--mc-fw-medium); color: var(--mc-ok); }
.mc-picker { position: relative; }
.mc-picker .mc-btn { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-picker-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: var(--mc-z-pop); min-width: 240px; max-width: 320px; max-height: 320px; overflow: auto; background: var(--mc-bg-pop); color: inherit; border: 1px solid var(--mc-border-strong); border-radius: var(--mc-r-lg); box-shadow: var(--mc-shadow-pop); padding: var(--mc-s3); display: flex; flex-direction: column; gap: var(--mc-s3); }
.mc-picker-group { display: flex; flex-direction: column; gap: var(--mc-s1); }
.mc-picker-label { font-size: var(--mc-fs-caption); text-transform: uppercase; letter-spacing: .06em; color: var(--mc-text-mute); padding: var(--mc-s1) var(--mc-s3); }
.mc-picker-row { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s3) var(--mc-s4); border: 1px solid transparent; border-radius: var(--mc-r-ctl); background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); text-align: left; }
.mc-picker-row:hover { background: var(--mc-hover); }
.mc-picker-row.on { background: var(--mc-accent-weak); }
.mc-picker-hint { font-size: var(--mc-fs-label); color: var(--mc-text-mute); padding: var(--mc-s2) var(--mc-s4); }
.mc-picker-row .sp { flex: 1; }
.mc-picker-row .mc-btn { padding: var(--mc-s1) var(--mc-s4); font-size: var(--mc-fs-label); }
/* The row itself is inert: its ACTION is this button, which is why the row
   carries no cursor, no role and no tabindex. It stretches to the row's full
   height, because moving the action off the row would otherwise have shrunk
   the target from the whole row down to the height of the text in it. */
.mc-pick { display: flex; align-items: center; gap: var(--mc-s4); flex: 1 1 auto; align-self: stretch; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); text-align: left; cursor: pointer; border-radius: var(--mc-r-ctl); }
/* A long AVD name plus its serial is ~250px of 14px mono inside a 240-320px
   popover, so it truncates instead of widening the popover. */
.mc-picker-row .mc-serial { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-menu-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: var(--mc-z-pop); min-width: 180px; background: var(--mc-bg-pop); color: inherit; border: 1px solid var(--mc-border-strong); border-radius: var(--mc-r-lg); box-shadow: var(--mc-shadow-pop); padding: var(--mc-s2); display: flex; flex-direction: column; }
.mc-menu-pop button { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s4) var(--mc-s5); border: 0; border-radius: var(--mc-r-ctl); background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); cursor: pointer; text-align: left; }
.mc-menu-pop button:hover { background: var(--mc-hover); }
.mc-menu { position: relative; }
.mc-live-sizesel { flex: 0 1 auto; width: 92px; }
.mc-live-size { display: flex; align-items: center; gap: var(--mc-s3); flex-wrap: wrap; }
.mc-seg { display: inline-flex; border: 1px solid var(--mc-border-strong); border-radius: var(--mc-r-md); overflow: hidden; }
.mc-seg button { border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--mc-fs-label); padding: var(--mc-s2) var(--mc-s4); cursor: pointer; opacity: .6; transition: opacity var(--mc-dur) var(--mc-ease); }
.mc-seg button[data-on] { background: var(--mc-accent-weak); color: var(--mc-accent); opacity: 1; }
.mc-seg button:not([data-on]):hover { opacity: .8; }
.mc-live-stage.fit { width: min(100%, calc(60vh * var(--mc-ar-n, 0.45))); aspect-ratio: var(--mc-ar-n, 0.45); display: flex; align-items: center; justify-content: center; margin-inline: auto; }
.mc-live-stage.fit img { width: auto; height: auto; max-width: 100%; max-height: 100%; object-fit: contain; }
.mc-live-stage.bezel { padding: var(--mc-s4); background: var(--mc-bezel); border-radius: var(--mc-r-xl); }
.mc-live-stage.device { padding: var(--mc-s6); background: var(--mc-bevel); border-radius: var(--mc-r-bezel); box-shadow: var(--mc-shadow-device); }
/* ── 0.7.0: compact conversation cards ── */
.mc-card-compact { display: flex; align-items: center; gap: var(--mc-s4); padding: var(--mc-s4) var(--mc-s6); border: 1px solid var(--mc-border); border-radius: var(--mc-r-lg); font-size: var(--mc-fs-label); background: var(--mc-bg-inset); }
.mc-card-compact .mc-card-kind { font-weight: var(--mc-fw-medium); }
.mc-badge.ok { background: var(--mc-ok-weak); color: var(--mc-ok); }
.mc-card-open { color: var(--mc-accent); cursor: pointer; border: 0; background: transparent; padding: var(--mc-s1) var(--mc-s2); font: inherit; font-size: var(--mc-fs-label); }
/* ── 0.7.0: composer status capsule ── */
.mc-capsule { display: inline-flex; align-items: center; gap: var(--mc-s3); padding: var(--mc-s3) var(--mc-s6); border: 1px solid var(--mc-ok-line); border-radius: var(--mc-r-pill); background: var(--mc-ok-weak); color: var(--mc-ok); font: inherit; font-size: var(--mc-fs-label); font-weight: var(--mc-fw-medium); cursor: pointer; flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden; }
.mc-capsule-serial { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-capsule:hover { background: var(--mc-ok-hover); }
/* ── visible keyboard focus everywhere, and a focusable file input ── */
.mc-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
[data-dsh-mobilecode-entry]:focus-visible,
.mc-panel button:focus-visible, .mc-panel select:focus-visible,
.mc-modal button:focus-visible, .mc-modal select:focus-visible,
.mc-section button:focus-visible, .mc-section select:focus-visible,
.dsh-mobilecode-resize:focus-visible {
  outline: 2px solid var(--mc-focus);
  outline-offset: 2px;
}
.mc-live-stage img:focus-visible { outline: 3px solid var(--mc-focus); outline-offset: -3px; }
.mc-log:focus-visible, .mc-logline:focus-visible { outline: 2px solid var(--mc-focus); outline-offset: 2px; }
/* The dialog takes focus when it opens so the Tab trap has somewhere to start.
   It is not a control and cannot be activated, so a ring around the whole panel
   would be noise — the ring belongs on the control the user tabs to next. */
.mc-modal:focus { outline: none; }
/* ── adaptation layer ──
   The pane is a right-hand drawer: 560px on a desktop, the full viewport on a
   phone. It is also reachable from the DSH Settings page, which is a normal
   document column. Both contexts have to hold up, so the rules below are
   either content-driven (flex-basis / clamp) or scoped to a context that
   genuinely changes the layout — not decorative breakpoints.

   The drawer's width is independent of the window (320px .. innerWidth-40), so
   the panel rules key on the PANE through .mc-panel-col, not on the viewport.
   Only the modal — fixed to the viewport — and the Settings section — in the
   host's own column — use @media, because neither has the drawer as an
   ancestor and a container query could never match them. A browser without
   @container support drops those two blocks and gets the desktop layout it had
   before: degraded, never broken. */
@container (max-width: 640px) {
  /* The only panel rule that genuinely depends on the pane width. The padding
     rules that used to sit here were no-ops: .mc-body, .mc-header and
     .mc-footer already declare var(--mc-s6) horizontally in their base rules. */
  .mc-live-stage .mc-live-off { width: 100%; min-width: 200px; height: 320px; }
}
@container (max-width: 380px) {
  .mc-body { padding-left: var(--mc-s5); padding-right: var(--mc-s5); }
  .mc-toolbar button { width: 34px; height: 30px; }
}
@media (max-width: 640px) {
  .mc-modal-body { padding-left: var(--mc-s6); padding-right: var(--mc-s6); }
  .mc-modal-head, .mc-modal-foot { padding-left: var(--mc-s6); padding-right: var(--mc-s6); }
  .mc-tabs { padding-left: var(--mc-s6); padding-right: var(--mc-s6); overflow-x: auto; scrollbar-width: none; }
  .mc-tabs::-webkit-scrollbar { display: none; }
  .mc-section .mc-tabs { padding-left: 0; padding-right: 0; }
  .mc-overlay { padding: var(--mc-s6); }
  .mc-modal { max-height: 92vh; }
}
/* Short viewports (phone landscape, split-screen): the stage is the biggest
   consumer of height, so cap it before anything else gives way. */
@media (max-height: 560px) {
  .mc-live-stage img { max-height: 44vh; }
  .mc-live-stage .mc-live-off { height: 260px; }
  .mc-modal { max-height: 94vh; }
}
/* Touch input: reach the 44px target the pointer now demands, and stop relying
   on :hover for anything load-bearing. Applies to hybrid touch laptops too,
   which is why it keys off pointer capability rather than viewport width. */
@media (pointer: coarse) {
  /* Promote the micro role ITSELF rather than the three classes that consume it,
     so the scale stays closed (still four roles) and a future fourth consumer
     cannot opt out by accident. 12px uppercase tracked text is under the 14px
     floor /harden sets for touch; a fine pointer keeps the compact badge
     density, which is where the small pill look belongs. */
  :root { --mc-fs-caption: var(--mc-fs-label); }
  .mc-panel button, .mc-panel select, .mc-panel input,
  .mc-modal button, .mc-modal select, .mc-modal input,
  .mc-section button, .mc-section select, .mc-section input,
  .mc-picker-row, .mc-menu-pop button, [data-dsh-mobilecode-entry] {
    min-height: 44px;
  }
  .mc-toolbar button { width: 44px; height: 44px; }
  .mc-toolbar { border-radius: var(--mc-r-xl); }
  .mc-seg button { padding: var(--mc-s2) var(--mc-s6); }
  .mc-tab, .mc-pill, .mc-log-toggle { min-height: 44px; }
  /* A 44px nested button would make every picker row ~56px tall and halve the
     number of devices visible in the popover; the ROW still carries the 44px. */
  .mc-picker-row .mc-btn { min-height: 32px; }
  /* Both controls stay 32px so the popover keeps its row density, but their
     hit AREA reaches 44px: the row's padding is 6px, so inset -6px 0 lands
     exactly on the row's bounds and stays inside them. The rows sit 2px
     apart, so an overshoot would put two devices under one finger. .mc-pick
     is stretched to the row's height, so the same -6px reaches the same 44px.
     WCAG 2.5.8 measures what responds to the pointer, not what is painted. */
  .mc-picker-row .mc-btn, .mc-pick { position: relative; }
  .mc-picker-row .mc-btn::after, .mc-pick::after { content: ""; position: absolute; inset: -6px 0; }
  .dsh-mobilecode-resize { width: 24px; left: -12px; }
  .dsh-mobilecode-resize::before { width: 5px; height: 64px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-mobilecode-view *, .mc-modal * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
  .mc-spin { animation: none; border-top-color: currentColor; opacity: .6; }
}
@media print {
  .dsh-mobilecode-view, .mc-overlay, [data-dsh-mobilecode-entry] { display: none !important; }
}
/* The narrowest tier, and the last block in the stylesheet on purpose: it has
   to outrank the pointer:coarse sizing above, which widens the handle to 24px
   and pushes it to left:-12px. At this width mountPanel floors the drawer at
   MIN_WIDTH, so the pane sits flush against the viewport edge and a handle
   hanging off the left would be off-screen entirely. The modal gutter tightens
   here too — its 640px tier lives in the block above, and one tier per query
   beats a second @media (max-width: 380px) further up the sheet. */
@media (max-width: 380px) {
  .mc-modal-body { padding-left: var(--mc-s5); padding-right: var(--mc-s5); }
  .dsh-mobilecode-resize { left: 0; width: 16px; }
  .dsh-mobilecode-resize::before { width: 4px; height: 48px; }
}
`;
		//#endregion

		const API_BASE = "/api/dsh-mobilecode";
		// Shown on both stream captions so a refresh visibly proves which client
		// bundle the browser is actually running. Kept in lockstep with
		// package.json by test/client.mjs.
		const MC_VERSION = "0.13.1";
		// The panel shows cards for platforms the host can actually drive; the
		// server reports its OS in info.os (iOS tooling is darwin-only).
		const fallbackPlatforms = (os) => (os === "darwin" ? ["ios", "android"] : ["android"]);
		const label = (p) => (p === "ios" ? "iOS" : "Android");
		// Shared by both panes so Device 1 and Device 2 scale identically (0.11.0).
		const stageSizeStyle = (m) => (m.mode === "pct"
			? { width: m.value + "%", maxWidth: "100%", maxHeight: "60vh" }
			: m.mode === "px"
				? { width: m.value + "px", maxWidth: "100%", maxHeight: "60vh" }
				: {});
		// Fit panes lock to a shared stage height so devices with different
		// aspect ratios still sit at the same height (0.11.3); presets stay
		// width-driven (S·240 / M·320 = device width px).
		const stageClassFor = (f, fit = false) => "mc-live-stage" + (fit ? " fit" : "") + (f !== "none" ? " " + f : "");
		const SIZE_PRESETS = [
			{ label: "Fit", mode: { mode: "fit" } },
			{ label: "100%", mode: { mode: "pct", value: 100 } },
			{ label: "S · 240", mode: { mode: "px", value: 240 } },
			{ label: "M · 320", mode: { mode: "px", value: 320 } },
		];
		/** Size presets + px/% select + frame seg — shared by both stream panes
		 *  (0.11.2) so Device 2 gets the same controls as Device 1. */
		function StageControls({ sizeMode, setSizeMode, frame, setFrame }) {
			const isCurrent = (m) => m.mode === sizeMode.mode && (m.value === undefined || m.value === sizeMode.value);
			return h("div", { className: "mc-live-size" },
				h("span", { className: "mc-hint" }, "Size"),
				h("div", { className: "mc-seg", role: "group", "aria-label": "Stage size preset" }, SIZE_PRESETS.map((p) => h("button", { key: p.label, type: "button", "data-on": isCurrent(p.mode) || undefined, "aria-pressed": isCurrent(p.mode), onClick: () => setSizeMode(p.mode) }, p.label))),
				h("select", { className: "mc-input mc-live-sizesel", "aria-label": "Stage size", value: sizeMode.mode === "pct" ? sizeMode.value + "%" : sizeMode.mode === "px" ? String(sizeMode.value) : "fit", onChange: (e) => {
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
				h("div", { className: "mc-seg", role: "group", "aria-label": "Stage frame" },
					h("button", { type: "button", "data-on": frame === "none" || undefined, "aria-pressed": frame === "none", onClick: () => setFrame("none") }, "none"),
					h("button", { type: "button", "data-on": frame === "bezel" || undefined, "aria-pressed": frame === "bezel", onClick: () => setFrame("bezel") }, "bezel"),
					h("button", { type: "button", "data-on": frame === "device" || undefined, "aria-pressed": frame === "device", onClick: () => setFrame("device") }, "device"),
				),
			);
		}

		// Shared SVG icon paths for the stream toolbars (0.11.5 — both panes
		// carry the same navigation controls; Device 2 used to lack them).
		const NAV_ICONS = {
			back: "M15 18l-6-6 6-6",
			home: "M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5",
			recents: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
			screenshot: "M4 7h4l2-3h4l2 3h4v13H4zM12 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
			rotate: "M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6",
			refresh: "M4 12a8 8 0 0 1 13.7-5.6M20 5v5h-5M20 12a8 8 0 0 1-13.7 5.6M4 19v-5h5",
		};
		/** One icon toolbar row; items: {title, icon, run}. Used by both panes. */
		function ToolbarRow({ items }) {
			return h("div", { className: "mc-toolbar", role: "toolbar", "aria-label": "Device navigation" },
				items.map((item) => h("button", { key: item.title, type: "button", title: item.title, "aria-label": item.title, onClick: item.run },
					h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
						h("path", { d: item.icon }),
					),
				)),
			);
		}
		/** Back/Home/Recents/(Screen)/Rotate built from nav icons (0.11.5). */
		const navToolbar = (control, capture, refresh) => [
			{ title: "Back", icon: NAV_ICONS.back, run: () => control({ kind: "button", name: "back" }) },
			{ title: "Home", icon: NAV_ICONS.home, run: () => control({ kind: "button", name: "home" }) },
			{ title: "Recents", icon: NAV_ICONS.recents, run: () => control({ kind: "button", name: "recents" }) },
			...(capture ? [{ title: "Screenshot", icon: NAV_ICONS.screenshot, run: () => capture() }] : []),
			{ title: "Rotate", icon: NAV_ICONS.rotate, run: () => control({ kind: "rotate" }) },
			{ title: "Refresh", icon: NAV_ICONS.refresh, run: refresh },
		];
		/** ☰ device-actions popover; serial-bound, shared by both panes. */
		function DeviceMenu({ serial, onError }) {
			const [open, setOpen] = useState(false);
			const ACTION_ITEMS = [
				{ action: "notifications", label: "Notifications" },
				{ action: "quick_settings", label: "Quick settings" },
				{ action: "collapse", label: "Collapse" },
				{ action: "lock", label: "Lock" },
				{ action: "wake", label: "Wake" },
				{ action: "assistant", label: "Assistant" },
			];
			const run = async (action) => {
				if (serial === "") return;
				try { await streamPost("/stream/device-action", { device: serial, action }); setOpen(false); }
				catch (err) { onError(err instanceof Error ? err.message : String(err)); }
			};
			return h("div", { className: "mc-menu" },
				h("button", {
					className: "mc-btn", type: "button", disabled: serial === "",
					title: "Device actions", "aria-label": "Device actions",
					"aria-haspopup": "menu", "aria-expanded": open,
					onClick: () => setOpen((v) => !v),
				}, "☰"),
				open && h("div", { className: "mc-menu-pop", role: "menu", "aria-label": "Device actions" },
					ACTION_ITEMS.map((item) => h("button", { key: item.action, type: "button", role: "menuitem", onClick: () => run(item.action) }, item.label)),
				),
			);
		}

		function PanelController() {
			let panelOpen = false;
			// The snapshot MUST be referentially stable: useSyncExternalStore compares
			// the value it gets back on every render and re-renders forever on a fresh
			// object (React then throws "Maximum update depth exceeded"). One cached
			// object, replaced only when the state actually changes.
			let snapshot = { panelOpen };
			const listeners = new Set();
			const emit = () => { snapshot = { panelOpen }; for (const fn of listeners) fn(); };
			return {
				getSnapshot: () => snapshot,
				subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
				setOpen: (value) => { if (panelOpen === value) return; panelOpen = value; emit(); },
				toggle: () => { panelOpen = !panelOpen; emit(); },
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

		/**
		 * Keyboard activation for clickable non-buttons. Rows that carry their own
		 * <button> (the picker's ⏻ off) cannot themselves be a <button> — nesting
		 * buttons is invalid — so they get role=button + Enter/Space instead.
		 */
		const activatable = (run) => ({
			role: "button",
			tabIndex: 0,
			onClick: run,
			onKeyDown: (event) => {
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(); }
			},
		});

		/**
		 * Dialog behaviour shared by every modal: Escape closes, focus moves into
		 * the dialog, Tab is trapped inside it, and focus returns to whatever
		 * opened it (WCAG 2.4.3 Focus Order / 2.1.2 No Keyboard Trap).
		 */
		function useDialogA11y(onClose) {
			const ref = useRef(null);
			const closeRef = useRef(onClose);
			closeRef.current = onClose;
			useEffect(() => {
				const node = ref.current;
				if (!node) return undefined;
				const previous = document.activeElement;
				const focusables = () => Array.from(node.querySelectorAll(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				)).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
				(focusables()[0] ?? node).focus();
				const onKey = (event) => {
					if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); return; }
					if (event.key !== "Tab") return;
					const items = focusables();
					if (items.length === 0) { event.preventDefault(); return; }
					const first = items[0];
					const last = items[items.length - 1];
					if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
				};
				node.addEventListener("keydown", onKey);
				return () => {
					node.removeEventListener("keydown", onKey);
					if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
				};
			}, []);
			return ref;
		}

		// A memo boundary, because the panel re-renders on every keystroke in its
		// own directory field while this section's only prop comes from the POLLED
		// payload — so without it the ref list re-rendered on every character typed.
		const RefCompareSection = memo(function RefCompareSection({ directory }) {
			const [project, setProject] = useState(() => {
				const base = String(directory || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
				return base || "trachtenberg";
			});
			const [screen, setScreen] = useState("practice");
			const [stateId, setStateId] = useState("default");
			const [refs, setRefs] = useState([]);
			const [activeId, setActiveId] = useState(null);
			const [opacity, setOpacity] = useState(55);
			const [swipe, setSwipe] = useState(50);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [pair, setPair] = useState(null);
			const [pairVersion, setPairVersion] = useState(0);
			const fileRef = useRef(null);

			const loadRefs = async (proj) => {
				try {
					const data = await apiGet("/refs?project=" + encodeURIComponent(proj ?? project));
					setRefs(data.records ?? []);
					setActiveId(data.active?.id ?? null);
				} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
			};
			const loadPair = async () => {
				try {
					const data = await apiGet("/refs/compare?project=" + encodeURIComponent(project) +
						"&screen=" + encodeURIComponent(screen) + "&stateId=" + encodeURIComponent(stateId));
					setPair(data);
				} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
			};
			useEffect(() => { loadRefs(project); }, [project]);
			useEffect(() => { loadPair(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [project, screen, stateId, activeId, pairVersion]);

			const run = async (name, fn) => {
				setBusy(name); setError("");
				try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
				finally { setBusy(""); }
			};
			const importFile = async (file) => {
				if (!file) return;
				const data = await new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(file);
				});
				await run("import", async () => {
					await streamPost("/refs/import", { project, screen, stateId, filename: file.name, data, provenance: "manual-import", intendedUse: "compare" });
					await loadRefs(project); setPairVersion((v) => v + 1);
				});
			};
			const capture = async () => {
				await run("capture", async () => {
					await streamPost("/refs/capture", { project, screen, stateId });
					await loadRefs(project); setPairVersion((v) => v + 1);
				});
			};
			const setActive = async (id) => {
				await run("active", async () => {
					await streamPost("/refs/active", { id });
					setActiveId(id); setPairVersion((v) => v + 1);
				});
			};
			const remove = async (id) => {
				await run("remove", async () => {
					await streamPost("/refs/remove", { id });
					await loadRefs(project); setPairVersion((v) => v + 1);
				});
			};
			const [diff, setDiff] = useState(null);
			// Two ceilings, two different reasons. The DECODE ceiling is the browser's:
			// the platform already decoded the bitmap by the time we see naturalWidth,
			// so this only stops us from then allocating a canvas + ImageData copy of
			// an absurd image. The TRANSPORT ceiling is the one that actually bites —
			// /refs/diff caps its request body at 64 MiB (lib/index.js readBody) and a
			// frame travels as base64 RGBA, which inflates by 4/3, so TWO
			// full-resolution frames must fit in 64 MiB ⇒ ~6 MP each. Checking here
			// means a doomed comparison fails before a ~100 MB string is built and
			// posted, instead of after the server rejects the body.
			const MAX_DECODE_PIXELS = 40_000_000;
			const MAX_FULLRES_PIXELS = 6_000_000;
			const decodeFrame = async (src, maxDim = 480) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("image decode failed: " + src)); img.src = src; });
				const px = img.naturalWidth * img.naturalHeight;
				const mp = (px / 1_000_000).toFixed(1);
				if (px > MAX_DECODE_PIXELS) throw new Error(`image is ${mp} MP — over the ${MAX_DECODE_PIXELS / 1_000_000} MP decode ceiling`);
				if (maxDim === Infinity && px > MAX_FULLRES_PIXELS) throw new Error(`full-resolution diff needs a frame under ${MAX_FULLRES_PIXELS / 1_000_000} MP (this one is ${mp} MP) — two native frames must fit the 64 MB comparison body; use the downsampled design-reference comparison instead`);
				const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
				const w = Math.max(1, Math.round(img.naturalWidth * scale));
				const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
				const canvas = document.createElement("canvas");
				canvas.width = w; canvas.height = hgt;
				const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
				ctx2d.drawImage(img, 0, 0, w, hgt);
				return { width: w, height: hgt, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, rgba: ctx2d.getImageData(0, 0, w, hgt).data };
			};
			const runDiff = async (fullRes) => {
				if (!refSrc || !capSrc) { setError("need both a reference and a capture to diff"); return; }
				await run("diff", async () => {
					// Regression needs NATIVE frames: decode both at full resolution and
					// require equal original dimensions — the server re-checks them against
					// the stored records before any "passed" is possible. Different aspects
					// stay triage-only (downsampled, needs_review) — never a silent stretch.
					const sameSize = fullRes === true;
					const [a, b] = sameSize
						? await Promise.all([decodeFrame(refSrc, Infinity), decodeFrame(capSrc, Infinity)])
						: await Promise.all([decodeFrame(refSrc, 480), decodeFrame(capSrc, 480)]);
					if (a.width !== b.width || a.height !== b.height) throw new Error("frame sizes differ (" + a.width + "x" + a.height + " vs " + b.width + "x" + b.height + ") — aspects differ; only downsampled triage applies, record a transform for aligned comparison");
					// Chunked, measured: the per-byte version allocates a single-character
					// string for every byte and leaves btoa() a multi-million-link cons
					// rope to flatten first. Identical output, 407 ms -> 37 ms on a
					// 1080x2400 frame (10.4 MB of RGBA). 8 KiB slices also stay far under
					// the argument-count limit String.fromCharCode.apply() would hit.
					const toB64 = (f) => {
						const bytes = f.rgba.subarray ? f.rgba : Uint8Array.from(f.rgba);
						const parts = [];
						for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
						return btoa(parts.join(""));
					};
					const r = await streamPost("/refs/diff", {
						a: { width: a.width, height: a.height, rgba: toB64(a) },
						b: { width: b.width, height: b.height, rgba: toB64(b) },
						mode: sameSize ? "regression" : "design-reference", project, screen, stateId,
						referenceId: pair?.reference?.id, captureId: pair?.capture?.id,
					});
					setDiff(r);
				});
			};

			const imgUrl = (record) => record ? API_BASE + "/refs/image?id=" + encodeURIComponent(record.id) : null;
			const refSrc = imgUrl(pair?.reference ?? refs.find((r) => r.id === activeId));
			const capSrc = imgUrl(pair?.capture);
			// native regression only makes sense between IDENTICAL source sizes
			const sizeMatch = !!pair?.reference && !!pair?.capture &&
				pair.reference.width === pair.capture.width && pair.reference.height === pair.capture.height;
			const box = { position: "relative", width: "100%", aspectRatio: "9/19.5", background: "var(--mc-stage)", borderRadius: "var(--mc-r-md)", overflow: "hidden" };
			const fit = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" };

			return h("div", { className: "mc-card", style: { borderTop: "1px solid var(--mc-border)" } },
				h("div", { className: "mc-card-head" }, h("span", null, "Reference compare"),
					h("span", { className: "sp" }), h("span", { style: { opacity: 0.6, fontSize: "var(--mc-fs-label)" } }, busy || "slice")),
				h("div", { className: "mc-row" },
					h("input", { className: "mc-input", "aria-label": "Reference project", value: project, placeholder: "project", onChange: (e) => setProject(e.target.value), style: { flex: 1 } }),
				),
				h("div", { className: "mc-row" },
					h("input", { className: "mc-input", "aria-label": "Reference screen", value: screen, placeholder: "screen", onChange: (e) => setScreen(e.target.value), style: { flex: 1 } }),
					h("input", { className: "mc-input", "aria-label": "Reference state", value: stateId, placeholder: "state", onChange: (e) => setStateId(e.target.value), style: { flex: 1 } }),
				),
				h("div", { className: "mc-row" },
					h("button", { className: "mc-btn", type: "button", onClick: () => fileRef.current?.click() },
						busy !== "" ? "Importing…" : "Import reference"),
					h("input", {
						ref: fileRef, type: "file", className: "mc-visually-hidden", tabIndex: -1, "aria-hidden": "true",
						accept: "image/png,image/jpeg,image/webp",
						onChange: (e) => { importFile(e.target.files?.[0]); e.target.value = ""; },
					}),
					h("button", { className: "mc-btn primary", disabled: busy !== "", onClick: capture }, "Capture screen"),
					h("button", { className: "mc-btn", disabled: busy !== "" || !refSrc || !capSrc, title: "reduced-resolution structure triage — needs_review only, can never pass regression", onClick: () => runDiff(false) }, "Diff (triage)"),
					h("button", { className: "mc-btn", disabled: busy !== "" || !refSrc || !capSrc || !sizeMatch, title: sizeMatch ? "full-resolution native comparison — regression verdict" : "source sizes differ — a native regression comparison is invalid between different configurations", onClick: () => runDiff(true) }, "Regression (full-res)"),
				),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				h("div", { style: { position: "relative" } },
					(refSrc || capSrc)
						? h("div", { style: box },
							refSrc && h("img", { src: refSrc, style: fit, alt: "reference" }),
							capSrc && h("img", { src: capSrc, alt: "captured screen", style: { ...fit, clipPath: "inset(0 " + (100 - swipe) + "% 0 0)", opacity: opacity / 100 } },
								/* capture overlaid on reference */),
							h("div", { style: { position: "absolute", left: swipe + "%", top: 0, bottom: 0, width: 1, background: "var(--mc-stage-fg)" } }),
						)
						: h("div", { className: "mc-empty" }, "Import a reference and capture the screen to compare."),
					(refSrc || capSrc) && h("div", { className: "mc-row", style: { marginTop: "var(--mc-s3)", gap: "var(--mc-s4)" } },
						h("label", { style: { display: "flex", alignItems: "center", gap: "var(--mc-s2)", fontSize: "var(--mc-fs-label)" } },
							"opacity", h("input", { type: "range", min: 0, max: 100, value: opacity, onChange: (e) => setOpacity(Number(e.target.value)) })),
						h("label", { style: { display: "flex", alignItems: "center", gap: "var(--mc-s2)", fontSize: "var(--mc-fs-label)" } },
							"swipe", h("input", { type: "range", min: 0, max: 100, value: swipe, onChange: (e) => setSwipe(Number(e.target.value)) })),
					),
				),
				h("div", { className: "mc-status" }, h("span", { style: { fontSize: "var(--mc-fs-label)", opacity: 0.7 } },
					"reference " + (refSrc ? "✓" : "—") + " · capture " + (capSrc ? "✓" : "—") +
					(pair?.reference && pair?.capture ? " · sources " + pair.reference.width + "x" + pair.reference.height + " vs " + pair.capture.width + "x" + pair.capture.height + (sizeMatch ? " (full-res regression available)" : " (triage only)") : "") +
					" · persisted in ~/.dsh/mobilecode/reference (survives reloads)")),
				diff && h("div", { style: { border: "1px solid var(--mc-border)", borderRadius: "var(--mc-r-md)", padding: "var(--mc-s4)", fontSize: "var(--mc-fs-label)" } },
					h("div", null, h("b", null, "diff · " + (diff.mode ?? "—") + " · " + (diff.comparisonSpace ?? "—") + " · " + diff.checkStatus),
						diff.diff ? h("span", { style: { opacity: 0.7 } }, "  " + diff.diff.changePct + "% changed (" + diff.diff.changedPixels + "/" + diff.diff.totalPixels + " px @ threshold L1>" + diff.diff.threshold + "; " + diff.diff.clusterFilter.droppedPixels + " px in sub-minimum clusters counted in verdict)")
							: h("span", { style: { opacity: 0.7 } }, "  " + (diff.reason ?? ""))),
					(diff.diff?.clusters ?? []).slice(0, 4).map((c, i) => h("div", { key: c.x + "," + c.y, style: { opacity: 0.85 } },
						"region cmp " + c.x + "," + c.y + " " + c.width + "×" + c.height + " (" + c.pixels + " px)" +
						(diff.regionsA?.[i] ? " · ref-original " + diff.regionsA[i].x + "," + diff.regionsA[i].y + " " + diff.regionsA[i].width + "×" + diff.regionsA[i].height : "") +
						(diff.regionsB?.[i] ? " · cap-original " + diff.regionsB[i].x + "," + diff.regionsB[i].y + " " + diff.regionsB[i].width + "×" + diff.regionsB[i].height : ""))),
					(diff.env?.masks ?? []).length > 0 && h("div", { style: { opacity: 0.85 } }, "masks: " + diff.env.masks.map((m) => m.reason).join(" | ")),
					h("div", { style: { opacity: 0.6 } }, diff.note ?? ""),
					(diff.limitations ?? []).map((l) => h("div", { key: l, style: { opacity: 0.6 } }, "· " + l)),
					diff.evidenceFile && h("div", { style: { opacity: 0.6 } }, "evidence: " + diff.evidenceFile)),
				refs.length > 0 && h("div", { style: { marginTop: "var(--mc-s3)", display: "flex", flexWrap: "wrap", gap: "var(--mc-s3)" }, role: "group", "aria-label": "Stored references" },
					refs.map((record) => h("span", {
						key: record.id,
						title: (record.provenance ?? "") + " · " + record.importedAt,
						"aria-pressed": record.id === activeId,
						...activatable(() => setActive(record.id)),
						style: {
							border: "1px solid " + (record.id === activeId ? "var(--mc-accent)" : "var(--mc-border)"),
							borderRadius: "var(--mc-r-sm)", padding: "var(--mc-s1) var(--mc-s4)", fontSize: "var(--mc-fs-label)", cursor: "pointer",
							background: record.id === activeId ? "var(--mc-accent-weak)" : "transparent",
						},
					},
					(record.kind === "capture" ? "📷 " : "🖼 ") + record.screen + "/" + record.stateId,
					record.id === activeId && h("button", {
						type: "button",
						"aria-label": "Delete reference " + record.screen + "/" + record.stateId,
						style: { border: 0, background: "none", cursor: "pointer", marginLeft: "var(--mc-s3)", color: "var(--mc-err)" },
						onClick: (e) => { e.stopPropagation(); remove(record.id); },
					}, "✕"))),
				),
			);
		});

		// Same boundary as RefCompareSection above, for the same reason: its one prop
		// is the polled directory, so typing in the panel's own field must not walk
		// the gallery again.
		const PreviewGallerySection = memo(function PreviewGallerySection({ directory }) {
			const [entries, setEntries] = useState([]);
			const [warnings, setWarnings] = useState([]);
			const [gradle, setGradle] = useState(false);
			const [busy, setBusy] = useState("");
			const [error, setError] = useState("");
			const [note, setNote] = useState("");

			const load = async (dir) => {
				const target = dir ?? directory;
				if (!target) { setEntries([]); setGradle(false); return; }
				try {
					const data = await apiGet("/preview/list?directory=" + encodeURIComponent(target));
					setGradle(!!data.gradle);
					setEntries(data.entries ?? []);
					setWarnings(data.warnings ?? []);
				} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
			};
			useEffect(() => { load(); }, [directory]);

			const renderOne = async (entry) => {
				setBusy(entry.fqClass + "." + entry.method); setError(""); setNote("");
				try {
					const r = await streamPost("/preview/render", { directory, class: entry.fqClass, method: entry.method });
					if (r.status === "passed") setNote("rendered " + entry.method + (r.provenance?.stale ? " (still stale?)" : ""));
					else setError(entry.method + ": " + (r.failureKind ?? r.status) + " — " + (r.tail ?? []).slice(-2).join(" | "));
					await load();
				} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
				finally { setBusy(""); }
			};

			return h("div", { className: "mc-card" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Preview gallery"),
					h("span", { className: "sp" }),
					h("button", { className: "mc-btn", onClick: () => load() }, "Refresh"),
				),
				!gradle && h("div", { className: "mc-empty" }, "Pick a Gradle project directory to discover @PreviewTest composables."),
				gradle && entries.length === 0 && h("div", { className: "mc-empty" }, "No @PreviewTest previews yet — apply the screenshot adapter (docs/design/render-adapter-decision.md)."),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				note !== "" && h("div", { className: "mc-status", role: "status" }, h("span", { style: { fontSize: "var(--mc-fs-label)" } }, note)),
				warnings.map((w) => h("div", { className: "mc-error", key: w, role: "alert" }, "discovery: " + w)),
				entries.length > 0 && h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "var(--mc-s4)" } },
					entries.map((entry) => h("div", { key: entry.fqClass + "." + entry.method, style: { border: "1px solid var(--mc-border)", borderRadius: "var(--mc-r-md)", padding: "var(--mc-s3)", fontSize: "var(--mc-fs-label)" } },
						entry.rendered
							? h("img", { src: API_BASE + "/preview/image?directory=" + encodeURIComponent(directory) + "&class=" + encodeURIComponent(entry.fqClass) + "&method=" + encodeURIComponent(entry.method), alt: entry.previewName, style: { width: "100%", borderRadius: "var(--mc-r-sm)", display: "block" } })
							// 150 is a component dimension, not a scale step: it stands in for a rendered
							// frame whose height nobody knows yet, so it belongs to no ladder.
							: h("div", { style: { height: 150, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5 } }, "not rendered"),
						h("div", { style: { marginTop: "var(--mc-s2)", fontWeight: 600 } }, entry.previewName),
						entry.rendered && entry.freshness !== "fresh_tracked_inputs" && h("span", { style: { color: "var(--mc-warn)" } },
							entry.freshness === "unknown" ? "freshness unknown (no manifest)" : entry.freshness === "last_run_failed" ? "last render failed" : "stale — tracked inputs changed"),
						h("button", { className: "mc-btn", disabled: busy !== "", style: { width: "100%", marginTop: "var(--mc-s2)" }, onClick: () => renderOne(entry) },
							busy === entry.fqClass + "." + entry.method ? "rendering…" : "Render"),
					)),
				),
				entries.length > 0 && h("div", { className: "mc-status" },
					h("span", { style: { fontSize: "var(--mc-fs-label)", opacity: 0.7 } }, "host-rendered (layoutlib) — NOT device-verified · failed/stale renders never labeled current")),
			);
		});

		function MobileCodePanel({ controller }) {
			const [directory, setDirectory] = useState(readDir);
			const [info, setInfo] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [openLogs, setOpenLogs] = useState({});
			const [frameKey, setFrameKey] = useState(0);
			const [settingsOpen, setSettingsOpen] = useState(false);

			// Poll while the panel is open. The pane is NOT unmounted when it closes —
			// mountPanel only sets container.hidden — so this has to SUBSCRIBE: reading
			// the flag once at render left the 2 s poll hammering the host API forever
			// behind a hidden pane.
			const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot).panelOpen;
			const lastPayload = useRef("");
			useEffect(() => {
				if (!open) return;
				let stopped = false;
				let timer;
				const poll = async () => {
					try {
						const current = await getInfo(readDir());
						if (!stopped) {
							// A tick that changes nothing must cost nothing. The host
							// answers with a freshly parsed object every time, so React's
							// Object.is bailout never fired and the WHOLE panel subtree —
							// live stages included — re-rendered every 2 s for as long as
							// the pane stayed open. Identical bytes in means identical
							// output out; same guard as the device poll in LiveDeviceCard.
							// Measured by test/render.mjs: 7 component bodies per tick
							// before this, 0 after.
							const payload = JSON.stringify(current);
							if (payload !== lastPayload.current) {
								lastPayload.current = payload;
								setInfo(current);
								setError("");
							}
						}
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
			const platforms = info?.platforms?.length > 0 ? info.platforms : fallbackPlatforms(info?.os);

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
				h("div", { className: "mc-panel-col" },
					h("div", { className: "mc-header" },
						h("h2", { className: "mc-title" }, "Devices"),
						h("button", {
							className: "mc-close",
							"aria-label": "Settings — doctor, PaddleOCR, AI prompt",
							title: "Settings — doctor, PaddleOCR, AI prompt",
							onClick: () => setSettingsOpen(true),
						}, "⚙"),
						h("button", { className: "mc-close", "aria-label": "Close the Devices pane", onClick: () => controller.setOpen(false) }, "✕"),
					),
					h("div", { className: "mc-body" },
						h("div", { className: "mc-row" },
							h("input", {
								className: "mc-input",
								"aria-label": "Project directory",
								placeholder: "Project directory (leave empty for the session default)",
								value: directory,
								onChange: (e) => setDirectory(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") detect(); },
							}),
							h("button", { className: "mc-btn primary", disabled: busy !== "", onClick: detect }, "Detect"),
						),
						error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
						h("div", { className: "mc-pills" },
							platforms.map((platform) => {
								// 0.10.0: Android's "server" IS the Device 1 stream — the pill
								// tracks attached devices, not a serve-avd process.
								const running = platform === "android"
									? (info?.deviceCount ?? 0) > 0
									: server(platform)?.status === "running";
								return h("span", { key: platform, className: "mc-pill", "data-on": running ? "true" : undefined,
									title: platform === "android" ? (running ? "Android device attached — mirrored in Device 1" : "No Android device attached") : "Preview server running" },
									h("span", { className: "mc-dot " + (running ? "on" : "off") }),
									label(platform),
								);
							}),
						),
						h(LiveStreamSection, { active: open }, null),
						platforms.map((platform) => {
							const srv = server(platform);
							const bld = build(platform);
							// 0.10.0 merge: "Start server" (serve-avd iframe) and "Device 1" were
							// two views of the same screen. The in-process stream won; the Android
							// card keeps project controls only. iOS keeps serve-sim (its only view).
							const preview = platform === "ios";
							return h("div", { key: platform, className: "mc-card" },
								h("div", { className: "mc-card-head" },
									h("span", null, label(platform)),
									h("span", { className: "sp" }),
									preview && (srv
										? h("button", { className: "mc-btn", disabled: busy !== "", onClick: () => act(platform + "-stop-server", "/stop", { platform }) },
											srv.status === "running" ? "Stop server" : "Server " + srv.status)
										: h("button", { className: "mc-btn primary", disabled: busy !== "", onClick: () => act(platform + "-start-server", "/start", { platform }) }, "Start server")),
									!preview && h("span", { className: "mc-live-cap" }, "screen: Device 1 ↑"),
								),
								preview && (srv?.url
									? h("iframe", {
										key: frameKey,
										className: "mc-frame",
										src: srv.url,
										sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads",
										title: label(platform) + " preview",
									})
									: srv?.status === "starting"
										? h("div", { className: "mc-status", role: "status" }, h("span", null, h("span", { className: "mc-dot warn" }), " Starting preview server…"))
										: null),
								h("div", { className: "mc-row" },
									h("button", {
										className: "mc-btn primary",
										disabled: busy !== "",
										onClick: () => { act(platform + "-run", "/run", { platform }); setFrameKey((k) => k + 1); },
									}, "Run app"),
									h("button", { className: "mc-btn danger", disabled: busy !== "", onClick: () => act(platform + "-stop", "/run/stop", { platform }) }, "Stop app"),
								),
								bld
									? h("div", { className: "mc-status", role: "status" },
										h("span", null,
											h("span", { className: "mc-dot " + statusClass(bld.status) }),
											" Build: ", h("b", null, bld.status),
											bld.step ? " — " + bld.step : "",
											bld.target ? " · target " + bld.target : "",
											bld.appID ? " · " + bld.appID : "",
										),
										bld.error !== undefined && bld.error !== "" && h("div", { className: "mc-error", role: "alert" }, bld.error),
										bld.log.length > 0 &&
											h("button", {
												className: "mc-log-toggle",
												"aria-expanded": openLogs[platform + "-build"] === true,
												"aria-controls": "mc-log-" + platform,
												onClick: () => toggleLog(platform + "-build"),
											}, openLogs[platform + "-build"] ? "Hide log" : "Show log (" + bld.log.length + ")"),
										// Scrollable, so it has to be reachable by keyboard (WCAG 2.1.1): Safari does not
										// make an overflow box focusable on its own, and a keyboard-only user cannot scroll
										// what they cannot focus. Deliberately NOT role="log": the lines are re-joined and
										// re-rendered whole on every 2s poll, so a polite live region would re-announce the
										// entire log each tick. An accessible name is enough to make it identifiable.
										openLogs[platform + "-build"] && h("pre", { className: "mc-log", id: "mc-log-" + platform, tabIndex: 0, "aria-label": "Build log for " + platform }, bld.log.join("\n")),
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
									h("button", {
										className: "mc-log-toggle",
										"aria-expanded": openLogs["bundler"] === true,
										"aria-controls": "mc-log-bundler",
										onClick: () => toggleLog("bundler"),
									}, openLogs["bundler"] ? "Hide log" : "Show log (" + info.bundler.log.length + ")"),
								openLogs["bundler"] && h("pre", { className: "mc-log", id: "mc-log-bundler", tabIndex: 0, "aria-label": "Metro bundler log" }, info.bundler.log.join("\n")),
							),
						info?.servers?.length === 0 && info?.builds?.length === 0 && (info?.deviceCount ?? 0) === 0 &&
							h("div", { className: "mc-empty" }, "Nothing running yet — pick a project directory and press Run app, or boot an AVD in Device 1 above."),
						h(RefCompareSection, { directory: info?.directory ?? "" }),
					h(PreviewGallerySection, { directory: info?.directory ?? "" }),
					),
					h("div", { className: "mc-footer" },
						h("span", null, "dsh-mobilecode · polls every 2s"),
						info && info.platforms.length > 0 && h("span", null, "detected: " + info.platforms.map(label).join(", ")),
					),
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
		const DUMMY_SNAPSHOT = { panelOpen: true };
		const DUMMY_STORE = { subscribe: () => () => {}, getSnapshot: () => DUMMY_SNAPSHOT };

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
			useEffect(() => {
				// The capsule is hidden while the pane is open, so stop the timer outright
				// rather than waking every 5 s only to decide not to poll.
				if (panelOpen) return;
				let stopped = false;
				const poll = async () => {
					try {
						const r = await streamPost("/stream/status", {});
						if (stopped) return;
						setRunning(r.running === true);
						// Only the serial reaches the DOM. Returning the previous object
						// when it is unchanged lets React bail out of the re-render.
						setStatus((prev) => (prev?.serial === r.serial ? prev : r));
					} catch {
						if (stopped) return;
						setRunning(false);
						setStatus(null);
					}
				};
				poll();
				const timer = setInterval(poll, 5000);
				return () => { stopped = true; clearInterval(timer); };
			}, [panelOpen]);
			if (!running || panelOpen) return null;
			return h("button", { className: "mc-capsule", onClick: () => activeController?.setOpen(true) },
				h("span", { className: "mc-dot on" }),
				h("span", { className: "mc-capsule-serial", title: status?.serial ?? "device stream" }, status?.serial ?? "device stream"),
			);
		}

		/** Shared stream lifecycle (0.9.0 co-op): HMAC-granted frame URL with a
		 *  re-mint timer, plus tap/drag pointer mapping for the <img>. Used by
		 *  the full card and by the second co-op pane. */
		/** Keyboard swipe distance as a fraction of the stage: a quarter-screen
		 *  is a decisive fling on a phone UI, and comfortably above the 2%
		 *  travel that would make it read as a tap. */
		const KEY_STEP = 0.25;
		function useLiveStream({ serial, onError }) {
			const [streamUrl, setStreamUrl] = useState("");
			// Native aspect ratio (w/h) of the streamed frames, learned from the
			// first decoded MJPEG frame so the Fit stage has the device's real
			// shape — zero letterboxing regardless of pane/device mix (0.11.5).
			const [ar, setAr] = useState(null);
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
			// Presence watcher (0.11.3): an MJPEG <img> does NOT fire error when
			// the device dies — it just freezes on the last frame with the Live
			// badge stuck. While a stream is up, poll device presence and drop
			// the stream if the serial vanished (⏻ off, crash, unplug).
			useEffect(() => {
				if (streamUrl === "") return;
				const watch = setInterval(async () => {
					try {
						const r = await streamPost("/stream/devices", {});
						if (!r.devices.some((d) => d.serial === serialRef.current)) {
							clearTimeout(grantTimer.current);
							setStreamUrl("");
							onErrorRef.current("device offline — stream stopped");
						}
					} catch { /* the next tick decides */ }
				}, 5000);
				return () => clearInterval(watch);
			}, [streamUrl]);

			const control = useCallback(async (action) => {
				if (serialRef.current === "") return;
				try { await streamPost("/stream/control", { device: serialRef.current, action }); }
				catch (err) { onErrorRef.current(err instanceof Error ? err.message : String(err)); }
			}, []);
			const norm = useCallback((clientX, clientY) => {
				const el = imgRef.current;
				if (!el) return null;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return null;
				return {
					x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
					y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
				};
			}, []);
			// Gesture coalescing: remember the down point + timestamp; on up,
			// taps (<2% travel) vs drags keep the real duration (clamped 0..5s).
			const onDown = useCallback((e) => { const p = norm(e.clientX, e.clientY); if (p) dragRef.current = { ...p, t: Date.now() }; }, [norm]);
			const onUp = useCallback((e) => {
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
			}, [control, norm]);
			// Keyboard equivalent of those gestures (WCAG 2.1.1). The stage is
			// focusable but was pointer-only: a keyboard user could tab to it,
			// get a focus ring, and do nothing. Arrows swipe a quarter-screen
			// from the centre — 25% travel is well past the 2% tap threshold,
			// so it is delivered as a drag — and Enter/Space tap the centre.
			const onKeyDown = useCallback((e) => {
				const dx = e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
				const dy = e.key === "ArrowDown" ? KEY_STEP : e.key === "ArrowUp" ? -KEY_STEP : 0;
				if (dx !== 0 || dy !== 0) {
					e.preventDefault();
					control({ kind: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5 + dx, toY: 0.5 + dy, durationMs: 200 });
					return;
				}
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					control({ kind: "tap", x: 0.5, y: 0.5 });
				}
			}, [control]);
			// Aspect-ratio learner: MJPEG frames decode into the same <img>, so
			// naturalWidth/naturalHeight is live. Poll once a second while the
			// stream is up; stage boxes read --mc-ar-n from here (fit mode).
			useEffect(() => {
				if (streamUrl === "") return;
				const tick = setInterval(() => {
					const el = imgRef.current;
					if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
						const a = +(el.naturalWidth / el.naturalHeight).toFixed(4);
						setAr((prev) => (prev === a ? prev : a));
					}
				}, 1000);
				return () => clearInterval(tick);
			}, [streamUrl]);

			return {
				streamUrl, grant, reset, control, ar,
				// aria-label carries the keyboard affordance alongside the name;
				// it supersedes the consumer's alt text as the accessible name,
				// so it has to say everything the alt did and then some.
				imgProps: useMemo(() => ({
					ref: imgRef,
					draggable: false,
					onPointerDown: onDown,
					onPointerUp: onUp,
					onKeyDown,
					"aria-label": "Live screen of " + (serial || "the device") + " — arrow keys swipe, Enter taps the centre",
				}), [onDown, onUp, onKeyDown, serial]),
			};
		}

		/** Device 1 stream: picker-popover header, SVG toolbar pill, device
		 *  menu, quick sizes + frame styles, and tap/drag with duration. */
		function LiveDeviceCard({ coopOn, onToggleCoop, onSerial, active }) {
			const [sizeMode, setSizeMode] = useState({ mode: "fit" }); // {mode:'fit'|'pct'|'px', value?}
			const [frame, setFrame] = useState("none"); // 'none' | 'bezel' | 'device'
			const [devices, setDevices] = useState([]);
			const [avds, setAvds] = useState([]);
			const [serial, setSerial] = useState("");
			const [error, setError] = useState("");
			const [pickerOpen, setPickerOpen] = useState(false);
			const [still, setStill] = useState(null);
			const [view, setView] = useState("live"); // 'live' | 'still'
			// sizeMode/frame are per-pane (0.11.2); StageControls renders the
			// identical row in both cards, and Fit locks both to one height.
			const [booting, setBooting] = useState(""); // AVD name while POST /boot is in flight
			const [powering, setPowering] = useState(""); // serial while POST /off is in flight
			const live = useLiveStream({ serial, onError: setError });
			const grant = (device) => live.grant(device).then((ok) => { if (ok) setError(""); });
			const control = live.control;
			const serialRef = useRef(serial);
			serialRef.current = serial;
			const autoPicked = useRef(false);
			const lastPayload = useRef("");
			useEffect(() => { if (onSerial) onSerial(serial); }, [serial]);

			const refreshDevices = async () => {
				try {
					const r = await streamPost("/stream/devices", {});
					// Every tick handed React a fresh array, so the card re-rendered
					// every 5 s even when the device list had not changed. The payload
					// is a handful of small objects: identical bytes in means
					// identical output out, so skip the write entirely.
					const payload = JSON.stringify(r);
					if (payload !== lastPayload.current) {
						lastPayload.current = payload;
						setDevices(r.devices);
						setAvds(r.avds ?? []);
					}
					// Prefer emulators for the welcome auto-pick: a physical
					// serial sorts first in adb order but has no ⏻ off control.
					// (Serial prefix, not the avd field — avdName() can fail.)
					const isEmu = (d) => d.serial.startsWith("emulator-");
					const first = r.devices.find((d) => d.streaming && isEmu(d))?.serial ?? r.devices.find(isEmu)?.serial
						?? r.devices.find((d) => d.streaming)?.serial ?? r.devices[0]?.serial ?? "";
					const cur = serialRef.current;
					if (cur === "") {
						// Auto-stream once per page load (the welcome flow). After
						// an explicit ⏻ off, the card stays idle — it must NOT
						// silently grab the partner device (0.11.3).
						if (!autoPicked.current && first !== "") { autoPicked.current = true; setSerial(first); }
					} else if (!r.devices.some((d) => d.serial === cur)) {
						autoPicked.current = true;
						setSerial(""); live.reset();
					}
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};

			// Only while the pane is actually visible: the panel tree stays mounted
			// behind container.hidden, so an unguarded interval would poll `adb devices`
			// every 5 s for the whole life of the page.
			useEffect(() => {
				if (!active) return;
				refreshDevices();
				const timer = setInterval(refreshDevices, 5000);
				return () => clearInterval(timer);
			}, [active]);

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

			const pick = (device) => { autoPicked.current = true; setSerial(device); live.reset(); setStill(null); setView("live"); setError(""); setPickerOpen(false); };
			// 0.10.0 merged "Start server": boot a configured AVD from the picker.
			// The route waits for boot completion; then we re-list and stream it.
			const boot = async (avd) => {
				setBooting(avd); setError("");
				try {
					const r = await streamPost("/boot", { avd });
					await refreshDevices();
					if (r.serial) pick(r.serial);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					await refreshDevices();
				} finally {
					setBooting("");
				}
			};
			// 0.11.0 device power-off: graceful `adb emu kill` via POST /off.
			// If we just killed the streamed device, drop back to the picker.
			const powerOff = async (device) => {
				setPowering(device); setError("");
				try {
					await streamPost("/off", { serial: device });
					if (device === serial) { setSerial(""); live.reset(); }
					await refreshDevices();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					await refreshDevices();
				} finally {
					setPowering("");
				}
			};
			const showLive = () => { setView("live"); if (serial !== "" && live.streamUrl === "") grant(serial); };

			const sizeStyle = stageSizeStyle(sizeMode);
			const stageClass = stageClassFor(frame, sizeMode.mode === "fit");
			const runningAvds = new Set(devices.map((d) => d.avd).filter(Boolean));
			const toolbar = navToolbar(control, capture, () => { if (serial !== "") grant(serial); });

			return h("div", { className: "mc-card mc-live" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Device 1"),
					live.streamUrl !== "" && h("span", { className: "mc-live-badge" }, h("span", { className: "mc-dot on" }), "Live"),
					h("span", { className: "sp" }),
					h("div", { className: "mc-picker" },
						h("button", {
							className: "mc-btn", type: "button",
							"aria-haspopup": "listbox", "aria-expanded": pickerOpen,
							onClick: () => setPickerOpen((v) => !v),
						}, serial || "no device", " ▾"),
						pickerOpen && h("div", { className: "mc-picker-pop" },
							devices.length > 0
								? h("div", { className: "mc-picker-group" },
									h("div", { className: "mc-picker-label" }, "Online devices"),
									devices.map((d) => h("div", {
										key: d.serial,
										className: "mc-picker-row" + (d.serial === serial ? " on" : ""),
									},
										// The row's action is a real button and the ⏻ off control is its
										// SIBLING. role="button" on the row would make its children
										// presentational and drop the off button out of the a11y tree
										// (axe nested-interactive, WCAG 4.1.2).
										h("button", {
											className: "mc-pick", type: "button",
											"aria-current": d.serial === serial ? "true" : undefined,
											onClick: () => pick(d.serial),
										},
											h("span", { "aria-hidden": "true" }, d.kind === "emulator" ? "🖥" : "📱"),
											h("span", { className: "mc-serial" }, d.avd ? d.avd + " · " + d.serial : d.serial),
											d.streaming && h("span", { className: "mc-badge" }, "streaming"),
										),
										d.kind === "emulator" && h("button", {
											className: "mc-btn", type: "button", disabled: booting !== "" || powering !== "",
											title: "Shut down this emulator (adb emu kill)",
											"aria-label": "Shut down " + d.serial,
											onClick: () => powerOff(d.serial),
										}, powering === d.serial ? "stopping…" : "⏻ off"),
									)),
								)
								: h("div", { className: "mc-picker-hint" }, "No device attached"),
							// Running AVDs already have their row (with ⏻ off) above;
							// the boot list shows only the stopped ones.
							avds.filter((avd) => !runningAvds.has(avd)).length > 0 && h("div", { className: "mc-picker-group" },
								h("div", { className: "mc-picker-label" }, "AVDs"),
								avds.filter((avd) => !runningAvds.has(avd)).map((avd) => h("div", { key: avd, className: "mc-picker-row" },
									h("span", null, "▫ " + avd),
									h("span", { className: "sp" }),
									h("button", {
										className: "mc-btn", type: "button", disabled: booting !== "" || powering !== "",
										title: "Boot this AVD (runs detached; it appears online when ready)",
										"aria-label": "Boot " + avd,
										onClick: () => boot(avd),
									}, booting === avd ? "booting…" : "⏻ boot"),
								)),
							),
						),
					),
					h(DeviceMenu, { serial, onError: setError }),
					// 0.9.0 co-op: side-by-side second pane (needs two online devices).
					devices.length >= 2 && h("button", {
						className: "mc-btn", type: "button", "data-on": coopOn || undefined,
						"aria-pressed": coopOn === true,
						title: "Co-op: watch Device 1 + Device 2 side by side",
						"aria-label": "Co-op: watch Device 1 and Device 2 side by side",
						onClick: onToggleCoop,
					}, "⧉"),
				),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				booting !== "" && h("div", { className: "mc-status", role: "status" },
					h("span", null, h("span", { className: "mc-dot warn" }), " Booting " + booting + " — it appears here once online (about a minute).")),
				// 0.11.0 audit: no ghost affordances — the toolbar appears once a
				// device is selected (disabled-grey read as broken).
				serial !== "" && h(ToolbarRow, { items: toolbar }),
				h("div", { className: stageClass, style: sizeMode.mode === "fit" && live.ar != null ? { "--mc-ar-n": live.ar } : undefined },
					view === "still" && still?.dataUrl
						? h("img", { src: still.dataUrl, alt: "Still capture of " + serial, draggable: false })
						: live.streamUrl !== ""
							? h("img", {
								...live.imgProps,
								src: live.streamUrl,
								alt: "Live screen of " + serial,
								tabIndex: 0,
								style: sizeStyle,
								onError: () => grant(serial),
							})
							: h("div", { className: "mc-live-off" }, serial === ""
									? (devices.length === 0
										? "No device attached — boot an AVD from the ▾ picker, or press Run app."
										: "Device was shut down — pick one from ▾, or ⏻ boot an AVD.")
									: "Connecting to " + serial + "..."),
				),
				view === "still"
					? h("div", { className: "mc-live-cap" }, "Still captured" + (still?.width ? " (" + still.width + "x" + still.height + ")" : "") + " · ",
						h("button", { className: "mc-log-toggle", type: "button", onClick: showLive }, "back to Live"))
					: h("div", { className: "mc-live-cap" }, "tap, drag or arrow-key the screen to drive the device · v" + MC_VERSION),
				h(StageControls, { sizeMode, setSizeMode, frame, setFrame }),
			);
		}
		/** Co-op second pane (0.9.0): a compact stream view for a second device —
		 *  device select, live image, tap/drag — and (0.11.2) its own Size/Frame
		 *  row, mirroring Device 1's controls. No toolbar/menu: those belong to
		 *  the full card. Defaults are identical, so the panes match out of the
		 *  box and can be adjusted independently. */
		function CoopPane({ excludeSerial, active }) {
			const [devices, setDevices] = useState([]);
			const [serial, setSerial] = useState("");
			const [sizeMode, setSizeMode] = useState({ mode: "fit" });
			const [frame, setFrame] = useState("none");
			const [error, setError] = useState("");
			const live = useLiveStream({ serial, onError: setError });
			const grant = (device) => live.grant(device).then((ok) => { if (ok) setError(""); });
			// Serial mirror for the 5s poller + one-shot auto-pick guard: this
			// pane may steal a partner while nothing is picked, but it must NOT
			// silently switch to a third device after its own goes offline.
			const serialRef = useRef(serial);
			serialRef.current = serial;
			const autoPicked = useRef(false);
			const lastPayload = useRef("");

			const refresh = async () => {
				try {
					const r = await streamPost("/stream/devices", {});
					// Every tick handed React a fresh array, so the card re-rendered
					// every 5 s even when the device list had not changed. The payload
					// is a handful of small objects: identical bytes in means
					// identical output out, so skip the write entirely.
					const payload = JSON.stringify(r);
					if (payload !== lastPayload.current) {
						lastPayload.current = payload;
						setDevices(r.devices);
					}
					// Partner candidates: emulators only (serial prefix, not the
					// flaky avd field) — the co-op partner must be killable from
					// the picker, and never Device 1's own serial.
					const others = r.devices.filter((d) => d.serial !== excludeSerial && d.serial.startsWith("emulator-"));
					const cur = serialRef.current;
					if (cur !== "") {
						// Keep any valid pick — including a manually chosen physical
						// device; only emulators are eligible for auto-pick. A dead
						// or stolen pick clears to the placeholder (never re-grabs).
						if (cur !== excludeSerial && r.devices.some((d) => d.serial === cur)) return;
						autoPicked.current = true;
						setSerial(""); live.reset();
						return;
					}
					if (!autoPicked.current) {
						const next = (others.find((d) => d.streaming) ?? others[0])?.serial ?? "";
						if (next !== "") { autoPicked.current = true; setSerial(next); }
					}
				} catch {
					/* the header keeps the last device list */
				}
			};

			useEffect(() => {
				if (!active) return;
				refresh();
				const timer = setInterval(refresh, 5000);
				return () => clearInterval(timer);
			}, [excludeSerial, active]);

			useEffect(() => { if (serial !== "" && live.streamUrl === "") grant(serial); }, [serial, live.streamUrl]);

			return h("div", { className: "mc-card mc-live mc-coop-pane" },
				h("div", { className: "mc-card-head" },
					h("span", null, "Device 2"),
					live.streamUrl !== "" && h("span", { className: "mc-live-badge" }, h("span", { className: "mc-dot on" }), "Live"),
					h("span", { className: "sp" }),
					h("select", { className: "mc-input mc-coop-select", "aria-label": "Device 2 serial", value: serial, onChange: (e) => { setSerial(e.target.value); live.reset(); } },
						// An honest empty option: a select with no matching option
						// silently DISPLAYS devices[0] while state is still "" —
						// that made the probe read a phantom pick (0.11.4).
						!devices.some((d) => d.serial === serial) && h("option", { value: "" }, devices.length === 0 ? "no device" : "— pick device —"),
						devices.map((d) => h("option", { key: d.serial, value: d.serial }, d.serial + (d.serial === excludeSerial ? " (Device 1)" : d.streaming ? " ●" : ""))),
					),
					h(DeviceMenu, { serial, onError: setError }),
				),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				// 0.11.5: Device 2 gets the same nav toolbar as Device 1
				// (back/home/recents/rotate/refresh) — full control of both players.
				serial !== "" && h(ToolbarRow, { items: navToolbar(live.control, undefined, () => { if (serial !== "") grant(serial); }) }),
				h("div", { className: stageClassFor(frame, sizeMode.mode === "fit"), style: sizeMode.mode === "fit" && live.ar != null ? { "--mc-ar-n": live.ar } : undefined },
					live.streamUrl !== ""
						? h("img", { ...live.imgProps, src: live.streamUrl, alt: "Live screen of " + serial, tabIndex: 0, style: stageSizeStyle(sizeMode), onError: () => grant(serial) })
						: h("div", { className: "mc-live-off" }, devices.filter((d) => d.serial !== excludeSerial).length === 0
							? "No second device — boot another emulator."
							: serial === "" || !devices.some((d) => d.serial === serial)
								? "Second device offline — pick one above."
								: "Connecting to " + serial + "..."),
				),
				h("div", { className: "mc-live-cap" }, "tap, drag or arrow-key the screen to drive this device · v" + MC_VERSION),
				h(StageControls, { sizeMode, setSizeMode, frame, setFrame }),
			);
		}

		/** Stream section: the classic single card, plus a co-op mode that docks
		 *  a second pane next to it for two-player testing. Each pane owns its
		 *  Size/Frame knobs (0.11.2); the shared CSS base makes them match. */
		// The boundary that matters most: everything below this line owns the two
		// live MJPEG stages, and `active` is its only prop from the panel. Without
		// memo, every panel-level write — a keystroke in the directory field, a log
		// toggle, opening settings — walked the whole device subtree again.
		const LiveStreamSection = memo(function LiveStreamSection({ active }) {
			const [coop, setCoop] = useState(false);
			const [serialA, setSerialA] = useState("");
			return h("div", { className: "mc-live-section" + (coop ? " coop" : "") },
				h(LiveDeviceCard, { coopOn: coop, onToggleCoop: () => setCoop((v) => !v), onSerial: setSerialA, active }),
				coop && h(CoopPane, { excludeSerial: serialA, active }),
			);
		});

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
					!ok && !installing && h("button", { className: "mc-btn primary", type: "button", disabled: busy, onClick: install }, "Install"),
				),
				h("div", { className: "mc-status", role: "status" },
					ok
						? h("span", null, "device_screen reads text from screenshots with local OCR.")
						: h("span", null, "Without it, device_screen returns the screenshot and UI tree but no OCR text — install to make the plugin work perfectly."),
					h("span", { className: "mc-hint" }, "PaddleOCR 3.x · fully local · one-time install (~2 min, needs network once)"),
				),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				(installing || failed) && (status?.log?.length > 0) && h("pre", { className: "mc-logline", tabIndex: 0, "aria-label": "Install log" }, status.log.join("\n")),
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

			return h("div", { className: "mc-body", style: { padding: "var(--mc-s6) 0 0" } },
				h("div", { className: "mc-row" },
					h("button", { className: "mc-btn primary", disabled: checks === null, onClick: run }, "Re-run checks"),
					checks !== null && h("span", { className: "mc-hint" },
						checks.filter((c) => c.ok).length + "/" + checks.length + " checks passing"),
				),
				error !== "" && h("div", { className: "mc-error", role: "alert" }, error),
				fixResult !== "" && h("div", { className: "mc-status", role: "status" }, fixResult),
				checks === null && !error && h("div", { className: "mc-row", role: "status" }, h("span", { className: "mc-spin", "aria-hidden": "true" }), " Running checks…"),
				checks?.map((check) =>
					h("div", { key: check.name, className: "mc-check" },
						h("span", { className: "mc-check-ico", "aria-hidden": "true", style: { color: check.ok ? "var(--mc-ok)" : "var(--mc-err)" } }, check.ok ? "✓" : "✗"),
						h("span", { className: "mc-check-detail" },
							h("span", { className: "mc-check-name" }, check.name + (check.ok ? " — passed" : " — failed")),
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
		let tabsInstance = 0;
		const TAB_IDS = ["doctor", "ocr", "prompt", "connection"];

		function SettingsTabs() {
			// Two SettingsTabs can be mounted at once (dialog + settings page), so
			// the tab/panel ids must be per-instance or aria-controls collides.
			const uidRef = useRef(null);
			if (uidRef.current === null) uidRef.current = "mc-tabs" + (++tabsInstance) + "-";
			const uid = uidRef.current;
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
				h("button", {
					className: "mc-tab", type: "button", role: "tab",
					id: uid + "tab-" + id,
					"aria-selected": tab === id,
					"aria-controls": uid + "panel-" + id,
					tabIndex: tab === id ? 0 : -1,
					"data-on": tab === id ? "true" : undefined,
					onClick: () => setTab(id),
					onKeyDown: (event) => {
						const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
						if (step === 0) return;
						event.preventDefault();
						const next = TAB_IDS[(TAB_IDS.indexOf(id) + step + TAB_IDS.length) % TAB_IDS.length];
						setTab(next);
						document.getElementById(uid + "tab-" + next)?.focus();
					},
				}, label);
			const panel = (id, children) =>
				h("div", { className: "mc-modal-body", role: "tabpanel", id: uid + "panel-" + id, "aria-labelledby": uid + "tab-" + id, tabIndex: 0 }, children);

			return [
				h("div", { className: "mc-tabs", role: "tablist", "aria-label": "Settings sections" },
					tabButton("doctor", "Doctor"),
					tabButton("ocr", "PaddleOCR"),
					tabButton("prompt", "AI Prompt"),
					tabButton("connection", "Connection"),
				),
				tab === "doctor" && panel("doctor", h(DoctorView, { onFixed: () => {} })),
				tab === "ocr" && panel("ocr", h(OcrCard, {})),
				tab === "prompt" && panel("prompt",
					h("div", null,
						h("h3", null, "Prompt for any AI"),
						h("div", { className: "mc-hint" }, "Copy this into any AI model to tell it how to fully control this plugin."),
					),
					h("div", { className: "mc-prompt" },
						h("pre", null, prompt || "Loading…"),
						h("button", { className: "mc-btn mc-copy", type: "button", onClick: copy }, copied ? "Copied ✓" : "Copy"),
					),
				),
				tab === "connection" && h("div", { className: "mc-modal-body" },
					h("div", null,
						h("h3", null, "adb connection"),
						connError !== "" && h("div", { className: "mc-warn", role: "alert" }, connError),
						connMsg !== "" && h("div", { className: "mc-hint", role: "status", style: { color: "var(--mc-ok)" } }, connMsg), 						h("div", { className: "mc-conn-form" }, 							h("div", { className: "mc-conn-row" }, 								h("input", { className: "mc-input", "aria-label": "Device IP address", placeholder: "device IP, e.g. 192.168.1.23", value: wifiHost, onChange: (e) => setWifiHost(e.target.value) }), 								h("input", { className: "mc-input mc-input-sm", "aria-label": "adb port", placeholder: "port", value: wifiPort, onChange: (e) => setWifiPort(e.target.value) }), 								h("button", { className: "mc-btn", type: "button", onClick: doConnect, disabled: connBusy !== "" }, connBusy === "connecting" ? "Connecting…" : "Connect"), 							), 							h("div", { className: "mc-conn-row" }, 								h("input", { className: "mc-input", "aria-label": "Pairing code", placeholder: "pairing code (first-time only)", value: pairCode, onChange: (e) => setPairCode(e.target.value) }), 								h("input", { className: "mc-input mc-input-sm", "aria-label": "Pairing port", placeholder: "pair port", value: pairPort, onChange: (e) => setPairPort(e.target.value) }), 								h("button", { className: "mc-btn", type: "button", onClick: doPairQr, disabled: connBusy !== "" }, connBusy === "qr" ? "Waiting for scan…" : "Pair by QR"), 							), 						), 						qrText !== "" && h("div", { className: "mc-qr" }, 							h("div", { className: "mc-hint" }, "WIFI:T:ADB — render as a QR code and scan with the phone (Settings → Connected devices → Pair by QR):"), 							h("pre", { className: "mc-qr-text" }, qrText), 						),
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
			const ref = useDialogA11y(onClose);
			return h("div", { className: "mc-overlay", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h("div", { className: "mc-modal", ref, role: "dialog", "aria-modal": "true", "aria-labelledby": "mc-settings-title", tabIndex: -1 },
					h("div", { className: "mc-modal-head" },
						h("h2", { className: "mc-modal-title", id: "mc-settings-title" }, "dsh-mobilecode · Settings"),
						h("button", { className: "mc-close", "aria-label": "Close settings", onClick: onClose }, "✕"),
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
			const ref = useDialogA11y(dismiss);

			return h("div", { className: "mc-overlay" },
				h("div", { className: "mc-modal", ref, role: "dialog", "aria-modal": "true", "aria-labelledby": "mc-welcome-title", tabIndex: -1 },
					h("div", { className: "mc-modal-head" },
						h("h2", { className: "mc-modal-title", id: "mc-welcome-title" }, "Welcome to dsh-mobilecode 🚀"),
						h("button", { className: "mc-close", "aria-label": "Dismiss welcome", onClick: dismiss }, "✕"),
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

			// Every observer below funnels into ONE rAF-coalesced pass. This is the
			// page's hottest idle path: the wait observer watches all of document.body
			// with subtree:true, the DSH shell mutates the DOM continuously (streaming
			// text, typing, the sidebar re-rendering on every session change), and the
			// old per-mutation callback ran a full querySelector walk synchronously on
			// every one of those mutations.
			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => { scheduled = false; tryPlace(); });
			};

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
					rootObserver = new MutationObserver(schedule);
					rootObserver.observe(root, { childList: true, subtree: true });
				}
			};

			// Watching the whole body is still required — the host can drop the sidebar
			// at any moment — but the guard is one pointer walk, so the overwhelmingly
			// common case (entry still mounted, mutations happening everywhere else)
			// costs nothing and never reaches the scheduler.
			const waitObserver = new MutationObserver(() => { if (!document.body.contains(entry)) schedule(); });
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
					resetWidth();
					return;
				}
				handle._lastClick = now;
				drag = { startX: e.clientX, startWidth: container.getBoundingClientRect().width };
				handle?.setAttribute("data-drag", "");
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			// The panel is anchored to the right edge, so widening means dragging the
			// handle left. Keyboard resizing mirrors that: ArrowLeft widens.
			const resetWidth = () => applyWidth(Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80)));
			const applyWidth = (w) => {
				const width = Math.round(Math.max(MIN_WIDTH, Math.min(window.innerWidth - 40, w)));
				container.style.width = width + "px";
				handle?.setAttribute("aria-valuenow", String(width));
				try { localStorage.setItem("dsh-mobilecode-width", String(width)); } catch { /* private mode */ }
			};
			const onKey = (e) => {
				const width = parseFloat(container.style.width) || readWidth();
				const step = e.shiftKey ? 64 : 16;
				if (e.key === "ArrowLeft") applyWidth(width + step);
				else if (e.key === "ArrowRight") applyWidth(width - step);
				else if (e.key === "Home" || e.key === "Enter" || e.key === " ") resetWidth();
				else return;
				e.preventDefault();
			};
			// readWidth() only runs in ensure(), so before this a window narrowed
			// while the pane was open left it at its old inline width, hanging off
			// the left edge of the viewport.
			const onResize = () => {
				if (container === undefined) return;
				const before = Math.round(parseFloat(container.style.width) || readWidth());
				const after = Math.round(Math.max(MIN_WIDTH, Math.min(window.innerWidth - 40, before)));
				if (after !== before) applyWidth(after);
				else handle?.setAttribute("aria-valuemax", String(Math.max(MIN_WIDTH, window.innerWidth - 40)));
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
				// A landmark, so the drawer is reachable by landmark navigation and
				// not only by tabbing through it. `complementary` is the honest role:
				// this is a sidebar supporting the host's main content. The name is
				// the same string the h2 inside carries, and test/client.mjs asserts
				// they stay equal — a labelled landmark that names itself something
				// other than its own heading is worse than an unnamed one. While the
				// drawer is hidden, `display: none` keeps it out of the a11y tree.
				container.setAttribute("role", "complementary");
				container.setAttribute("aria-label", "Devices");
				container.style.cssText += "position:fixed;top:0;right:0;bottom:0;left:auto;z-index:var(--mc-z-panel);";
				container.style.width = readWidth() + "px";
				container.hidden = true;
				handle = document.createElement("div");
				handle.className = "dsh-mobilecode-resize";
				handle.title = "Drag to resize (double-click to reset)";
				handle.setAttribute("role", "separator");
				handle.setAttribute("aria-orientation", "vertical");
				handle.setAttribute("aria-label", "Resize the Devices pane — arrow keys to resize, Home to reset");
				handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
				handle.setAttribute("aria-valuemax", String(Math.max(MIN_WIDTH, window.innerWidth - 40)));
				handle.setAttribute("aria-valuenow", String(parseFloat(container.style.width) || readWidth()));
				handle.tabIndex = 0;
				handle.addEventListener("mousedown", onDown);
				handle.addEventListener("keydown", onKey);
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
			window.addEventListener("resize", onResize);

			const applyOpen = () => {
				if (container !== undefined) container.hidden = !controller.getSnapshot().panelOpen;
			};
			const unsubscribe = controller.subscribe(applyOpen);
			applyOpen();

			return () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				window.removeEventListener("resize", onResize);
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
			// `isConnected` instead of a head.contains() tree walk — same answer, one flag.
			const styleGuard = new MutationObserver(() => { if (!style.isConnected) document.head.appendChild(style); });
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

