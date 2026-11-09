import type { CSSProperties } from "react";

/**
 * The console's colours. The shared components (Button, Field, Card, Notice...)
 * read their colours from Tailwind's theme variables, so the console sets those
 * variables to dark values on its outermost element and reuses the components
 * unchanged. Nothing outside /console is affected.
 *
 * How to read the classes inside the console:
 * - bg-ink-50 is the page, bg-white is a raised panel, text-ink-900 is the strongest text.
 * - brand is the one accent. It is light, so text on an accent fill is dark.
 * - red, emerald and amber are for state only: dark tints for boxes, light tones for text.
 */
export const CONSOLE_THEME = {
  colorScheme: "dark",

  "--color-white": "#14171e",
  "--color-ink-50": "#0c0e13",
  "--color-ink-100": "#1b1f28",
  "--color-ink-200": "#272c37",
  "--color-ink-300": "#363c49",
  "--color-ink-400": "#6c7487",
  "--color-ink-500": "#8d95a7",
  "--color-ink-600": "#a9b0bf",
  "--color-ink-700": "#c3c8d4",
  "--color-ink-800": "#dde1e8",
  "--color-ink-900": "#f2f4f7",

  "--color-brand-50": "#0b2230",
  "--color-brand-100": "#0e3247",
  "--color-brand-200": "#14506f",
  "--color-brand-300": "#1d75a0",
  "--color-brand-400": "#2b9bd1",
  "--color-brand-500": "#38bdf8",
  "--color-brand-600": "#5ccaf9",
  "--color-brand-700": "#86d8fb",
  "--color-brand-800": "#b0e6fd",
  "--color-brand-900": "#d9f3fe",

  "--color-red-50": "#2a1316",
  "--color-red-100": "#3d171b",
  "--color-red-200": "#5e252b",
  "--color-red-600": "#f87171",
  "--color-red-800": "#fecaca",
  "--color-emerald-50": "#0e271d",
  "--color-emerald-200": "#1c4b37",
  "--color-emerald-600": "#34d399",
  "--color-emerald-800": "#a7f3d0",
  "--color-amber-50": "#2a2010",
  "--color-amber-200": "#5b4419",
  "--color-amber-900": "#fde68a",
} as CSSProperties;
