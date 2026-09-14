# Renderer adapter decision (T4) — evidence-based

## Constraints
- Trachtenberg app toolchain UNCHANGED: AGP 8.7.3, Gradle wrapper 8.11.1, Kotlin 2.1.0,
  Compose BOM 2024.12.01, material3 1.3.1, JVM 17, host Java 21, Windows.
- No toolchain migrations without explicit user approval.

## Candidates evaluated

| Candidate | Verdict | Evidence |
|---|---|---|
| compose-ai-tools (yschimke) | **BLOCKED on this toolchain** | README states requirements Java 17+, **Gradle 8.13+, AGP 8.13.0+**, Kotlin 2.0.21+. App has AGP 8.7.3 / Gradle 8.11.1 → adopting it = major toolchain migration (needs user approval). Setup path: upgrade AGP→8.13.x + Gradle→8.13+ (not performed). |
| Official Compose Preview Screenshot Testing (`com.android.compose.screenshot`) | **SELECTED — works unchanged** | Full compile+render smoke passed (below). |
| Roborazzi / Paparazzi | **not pursued** (YAGNI) | Primary path proven without them; keep as fallback if the alpha plugin destabilizes. |

## Smoke evidence (branch `feat/preview-screenshot-smoke`, throwaway)
- Plugin applies and resolves: `id("com.android.compose.screenshot") version "0.0.1-alpha16"`
  (note: **no 8.7.3 exists** — the plugin has its own version line, latest alpha16, published 2026-07-27; verified from Google Maven maven-metadata.xml).
- Module opt-in required: `experimentalProperties["android.experimental.enableScreenshotTest"] = true` (app block) — error text names it, applied 2026-09-14.
- Compile: `:app:compileDebugScreenshotTestKotlin` OK.
- Render: `:app:updateDebugScreenshotTest` **BUILD SUCCESSFUL**, produced:
  - `PreviewSmokeTest/smokeDigitRow_Smoke Digit Row_*.png` — 945x35, stock M3 Text in TrachtenbergTheme.
  - `PreviewSmokeTest/smokeAppDigits_Smoke App Digits_*.png` — **945x124, REAL app design-system components**: `DigitText('7')`, `DigitText('3', highlight=true)`, `DigitText('8')` inside `TrachtenbergTheme`. Visually inspected: digits render. 3436 bytes. sha256 4b0ec3b3…
- Regression semantics: `:app:validateDebugScreenshotTest` **BUILD SUCCESSFUL** against recorded baselines; baselines live in `app/src/screenshotTestDebug/reference/**` — plain committable PNGs = human-approvable artifacts.
- Discovery contract (learned empirically; NOT obvious from truncated docs):
  `screenshotTestImplementation("com.android.tools.screenshot:screenshot-validation-api:0.0.1-alpha16")` +
  class named `*Test*` (Gradle class filter!) + **method** annotated `@PreviewTest` **and** `@Preview @Composable` —
  marker annotation has no members; class-level use is a compile error ("applicable targets: function");
  engine error "@Preview annotation is required for @PreviewTest".
- Width math sanity: widthDp=360 → 945px at density 2.625 ✓.

## Limitations (provenance, tracked)
- **Host-rendered (layoutlib), NOT device-verified.** No claim of real-device behavior.
- Plugin is 0.0.1-alpha — API/format may shift; pin alpha16.
- Existing private main-source `@Preview`s (14 across Journey/Dashboard/PracticeSetup/Rank/Skills — final audit F-1 corrected the earlier count of 15, one grep hit was a comment reference) are NOT rendered by this flow — public wrappers in `screenshotTest` source are the way (planned T5 "fixture entry points", throwaway branch, no architecture rewrites).
- Recording renders one configuration per test method; matrix = multiple @Preview/@PreviewTest entries (bounded by design, T7m).

## Decision
**Primary path = official Compose Preview Screenshot Testing, pinned 0.0.1-alpha16**, driven through the unchanged toolchain on the throwaway branch. App production sources untouched; only `app/build.gradle.kts` (+2 lines), `gradle.properties` (+2 lines) and `src/screenshotTest/**` on the smoke branch.
