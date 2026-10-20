<!-- Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 -->
---
name: CanAI
register: product
palette: Graphite + Vermilion
colors:
  bg: '#f6f7f8'
  surface: '#ffffff'
  surface-2: '#fafbfc'
  surface-3: '#eef0f2'
  canvas-bg: '#edeff2'
  border: '#e4e7ea'
  border-strong: '#d2d7dc'
  ink: '#17181a'
  text-2: '#565a61'
  text-3: '#6b7079'
  accent: '#d33f21'
  accent-hover: '#bd3518'
  accent-press: '#a52e14'
  accent-soft: '#fcebe6'
  accent-soft-border: '#f6cdc3'
  accent-text: '#b83a20'
  danger: '#c62a1c'
  danger-dark: '#ff6b50'
  danger-fill: '#c62a1c'
  danger-soft: '#fbeae7'
  warn-text: '#8a5a12'
  warn-soft: '#fbf1df'
  warn-border: '#efd9ac'
  ok: '#157f4e'
  white: '#ffffff'
typography:
  display:
    family: Onest
    size: 52px
  h1:
    family: Onest
    size: 38px
  h2:
    family: Onest
    size: 22px
  h3:
    family: Onest
    size: 20px
  title:
    family: Onest
    size: 18px
  body-lg:
    family: Onest
    size: 15px
  body:
    family: Onest
    size: 14px
  ui:
    family: Onest
    size: 13px
  small:
    family: Onest
    size: 12px
  micro:
    family: Onest
    size: 11px
  mono:
    family: JetBrains Mono
    size: 13px
rounded:
  panel: var(--radius-panel) # 16px
  control: var(--radius-control) # 10px
  compact: var(--radius-compact) # 8px
  pill: var(--radius-pill) # 999px
---

# Public design guide

This guide is the public version of CanAI's design contract. The local app is a
content-generation studio built around a Canvas, a Library, Assistant, Agents,
and a Workflow/Macro editor. Product behavior, storage formats, accessibility,
and security take priority over visual simplification. Keep this guide in sync
with the semantic tokens in `client/src/styles/tokens.css` and the shared
control rules in `client/src/styles/controls.css`.

## Product language and color

CanAI uses a restrained Graphite + Vermilion palette. Neutral graphite surfaces
carry the interface; Vermilion marks the primary action, current selection, and
active state. In the light theme use `#f6f7f8` for the background, white
surfaces, and `#17181a` ink. The dark theme uses `#0e0f12` and `#1d1f24`, never
absolute black. Secondary text and placeholders must meet WCAG AA contrast.

Use `#d33f21` for the main accent and white text on it only when contrast is at
least 4.5:1. Use `#b83a20` for accent text on light surfaces. Success is
`#157f4e`, warning text is `#8a5a12`, and light-theme danger is `#c62a1c`.
Dark-theme danger text uses `#ff6b50`; danger fills use `#c62a1c` in both
themes so white labels remain readable. Shadows stay neutral and do not glow
with a color.

## Type, spacing, and controls

Onest is the UI and content font (`--font-sans`) for headings, controls,
messages, Assistant, and user text on the Canvas. JetBrains Mono
(`--font-mono`) is reserved for technical values:
prices, zoom, dimensions, timers, counters, slot letters, hotkeys, links, and
diagnostics. Both fonts are bundled locally with Latin and Cyrillic subsets and
their existing SIL OFL notices.

Use semantic typography and spacing tokens. The compact rhythm is 8px, 12px,
and 16px (`--space-2`, `--space-3`, `--space-4`). The standard type roles are
`--text-panel-title` at 16px, `--text-body` at 14px, `--text-control` at 13px,
`--text-secondary` at 12px, and `--text-micro` at 11px.
Avoid fractional tiny sizes such as 9.5px, 10.5px, 11.5px, 12.5px, and 13.5px.

Controls use one shared geometry contract:

- `--control-h-compact`, `--control-h-standard`, and `--control-h-emphasis` are
  32px, 36px, and 44px;
- panel, control, compact, and pill radii are 16px, 10px, 8px, and 999px;
- one-line native controls use `inline-flex`, center their contents, and keep
  `line-height: 1` with no vertical padding growth;
- labels, icons, and values align to the control's center; stacked controls opt
  into the explicit stacked layout contract;
- numeric radii and one-off button shapes are not introduced in component CSS;
  use semantic tokens and the shared controls rule.

## Surfaces and layering

Use three neutral shadow levels (`--shadow-sm`, `--shadow-md`, `--shadow-lg`)
and three functional material weights (`--material-thin`, `--material-regular`,
`--material-thick`). Larger surfaces use a denser material and stronger
separation. Floating functional surfaces include the Prompt dock, toolbars, the
zoom bar, sketch palette, and context menu. Cards have a light border and do
not contain other cards. Popovers materialize from their source control through
`transform-origin`.

Keep the semantic z-order: Canvas UI 300, overlays 400, top bar 500, and modal
1000. Do not invent 999 or 9999 layers. Comparison overlays use their own local
text, border, surface, and material tokens so a video frame cannot reduce
contrast. Their header and hint share an 18px edge; the hint never translates
when controls become resting.

## Status and notices

The top bar uses one status pill with a 6px tone dot for save state and team
connection state. The surface is `--surface-3` and the label uses micro text.
Work pulses the accent, success uses `--ok`, failure uses warning or danger,
and neutral state uses `--text-3`. Add new statuses to the shared status rule.

All notices use the material from `styles/notices.css`: thick material, a
semantic border, control radius, 12px text, a 6px tone dot, pill actions, and a
quiet circular close button. Use a **row** for one sentence and at most one
action. Use a **card** only when there is explanatory text or more than one
action; cards never nest another surface.

Transient notices stack in the lower-right `.notice-corner`. An `.inline-notice`
stays inside the panel it describes while keeping the same material. A clip
editing notice may sit over the frame. Completed events fade after 2 seconds
(6 seconds when an action is offered); a save-in-progress notice expires after
12 seconds and remains visible through Tasks. A review, broken session, or
conflict stays until the user resolves it. Identical events collapse into one
notice with a count and an expandable list. One event produces one notice in
one place.

## Generate, Assistant, and Agents

The bottom dock is one working surface with the explicit modes **Generate**,
**Assistant**, and **Agents**. Switching modes does not change Canvas width or
camera. Text never silently switches a conversation into a paid action.

- **Generate** shows the kind, model, parameters, estimate, references, and
  **Generate** action. Image, Video, and Audio controls use the same compact
  geometry. Multiple selected images can be processed separately or used
  together as references; inputs are captured at start and originals remain.
- **Assistant** keeps conversation history, model, draft, cursor, and references
  together. **Send** shows the estimated cost and follows the user's
  confirmation settings. An explicit request to create or edit media may start
  generation on the Canvas; a prompt-only request does not. Suggested prompts
  expose **Generate**, **Use prompt**, **Copy**, and **Add to canvas**. A moved
  prompt preserves the references from its question and does not run by itself.
- **Agents** provides package selection, task submission, progress, and review
  decisions only when the current transport and server capability advertise
  them. Git/ZIP trust and Python preparation belong in Settings on the desktop
  Host. This edition uses the local Host and excludes CanAI Cloud accounts,
  shared network boards, and collaboration.

On desktop and tablet the dock remains below the Canvas. Narrow layouts use the
available width instead of a second column or a permanent bottom sheet. The
Assistant history scrolls inside its bounded height and has a vertical resize
handle. References use one shared `RefChip`: media receive sequential numbers;
text references remain unnumbered. Text tasks show their stage, seconds, and
**Stop**; changing tabs or closing Assistant does not cancel the task. Agent
buttons on tablet are at least 44px, and the task panel moves above the dock in
portrait mode without covering the input.

## Workflow/Macro editor

The Workflow/Macro editor uses React Flow over a full-window Canvas. One floating
top toolbar contains navigation, the macro name, node choices, diagnostics,
save, and delete. There is no permanent library column. The toolbar, a Canvas
context menu, and `Ctrl+Space` expose the same node list.

Node names, order, IDs, ports, and graph format remain compatible with saved
workflows. A new node lands near the preceding nodes in the nearest free area;
it never covers an existing node. At zoom above 100%, the editor reveals space
around the current center so the new node stays visible. Existing manual layout
is preserved. At 1280px and 768px widths, the page and Canvas do not gain a
horizontal scrollbar; only the toolbar may scroll or compact itself.

Macros run from the Canvas on selected objects. The editor builds and validates
the graph, waits for dirty or in-flight saves before exit, and presents a 409
revision conflict as a recoverable state. It does not add a second execution
mechanism.

## Behavior, accessibility, and safety invariants

- Autosave, server revisions, conflict recovery, and safe exit take priority over
  visual simplification. Media remain `/media/...` links; do not add base64
  media or browser-local project storage.
- Native `window.confirm`, `window.prompt`, and `window.alert` are forbidden.
  Use `askConfirm` from `ui/confirmBus` so a dismissed or blocked browser dialog
  cannot silently cancel an operation.
- Text preparation cannot choose a model, parameters, external URL, or tool on
  behalf of the user. Provider estimates and confirmation precede paid work.
- Verify new layouts at 1280×720 and 768×720, including keyboard focus, visible
  focus rings, contrast, hit targets, and reduced-motion preferences. Keep the
  standard control geometry in `controls.css` rather than creating local rules.

## Motion

Motion is event-driven: idle surfaces do not animate, and a pressed control
responds on pointer-down through `:active` at 0.08s. The ordinary UI spring is
the monotonic CSS `linear()` curve in `--spring-ui` (critically damped, with no
overshoot). Bounce is reserved for a real gesture impulse; buttons, menus, and
new results do not bounce on their own.

Gallery cards cascade at a 40ms step, with no delay after the tenth card. A
preview shimmer runs only while an image is loading. Blur from 16–30px is
limited to functional glass layers. View Transitions connect Library, Canvas,
and Workflow/Macro editor; fresh Canvas results arrive with the 0.28s Konva
ease-out. `prefers-reduced-motion` disables motion, `prefers-reduced-transparency`
makes materials opaque, and `prefers-contrast: more` strengthens borders and
text.

## Product vocabulary

Use one term for each entity in UI text, help, and notices:

| Term | Meaning |
| --- | --- |
| **Board** | A saved file in Library. |
| **Canvas** | The infinite surface inside a Board. |
| **Object** | An image, video, audio item, or text on Canvas. |
| **Reference** | An Object attached to a Prompt. |
| **Prompt** | Request text entered in Generate. |
| **Task** | A unit of work shown in Tasks. |
| **Workflow/Macro** | A node graph edited in the Workflow/Macro editor and run from Canvas. |
| **Assistant** | The conversation surface and its helper. |
| **Agents** | The package and task surface when the transport supports it. |
| **Library** | The saved Board and Assets surface. |
| **Archive** | The surface for archived Assets and Boards. |
| **Trash** | The recoverable deleted-Board surface. |

## Do and do not

- **Do** reserve Vermilion for action, selection, and state; keep the rest
  neutral; meet 4.5:1 text contrast; use Mono only for technical data; reuse
  semantic spacing, radius, type, and control tokens.
- **Do not** add purple or cyan gradients, cream backgrounds, colored glow
  shadows, gradient text, eyebrow chips, nested cards, arbitrary numeric radii,
  fractional tiny type, multi-bounce or elastic motion, bounce without user
  impulse, or gray text on a colored surface.
