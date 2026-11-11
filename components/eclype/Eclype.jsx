"use client";

// Eclype: a slowly turning moon in eclipse with silk ribbons of light.
// Needs only React and three. Fills its parent element.
// See README.md in this folder.

import { useEffect, useRef } from "react";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, Group,
  LineBasicMaterial, LineSegments, LinearFilter, LinearMipmapLinearFilter, MathUtils, Matrix3, Matrix4,
  Mesh, NoBlending, NormalBlending, PerspectiveCamera, PlaneGeometry, Points, RepeatWrapping, Scene,
  ShaderMaterial, SphereGeometry, Vector2, Vector3, Vector4, WebGLRenderTarget, WebGLRenderer,
} from "three";
import { POSTER_STYLE } from "./poster";
import {
  BASE_COLOR,
  fullscreenVertex, bakeFragment, bakeFragmentFull, moonVertex, moonFragment, haloFragment,
  backgroundVertex, backgroundFragment, galaxyFragment, starVertex, starFragment,
  strandVertex, strandFragment, sparkVertex, sparkFragment, flareVertex, flareFragment,
  markVertex, markFragment,
} from "./eclype-shaders";

const FOV = 16; // long lens: no stretching of the moon at the screen edge
const HALF_H = 6; // visible half-height (world units) on the z = 0 plane
const CAMERA_Z = HALF_H / Math.tan(MathUtils.degToRad(FOV / 2));
const LIGHT = new Vector3(-0.55, 0.2, -0.81).normalize();
// The moon map. The bake shader is the most expensive thing the scene runs,
// so the map is small (the moon is drawn at half resolution anyway) and is
// baked two strips (1024 x 32 pixels each) a frame, done in 8 frames.
const BAKE_W = 1024;
const BAKE_H = 512;
const BAKE_STRIPS = 16;
const BAKE_STRIPS_PER_FRAME = 2;

// Quality. The canvas is drawn at RENDER_SCALE of the panel's CSS size in
// each direction (device pixel ratio counted as at most 1) and CSS scales it
// up: a quarter of the pixels, and the image is soft and glowing anyway.
const RENDER_SCALE = 0.5;
// After the moon map is baked, the first second of frames is timed. If the
// average gap between drawn frames is over SLOW_FRAME_MS, the scale drops to
// SLOW_SCALE; if it is still too slow, the scene stops and the poster stays.
const SLOW_SCALE = 0.35;
const SLOW_FRAME_MS = 50;
// At most 30 frames a second. The 2 ms slack keeps a 60 Hz screen at 30.
const FRAME_MS = 1000 / 30 - 2;

// Detail counts at the start, and at full quality after refinement.
const CHEAP = { sphere: [96, 64], stars: 900, sparks: 300, steps: 120, octaves: 4 };
const FULL = { sphere: [160, 120], stars: 1300, sparks: 450, steps: 180, octaves: 6 };

// Refinement. It starts only after the speed check passes at RENDER_SCALE.
// Steps run one at a time; each is timed for MEASURE_MS of frames, and one
// that is too slow is undone and refinement stops there for this visit.
const MEASURE_MS = 1000; // length of one timing window
const REFINE_SCALES = [0.75, 1]; // render scale steps after RENDER_SCALE
const FULL_PIXEL_RATIO = 1.5; // last resolution step: device pixel ratio up to this
const FULL_BAKE_W = 2048; // the original moon map size
const FULL_BAKE_H = 1024;
const FULL_BAKE_STRIPS = 256; // 2048 x 4 texels each, one per frame: about 8.5 s at 30 fps
const TYPING_HOLD_MS = 1000; // no refinement work within this long of a key press

// Staged reveal: the canvas fades in over the poster showing the sky, then
// the moon, then the light ribbons, then the constellations and orbit rings.
// Times in seconds. Each stage starts when the one before is about 70% in.
const REVEAL = {
  moon: { start: 0.4, length: 0.8 },
  waves: { start: 0.95, length: 0.9 },
  zodiac: { start: 1.6, length: 0.8 },
};
const easeOut = (x) => 1 - (1 - x) ** 3;

// Orbit rings around the moon (radii in moon radii, speeds in radians/second;
// + is counter-clockwise). They turn in opposite directions.
const ARC_RING = { radius: 1.3, speed: -0.025, arcs: [[0.2, 1.9], [2.3, 3.7], [4.1, 5.7]] };
const DOT_RING = { radius: 1.58, speed: 0.04, step: 0.03, gaps: [[0.9, 1.5], [3.6, 4.4]] };

// Constellations sit far back in the sky (fixed to the view, like the stars)
// but are placed relative to the moon as seen on screen, so the composition
// holds at any panel size. "at" is the position in moon radii from the moon's
// centre (+x right, +y up); star offsets are in moon radii too. "warm" marks
// the orange star, "bright" the larger one.
const SKY_Z = -40;
const CONSTELLATIONS = [
  { at: [-1.65, 0.69], stars: [[0, 0], [0.24, 0.21], [0.52, -0.03], [-0.21, -0.14]], lines: [[0, 1], [1, 2], [2, 0], [0, 3]], warm: 2, bright: 1 },
  { at: [-1.94, -0.93], stars: [[0, 0.24], [0.03, -0.1], [-0.22, -0.03]], lines: [[0, 1], [1, 2]], warm: 0 },
  { at: [-1.2, -1.35], stars: [[0, 0], [0.21, 0.17], [0.29, -0.1]], lines: [[0, 1], [1, 2], [2, 0]], bright: 1 },
  { at: [-0.03, -1.63], stars: [[0, 0], [0.31, 0.17], [0.59, 0.03], [0.47, -0.24], [0.14, -0.29]], lines: [[0, 1], [1, 2], [2, 3], [3, 4]], warm: 2, bright: 0 },
  { at: [-1.13, 0.97], stars: [[0, 0], [0.21, 0.09], [0.4, -0.03]], lines: [[0, 1], [1, 2]] },
];
const COOL = [0.82, 0.8, 1];
const WARM = [1, 0.7, 0.42];

// The wrapper shows the poster until the canvas has faded in over it.
const wrapStyle = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  ...POSTER_STYLE,
};
const stageStyle = { position: "absolute", inset: 0 };
const canvasStyle = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  // Hidden until the first frame is drawn: a fresh WebGL canvas is black.
  opacity: "0",
  transition: "opacity 0.8s ease-out",
};
const contentStyle = { position: "relative", zIndex: 1, height: "100%" };

/**
 * @param {{ className?: string, style?: import("react").CSSProperties, children?: import("react").ReactNode }} props
 */
export default function Eclype({ className, style, children }) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    // The effect makes its own canvas, so every mount gets a fresh WebGL
    // context and the cleanup can hand that context straight back to the
    // browser. (A canvas whose context was released cannot be used again,
    // which matters when React mounts the component twice in development.)
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, canvasStyle);
    stageRef.current.appendChild(canvas);

    let renderer;
    try {
      // "default", not "high-performance": a decorative background should not
      // wake up the discrete GPU on a dual-GPU laptop.
      renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "default" });
    } catch {
      // No WebGL: the poster stays.
      canvas.remove();
      return undefined;
    }
    // Software WebGL (no GPU: headless test browsers, some VMs and old laptops)
    // would be far too slow. Keep the poster instead.
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu)) {
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      return undefined;
    }
    renderer.setClearColor(BASE_COLOR, 1);
    renderer.autoClear = true;

    // Seeded random numbers. state() lets a later build replay the same
    // sequence, so the fuller star and spark sets start with the cheap ones.
    const makeRandom = (start) => {
      let seed = start;
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      next.state = () => seed;
      return next;
    };
    const random = makeRandom(91);

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 400);
    camera.position.set(0, 0, CAMERA_Z);
    // The sky (stars, galaxies) rides with the camera so it never shifts with
    // the mouse; only the moon and the light strands respond in depth.
    scene.add(camera);

    const disposables = [];
    const track = (item) => { disposables.push(item); return item; };
    const shared = {
      uTime: { value: 0 },
      uHalf: { value: new Vector2(HALF_H, HALF_H) },
      uFocal: { value: new Vector2() },
      uLength: { value: 16 },
      uAngles: { value: new Vector4() },
      uSpread: { value: HALF_H },
      uPointer: { value: new Vector3() },
      uPixel: { value: 0.01 },
      uDpr: { value: 1 },
      uOctaves: { value: CHEAP.octaves },
      uLight: { value: LIGHT },
      // How far each layer is through its reveal, 0 (absent) to 1 (fully in).
      // Every material shares this object, so one assignment per frame
      // updates all of them. Set in applyReveal() below. The sky (uBg) is
      // in from the start: the canvas fades in over the poster instead.
      uBg: { value: 1 },
      uMoon: { value: 0 },
      uWaves: { value: 0 },
      uZodiac: { value: 0 },
    };
    const material = (vertexShader, fragmentShader, uniforms = {}, options = {}) => track(new ShaderMaterial({
      uniforms: { ...shared, ...uniforms },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      ...options,
    }));
    const add = (object, order) => {
      object.frustumCulled = false;
      object.renderOrder = order;
      scene.add(object);
      return object;
    };

    // ---- Backdrop: nebula, galactic band and the finest stars (at infinity).
    const quad = track(new PlaneGeometry(2, 2));
    // Everything stays in one render list ordered by renderOrder.
    add(new Mesh(quad, material(backgroundVertex, backgroundFragment, {}, {
      blending: NoBlending,
    })), 0);

    // ---- Distant galaxies, far behind the moon.
    const plane = track(new PlaneGeometry(1, 1));
    [
      { x: -0.62, y: 0.62, z: -90, size: 7, squash: 0.38, tilt: 0.5, bright: 0.55 },
      { x: 0.48, y: 0.78, z: -140, size: 9, squash: 0.3, tilt: -0.35, bright: 0.4 },
      { x: -0.1, y: -0.72, z: -110, size: 6, squash: 0.55, tilt: 1.1, bright: 0.45 },
      { x: 0.93, y: -0.88, z: -160, size: 8, squash: 0.45, tilt: 2.2, bright: 0.35 },
    ].forEach((g, index) => {
      const mesh = add(new Mesh(plane, material(flareVertex, galaxyFragment, {
        uSeed: { value: index * 1.37 + 0.3 },
        uBright: { value: g.bright },
      })), 1);
      mesh.userData.galaxy = g;
      mesh.rotation.z = g.tilt;
      mesh.scale.set(g.size, g.size * g.squash, 1);
    });
    const galaxies = scene.children.filter((child) => child.userData.galaxy);
    galaxies.forEach((mesh) => camera.add(mesh));

    // ---- Starfield in depth, fixed to the view.
    const buildStars = (count, rand) => {
      const starPos = new Float32Array(count * 3);
      const starSize = new Float32Array(count);
      const starSeed = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const z = -10 - Math.pow(rand(), 0.7) * 150;
        const half = (CAMERA_Z - z) * Math.tan(MathUtils.degToRad(FOV / 2)) * 1.25;
        starPos[i * 3] = (rand() * 2 - 1) * half * 2.6;
        starPos[i * 3 + 1] = (rand() * 2 - 1) * half;
        starPos[i * 3 + 2] = z - CAMERA_Z;
        const r = rand();
        starSize[i] = r > 0.988 ? 2.5 + rand() * 1.3 : 0.45 + Math.pow(rand(), 3) * 1.5;
        starSeed[i] = rand();
      }
      const geometry = track(new BufferGeometry());
      geometry.setAttribute("position", new BufferAttribute(starPos, 3));
      geometry.setAttribute("aSize", new BufferAttribute(starSize, 1));
      geometry.setAttribute("aSeed", new BufferAttribute(starSeed, 1));
      return geometry;
    };
    const starStart = random.state();
    const stars = new Points(buildStars(CHEAP.stars, random), material(starVertex, starFragment));
    stars.frustumCulled = false;
    stars.renderOrder = 2;
    camera.add(stars);

    // ---- Moon surface: baked once (in strips) into a normal + albedo map.
    const mapOptions = {
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      generateMipmaps: true, // allocates the mip chain; regenerated on the first and last strip only
      depthBuffer: false,
    };
    const bakeTarget = track(new WebGLRenderTarget(BAKE_W, BAKE_H, mapOptions));
    bakeTarget.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const bakeScene = new Scene();
    const bakeMaterial = track(new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: bakeFragment,
      depthTest: false,
      depthWrite: false,
    }));
    const bakeMesh = new Mesh(quad, bakeMaterial);
    bakeMesh.frustumCulled = false;
    bakeScene.add(bakeMesh);
    let bakedStrips = 0;
    const bakeStrip = () => {
      const stripH = BAKE_H / BAKE_STRIPS;
      bakeTarget.scissor.set(0, bakedStrips * stripH, BAKE_W, stripH);
      bakeTarget.scissorTest = true;
      bakeTarget.texture.generateMipmaps = bakedStrips === 0 || bakedStrips === BAKE_STRIPS - 1;
      renderer.setRenderTarget(bakeTarget);
      renderer.render(bakeScene, camera);
      renderer.setRenderTarget(null);
      bakedStrips += 1;
    };
    const baked = () => bakedStrips >= BAKE_STRIPS;
    // A few strips per frame, never the whole map at once.
    const bakeSome = () => {
      if (baked()) return;
      for (let i = 0; i < BAKE_STRIPS_PER_FRAME && !baked(); i++) bakeStrip();
      if (baked()) {
        moonUniforms.uReady.value = 1;
        // The bake shader is never needed again: free its GPU program now.
        bakeMaterial.dispose();
      }
    };

    // ---- Eclipse halo behind the moon.
    const halo = add(new Mesh(plane, material(flareVertex, haloFragment, {}, { depthTest: true })), 3);

    // ---- The moon: a real sphere, lit from behind, slowly turning.
    const moonPivot = new Group();
    moonPivot.rotation.set(0.32, 0, -0.22);
    scene.add(moonPivot);
    const rotation = new Matrix3();
    const rotation4 = new Matrix4();
    const moonUniforms = {
      uMap: { value: bakeTarget.texture },
      uRot: { value: rotation },
      uReady: { value: 0 },
    };
    const moon = new Mesh(
      track(new SphereGeometry(1, ...CHEAP.sphere)),
      // Normal blending so the moon can fade in with alpha (uMoon). Once it
      // is fully in, alpha is 1 and this draws exactly like the opaque moon.
      material(moonVertex, moonFragment, moonUniforms, {
        blending: NormalBlending,
        depthTest: true,
        depthWrite: true,
      }),
    );
    moon.renderOrder = 4;
    moonPivot.add(moon);

    // ---- Silk ribbons of light flowing left from the burst, through depth.
    // Each ribbon is a bundle of fine strands sharing one big slow sine wave;
    // the strands fan apart a little so the ribbon widens as it travels.
    // fan = slope, bend = curvature, amp = wave height (all in moon radii),
    // freq = wave count, phase = where the crest sits.
    const ribbons = [
      { count: 14, fan: 0.04, bend: 0.12, amp: 0.9, freq: 0.5, phase: 0, warm: 0.95, depth: 0.2 },
      { count: 13, fan: -0.14, bend: -0.08, amp: 0.78, freq: 0.28, phase: 0.45, warm: 0.08, depth: -0.4 },
      { count: 12, fan: 0.24, bend: 0.25, amp: 0.62, freq: 0.75, phase: 0.72, warm: 0.6, depth: 0.6 },
    ];
    const strandSeeds = [];
    ribbons.forEach((ribbon, ribbonIndex) => {
      for (let i = 0; i < ribbon.count; i++) {
        const warm = Math.min(1, Math.max(0, ribbon.warm + (random() - 0.5) * 0.4));
        strandSeeds.push({
          seed: [
            ribbon.fan + (random() - 0.5) * 0.22,
            ribbon.freq + (random() - 0.5) * 0.06,
            ribbon.phase + (random() - 0.5) * 0.08,
            warm,
          ],
          meta: [0.65 + random() * 0.3, 0.35 + random() * 0.65, ribbon.depth + (random() - 0.5) * 0.4],
          shape: [ribbon.bend + (random() - 0.5) * 0.1, ribbon.amp * (0.88 + random() * 0.24)],
          ribbon: ribbonIndex,
        });
      }
    });
    // A few faint loose threads between the ribbons.
    for (let i = 0; i < 6; i++) {
      strandSeeds.push({
        seed: [(random() - 0.5) * 0.8, random(), random(), random()],
        meta: [0.5 + random() * 0.4, 0.2 + random() * 0.25, random() * 2 - 1],
        shape: [(random() - 0.5) * 0.4, 0.1 + random() * 0.2],
        ribbon: 3,
      });
    }
    const STRANDS = strandSeeds.length;
    const buildStrands = (steps) => {
      const vertsPerStrand = (steps + 1) * 2;
      const aT = new Float32Array(STRANDS * vertsPerStrand);
      const aSide = new Float32Array(STRANDS * vertsPerStrand);
      const aSeed = new Float32Array(STRANDS * vertsPerStrand * 4);
      const aMeta = new Float32Array(STRANDS * vertsPerStrand * 3);
      const aShape = new Float32Array(STRANDS * vertsPerStrand * 2);
      const aRibbon = new Float32Array(STRANDS * vertsPerStrand);
      const indices = [];
      strandSeeds.forEach((strand, s) => {
        for (let k = 0; k <= steps; k++) {
          const t = Math.pow(k / steps, 1.6);
          for (let side = 0; side < 2; side++) {
            const v = s * vertsPerStrand + k * 2 + side;
            aT[v] = t;
            aSide[v] = side ? 1 : -1;
            aSeed.set(strand.seed, v * 4);
            aMeta.set(strand.meta, v * 3);
            aShape.set(strand.shape, v * 2);
            aRibbon[v] = strand.ribbon;
          }
          if (k < steps) {
            const a = s * vertsPerStrand + k * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
      });
      const geometry = track(new BufferGeometry());
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(STRANDS * vertsPerStrand * 3), 3));
      geometry.setAttribute("aT", new BufferAttribute(aT, 1));
      geometry.setAttribute("aSide", new BufferAttribute(aSide, 1));
      geometry.setAttribute("aSeed", new BufferAttribute(aSeed, 4));
      geometry.setAttribute("aMeta", new BufferAttribute(aMeta, 3));
      geometry.setAttribute("aShape", new BufferAttribute(aShape, 2));
      geometry.setAttribute("aRibbon", new BufferAttribute(aRibbon, 1));
      geometry.setIndex(indices);
      return geometry;
    };
    // Two meshes share one geometry: a wide soft glow and a fine core.
    const strandGeometry = buildStrands(CHEAP.steps);
    const strandMeshes = [1, 0].map((glow, index) => add(new Mesh(strandGeometry, material(strandVertex, strandFragment, { uGlow: { value: glow } }, {
      depthTest: true,
      side: DoubleSide,
    })), 5 + index));

    // Sparks drifting outward along the strands.
    const buildSparks = (count, rand) => {
      const sparkSeed = new Float32Array(count * 4);
      const sparkMeta = new Float32Array(count * 3);
      const sparkMotion = new Float32Array(count * 2);
      const sparkShape = new Float32Array(count * 2);
      const sparkRibbon = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const strand = strandSeeds[Math.floor(rand() * STRANDS)];
        sparkSeed.set(strand.seed, i * 4);
        sparkMeta.set(strand.meta, i * 3);
        sparkShape.set(strand.shape, i * 2);
        sparkRibbon[i] = strand.ribbon;
        sparkMotion[i * 2] = rand();
        sparkMotion[i * 2 + 1] = 0.012 + rand() * 0.04;
      }
      const geometry = track(new BufferGeometry());
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute("aSeed", new BufferAttribute(sparkSeed, 4));
      geometry.setAttribute("aMeta", new BufferAttribute(sparkMeta, 3));
      geometry.setAttribute("aMotion", new BufferAttribute(sparkMotion, 2));
      geometry.setAttribute("aShape", new BufferAttribute(sparkShape, 2));
      geometry.setAttribute("aRibbon", new BufferAttribute(sparkRibbon, 1));
      return geometry;
    };
    const sparkStart = random.state();
    const sparks = add(new Points(buildSparks(CHEAP.sparks, random), material(sparkVertex, sparkFragment, {}, { depthTest: true })), 7);

    // ---- The burst where the light breaks past the limb.
    const flare = add(new Mesh(plane, material(flareVertex, flareFragment)), 8);

    // Helpers for the rings and constellations below: thin lines and round dots.
    const markMaterial = material(markVertex, markFragment);
    // Lines use three's own LineBasicMaterial, which has no uZodiac uniform,
    // so the reveal scales their opacity instead (see applyReveal).
    const lineMaterials = [];
    const lines = (coords, opacity) => {
      const geometry = track(new BufferGeometry());
      geometry.setAttribute("position", new Float32BufferAttribute(coords, 3));
      const lineMaterial = track(new LineBasicMaterial({
        color: 0xd8ceff, transparent: true, opacity: 0,
        blending: AdditiveBlending, depthTest: false, depthWrite: false,
      }));
      lineMaterial.userData.opacity = opacity;
      lineMaterials.push(lineMaterial);
      const object = new LineSegments(geometry, lineMaterial);
      object.frustumCulled = false;
      return object;
    };
    const dots = (list) => {
      const geometry = track(new BufferGeometry());
      geometry.setAttribute("position", new Float32BufferAttribute(list.flatMap((d) => [d.x, d.y, 0]), 3));
      geometry.setAttribute("aSize", new Float32BufferAttribute(list.map((d) => d.size), 1));
      geometry.setAttribute("aColor", new Float32BufferAttribute(list.flatMap((d) => d.color), 3));
      geometry.setAttribute("aSeed", new Float32BufferAttribute(list.map(() => random()), 1));
      const object = new Points(geometry, markMaterial);
      object.frustumCulled = false;
      return object;
    };

    // ---- Orbit rings around the moon. They face the camera, sit behind the
    // moon (drawn before it), and turn in opposite directions.
    const ringPivot = new Group();
    scene.add(ringPivot);
    const arcCoords = [];
    ARC_RING.arcs.forEach(([from, to]) => {
      const steps = Math.ceil((to - from) / 0.02);
      for (let i = 0; i < steps; i++) {
        const a0 = from + ((to - from) * i) / steps;
        const a1 = from + ((to - from) * (i + 1)) / steps;
        const r = ARC_RING.radius;
        arcCoords.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
      }
    });
    const arcRing = lines(arcCoords, 0.35);
    const ringDots = [];
    for (let a = 0; a < Math.PI * 2; a += DOT_RING.step) {
      if (DOT_RING.gaps.some(([from, to]) => a > from && a < to)) continue;
      ringDots.push({ x: Math.cos(a) * DOT_RING.radius, y: Math.sin(a) * DOT_RING.radius, size: 5, color: [0.7, 0.67, 0.92] });
    }
    const dotRing = dots(ringDots);
    [arcRing, dotRing].forEach((ring) => {
      ring.renderOrder = 3;
      ringPivot.add(ring);
    });

    // ---- Constellations, fixed to the view like the stars and galaxies.
    const constellations = CONSTELLATIONS.map((c) => {
      const group = new Group();
      group.userData.at = c.at;
      group.add(lines(c.lines.flatMap(([a, b]) => [...c.stars[a], 0, ...c.stars[b], 0]), 0.3));
      group.add(dots(c.stars.map(([x, y], i) => ({ x, y, size: i === c.bright ? 11 : 8, color: i === c.warm ? WARM : COOL }))));
      group.children.forEach((child) => { child.renderOrder = 2; });
      camera.add(group);
      return group;
    });

    // ---- Layout, pointer, loop.
    let halfW = HALF_H;
    let moonX = 0;
    let moonY = 0;
    let radius = 4;
    let scale = RENDER_SCALE;
    let maxRatio = 1;
    let rect = wrap.getBoundingClientRect();
    const pointerNdc = new Vector2();
    const pointerSmooth = new Vector2();
    const pointerWorld = new Vector3();
    let pointerActive = 0;
    const ray = new Vector3();

    const layout = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (!width || !height) return;
      rect = wrap.getBoundingClientRect();
      const aspect = width / height;
      halfW = HALF_H * aspect;
      if (aspect >= 1.05) {
        radius = Math.min(4.2, halfW * 0.45);
        moonX = halfW - radius * 1.0;
        moonY = -0.1;
      } else {
        radius = halfW * 0.62;
        moonX = halfW * 0.4;
        moonY = HALF_H * 0.32;
      }
      moonPivot.position.set(moonX, moonY, 0);
      moonPivot.scale.setScalar(radius);
      halo.position.set(moonX, moonY, -radius * 0.05);
      halo.scale.setScalar(radius * 5.2);
      const focalX = moonX - radius * 0.996;
      const focalY = moonY + radius * 0.09;
      shared.uFocal.value.set(focalX, focalY);
      shared.uLength.value = focalX + halfW * 1.35 + 0.6;
      flare.position.set(focalX, focalY, 0.05);
      flare.scale.setScalar(radius * 2.4);
      shared.uHalf.value.set(halfW, HALF_H);
      shared.uSpread.value = radius;
      galaxies.forEach((mesh) => {
        const g = mesh.userData.galaxy;
        const half = (CAMERA_Z - g.z) * Math.tan(MathUtils.degToRad(FOV / 2));
        mesh.position.set(g.x * half * aspect, g.y * half, g.z - CAMERA_Z);
      });
      ringPivot.position.set(moonX, moonY, -radius * 0.02);
      ringPivot.scale.setScalar(radius);
      // Push each moon-relative spot back along the line of sight to the sky.
      const toSky = (CAMERA_Z - SKY_Z) / CAMERA_Z;
      constellations.forEach((group) => {
        const [x, y] = group.userData.at;
        group.position.set((moonX + x * radius) * toSky, (moonY + y * radius) * toSky, SKY_Z - CAMERA_Z);
        group.scale.setScalar(radius * toSky);
      });

      // Drawing buffer at a fraction of the CSS size; CSS stretches it back.
      const ratio = Math.min(window.devicePixelRatio || 1, maxRatio) * scale;
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      shared.uDpr.value = ratio;
      shared.uPixel.value = (HALF_H * 2) / height;
    };

    // Each ribbon's heading drifts on its own slow, irregular rhythm within a
    // ~60 degree fan around straight left (about 35 degrees either way), so
    // the ribbons sweep past each other but never turn vertical.
    const MAX_ANGLE = MathUtils.degToRad(35);
    const wander = [
      { a: 0.19, b: 0.083, p: 0.4, q: 2.1 },
      { a: 0.23, b: 0.071, p: 3.9, q: 5.0 },
      { a: 0.16, b: 0.097, p: 1.2, q: 0.7 },
      { a: 0.21, b: 0.064, p: 5.3, q: 3.3 },
    ];
    const headings = wander.map((w) => (t) => MAX_ANGLE * (Math.sin(t * w.a + w.p) * 0.62 + Math.sin(t * w.b + w.q) * 0.38));
    const updateHeadings = () => {
      // Four plain calls, not headings.map(): no new array every frame.
      shared.uAngles.value.set(headings[0](time), headings[1](time), headings[2](time), headings[3](time));
    };

    // How far one stage is through its reveal at the current reveal time, eased out.
    const stage = (s) => easeOut(MathUtils.clamp((revealTime - s.start) / s.length, 0, 1));
    const applyReveal = () => {
      shared.uMoon.value = stage(REVEAL.moon);
      shared.uWaves.value = stage(REVEAL.waves);
      shared.uZodiac.value = stage(REVEAL.zodiac);
      for (let i = 0; i < lineMaterials.length; i++) {
        lineMaterials[i].opacity = lineMaterials[i].userData.opacity * shared.uZodiac.value;
      }
    };

    let time = 0;
    let spin = 0;
    let frame = 0;
    let lastDraw = 0;
    let disposed = false;
    let stopped = false;
    let visible = true;
    let focused = document.hasFocus();
    let compiled = false;
    let shown = false;
    // Seconds into the staged reveal.
    let revealTime = 0;
    // Speed check and refinement. phase is "check" (cheap settings),
    // "refine" or "done". probeStart is the time of the first frame in the
    // current timing window (0 = not started), probeFrames the frames since.
    let phase = "check";
    let probeStart = 0;
    let probeFrames = 0;
    let lastKey = -Infinity;
    // Built once and reused every frame: these face the camera.
    const billboards = [halo, flare, ringPivot];

    const render = (dt) => {
      applyReveal();
      shared.uTime.value = time;
      updateHeadings();
      moon.rotation.y = spin;

      // Camera drifts gently and leans toward the pointer: true parallax.
      pointerSmooth.lerp(pointerNdc, 1 - Math.exp(-dt * 2.5));
      const driftX = Math.sin(time * 0.05) * 0.9;
      const driftY = Math.sin(time * 0.037) * 0.45;
      camera.position.set(pointerSmooth.x * 3 + driftX, pointerSmooth.y * 1.7 + driftY, CAMERA_Z);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      // Pointer position on the strand plane (z = 0) for the local push.
      ray.set(pointerNdc.x, pointerNdc.y, 0.5).unproject(camera).sub(camera.position).normalize();
      const along = -camera.position.z / ray.z;
      pointerWorld.copy(camera.position).addScaledVector(ray, along);
      const p = shared.uPointer.value;
      p.x += (pointerWorld.x - p.x) * (1 - Math.exp(-dt * 6));
      p.y += (pointerWorld.y - p.y) * (1 - Math.exp(-dt * 6));
      p.z += (pointerActive - p.z) * (1 - Math.exp(-dt * 3));

      for (let i = 0; i < billboards.length; i++) billboards[i].quaternion.copy(camera.quaternion);

      // Parents first: on the very first frame the pivot's world matrix has
      // not been computed yet, and the moon would be lit at the wrong angle.
      moon.updateWorldMatrix(true, false);
      rotation.setFromMatrix4(rotation4.extractRotation(moon.matrixWorld));
      renderer.render(scene, camera);
      if (!shown) {
        // The first frame is the sky alone, close to the poster, and the
        // canvas fades in over it.
        shown = true;
        canvas.style.opacity = "1";
      }
    };

    // Stop for good and leave the poster. The GPU memory is released on unmount.
    const halt = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      frame = 0;
      canvas.style.opacity = "0";
    };

    // Average gap between drawn frames over one MEASURE_MS window, or 0
    // while the window is still filling.
    const measure = (now) => {
      if (!probeStart) {
        probeStart = now;
        probeFrames = 0;
        return 0;
      }
      probeFrames += 1;
      if (now - probeStart < MEASURE_MS) return 0;
      const average = (now - probeStart) / probeFrames;
      probeStart = 0;
      return average;
    };

    // ---- Refinement steps, in order. Each has apply() (one cheap change or
    // one build, in one frame), work() (more frames of work; true when done),
    // undo() and commit() (drop whatever the step replaced).
    const resolutionStep = (change, back) => ({
      apply() { change(); layout(); },
      work: () => true,
      undo() { back(); layout(); },
      commit() {},
    });
    // Swap one geometry for a fuller one on every object that uses it.
    const geometryStep = (objects, build) => {
      let old;
      let fresh;
      return {
        apply() {
          old = objects[0].geometry;
          fresh = build();
          objects.forEach((object) => { object.geometry = fresh; });
        },
        work: () => true,
        undo() {
          objects.forEach((object) => { object.geometry = old; });
          fresh.dispose();
        },
        commit() { old.dispose(); },
      };
    };
    // Re-bake the moon map at full size with the original shader, one strip
    // a frame, into a second texture. The cheap map stays on screen until the
    // full one is complete.
    const fullBakeStep = () => {
      let target;
      let bakeFull;
      let fullScene;
      let ready = false;
      let strips = 0;
      const step = {
        failed: false,
        apply() {
          target = track(new WebGLRenderTarget(FULL_BAKE_W, FULL_BAKE_H, mapOptions));
          target.texture.anisotropy = bakeTarget.texture.anisotropy;
          bakeFull = track(new ShaderMaterial({
            vertexShader: fullscreenVertex,
            fragmentShader: bakeFragmentFull,
            depthTest: false,
            depthWrite: false,
          }));
          const mesh = new Mesh(quad, bakeFull);
          mesh.frustumCulled = false;
          fullScene = new Scene();
          fullScene.add(mesh);
          renderer.setRenderTarget(target);
          renderer.compileAsync(fullScene, camera).then(() => { ready = true; }, () => { step.failed = true; });
          renderer.setRenderTarget(null);
        },
        work() {
          if (!ready) return false;
          if (strips < FULL_BAKE_STRIPS) {
            const stripH = FULL_BAKE_H / FULL_BAKE_STRIPS;
            target.scissor.set(0, strips * stripH, FULL_BAKE_W, stripH);
            target.scissorTest = true;
            target.texture.generateMipmaps = strips === 0 || strips === FULL_BAKE_STRIPS - 1;
            renderer.setRenderTarget(target);
            renderer.render(fullScene, camera);
            renderer.setRenderTarget(null);
            strips += 1;
            return false;
          }
          bakeFull.dispose();
          moonUniforms.uMap.value = target.texture;
          return true;
        },
        undo() {
          moonUniforms.uMap.value = bakeTarget.texture;
          bakeFull.dispose();
          target.dispose();
        },
        commit() { bakeTarget.dispose(); },
      };
      return step;
    };
    const steps = [
      ...REFINE_SCALES.map((next) => {
        let before;
        return resolutionStep(() => { before = scale; scale = next; }, () => { scale = before; });
      }),
      ...(window.devicePixelRatio > 1
        ? [resolutionStep(() => { maxRatio = FULL_PIXEL_RATIO; }, () => { maxRatio = 1; })]
        : []),
      fullBakeStep(),
      geometryStep([moon], () => track(new SphereGeometry(1, ...FULL.sphere))),
      geometryStep([stars], () => buildStars(FULL.stars, makeRandom(starStart))),
      geometryStep(strandMeshes, () => buildStrands(FULL.steps)),
      geometryStep([sparks], () => buildSparks(FULL.sparks, makeRandom(sparkStart))),
      {
        apply() { shared.uOctaves.value = FULL.octaves; },
        work: () => true,
        undo() { shared.uOctaves.value = CHEAP.octaves; },
        commit() {},
      },
    ];
    let stepIndex = 0;
    let step = null;
    let stepDone = false;

    // One step at a time: apply, work until done, then one timing window.
    // A slow window (during the work or after it) undoes the step and ends
    // refinement for this visit, so it never goes back and forth.
    const refine = (now) => {
      // Hold while the person is typing; the window starts over afterwards.
      if (now - lastKey < TYPING_HOLD_MS) {
        probeStart = 0;
        return;
      }
      if (!step) {
        if (stepIndex >= steps.length) {
          phase = "done";
          return;
        }
        step = steps[stepIndex];
        stepDone = false;
        step.apply();
        probeStart = 0;
        return;
      }
      if (step.failed) {
        step.undo();
        phase = "done";
        return;
      }
      if (!stepDone && step.work()) {
        stepDone = true;
        probeStart = 0;
        return;
      }
      const average = measure(now);
      if (!average) return;
      if (average > SLOW_FRAME_MS) {
        step.undo();
        phase = "done";
      } else if (stepDone) {
        step.commit();
        step = null;
        stepIndex += 1;
      }
    };

    // First the speed check at the cheap settings, once the moon map is
    // baked (see SLOW_FRAME_MS). Refinement only follows a clean pass.
    const checkSpeed = (now) => {
      if (phase === "refine") refine(now);
      if (phase !== "check" || !baked()) return;
      const average = measure(now);
      if (!average) return;
      if (average <= SLOW_FRAME_MS) phase = scale === RENDER_SCALE ? "refine" : "done";
      else if (scale > SLOW_SCALE) {
        scale = SLOW_SCALE;
        layout();
      } else halt();
    };

    const loop = (now) => {
      frame = requestAnimationFrame(loop);
      // At most 30 frames a second: skip this one if the last draw was recent.
      if (now - lastDraw < FRAME_MS) return;
      const dt = Math.min((now - lastDraw) / 1000, 0.05);
      lastDraw = now;
      bakeSome();
      time += dt;
      spin += dt * 0.035;
      arcRing.rotation.z += dt * ARC_RING.speed;
      dotRing.rotation.z += dt * DOT_RING.speed;
      render(dt);
      // Advance the reveal after drawing, so the very first frame is at 0.
      // The clock only counts frames that are drawn, so a tab opened in the
      // background still plays the reveal when it is shown. The moon waits
      // for its surface map, so it never appears unfinished.
      revealTime += dt;
      if (!baked()) revealTime = Math.min(revealTime, REVEAL.moon.start);
      checkSpeed(now);
    };
    // (Re)start or pause the loop. Nothing is drawn while the shaders are
    // still compiling, the panel is off screen, the tab is hidden or the
    // window does not have focus.
    const start = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      // A pause would count as a slow frame, so the speed check starts over.
      probeStart = 0;
      if (disposed || stopped || !compiled || !visible || !focused || document.hidden) return;
      lastDraw = performance.now() - FRAME_MS;
      frame = requestAnimationFrame(loop);
    };

    const onMove = (event) => {
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        onLeave();
        return;
      }
      pointerNdc.set(x * 2 - 1, -y * 2 + 1);
      pointerActive = 1;
    };
    function onLeave() { pointerActive = 0; pointerNdc.set(0, 0); }
    const onScroll = () => { rect = wrap.getBoundingClientRect(); };
    const onFocus = () => { focused = true; start(); };
    const onBlur = () => { focused = false; start(); };
    // Typing in the form holds refinement (see TYPING_HOLD_MS).
    const onKey = () => { lastKey = performance.now(); };
    // Reduced motion switched on while the scene runs: back to the poster.
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => { if (media.matches) halt(); };
    const onLost = (event) => {
      event.preventDefault();
      disposed = true;
      halt();
    };
    const onResize = () => {
      layout();
      // Resizing clears the canvas. A running loop redraws on its own; a
      // paused one (window in the background) draws one frame here.
      if (shown && !frame && compiled && !stopped && !disposed) render(0);
    };
    // Follow the container's size, and pause while it is off screen.
    const resizeObserver = new ResizeObserver(onResize);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });

    layout();
    resizeObserver.observe(wrap);
    visibilityObserver.observe(wrap);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", onKey, true);
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", start);
    media.addEventListener("change", onMotion);
    canvas.addEventListener("webglcontextlost", onLost);
    if (media.matches) halt();

    // Compile every shader before the first frame. Where the browser supports
    // KHR_parallel_shader_compile (Chrome and Edge do, including on Windows,
    // where shader compiles are slowest) the driver works in the background
    // and the page stays responsive. The bake shader is compiled with its
    // render target bound, because three builds a different program for
    // off-screen targets and would otherwise compile it again on first use.
    renderer.setRenderTarget(bakeTarget);
    const bakeCompiled = renderer.compileAsync(bakeScene, camera);
    renderer.setRenderTarget(null);
    Promise.all([bakeCompiled, renderer.compileAsync(scene, camera)]).then(() => {
      compiled = true;
      start();
    }, halt);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("keydown", onKey, true);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", start);
      media.removeEventListener("change", onMotion);
      canvas.removeEventListener("webglcontextlost", onLost);
      disposables.forEach((item) => item.dispose());
      renderer.dispose();
      // Release the GPU context and its memory now, instead of whenever the
      // canvas is garbage collected. Browsers keep only about 16 contexts
      // alive, and each one here holds the moon map and the frame buffers.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  return (
    <div ref={wrapRef} className={className} style={{ ...wrapStyle, ...style }}>
      {/* Empty on purpose: the effect puts the canvas in here. */}
      <div ref={stageRef} style={stageStyle} />
      {children ? <div style={contentStyle}>{children}</div> : null}
    </div>
  );
}
