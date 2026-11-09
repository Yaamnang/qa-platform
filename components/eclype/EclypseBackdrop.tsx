"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The scene and three.js are a separate download, fetched only when
// useSceneWhenIdle says so. Until the scene draws its first frame the
// backdrop is a plain colour (#05040f), the same colour the scene starts from.
const Eclype = dynamic(() => import("./Eclype"), { ssr: false });

/**
 * True once the page is interactive and the browser has a quiet moment, so
 * three.js never competes with the form. Only at 1024px and wider: phones
 * never download three.js at all.
 */
function useSceneWhenIdle() {
  const [load, setLoad] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    let cancelled = false;
    const loadScene = () => {
      if (!cancelled) setLoad(true);
    };
    // Effects run after hydration, so the form already works at this point.
    // Safari has no requestIdleCallback; a short timeout does the job there.
    const schedule = () => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(loadScene, { timeout: 1500 });
      else setTimeout(loadScene, 300);
    };
    // A narrow window that is widened later gets the scene then.
    const onChange = () => {
      if (!wide.matches) return;
      wide.removeEventListener("change", onChange);
      schedule();
    };
    if (wide.matches) schedule();
    else wide.addEventListener("change", onChange);
    return () => {
      cancelled = true;
      wide.removeEventListener("change", onChange);
    };
  }, []);
  return load;
}

/**
 * The Eclype scene as a decorative backdrop. Hidden below 1024px. Position it
 * with className (for example "fixed inset-0 -z-10"). Reduced motion, the
 * staged reveal, the pixel ratio cap and pausing when hidden are all handled
 * inside Eclype.jsx. Where WebGL is unavailable the plain colour stays.
 */
export function EclypseBackdrop({ className = "" }: { className?: string }) {
  const showScene = useSceneWhenIdle();
  return (
    <div aria-hidden="true" className={`pointer-events-none hidden bg-[#05040f] lg:block ${className}`}>
      {showScene && <Eclype style={{ position: "absolute", inset: 0 }} />}
    </div>
  );
}
