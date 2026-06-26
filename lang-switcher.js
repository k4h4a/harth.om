/**
 * lang-switcher.js — Harth Platform
 * Injects the AR/EN language dropdown into the header next to the
 * login button (or, on pages without the standard header, next to the
 * back button in .top-navigation). Depends on i18n.js (window.HarthI18n).
 */
(function () {
  "use strict";

  const LANGS = [
    { code: "ar", flag: "🇸🇦", label: "العربية" },
    { code: "en", flag: "🇺🇸", label: "English" },
  ];

  function injectCSS() {
    if (document.getElementById("lang-switcher-css")) return;
    const s = document.createElement("style");
    s.id = "lang-switcher-css";
    s.textContent = `
      .lang-switcher { position: relative; display: inline-block; }
      .lang-switcher-trigger {
        display: flex; align-items: center; gap: 6px;
        background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
        color: #fff; padding: 7px 12px; border-radius: 20px;
        font-family: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
        transition: .2s; white-space: nowrap;
      }
      .lang-switcher-trigger:hover { background: rgba(255,255,255,.18); }
      .lang-switcher-menu {
        position: absolute; top: calc(100% + 8px); inset-inline-end: 0;
        background: #1a2e0f; border: 1px solid rgba(106,176,76,.3);
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
        min-width: 150px; overflow: hidden;
        opacity: 0; visibility: hidden; transform: translateY(-6px);
        transition: opacity .18s, visibility .18s, transform .18s;
        z-index: 9999;
      }
      .lang-switcher-menu.is-open {
        opacity: 1; visibility: visible; transform: translateY(0);
      }
      .lang-switcher-option {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 10px 14px; background: none; border: none;
        color: rgba(255,255,255,.85); font-family: inherit; font-size: 14px;
        text-align: start; cursor: pointer; transition: .15s;
      }
      .lang-switcher-option:hover { background: rgba(106,176,76,.15); color: #fff; }
      .lang-switcher-option.is-active { color: #6ab04c; font-weight: 700; }
      .lang-switcher-flag { font-size: 16px; }
      .top-navigation .lang-switcher { margin-inline-end: 10px; }
    `;
    document.head.appendChild(s);
  }

  function findMountPoint() {
    return (
      document.querySelector(".header-capsule .section.left") ||
      document.querySelector(".top-navigation") ||
      document.querySelector("body")
    );
  }

  function buildSwitcher() {
    const wrap = document.createElement("div");
    wrap.className = "lang-switcher";
    wrap.id = "lang-switcher";
    wrap.innerHTML = `
      <button type="button" class="lang-switcher-trigger" id="lang-switcher-trigger">
        <span class="lang-switcher-flag" id="lang-switcher-flag">🇸🇦</span>
        <span id="lang-switcher-code">AR</span>
        <i class="fas fa-chevron-down" style="font-size:10px;opacity:.7"></i>
      </button>
      <div class="lang-switcher-menu" id="lang-switcher-menu">
        ${LANGS.map(
          (l) => `
          <button type="button" class="lang-switcher-option" data-lang="${l.code}">
            <span class="lang-switcher-flag">${l.flag}</span> ${l.label}
          </button>`,
        ).join("")}
      </div>
    `;
    return wrap;
  }

  function updateTrigger(lang) {
    const flag = document.getElementById("lang-switcher-flag");
    const code = document.getElementById("lang-switcher-code");
    const found = LANGS.find((l) => l.code === lang) || LANGS[0];
    if (flag) flag.textContent = found.flag;
    if (code) code.textContent = found.code.toUpperCase();
    document.querySelectorAll(".lang-switcher-option").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.lang === lang);
    });
  }

  function wire(wrap) {
    const trigger = wrap.querySelector("#lang-switcher-trigger");
    const menu = wrap.querySelector("#lang-switcher-menu");

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("is-open");
    });
    document.addEventListener("click", () => menu.classList.remove("is-open"));

    wrap.querySelectorAll(".lang-switcher-option").forEach((btn) => {
      btn.addEventListener("click", async () => {
        menu.classList.remove("is-open");
        await window.HarthI18n.setLanguage(btn.dataset.lang);
        updateTrigger(btn.dataset.lang);
      });
    });
  }

  function run() {
    if (!window.HarthI18n || document.getElementById("lang-switcher")) return;
    injectCSS();
    const mount = findMountPoint();
    if (!mount) return;
    const wrap = buildSwitcher();
    mount.insertBefore(wrap, mount.firstChild);
    wire(wrap);
    window.HarthI18n.ready().then(() => updateTrigger(window.HarthI18n.getLanguage()));
    document.addEventListener("harth:langchange", (e) => updateTrigger(e.detail.lang));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
