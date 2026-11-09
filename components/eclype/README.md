# Eclype

A slowly turning, crater-detailed moon in eclipse. A burst of light sits on its edge, and three silk ribbons of light flow out of it and wander across a deep violet sky. Two orbit rings (broken arcs and a dotted ring) turn around the moon in opposite directions, and a few constellations sit among the stars. Everything is procedural (three.js shaders), so there are no image assets.

## Files

| File | What it is |
| --- | --- |
| `Eclype.jsx` | The React component: scene setup, animation, mouse parallax |
| `eclype-shaders.js` | All GLSL: moon surface bake, moon lighting, glow, sky, ribbons, burst |
| `index.js` | Entry point (`import Eclype from "./eclype"`) |

Copy the whole folder into the other project. It has no CSS file and no other local imports.

## Requirements

- React 18 or newer
- three (built and tested with `three@0.181`)

```bash
npm install three
```

## Usage

The component fills its parent, so give the parent a size.

**Full screen (Next.js App Router):**

```jsx
import Eclype from "@/components/eclype"; // wherever you put the folder

export default function Page() {
  return (
    <main style={{ position: "fixed", inset: 0 }}>
      <Eclype />
    </main>
  );
}
```

**As a section background, with your own content on top:**

```jsx
<section style={{ height: "100vh" }}>
  <Eclype>
    <h1>Your headline</h1>
  </Eclype>
</section>
```

Children render above the canvas. Props:

| Prop | Type | Notes |
| --- | --- | --- |
| `className` | string | Added to the wrapper `div` |
| `style` | object | Merged into the wrapper's inline style |
| `children` | node | Rendered over the scene |

`Eclype.jsx` starts with `"use client"`, so it works directly in the Next.js App Router. In Vite, CRA or the Pages Router, import it like any other component.

## Behaviour

- **Loading:** the wrapper starts as a plain colour, `#05040f` (`BASE_COLOR` in `eclype-shaders.js`). All shaders are compiled up front with `compileAsync`, which runs in the background where the browser supports `KHR_parallel_shader_compile`. The first frame drawn is that same plain colour, so the hand-over to WebGL is invisible.
- **Staged reveal:** the sky fades in, then the moon, then the burst lights up and the ribbons grow out of it, then the orbit rings and constellations. Each layer's shader multiplies its output by one 0-to-1 uniform (`uBg`, `uMoon`, `uWaves`, `uZodiac`); `REVEAL` in `Eclype.jsx` sets when each one starts and how long it takes. Everything settles by 2.5 s. At 1 every layer draws exactly as it did before the reveal existed.
- **Moon map:** the surface map (2048×1024) is baked on the GPU, 4 strips per frame over the first 16 frames, so no single frame stalls. The moon's stage waits for it.
- **Lazy mount:** `EclypseBackdrop.tsx` (used by the QA console's sign-in pages) mounts this component only after the page is interactive and the browser is idle, and only at 1024px and wider, so phones never download three.js.
- **Mouse:** the moon and ribbons shift in depth with the mouse, and the ribbons bend away from the cursor. The sky stays still.
- **Performance:** pixel ratio capped at 1.5. Animation pauses when the component is off screen or the tab is hidden. On unmount every geometry, material and listener is released and the WebGL context is handed back to the browser at once.
- **Reduced motion:** if the user prefers reduced motion, there is no reveal and no movement: the settled scene is drawn once.
- **No WebGL, or software-only WebGL** (no GPU, as in headless test browsers): the plain colour stays. Baking the moon map in software would freeze the page for many seconds.

## Tuning

All in `Eclype.jsx` unless noted:

| What | Where |
| --- | --- |
| Moon size and position | `radius`, `moonX`, `moonY` in `layout()` |
| Light direction (crescent width) | `LIGHT` at the top |
| Moon spin speed | `spin += dt * 0.035` in `loop` |
| Ribbon shape, colour, wave height | the `ribbons` list (`amp` = wave height, `freq` = wave count, `warm` = gold vs violet) |
| How far ribbons swing / how fast | `MAX_ANGLE` (keep under ~40° so they never go vertical) and the `a`/`b` speeds in `wander` |
| Orbit rings (size, gaps, speed and direction) | `ARC_RING` and `DOT_RING` at the top (`speed` + = counter-clockwise) |
| Constellations (position, shape, which star is warm or larger) | `CONSTELLATIONS` at the top |
| Crater detail | crater weights in `surface()` in `eclype-shaders.js` |
| Surface map resolution | `BAKE_W` / `BAKE_H` (4096×2048 is sharper but takes 4 times as long to bake) |
| Reveal order and timing | `REVEAL` at the top (start and length of each stage, in seconds) |
| Pixel ratio cap | `MAX_PIXEL_RATIO` at the top |
