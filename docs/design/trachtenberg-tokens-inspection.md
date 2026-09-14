# Trachtenberg design-token inspection (T6) — INSPECTION ONLY

Source of truth: `app/src/main/java/com/trachtenberg/math/core/designsystem/` in
`C:\Users\Administrator\Desktop\trachtenberg_method` (branch master, read 2026-09-14).
**No writes to the app. No generated Kotlin. This is not a token→Compose mapping**
— guarded token writes are deferred and were not requested.

## What exists (canonical Compose tokens)

### Color — `token/DesignTokens.kt` `object Colors`
- Neutrals N950…N100 (OKLCH-derived, annotated with L/C), base `N900 #1C1C23`, raised `N800 #2E2E38`.
- Brand red `#E63E3E` (+Light/Dark). Explicit use-comments ("hero numerals only", "the wrong-key surface, nowhere else").
- Performance semantics: FastGreen / SlowAmber / IncorrectRed / ComboOrange / DecayPurple — documented rule: **never color-alone; pair with icon/label**.
- Rank tiers restricted to crests/tier rows. On* constants = label-on-fill pairs.
- Surfaces: `SurfaceBase=Raised-1=Overlay` aliases of N900/800/700.
- M3 mapping `EliteDark = darkColorScheme(...)` in `theme/TrachtenbergTheme.kt`.
  - ⚠ review-flag (not an error to fix silently): `secondary/onSecondary` slot values are `FastGreen` + **12% alpha tint** — `onSecondary` used as a fill tint, not a foreground. A design tool importing M3 slot semantics would misread this.

### Teaching color roles — `LocalTrachtenbergColors`
`highlight` amber · `carry` purple · `arrow` brand-red · `complement` purple · `addFive` green · `success` green.
These are domain-semantic (carry/neighbor arrows) and **have no standard M3/web equivalent** — any design-doc import must map them explicitly or mark unresolved.

### Typography — `theme/Typography.kt`
- Families: Display = Chakra Petch (400/500/600/700), Micro = JetBrains Mono (400/500/700), static OFL TTFs in `res/font/`.
- Every numeral-bearing style sets `fontFeatureSettings = "tnum"` — **tabular digits are the app-wide numeric-alignment mechanism** (matches the practice-screen requirement "stable digit alignment").
- Named styles `TrachtenbergType` (adult) and `SeniorType` (mirror); Senior ratios per role 1.250–1.333 — **deliberately non-uniform** (documented policy "NOT uniform 1.3x").
- `platformStyle includeFontPadding=false` applied ONCE (documented "only permitted vertical-metric intervention"; screens use spacers, no lineHeight overrides).
- M3 slot mapping via `m3Typography()`; colors left unspecified on purpose.
- `object TypeScale` (1.25 modular) exists alongside the named styles — **two typographic vocabularies**; the named styles are what components consume. Unresolved: TypeScale's role/retirement is an app-owner decision, not ours.

### Spacing / Shape / Motion
- `Spacing4` 4pt scale (xxs…huge).
- `Radii`: semantic set button/chip 4 · input 6 · key 8 · card 10 · panel 12; `lg/xl` **legacy, forbidden** for cards/buttons/chips/keys; `full` circles only.
- `Motion`: Instant/Fast/State/Layout/Ceremonial ms + ExitRatio 0.75. Reduced motion = `LocalReducedMotion`, seeded from system `ANIMATOR_DURATION_SCALE == 0` **and** explicit param.

### Component dimensions / a11y
- `LocalTouchTarget`: 48dp (child/teen/adult) / **64dp senior** — components consume this, hardcoding forbidden (recent commits enforce floors: cockpit, settings cells, skills rows).
- AgeGroup (DB entity) selects typography + touch target; **SeniorType is app-level, NOT Android fontScale**. System font-scale rendering still multiplies all sp values independently → both dimensions matter for matrices (do not conflate ageGroup with device font_scale).
- `Thresholds`: PPM bands + accuracy gates + per-technique target times — gameplay, NOT visual design; out of the design contract's scope (listed so importers don't treat them as style tokens).

## Unresolved / unsupported mappings (kept visible — never silently approximated)
| Item | Why unresolved |
|---|---|
| Reference-image px ↔ dp | design boards are artwork at unknown density; any px→dp rule (e.g. ÷3) is a guess. Conversion requires a recorded density assumption per reference. |
| Light theme | app is **always dark** (`darkTheme` param documented as ignored) → a light-theme matrix row is N/A, not failing. |
| Landscape | app appears phone-portrait; no landscape spec found → N/A until owner decides. |
| Elevation/shadows | no shadow tokens found; surfaces are flat color steps → design-doc elevation values have no target. |
| Web/HTML line-height | `includeFontPadding=false` + spacer-driven rhythm is Compose-specific; web renderers cannot reproduce baseline metrics 1:1. |
| em letter-spacing | renderer-dependent conversion; compare tools must not expect px equality. |
| `tnum` | honored by Compose/layoutlib/Android; arbitrary design tools may ignore it — differences are expected, not regressions. |
| TypeScale vs named styles | two parallel type vocabularies in the app — owner decision which is canonical; we consume the named styles. |

## Status
`operation: completed · check: needs_review (by design — inspection produced findings, no claims)`.
Next possible step (NOT done): a guarded token→design-doc export would require an explicit request + its own tests; the Compose code stays canonical either way.
