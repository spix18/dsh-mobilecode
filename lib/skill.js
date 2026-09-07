/**
 * dsh-mobilecode — the plugin's bundled playbook, contributed through
 * ctx.skills.register().
 *
 * A tool description answers "what does this argument mean", one tool at a
 * time. What agents re-derive every session is the WORKFLOW between the tools
 * — which observer to reach for, how to confirm an action landed, what a
 * device refuses to tell you. This skill carries that workflow so the model
 * loads it once per UI task instead of rediscovering it by trial and error.
 *
 * Registration is DEFENSIVE: a host without the skill service still loads the
 * plugin, it just does not advertise the playbook (the scoped inject never
 * runs when the service is absent).
 *
 * Playbook design credit: ZSeven-W/dsh-android (MIT) src/skill.ts.
 */

export const SKILL_NAME = "device-ui-automation"

export const SKILL_DESCRIPTION =
  "Drive an attached Android device through the dsh-mobilecode device_* tools: read the screen, tap by identity, " +
  "type, and confirm that an action landed. Load this before the first device_ui_tree / device_tap_element call of a UI task."

export const SKILL_WHEN_TO_USE =
  "Any task that operates an Android app through the device_* tools — opening apps, tapping controls, filling " +
  "fields, scrolling, reading logs, or verifying what is on screen, on an emulator or a real device."

export const SKILL_CONTENT = `# Driving Android with dsh-mobilecode

The loop is **observe once → act with an assertion → observe again only if the assertion could not settle it**. Everything goes through adb; an emulator and a USB phone take exactly the same tools with the same arguments.

## Reading the screen

| Tool | Cost | Use it for |
| --- | --- | --- |
| \`device_ui_tree\` | ~0.6–1.5 s | hierarchy, resource-ids, text, enabled state — the default observer |
| \`device_screen\` | ~0.3 s + OCR | the picture for the user, plus PaddleOCR text+boxes when the tree is blind |
| \`device_log\` | fast | what the device logs (main/crash/events buffers) |

- Start with \`device_ui_tree\`: the accessibility tree carries \`resource-id\` (e.g. \`com.android.settings:id/search_bar\`), the most stable handle a control can have — far better than its text, which changes with the device language.
- \`uiautomator\` dumps a snapshot of the CURRENT frame. If an animation is still running the tree can be a half-finished layout; when a read looks wrong, re-read once rather than reasoning about the wrong frame.
- A shallow or empty tree is NEVER evidence that an app lacks accessibility support. Attribute an unlabeled read to ONE of three causes — (a) the depth/filter cut it: re-read wider; (b) a WebView, Compose or canvas surface that publishes little: \`device_screen\` OCR is the fallback; (c) a DEEP, unfiltered read with no labels — only then may "little accessibility information" be reported. Never jump from a shallow read to "OCR the screen".
- The uiautomator dump fails on a continuously animating foreground (a page still loading) — the error says so. Do not retry; use \`device_screen\` (OCR reads pixels and needs no idle).

## Acting

- Prefer \`device_tap_element\` (resource-id / text / content-desc). Raw pixel coordinates through \`device_input action=tap\` are the last resort — they break on the next layout change.
- When you must tap pixels, take the center of a box from \`device_ui_tree\`/\`device_screen\`: x=(x1+x2)/2, y=(y1+y2)/2. Coordinates are ABSOLUTE pixels of the current display.
- \`device_input action=swipe\` scrolls; \`action=key\` with "back" is a first-class verb on Android — use it instead of hunting for an on-screen back arrow.
- Typing is ASCII-only through adb. Non-ASCII text (Chinese, emoji) cannot be delivered by \`input text\` — do not retry; type via the app's own UI instead.

## Never guess a package name or a control

- A package name that looks plausible is routinely NOT the installed one. Check \`device_status\` / \`device_log filter=<package>\` for what is actually running before assuming.
- Icon-only controls carry no OCR text by definition: the tree's \`content-desc\` is the only reliable handle — a bare tree means "look deeper", never "start guessing".

## Confirming an action landed

- Pass \`expect_text\` (or \`expect_gone\`) to \`device_tap_element\`: the tap and its verification become ONE round trip, and the result carries \`expected.matched\`.
- Waiting for something slow (a load, an animation, a network round trip) is a \`device_ui_tree\`/\`device_screen\` re-read after a pause — one observation, not a poll loop.
- Never compare screenshots or count pixels to decide whether something happened. Read the text back.

## Logs

- \`device_log\` buffers: \`main\` (default), \`crash\` (holds ONLY fatal Java/native crashes — that is where a stack trace lives), \`events\` (activity lifecycle), \`kernel\` (needs adb root; emulators usually allow it).
- An idle emulator emits hundreds of lines a second. Narrow BEFORE widening: \`filter\` (package or tag substring) and a small \`lines\` count first.

## Real devices

- **Every tap on a real phone has real consequences** — posts, likes, purchases, messages. NEVER tap an unidentified control to find out what it does. If a control cannot be identified (no resource-id after a deep tree, no distinguishing text), STOP and report what you see and ask how to proceed. Do not guess coordinates on someone's live account.
- A phone must be UNLOCKED for anything to be visible; \`device_input action=key key="wakeup"\` wakes it, but a PIN/pattern lock cannot be passed from here.
- \`device_status\` reports each device's adb state: \`unauthorized\` means the USB-debugging prompt has not been accepted ON the device — no tool can fix that from this side.
`

/**
 * Register the playbook when the host provides the skill service. The scoped
 * inject is the optional-service pattern: a profile without the skill service
 * simply never runs the callback, and the plugin loads without the playbook.
 */
export function registerMobileSkill(ctx) {
  if (typeof ctx.inject === "function") {
    const fiber = ctx.inject(["skills"], (skillCtx) => {
      skillCtx.effect(() => skillCtx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: SKILL_CONTENT,
        source: "bundled",
      }), "dsh-mobilecode: skill")
    })
    return () => { try { fiber.dispose() } catch { /* already disposed */ } }
  }
  // Very old hosts: direct registration when the service exists, else skip.
  if (ctx.skills && typeof ctx.skills.register === "function") {
    return ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      content: SKILL_CONTENT,
      source: "bundled",
    })
  }
  return undefined
}
