/**
 * theme.js — Harth Platform
 * Tiny vanilla-JS dark/light mode engine, mirroring i18n.js's shape: a
 * localStorage-backed preference applied via an attribute on <html>, with
 * an early inline snippet in each page's <head> applying it before first
 * paint (see the anti-flash script next to the harth_lang check).
 *
 * Usage in JS:
 *   HarthTheme.setTheme("dark")
 *   HarthTheme.getTheme() // "light" | "dark"
 *   document.addEventListener("harth:themechange", () => { ...update toggle UI... })
 */
(function () {
  "use strict";

  const STORAGE_KEY = "harth_theme";
  const DEFAULT_THEME = "light";
  const SUPPORTED = ["light", "dark"];

  function getStoredTheme() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(v) ? v : null;
    } catch {
      return null;
    }
  }

  function applyThemeAttr(theme) {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function setTheme(theme, opts) {
    if (!SUPPORTED.includes(theme)) theme = DEFAULT_THEME;
    applyThemeAttr(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private browsing / storage disabled — theme just won't persist */
    }
    if (!opts || !opts.silent) {
      document.dispatchEvent(new CustomEvent("harth:themechange", { detail: { theme } }));
    }
  }

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  // The <head> anti-flash snippet already applied the attribute before
  // paint — this just makes sure state is consistent (e.g. first-ever
  // visit with nothing stored yet defaults to light).
  setTheme(getStoredTheme() || DEFAULT_THEME, { silent: true });

  window.HarthTheme = {
    setTheme,
    getTheme,
    SUPPORTED,
  };
})();
