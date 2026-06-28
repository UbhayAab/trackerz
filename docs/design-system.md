# Trackerz design system — premium, motion & dark mode

Strict, enforceable rules for the visual layer. The chrome is neutral; colour is
earned. Premium = restraint + crisp motion + real depth. Everything below is
implemented in `styles/tokens.css`, `styles/motion.css`, `styles/theme-premium.css`
and `src/ui/theme.js`.

## 1. Foundations (already in place)

- **One font family**: Inter (system fallback). No second family, ever.
- **One earned accent**: green (`--accent`). It appears only on the primary
  action and on data that means money/progress. No green wash.
- **Type scale**: `--fs-xs … --fs-2xl`, headers tightened `letter-spacing: -.02em`,
  line-height 1.1–1.16 for headings.
- **Spacing**: 4px base grid (`--sp-1…6` = 4/8/12/16/22/30). Group primary
  content blocks with `--sp-4` (16) and section rhythm with `--sp-3`.
- **Semantic colour**: green = success/money, red = risk/urgency, amber = warning,
  blue = wellness/trust. Used for small signifiers (dots, figures, chips), not fills.

## 2. Motion — strict budget

Motion must feel **fast, intentional, and calm**. We animate a lot, but briefly.

**Duration tokens** (`--dur-*`): `instant 90ms`, `fast 150ms`, `base 220ms`,
`slow 320ms`, `entrance 440ms`. Nothing user-blocking exceeds 320ms; entrances
(non-blocking) may reach 440ms.

**Easing tokens**: `--ease-standard: cubic-bezier(.2,0,0,1)` (most transitions),
`--ease-emphasized: cubic-bezier(.2,0,0,.2)` (entrances/exits),
`--ease-spring: cubic-bezier(.34,1.56,.64,1)` (press/pop only, used sparingly).

**What animates, and how:**
| Element | Motion | Token |
|---|---|---|
| Page sections | staggered fade + 8px rise on load | `entrance` / `ease-emphasized` |
| Cards | hover lift 2px + shadow grow | `fast` / `ease-standard` |
| Buttons | press sink 1px, shadow drop | `instant` |
| Nav active | colour + background slide | `base` |
| Toast | slide-up 140%→0 | `slow` / spring-ish |
| Dropzone | border/bg/elevation on state | `base` |
| Theme switch | 220ms colour cross-fade on surfaces | `base` |
| Table rows | fade-in on first paint | `base`, capped stagger |

**Hard rules:**
- Animate only `transform` and `opacity` for anything that runs per-frame
  (never animate `width/height/top/left`).
- Stagger is capped at 6 items (`--stagger: 45ms` each) so long lists don't crawl.
- **`prefers-reduced-motion: reduce` disables all entrances/among transforms**,
  keeping only instant opacity. This is non-negotiable.

## 3. Dark mode — engineering rules

Driven by `:root[data-theme="dark"]`. Resolution order in `src/ui/theme.js`:
explicit user choice (`localStorage trackerz.theme = light|dark|system`) →
else system `prefers-color-scheme`. Applied **before first paint** via a tiny
inline script in each page `<head>` (no flash).

- **Depth from surfaces, not shadows.** Cards (`--panel`) are *lighter* than the
  canvas (`--paper`); elevated layers lighter still. Shadows are softened.
- **Low-contrast borders.** Borders are low-alpha white (`rgba(255,255,255,.09)`),
  never bright lines.
- **Custom deep hue, not flat grey.** Canvas is a deep green-ink (`#101412`),
  on-brand, never pure black or navy-grey.
- **Dimmed status colour.** Accent and semantic hues are slightly brighter for
  legibility but their *soft* fills are low-alpha; badges are de-saturated.
- **`color-scheme: dark`** so native controls/scrollbars match.

## 4. Component states

Every interactive element ships four states: **default, hover, pressed (`:active`),
disabled**. Inputs get an accent focus ring; errors get a red border. Secondary
CTAs use the zero-fill **ghost** button.

## 5. Hierarchy

Highest-value figure: **top-left, bold, tabular-nums**. Money/totals align
**top-right**. Inactive text is `--muted`. Direction is shown with iconography,
not sentences.
