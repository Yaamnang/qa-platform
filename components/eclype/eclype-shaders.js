// Shaders for the Eclype scene. Everything is procedural: the moon surface is
// baked once into an equirectangular normal/albedo map, the rest is computed live.
//
// Staged reveal: each layer reads one 0-to-1 uniform that Eclype.jsx ramps in
// turn (uBg, uMoon, uWaves, uZodiac). At 0 a layer adds nothing, at 1 it looks
// exactly as it did before the reveal existed.

// The plain colour the scene starts from, and the colour the page shows
// before WebGL is ready. The sky fades in from it, so there is no seam.
export const BASE_COLOR = "#05040f";
const BASE_RGB = /* glsl */ `vec3(5., 4., 15.) / 255.`; // same colour as BASE_COLOR

const noise3 = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * .1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(.1031, .1030, .0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3. - 2. * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
          mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
          mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y),
      u.z);
  }
  float fbm(vec3 p) {
    float v = 0.;
    float a = .5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= .5;
    }
    return v;
  }
`;

export const fullscreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0., 1.);
  }
`;

// ---------------------------------------------------------------- moon bake
// A surface saturated with overlapping craters: their sharp rims knit into
// the lacy, cellular relief that catches the eclipse light. The slope of the
// surface is added up crater by crater as it is built, so each texel needs
// one pass instead of four (no finite differences).
export const bakeFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${noise3}

  // fbm with 3 octaves, for the warp and the albedo detail.
  float fbm3(vec3 p) {
    float v = 0.;
    float a = .5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= .5;
    }
    return v;
  }

  // One layer of craters at scale k, weighted by weight: flat-ish bowl and
  // sharp raised rim. Adds the layer's slope to grad and returns its albedo shift.
  float craters(vec3 p, float k, float density, float seed, float weight, inout vec3 grad) {
    vec3 q = p * k;
    vec3 i = floor(q);
    vec3 f = fract(q);
    float albedo = 0.;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 r = hash33(i + g + seed);
      if (r.z > density) continue;
      vec3 o = hash33(i + g + seed + 17.31);
      vec3 c = g + .15 + .7 * o - f;
      float rad = .26 + .3 * pow(fract(r.x * 13.7 + r.y * 7.1), 1.6);
      float len = length(c);
      float d = len / rad;
      if (d > 1.7) continue;
      // Height is (bowl + rim) * rad; these are its slopes along d.
      float rim = exp(-(d - 1.) * (d - 1.) * 14.) * .16;
      float dBowl = d < 1. ? 2.1 * d * (1. - d) : 0.;
      float dRim = -28. * (d - 1.) * rim;
      grad -= (dBowl + dRim) * k * weight * c / max(len, 1e-4);
      albedo += rim * .5 - (1. - smoothstep(.2, 1., d)) * .06;
    }
    return albedo * weight;
  }

  void main() {
    float lon = (vUv.x - .5) * 6.28318531;
    float lat = (vUv.y - .5) * 3.14159265;
    vec3 p = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
    vec3 w = p + (vec3(fbm3(p * 3.), fbm3(p * 3. + 5.2), fbm3(p * 3. + 11.7)) - .5) * .1;
    // Basins down to small pocks. Weights fall with size so small craters add
    // crisp detail without turning into clusters of dark holes.
    vec3 grad = vec3(0.);
    float shift = craters(w, 1.6, .35, 23., .7, grad)
                + craters(w, 3.4, .4, 0., .8, grad)
                + craters(w, 7., .32, 3., .38, grad)
                + craters(w, 14., .34, 7., .17, grad)
                + craters(w, 28., .34, 11., .08, grad);
    vec3 tangential = grad - dot(grad, p) * p;
    vec3 n = normalize(p - tangential * .23);

    // Soft dark "seas" give the familiar, calm lunar face.
    float maria = smoothstep(.42, .62, fbm(p * 1.5 + 2.));
    float alb = mix(.9, .52, maria);
    alb *= .92 + .16 * fbm3(p * 12.);
    alb = clamp(alb + shift * .3, .3, 1.);
    gl_FragColor = vec4(n * .5 + .5, alb);
  }
`;

// The original bake, used when the scene refines to full quality: six
// crater layers, fine grain, 5-octave noise, and the slope taken by finite
// differences (four surface passes per texel). Slow, so it runs in thin
// strips spread over many frames.
export const bakeFragmentFull = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  ${noise3}

  // One layer of craters: flat-ish bowl + sharp raised rim.
  // x = height, y = albedo shift.
  vec2 craters(vec3 p, float density, float seed) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec2 acc = vec2(0.);
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 r = hash33(i + g + seed);
      if (r.z > density) continue;
      vec3 o = hash33(i + g + seed + 17.31);
      vec3 c = g + .15 + .7 * o - f;
      float rad = .26 + .3 * pow(fract(r.x * 13.7 + r.y * 7.1), 1.6);
      float d = length(c) / rad;
      if (d > 1.7) continue;
      float bowl = (smoothstep(.0, 1., d) - 1.) * .35;
      float rim = exp(-(d - 1.) * (d - 1.) * 14.) * .16;
      acc.x += (bowl + rim) * rad;
      acc.y += rim * .5 - (1. - smoothstep(.2, 1., d)) * .06;
    }
    return acc;
  }

  vec2 surface(vec3 p) {
    vec3 w = p + (vec3(fbm(p * 3.), fbm(p * 3. + 5.2), fbm(p * 3. + 11.7)) - .5) * .1;
    // Basins down to tiny pocks. Weights fall with size so small craters add
    // crisp detail without turning into clusters of dark holes.
    vec2 h = craters(w * 1.6, .35, 23.) * .7
           + craters(w * 3.4, .4, 0.) * .8
           + craters(w * 7., .32, 3.) * .38
           + craters(w * 14., .34, 7.) * .17
           + craters(w * 28., .34, 11.) * .08
           + craters(w * 56., .3, 19.) * .038;
    h.x += (fbm(p * 6.) - .5) * .05;
    // Fine regolith grain.
    h.x += (fbm(p * 90.) - .5) * .006;
    return h;
  }

  void main() {
    float lon = (vUv.x - .5) * 6.28318531;
    float lat = (vUv.y - .5) * 3.14159265;
    vec3 p = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
    float e = .0008;
    vec2 s = surface(p);
    float hx = surface(p + vec3(e, 0., 0.)).x;
    float hy = surface(p + vec3(0., e, 0.)).x;
    float hz = surface(p + vec3(0., 0., e)).x;
    vec3 grad = (vec3(hx, hy, hz) - s.x) / e;
    vec3 tangential = grad - dot(grad, p) * p;
    vec3 n = normalize(p - tangential * .23);

    // Soft dark "seas" give the familiar, calm lunar face.
    float maria = smoothstep(.42, .62, fbm(p * 1.5 + 2.));
    float alb = mix(.9, .52, maria);
    alb *= .92 + .16 * fbm(p * 12.);
    alb *= .94 + .12 * fbm(p * 70.);
    alb = clamp(alb + s.y * .3, .3, 1.);
    gl_FragColor = vec4(n * .5 + .5, alb);
  }
`;

// --------------------------------------------------------------------- moon
export const moonVertex = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vWorldPos;
  void main() {
    vObj = position;
    vec4 world = modelMatrix * vec4(position, 1.);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const moonFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform mat3 uRot;
  uniform vec3 uLight;
  uniform float uReady;
  uniform float uMoon;
  varying vec3 vObj;
  varying vec3 vWorldPos;

  void main() {
    vec3 p = normalize(vObj);
    float u = atan(p.z, p.x) / 6.28318531 + .5;
    float uA = fract(u);
    float uB = fract(u + .5) - .5;
    u = fwidth(uA) <= fwidth(uB) + .0001 ? uA : uB;
    vec2 uv = vec2(u, asin(clamp(p.y, -1., 1.)) / 3.14159265 + .5);
    vec4 tex = texture2D(uMap, uv);
    vec3 nObj = normalize(mix(p, tex.rgb * 2. - 1., uReady));
    float alb = mix(.7, tex.a, uReady);

    vec3 n = normalize(uRot * nObj);
    vec3 g = normalize(uRot * p);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uLight);
    vec3 Lp = normalize(L - V * dot(L, V));
    vec3 gFlat = g - V * dot(g, V);
    float ndv = clamp(dot(g, V), 0., 1.);
    float facing = dot(normalize(gFlat + 1e-5), Lp);

    // Sun from behind: a narrow gold crescent with hard crater relief.
    float gd = dot(g, L);
    float relief = clamp(1. + (dot(n, L) - gd) * 2.4, .4, 2.);
    float zone = smoothstep(-.06, .42, gd);
    vec3 gold = mix(vec3(.92, .4, .15), vec3(1., .84, .58), smoothstep(.12, .62, gd));
    vec3 col = alb * gold * zone * relief * 1.9;

    // Lavender light rakes the crater rims in a band inside the crescent.
    vec3 L2 = normalize(vec3(-.88, .3, .3));
    float g2 = dot(g, L2);
    float relief2 = clamp(1. + (dot(n, L2) - g2) * 2.5, .3, 2.);
    float band = smoothstep(.35, .95, g2);
    col += alb * vec3(.3, .22, .68) * band * relief2 * .32 * (1. - zone * .7);

    // Night side: deep indigo.
    col += alb * vec3(.022, .018, .052);

    // Edge light: lavender all round, gold toward the eclipse.
    float edge = pow(1. - ndv, 8.);
    vec3 edgeCol = mix(vec3(.5, .42, 1.), vec3(1., .8, .55), smoothstep(-.1, .8, facing));
    col += edgeCol * edge * (.55 + .9 * max(facing, 0.));
    col += vec3(1., .88, .7) * pow(1. - ndv, 3.) * pow(max(facing, 0.), 4.) * .8;

    col = 1. - exp(-col * 1.2);
    // The moon is opaque, so it fades in with alpha (normal blending) rather
    // than by darkening, which would show a black disc over the sky.
    gl_FragColor = vec4(col, uMoon);
  }
`;

// --------------------------------------------------------------------- halo
// Glow around the silhouette: hot gold off the crescent, a thin lavender
// halo around the night side.
export const haloFragment = /* glsl */ `
  precision highp float;
  uniform vec3 uLight;
  uniform float uTime;
  uniform float uMoon;
  varying vec2 vUv;

  void main() {
    vec2 d = (vUv - .5) * 2. * 2.6;
    float r = length(d);
    float dm = max(r - 1., 0.);
    vec2 dir = d / max(r, 1e-4);
    float facing = dot(dir, normalize(uLight.xy));
    float warm = smoothstep(-.2, .9, facing);
    float hot = pow(max(facing, 0.), 3.);

    vec3 col = vec3(1., .86, .62) * exp(-dm * 80.) * (.25 + 1.8 * hot);
    col += vec3(1., .58, .26) * exp(-dm * 14.) * (.06 + .9 * hot);
    col += vec3(.52, .42, 1.) * exp(-dm * 45.) * (1. - warm) * .55;
    col += mix(vec3(.22, .16, .55), vec3(.7, .38, .22), warm) * exp(-dm * 3.2) * .07;

    col *= .96 + .04 * sin(uTime * .6);
    col *= 1. - smoothstep(2.2, 2.6, r);
    // Nothing in the middle of the disc: the moon always covers it once it is
    // in, and while the moon fades in this bright centre would show through
    // it. The rim (r > .96) stays, because the sphere's edge is made of flat
    // segments and the halo shows between them.
    col *= smoothstep(.9, .96, r);
    col *= uMoon; // the glow arrives with the moon
    gl_FragColor = vec4(col, 1.);
  }
`;

// --------------------------------------------------------------- background
export const backgroundVertex = /* glsl */ `
  uniform vec2 uHalf;
  varying vec2 vWorld;
  void main() {
    vWorld = position.xy * uHalf;
    gl_Position = vec4(position.xy, 0., 1.);
  }
`;

export const backgroundFragment = /* glsl */ `
  precision highp float;
  uniform vec2 uHalf;
  uniform float uTime;
  uniform float uDpr;
  uniform float uBg;
  uniform float uOctaves;
  varying vec2 vWorld;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3. - 2. * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.;
    float a = .5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    // uOctaves is 4 at the start and 6 at full quality.
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uOctaves) break;
      v += a * noise(p);
      p = m * p;
      a *= .5;
    }
    return v;
  }
  // Tiny pin-point stars at a fixed on-screen size (crisp at any resolution).
  float starLayer(vec2 px, float cell, float density, float seed) {
    vec2 c = floor(px / cell);
    vec2 f = fract(px / cell);
    float h = hash12(c + seed);
    if (h > density) return 0.;
    vec2 pos = vec2(hash12(c + seed + 7.1), hash12(c + seed + 3.7)) * .7 + .15;
    float d = length((f - pos) * cell);
    float tw = .7 + .3 * sin(uTime * (1. + h * 9.) + h * 80.);
    return exp(-d * d * 1.4) * (.25 + .75 * hash12(c + seed + 1.3)) * tw;
  }

  void main() {
    vec2 p = vWorld;
    vec2 uv = p / uHalf;

    // Deep indigo, a touch lighter toward the upper left.
    vec3 col = mix(vec3(.018, .014, .045), vec3(.05, .035, .11), smoothstep(-1.3, 1.2, uv.y * .55 - uv.x * .4 + .1));

    // A faint galactic band behind the moon, broken by dark dust lanes.
    vec2 axis = normalize(vec2(1., .42));
    float across = dot(p, vec2(-axis.y, axis.x)) + 1.2;
    float along = dot(p, axis);
    float warp = (fbm(vec2(along * .12, across * .2) + 3.) - .5) * 3.;
    float band = exp(-pow((across + warp) / 3.2, 2.));
    float dust = smoothstep(.45, .75, fbm(p * .38 + vec2(uTime * .004, 4.)));
    float glowBand = band * (.55 + .45 * fbm(p * .7 + 9.)) * (1. - dust * .8);
    col += mix(vec3(.12, .08, .28), vec3(.26, .19, .42), fbm(p * .3)) * glowBand * .3;

    // Slow, quiet nebula.
    float n = fbm(p * .16 + vec2(uTime * .006, 0.));
    float m = fbm(p * .42 + n * 2.2 - vec2(0., uTime * .008));
    col += vec3(.11, .06, .24) * pow(m, 2.6) * .9;
    col += vec3(.03, .035, .12) * smoothstep(.5, .85, n) * .5;

    // Fine distant stars, a little denser inside the band.
    vec2 px = gl_FragCoord.xy / uDpr;
    float stars = starLayer(px, 6., .01 + band * .07, 0.) * .7
                + starLayer(px, 11., .018 + band * .04, 17.);
    col += mix(vec3(.75, .76, 1.), vec3(1., .9, .95), hash12(floor(px / 5.))) * stars * (.55 + band * .5);

    col *= 1. - .4 * smoothstep(.5, 1.5, length(uv * vec2(.8, 1.)));
    col += (hash12(gl_FragCoord.xy + fract(uTime)) - .5) / 255.;
    // Reveal: start from the page's plain colour, so frame one matches it exactly.
    gl_FragColor = vec4(mix(${BASE_RGB}, col, uBg), 1.);
  }
`;

// ----------------------------------------------------------------- galaxies
export const galaxyFragment = /* glsl */ `
  precision highp float;
  uniform float uSeed;
  uniform float uBright;
  uniform float uTime;
  uniform float uBg;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  void main() {
    vec2 d = (vUv - .5) * 2.;
    float r = length(d);
    float a = atan(d.y, d.x) + uTime * .01;
    float arms = .5 + .5 * cos(2. * (a - log(r + .02) * 2.7 + uSeed * 6.));
    float grain = .7 + .3 * h(floor(vUv * 90.) + uSeed);
    float disk = exp(-r * 3.6) * (.3 + .7 * pow(arms, 2.)) * grain;
    float core = exp(-r * r * 70.);
    vec3 col = mix(vec3(.5, .46, 1.), vec3(1., .86, .72), core + exp(-r * 6.) * .4) * (disk + core * 1.4);
    col *= uBright * (1. - smoothstep(.65, 1., r)) * uBg;
    gl_FragColor = vec4(col, 1.);
  }
`;

// -------------------------------------------------------------------- stars
export const starVertex = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  attribute float aSize;
  attribute float aSeed;
  varying float vBright;
  varying float vBig;
  varying vec3 vCol;
  void main() {
    vBig = step(2.4, aSize);
    vBright = (.55 + .45 * sin(uTime * (.5 + aSeed * 1.8) + aSeed * 40.)) * mix(.5, 1., fract(aSeed * 3.7));
    vCol = mix(vec3(.72, .76, 1.), vec3(1., .86, .96), fract(aSeed * 7.3));
    gl_PointSize = aSize * uDpr * mix(2.2, 6., vBig);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;

export const starFragment = /* glsl */ `
  precision highp float;
  uniform float uBg;
  varying float vBright;
  varying float vBig;
  varying vec3 vCol;
  void main() {
    vec2 d = gl_PointCoord - .5;
    float r2 = dot(d, d);
    float small = exp(-r2 * 40.);
    float big = exp(-r2 * 260.) * 1.4 + exp(-sqrt(r2) * 10.) * .25
              + (exp(-abs(d.x) * 70.) * exp(-abs(d.y) * 7.) + exp(-abs(d.y) * 70.) * exp(-abs(d.x) * 7.)) * .45;
    float a = mix(small, big, vBig) * vBright * uBg;
    gl_FragColor = vec4(vCol * a, 1.);
  }
`;

// ------------------------------------------------------------------ strands
// Every strand leaves the burst on the limb. Each ribbon flows along its own
// heading (uAngles, radians from straight left, + = up), which wanders over
// time but never turns vertical. Lateral distances are in moon radii.
const strandCurve = /* glsl */ `
  uniform vec2 uFocal;
  uniform float uSpread;
  uniform float uLength;
  uniform vec4 uAngles;
  uniform float uTime;
  uniform vec3 uPointer;

  // s: fan, wave frequency, phase, warmth. sh: bend, wave amplitude.
  vec2 strandPoint(float t, vec4 s, vec2 sh, float ribbon, float jitter) {
    float ang = ribbon < .5 ? uAngles.x : ribbon < 1.5 ? uAngles.y : ribbon < 2.5 ? uAngles.z : uAngles.w;
    vec2 dir = vec2(-cos(ang), sin(ang));
    vec2 side = vec2(sin(ang), cos(ang));
    float lateral = s.x * t + sh.x * t * t;
    float k = 1.4 + s.y * 2.2;
    // Flatten the wave a little as the heading steepens, so no part of a
    // ribbon ever turns vertical.
    float calm = 1. - .45 * clamp(abs(ang) / .61, 0., 1.);
    lateral += sin(t * k * 3.14159 - uTime * .32 + s.z * 6.28318531) * sh.y * calm * pow(t, .85);
    vec2 p = uFocal + dir * (t * uLength) + side * (lateral * uSpread + jitter);
    vec2 d = p - uPointer.xy;
    float push = exp(-dot(d, d) / (uSpread * uSpread * .12)) * uPointer.z * smoothstep(0., .2, t);
    p += d / (length(d) + .25) * push * uSpread * .1;
    return p;
  }
`;

// Reveal for the ribbons: they grow out of the burst instead of just fading.
// A soft front travels along each strand, from the limb (t = 0) to its far
// end (t = 1), as uWaves goes from 0 to 1.
const waveReveal = /* glsl */ `
  uniform float uWaves;
  float waveReveal(float t) {
    float front = uWaves * 1.3;
    return 1. - smoothstep(front - .3, front, t);
  }
`;

const strandColor = /* glsl */ `
  vec3 strandColor(float t, vec4 s) {
    vec3 warm = mix(vec3(1., .5, .2), vec3(1., .76, .42), fract(s.y * 3.7));
    vec3 cool = mix(vec3(.42, .38, 1.), vec3(.66, .52, 1.), fract(s.z * 5.3));
    vec3 col = mix(cool, warm, smoothstep(.4, .6, s.w));
    return mix(col, vec3(1., .82, .55), exp(-t * 14.) * .8);
  }
`;

export const strandVertex = /* glsl */ `
  ${strandCurve}
  uniform float uPixel;
  uniform float uGlow;
  attribute float aT;
  attribute float aSide;
  attribute vec4 aSeed;
  attribute vec3 aMeta;
  attribute vec2 aShape;
  attribute float aRibbon;
  varying float vSide;
  varying float vT;
  varying vec4 vSeed;
  varying vec2 vMeta;
  void main() {
    vec2 p = strandPoint(aT, aSeed, aShape, aRibbon, 0.);
    vec2 q = strandPoint(aT + .003, aSeed, aShape, aRibbon, 0.);
    vec2 dir = normalize(q - p);
    vec2 nrm = vec2(-dir.y, dir.x);
    float w = uPixel * mix(1.1, 1.7, aT) * mix(1.5, 12., uGlow);
    p += nrm * aSide * w;
    vSide = aSide;
    vT = aT;
    vSeed = aSeed;
    vMeta = aMeta.xy;
    float z = aMeta.z * uSpread * .35 * pow(aT, 1.2);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, z, 1.);
  }
`;

export const strandFragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uGlow;
  varying float vSide;
  varying float vT;
  varying vec4 vSeed;
  varying vec2 vMeta;
  ${strandColor}
  ${waveReveal}
  void main() {
    float t = vT;
    float profile = exp(-vSide * vSide * mix(4.5, 2.5, uGlow));
    float fadeEnd = 1. - smoothstep(vMeta.x - .25, vMeta.x, t);
    float fadeIn = smoothstep(0., .03, t);
    float energy = .16 + 1.1 * exp(-t * 4.5);
    // Faint pulses of light travel outward along each strand.
    energy *= .8 + .5 * pow(.5 + .5 * sin(t * 12. - uTime * 1.4 + vSeed.z * 30.), 8.);
    float a = profile * energy * fadeEnd * fadeIn * vMeta.y * mix(.62, .1, uGlow) * waveReveal(t);
    gl_FragColor = vec4(strandColor(t, vSeed) * a, 1.);
  }
`;

// Dust and bokeh drifting outward along the strands.
export const sparkVertex = /* glsl */ `
  ${strandCurve}
  uniform float uDpr;
  attribute vec4 aSeed;
  attribute vec3 aMeta;
  attribute vec2 aMotion;
  attribute vec2 aShape;
  attribute float aRibbon;
  varying float vAlpha;
  varying float vBig;
  varying vec3 vCol;
  ${strandColor}
  ${waveReveal}
  void main() {
    float t = fract(aMotion.x + uTime * aMotion.y);
    vec2 p = strandPoint(t, aSeed, aShape, aRibbon, (fract(aMotion.x * 91.7) - .5) * uSpread * .14 * t);
    float twinkle = .5 + .5 * sin(uTime * (2. + aMotion.y * 60.) + aMotion.x * 50.);
    vBig = step(.93, fract(aMotion.x * 29.3));
    vAlpha = (1. - smoothstep(aMeta.x - .25, aMeta.x, t)) * smoothstep(.02, .08, t)
           * (.35 + .65 * twinkle) * aMeta.y * mix(1., .45, vBig) * waveReveal(t);
    vCol = strandColor(t, aSeed);
    gl_PointSize = uDpr * (1.3 + 2.4 * pow(fract(aMotion.x * 13.), 3.)) * mix(1., 4., vBig);
    float z = aMeta.z * uSpread * .35 * pow(t, 1.2);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, z, 1.);
  }
`;

export const sparkFragment = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying float vBig;
  varying vec3 vCol;
  void main() {
    vec2 d = gl_PointCoord - .5;
    float r2 = dot(d, d);
    float dot1 = exp(-r2 * 30.);
    float bokeh = exp(-r2 * 10.) * .55 + exp(-sqrt(r2) * 7.) * .2;
    gl_FragColor = vec4(vCol * mix(dot1, bokeh, vBig) * vAlpha, 1.);
  }
`;

// -------------------------------------------------------------------- marks
// Round dots for constellation stars and the dotted orbit ring: a crisp core
// with a soft halo, each pulsing gently out of step with the others.
export const markVertex = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  attribute float aSize;
  attribute float aSeed;
  attribute vec3 aColor;
  varying vec3 vCol;
  void main() {
    vCol = aColor * (.82 + .18 * sin(uTime * (.4 + aSeed) + aSeed * 30.));
    gl_PointSize = aSize * uDpr;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;

export const markFragment = /* glsl */ `
  precision highp float;
  uniform float uZodiac;
  varying vec3 vCol;
  void main() {
    vec2 d = gl_PointCoord - .5;
    float r2 = dot(d, d);
    float a = (smoothstep(.05, .015, r2) + exp(-r2 * 16.) * .3) * uZodiac;
    gl_FragColor = vec4(vCol * a, 1.);
  }
`;

// -------------------------------------------------------------------- flare
// The burst where sunlight breaks past the limb: white-hot core, warm glow,
// and a starburst of thin orange spikes.
export const flareVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;

export const flareFragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uWaves;
  varying vec2 vUv;
  float h11(float x) { return fract(sin(x * 127.1 + 1.3) * 43758.5453); }
  void main() {
    vec2 d = (vUv - .5) * 2.;
    float r = length(d);
    float ang = atan(d.y, d.x);

    const float N = 30.;
    float sector = ang / 6.28318531 * N;
    float rays = 0.;
    for (int k = -1; k <= 1; k++) {
      float idx = floor(sector) + float(k);
      float hh = h11(idx);
      float center = (idx + .5 + (hh - .5) * .7) / N * 6.28318531;
      float da = mod(ang - center + 3.14159265, 6.28318531) - 3.14159265;
      float dist = abs(da) * r;
      float len = .035 + .14 * pow(h11(idx + 9.7), 2.);
      float w = .003 + .003 * h11(idx + 5.3);
      float flick = .75 + .25 * sin(uTime * (.8 + hh * 2.) + idx * 1.7);
      rays += exp(-dist * dist / (w * w)) * exp(-r / len) * (.35 + .65 * h11(idx + 1.7)) * flick;
    }

    float core = exp(-r * r * 1400.) * 2.6 + exp(-r * r * 160.) * .7;
    float glow = exp(-r * 11.) * .38 + exp(-r * 3.5) * .08;
    vec3 col = vec3(1., .96, .9) * core + vec3(1., .62, .3) * (rays * .7 + glow);
    col += vec3(1., .72, .42) * exp(-abs(d.y) * 180.) * exp(-abs(d.x) * 8.) * .5;
    col *= .94 + .06 * sin(uTime * 1.3);
    col *= 1. - smoothstep(.85, 1., max(abs(d.x), abs(d.y)));
    col *= uWaves; // the burst lights up as the ribbons start to flow out of it
    gl_FragColor = vec4(col, 1.);
  }
`;
