/**
 * i18n.js — Harth Platform
 * Tiny vanilla-JS translation engine. No build step, no framework — this
 * project is plain HTML/CSS/JS served statically by Express, so we load
 * locales/{lang}.json over fetch() and swap text via data-i18n-* attributes.
 *
 * Usage in markup:
 *   <span data-i18n="nav.home">الرئيسية</span>
 *   <input data-i18n-placeholder="home.hero.searchPlaceholder" placeholder="..." />
 *   <img data-i18n-alt="common.siteName" alt="..." />
 * (data-i18n-title, data-i18n-aria-label, data-i18n-value, data-i18n-html also supported)
 *
 * Usage in JS:
 *   HarthI18n.t("common.buttons.save")
 *   HarthI18n.t("home.stories.minutesAgo", { n: 5 })
 *   document.addEventListener("harth:langchange", () => { ...re-render dynamic UI... })
 */
(function () {
  "use strict";

  const STORAGE_KEY = "harth_lang";
  const DEFAULT_LANG = "ar";
  const SUPPORTED = ["ar", "en"];
  const ATTR_MAP = {
    "data-i18n": "textContent",
    "data-i18n-html": "innerHTML",
    "data-i18n-placeholder": "placeholder",
    "data-i18n-aria-label": "aria-label",
    "data-i18n-title": "title",
    "data-i18n-value": "value",
    "data-i18n-alt": "alt",
    "data-i18n-content": "content",
  };

  let translations = {};
  let currentLang = DEFAULT_LANG;
  let loadPromise = null;

  function getStoredLang() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(v) ? v : null;
    } catch {
      return null;
    }
  }

  function get(obj, path) {
    return path
      .split(".")
      .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
  }

  function t(key, vars) {
    let str = get(translations, key);
    if (str === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        str = str.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), vars[k]);
      });
    }
    return str;
  }

  function applyDom(root) {
    const scope = root || document;
    Object.keys(ATTR_MAP).forEach((attr) => {
      const prop = ATTR_MAP[attr];
      scope.querySelectorAll(`[${attr}]`).forEach((el) => {
        const value = t(el.getAttribute(attr));
        if (prop === "textContent" || prop === "innerHTML" || prop === "value") {
          el[prop] = value;
        } else {
          el.setAttribute(prop, value);
        }
      });
    });
  }

  function setDirAttrs(lang) {
    const dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", dir);
  }

  async function loadLang(lang) {
    const res = await fetch(`locales/${lang}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`i18n: failed to load locales/${lang}.json`);
    return res.json();
  }

  async function setLanguage(lang) {
    if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;
    translations = await loadLang(lang);
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* private browsing / storage disabled — language just won't persist */
    }
    setDirAttrs(lang);
    applyDom(document);
    document.documentElement.classList.remove("i18n-loading");
    document.dispatchEvent(new CustomEvent("harth:langchange", { detail: { lang } }));
  }

  function getLanguage() {
    return currentLang;
  }

  // Numbers/dates should render in the script that matches the active UI
  // language (Arabic-Indic digits look wrong inside an English sentence).
  function localeTag() {
    return currentLang === "ar" ? "ar" : "en";
  }

  loadPromise = setLanguage(getStoredLang() || DEFAULT_LANG);

  window.HarthI18n = {
    t,
    setLanguage,
    getLanguage,
    applyDom,
    localeTag,
    ready: () => loadPromise,
    SUPPORTED,
  };
})();
