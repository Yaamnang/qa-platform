# Eclype

A slowly turning, crater-detailed moon in eclipse. A burst of light sits on its edge, and three silk ribbons of light flow out of it and wander across a deep violet sky. Two orbit rings (broken arcs and a dotted ring) turn around the moon in opposite directions, and a few constellations sit among the stars. Everything is procedural (three.js shaders), so there are no image assets; a CSS poster stands in until the scene is ready.

## Files

| File | What it is |
| --- | --- |
| `Eclype.jsx` | The React component: scene setup, animation, mouse parallax |
| `eclype-shaders.js` | All GLSL: moon surface bake, moon lighting, glow, sky, ribbons, burst |
| `poster.ts` | The CSS poster of the sky, shown before and instead of the live scene |
| `EclypseBackdrop.tsx` | The sign-in backdrop: poster at once, scene loaded when the page is idle |
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

- **Poster first:** the wrapper (and `EclypseBackdrop`) shows `POSTER_STYLE` from `poster.ts`, CSS gradients that match the sky's colours plus a few faint stars. It renders on the server, so it is there on the first paint. The canvas fades in over it after its first frame and fades out again if the scene stops.
- **Lazy mount:** `EclypseBackdrop.tsx` mounts the scene only after the page has loaded and the browser is idle, only at 1024px and wider, and never with reduced motion. Phones and reduced-motion users never download three.js.
- **Shaders:** compiled up front with `compileAsync`, which runs in the background where the browser supports `KHR_parallel_shader_compile`.
- **Staged reveal:** the sky is in from the first frame, then the moon, the burst and ribbons, then the orbit rings and constellations. `REVEAL` in `Eclype.jsx` sets the timing.
- **Moon map:** 1024x512, baked on the GPU two strips a frame over the first 8 frames. The crater slopes are summed as the surface is built, so each texel is computed once. The moon's stage waits for the map.
- **Cost per frame:** drawn at half the panel size in each direction (`RENDER_SCALE`, device pixel ratio counted as 1) and scaled up by CSS, at most 30 frames a second (`FRAME_MS`).
- **Slow machines:** after the bake, the first second of frames is timed. Over `SLOW_FRAME_MS` on average, the scale drops to `SLOW_SCALE`; still too slow, the scene stops and the poster stays.
- **Refinement:** only after that check passes at `RENDER_SCALE`, the scene climbs back to full quality one step at a time: render scale 0.75, then 1, then device pixel ratio up to 1.5, then a full 2048x1024 moon map baked with the original shader one thin strip a frame (the cheap map stays until it is done), then the fuller sphere, stars, ribbons and sparks (one build per frame), then 6 sky octaves. Each step is timed for `MEASURE_MS`; a slow step is undone and refinement stops for the rest of the visit. It pauses with the animation (tab hidden, window not focused) and holds while a key was pressed in the last `TYPING_HOLD_MS`.
- **Pausing:** the loop stops while the panel is off screen, the tab is hidden or the window does not have focus. On unmount every geometry, material and listener is released and the WebGL context is handed back to the browser at once.
- **No WebGL, software-only WebGL, a lost context or reduced motion:** the poster stays.

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
| Surface map resolution | `BAKE_W` / `BAKE_H` (2048x1024 is sharper but takes 4 times as long to bake) |
| Reveal order and timing | `REVEAL` at the top (start and length of each stage, in seconds) |
| Render resolution, frame cap, slow-machine limits | `RENDER_SCALE`, `FRAME_MS`, `SLOW_FRAME_MS`, `SLOW_SCALE` at the top |
| Detail counts at the start and at full quality | `CHEAP` and `FULL` at the top (sphere segments, stars, sparks, strand steps, sky octaves) |
| Refinement steps and guards | `REFINE_SCALES`, `FULL_PIXEL_RATIO`, `FULL_BAKE_W` / `FULL_BAKE_H`, `FULL_BAKE_STRIPS` (more strips = less work per frame, longer bake), `MEASURE_MS`, `TYPING_HOLD_MS` |
| Poster colours and stars | `poster.ts` |
