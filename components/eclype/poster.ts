import type { CSSProperties } from "react";

// A still stand-in for the scene's sky, drawn with CSS gradients. It shows at
// once and stays whenever the live scene does not run (no WebGL, reduced
// motion, a slow machine). The colours follow backgroundFragment in
// eclype-shaders.js: deep indigo, lighter toward the upper left, darker corners.

// A fixed seed, so the server and the browser build the same list of stars
// and the markup always matches.
let seed = 7;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const stars = Array.from({ length: 40 }, () => {
  const x = (random() * 100).toFixed(1);
  const y = (random() * 100).toFixed(1);
  const alpha = (0.3 + random() * 0.5).toFixed(2);
  const size = random() > 0.85 ? 1.6 : 1;
  return `radial-gradient(circle at ${x}% ${y}%, rgb(210 212 255 / ${alpha}) 0, transparent ${size}px)`;
});

export const POSTER_STYLE: CSSProperties = {
  backgroundColor: "#05040f",
  backgroundImage: [
    ...stars,
    "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 45%, rgb(3 2 8 / 0.5))",
    "linear-gradient(135deg, rgb(14 10 30), rgb(6 5 14) 65%, rgb(4 3 10))",
  ].join(", "),
};
