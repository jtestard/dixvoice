# Visual identity: Tape Deck

Dixvoice's look is **Tape Deck**: mixtapes, hand-written labels and masking tape. It should feel loud and handmade,
with party-game energy, the way a stack of cassettes looks on a friend's shelf. The clips are the heroes: each one is
a small labelled tape card you tap to hear.

Design canvas (the reference board, shared from its Share menu):
https://claude.ai/artifact/CU5HaR9ZDRyx7vH6EhqAsA (board "B · Tape Deck").

## Principles

- **Flat ink on paper.** Solid colours, 2px ink outlines, hard offset shadows (`4px 4px 0` ink). No blurred shadows,
  gradients, glass or glow.
- **Slightly off-kilter.** Cards and stickers sit at small rotations (±1–3°), like things taped onto a page. Text
  blocks, inputs and buttons stay straight so they remain easy to read and tap.
- **Labels speak mono.** Anything that sounds like a machine label (clip number, duration, room code, phase, "FIRST
  TO 10") is uppercase IBM Plex Mono. Everything else is Bricolage Grotesque.
- **One loud colour.** Tomato is the brand colour and the "this is you / this is selected / this is the action"
  colour. Teal is the calm counterpart (success, done, face-down backs). Don't add more colours.

## Colour tokens

Apply these through the existing variables in `webapp/frontend/src/index.css` (no component should hard-code a hex).

| Name | Hex | Role | Maps to |
|---|---|---|---|
| Paper | `#F3ECDD` | Page background | `--color-bg` |
| Card | `#FFFDF7` | Surfaces: cards, panels, inputs | `--color-surface` |
| Ink | `#1E1B18` | Text, outlines, hard shadows, primary buttons | `--color-text`, `--color-primary`, `--color-border`, `--color-selected` |
| Ink soft | `#4A433B` | Secondary text | `--color-muted` |
| Tomato | `#E85A3C` | Brand accent: logo "dix", clip label strips, selected state, score pips | new `--color-accent` |
| Tomato deep | `#B8351F` | Errors, danger buttons, accent text on paper | `--color-danger` |
| Teal | `#1F6F6A` | Success, "done" status, face-down card backs | `--color-success` |
| Kraft | `#D8C7A3` | Secondary buttons, tags, dividers | `--color-secondary`, `--color-selected-bg` |

Notice backgrounds: keep them in the palette: error `#F8D9CF`, info `#D6E6E4`, warning `#F5E2B0`, all with Ink text.

Contrast (checked, WCAG AA):

- Ink on Paper 14.6:1, on Card 16.9:1, on Kraft 10.3:1, on Tomato 4.9:1.
- Ink soft on Paper 8.3:1. Paper on Teal 5.0:1. Tomato deep on Paper 5.0:1, on Card 5.8:1.
- **Never put white or paper text on Tomato** (fails). Text on Tomato is always Ink.
- Don't use Tomato `#E0472B` (the canvas's first draft): Ink on it is only 4.2:1.

## Typography

| Use | Font | Weight / style |
|---|---|---|
| Wordmark, screen titles, clue text, big numbers | **Bricolage Grotesque** | 800, letter-spacing `-0.03em` to `-0.04em` |
| Body, buttons, inputs, player names | **Bricolage Grotesque** | 500 (700 for buttons) |
| Labels, clip numbers, durations, room code, phase names | **IBM Plex Mono** | 600, uppercase, letter-spacing `0.1em` |

- Self-host the fonts (e.g. `@fontsource-variable/bricolage-grotesque` and `@fontsource/ibm-plex-mono`) so the itch.io
  zip works offline and without third-party requests. Keep system-font fallbacks in `--font` / `--font-mono`.
- Scale (mobile first): body 16px, labels 12–13px, screen title 32px, clue 28px, wordmark 56px on phones (up to 104px
  on desktop home).

## Shape, spacing, depth

- Keep the existing `--space-*` scale and `--tap: 44px`.
- `--radius: 6px` for cards and buttons, `4px` for tags, swatches and pips. Pills and fully round shapes only for
  avatars and score pips.
- Outlines: `2px solid` Ink on cards, buttons, inputs and panels. Selected/focused: `3px`.
- Depth: new `--shadow: 4px 4px 0 var(--color-text)`; selected card `6px 6px 0`. Pressed buttons translate
  `2px 2px` and drop the shadow to `2px 2px 0` (tactile "click").
- Focus ring: `outline: 3px solid var(--color-accent); outline-offset: 2px`.

## Logo

The mark is a cassette in Tomato with Ink outlines; the wordmark is "**dix**voice" in Bricolage Grotesque 800, "dix" in
Tomato and "voice" in Ink, all lower case.

```svg
<svg width="92" height="64" viewBox="0 0 92 64" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="88" height="60" rx="7" fill="#E85A3C" stroke="#1E1B18" stroke-width="3"/>
  <rect x="13" y="11" width="66" height="26" rx="3" fill="#FFFDF7" stroke="#1E1B18" stroke-width="2.5"/>
  <circle cx="31" cy="24" r="7" fill="#F3ECDD" stroke="#1E1B18" stroke-width="2.5"/>
  <circle cx="61" cy="24" r="7" fill="#F3ECDD" stroke="#1E1B18" stroke-width="2.5"/>
  <path d="M24 62l5-14h34l5 14" fill="none" stroke="#1E1B18" stroke-width="2.5"/>
</svg>
```

Use the mark alone for the favicon and the itch.io icon; mark + wordmark on the Home screen and the itch.io cover.

## Components

**Clip card** (the hand, submit and vote screens). About 2:3 portrait; on phones the 6 cards sit in a 3×2 grid, on
wider screens in one row.

- Card surface, 2px Ink outline, 6px radius, overflow hidden.
- Top label strip: Tomato fill, 2px Ink bottom border, mono `CLIP 01` (the clip's position in the hand) in Ink.
- Middle: a static waveform of ~16 square Ink bars, 3px wide, 2px gaps, with a fade in and out at both ends (height
  derived from the clip id so it is stable, it doesn't need to reflect the real audio in v1).
- Bottom strip: dashed 2px Ink top border, a play triangle on the left, mono `2s` on the right. While playing, the
  triangle becomes a pause icon and the bars animate (respect `prefers-reduced-motion`).
- The whole card is the `<button>` (it plays the clip); selection is a separate, explicit action where the phase needs
  it.
- Rotation: each card gets a stable tilt from the set `-2.5, 1.5, -1, 2, 1, -2` degrees by position. Selected card:
  3px outline, lifted `translateY(-12px)`, `6px 6px 0` shadow, no tilt.

**Face-down card** (hidden storyteller clip, other players' submissions before the vote): Teal with 45° stripes
(`repeating-linear-gradient(45deg, #1F6F6A 0 8px, #257D77 8px 16px)`), 2px Ink outline, centred Paper circle with a
Bricolage 800 "?".

**Clue**: a Card-coloured strip rotated `-1.2deg`, 2px Ink outline, hard shadow, mono `CLUE` label in Teal above the
clue in Bricolage 800. It's the most important text on a round screen, so make it big.

**Score track** ("FIRST TO 10", a nod to "dix" = ten): 10 square pips, 2px Ink outline, Tomato fill up to the score,
Card fill after. Use it on the scoreboard next to each player; the current player's row gets a Kraft background.

**Buttons**:

- Primary: Ink fill, Paper text, hard Tomato shadow `4px 4px 0 var(--color-accent)`.
- Secondary: Kraft fill, Ink text and outline.
- Danger (Stop): Card fill, Tomato-deep text and outline; the in-page confirmation uses a filled Tomato-deep button
  with Card text.
- Link: Tomato-deep, underlined.

**Room code**: each letter in its own Card tile (mono 600, 32px+, 2px Ink outline, alternating ±2° tilt), like label
maker tape. Easy to read aloud, still copyable as one string.

**Player list / status tags**: Kraft tags with mono uppercase text; "done" tags in Teal with Paper text; "waiting"
in Card with Ink soft text. The storyteller gets a Tomato tag reading `STORYTELLER`.

**Notices and banners**: the matching notice background (see Colour tokens), 2px Ink outline, hard shadow, and a mono
label (`ERROR`, `INFO`) before the message.

## Motion

Short and physical: 120–180ms ease-out. Cards drop in with a small overshoot when dealt; the reveal flips face-down
cards (`rotateY`). No looping ambient animation except the playing waveform. Everything turns off under
`prefers-reduced-motion: reduce`.

## itch.io page

- Page background Paper, text Ink, links Tomato deep, buttons Ink (itch.io's theme editor accepts these hexes).
- Cover image (630×500): Paper background, the hand of tilted clip cards fanned out, the wordmark on top.
- Screenshots: the round screens on a phone frame against Paper.

## Out of scope for v1

Illustrations per clip, custom sound design for UI clicks, dark mode. Keep the tokens so a dark "night shift" variant
(Ink background, Paper text) can be added later by redefining the variables only.
