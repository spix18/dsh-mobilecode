# dsh-mobilecode design-workbench — file ownership (amended plan)

Concurrent edits to shared files are forbidden. Owner writes; everyone else reads.
Violations go to the captain before any edit.

## Plugin repo (C:\Users\Administrator\Desktop\mobilecode_dsh)

| Path | Owner | Tasks |
|------|-------|-------|
| `lib/index.js` | dsh-engineer (sole writer) | t1, t3 |
| `lib/reference-workspace.js` (new) | dsh-engineer | t1 |
| `lib/visual-compare.js` + `lib/evidence-store.js` (new) | vis-engineer | t2 |
| `lib/config-matrix.js` (new) | vis-engineer | t7m |
| `lib/openpencil-adapter.js` (new) | dsh-engineer | t7 |
| `lib/client.js` | dsh-engineer until t3 done; compose-engineer (gallery section) only after t3 completed | t1, t3, t5 |
| `test/*.mjs` | per-module owner, named after the module | t1, t2, t3, t7m |
| `docs/` | captain + dsh-engineer | t10, gates |
| `evidence/` (plugin) | vis-engineer (append-only) | t2, t5r, t8r |

## Trachtenberg app repo (C:\Users\Administrator\Desktop\trachtenberg_method)

| Path | Owner | Tasks |
|------|-------|-------|
| Production sources | FROZEN until user picks a visual direction (t9 approval gate) | — |
| Preview fixtures / stateless preview entry points | compose-engineer, throwaway branch only, never merged | t4, t5 |
| `docs/design/practice-directions/` | ui-designer | t9 |
| Evidence captures of the app | vis-engineer (frozen captures) | t2, t7m |

## Critic role

- Read-only on code. Writes only findings: `docs/audit/<phase>-<run>.md`.
- Review required before a phase is marked complete; final consolidated audit after all phase gates.
- Independent of implementation and of the ui-designer's direction work.
