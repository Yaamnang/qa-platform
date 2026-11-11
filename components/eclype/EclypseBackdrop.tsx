"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { POSTER_STYLE } from "./poster";

// The scene and three.js are a separate download, fetched only when
// useSceneWhenIdle says so. Until then, and whenever the scene cannot run,
// the CSS poster fills the panel.
const Eclype = dynamic(() => import("./Eclype"), { ssr: false });

/**
 * True once the page is interactive and the browser has a quiet moment, so
 * three.js never competes with the form. Only at 1024px and wider, and never
 * when the user prefers reduced motion: then the poster is all there is.
 */
function useSceneWhenIdle() {
  const [load, setLoad] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let cancelled = false;
    let scheduled = false;
    const loadScene = () => {
      if (!cancelled) setLoad(true);
    };
    // Effects run after hydration, so the form already works at this point.
    // Safari has no requestIdleCallback; a short timeout does the job there.
    const schedule = () => {
      if (scheduled || !wide.matches || calm.matches) return;
      scheduled = true;
      if ("requestIdleCallback" in window) window.requestIdleCallback(loadScene, { timeout: 2000 });
      else setTimeout(loadScene, 500);
    };
    // Wait for the page's own load to finish before asking for the idle slot.
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    // A narrow window that is widened later gets the scene then.
    wide.addEventListener("change", schedule);
    calm.addEventListener("change", schedule);
    return () => {
      cancelled = true;
      window.removeEventListener("load", schedule);
      wide.removeEventListener("change", schedule);
      calm.removeEventListener("change", schedule);
    };
  }, []);
  return load;
}

/**
 * The Eclype scene as a decorative backdrop. Hidden below 1024px. Size and
 * position it with className (for example "relative flex-1"). The poster
 * shows at once; the live scene fades in over it when it is ready.
 */
export function EclypseBackdrop({ className = "" }: { className?: string }) {
  const showScene = useSceneWhenIdle();
  return (
    <div aria-hidden="true" data-eclype-poster="" style={POSTER_STYLE} className={`pointer-events-none hidden overflow-hidden lg:block ${className}`}>
      {showScene && <Eclype style={{ position: "absolute", inset: 0 }} />}
    </div>
  );
}
