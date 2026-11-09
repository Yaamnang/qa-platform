import type { Page } from "@playwright/test";

/**
 * What the planner sees of one screen: headings, and the things a person can
 * act on, each with its role, accessible name and test id. Never a field's
 * value, never a table cell, never a password or code field.
 */
export type ScreenControl = {
  role: string;
  name: string;
  testId: string | null;
  /** Links: same-origin path, or "external". */
  href: string | null;
  /** Inputs: type, and for selects the first few option labels. */
  inputType: string | null;
  options: string[];
  /** Looks like it downloads a file: a download attribute or a file-like href. */
  downloads: boolean;
};

export type Screen = { path: string; title: string; headings: string[]; controls: ScreenControl[] };

function readScreen(): Screen {
  const clean = (value: string | null | undefined, max = 80): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && !el.closest('[aria-hidden="true"], [inert]');
  };
  const labelOf = (el: Element): string => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = clean(el.getAttribute("aria-labelledby"))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (clean(by)) return clean(by);
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(Array.from(labels).map((l) => l.textContent).join(" "));
    return "";
  };
  const roleOf = (el: Element): string => {
    const explicit = clean(el.getAttribute("role"));
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "file";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return tag;
  };

  const out: ScreenControl[] = [];
  const seen = new Set<string>();
  const selector = 'a[href], button, summary, select, textarea, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]';
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (out.length >= 70) break;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    // File inputs are often hidden behind a styled button; they still count.
    if (!(tag === "input" && type === "file") && !visible(el)) continue;
    if (tag === "input" && ["hidden", "password"].includes(type)) continue;
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("one-time-code") || autocomplete.includes("password") || /^cc-/.test(autocomplete)) continue;
    const role = roleOf(el);
    const isField = ["input", "select", "textarea"].includes(tag);
    const name = isField
      ? labelOf(el) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("name"))
      : labelOf(el) || clean(el.textContent) || clean(el.getAttribute("title")) || clean(el.getAttribute("value"));
    let href: string | null = null;
    let downloads = false;
    if (tag === "a") {
      const raw = el.getAttribute("href") || "";
      try {
        const url = new URL(raw, location.href);
        href = url.origin === location.origin ? url.pathname + url.search : "external";
        downloads = el.hasAttribute("download") || /\.(csv|json|pdf|xlsx|xls|zip|txt|png|jpg|docx)$/i.test(url.pathname);
      } catch {
        href = "external";
      }
    }
    const entry: ScreenControl = {
      role,
      name: name || "(no name)",
      testId: el.getAttribute("data-testid"),
      href,
      inputType: isField ? (tag === "input" ? type || "text" : tag) : null,
      options: tag === "select" ? Array.from((el as HTMLSelectElement).options).slice(0, 6).map((o) => clean(o.label || o.text, 40)) : [],
      downloads,
    };
    const key = `${entry.role}|${entry.name}|${entry.href}|${entry.testId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter(visible)
    .slice(0, 12)
    .map((h) => clean(h.textContent));
  return { path: location.pathname + location.search, title: clean(document.title), headings, controls: out };
}

export async function readScreenOf(page: Page): Promise<Screen> {
  // tsx wraps named functions in a __name helper that does not exist in the page. See readPageShape in crawl.ts.
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
  return page.evaluate(readScreen);
}

export function describeScreen(screen: Screen): string {
  const lines = [`Page ${screen.path} · title "${screen.title}"`];
  if (screen.headings.length) lines.push(`  Headings: ${screen.headings.join(" | ")}`);
  for (const c of screen.controls) {
    const parts = [`  - ${c.role} "${c.name}"`];
    if (c.testId) parts.push(`testid=${c.testId}`);
    if (c.href) parts.push(`-> ${c.href}`);
    if (c.inputType) parts.push(`(${c.inputType})`);
    if (c.options.length) parts.push(`options: ${c.options.join(", ")}`);
    if (c.downloads) parts.push("[downloads a file]");
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
