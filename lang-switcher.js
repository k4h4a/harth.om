/**
 * lang-switcher.js — Harth Platform
 * Injects a round globe button into the header next to the login button
 * (or, on pages without the standard header, next to the back button in
 * .top-navigation). Clicking it reveals a single button for the other
 * language; clicking that switches instantly. Depends on i18n.js
 * (window.HarthI18n).
 */
(function () {
  "use strict";

  const LANGS = {
    ar: { label: "العربية" },
    en: { label: "English" },
  };

  function otherLang(lang) {
    return lang === "ar" ? "en" : "ar";
  }

  function injectCSS() {
    if (document.getElementById("lang-switcher-css")) return;
    const s = document.createElement("style");
    s.id = "lang-switcher-css";
    s.textContent = `
      .lang-switcher { position: relative; display: inline-block; }
      .lang-switcher-trigger {
        display: flex; align-items: center; justify-content: center;
        width: 40px; height: 40px; border-radius: 50%;
        background: #2f7cf6; border: none; color: #fff;
        font-size: 18px; cursor: pointer;
        box-shadow: 0 4px 10px rgba(47,124,246,.45);
        transition: transform .15s, box-shadow .15s;
      }
      .lang-switcher-trigger:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 14px rgba(47,124,246,.55);
      }
      .lang-switcher-menu {
        position: absolute; top: calc(100% + 10px); inset-inline-end: 0;
        background: #1a2e0f; border: 1px solid rgba(106,176,76,.3);
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
        overflow: hidden;
        opacity: 0; visibility: hidden; transform: translateY(-6px);
        transition: opacity .18s, visibility .18s, transform .18s;
        z-index: 9999;
      }
      .lang-switcher-menu.is-open {
        opacity: 1; visibility: visible; transform: translateY(0);
      }
      .lang-switcher-option {
        display: flex; align-items: center; width: 100%;
        padding: 12px 20px; background: none; border: none;
        color: rgba(255,255,255,.9); font-family: inherit; font-size: 14px;
        font-weight: 700; text-align: start; cursor: pointer;
        white-space: nowrap; transition: .15s;
      }
      .lang-switcher-option:hover { background: rgba(106,176,76,.15); color: #fff; }
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
      <button type="button" class="lang-switcher-trigger" id="lang-switcher-trigger" aria-label="تغيير اللغة">
        <i class="fas fa-globe"></i>
      </button>
      <div class="lang-switcher-menu" id="lang-switcher-menu">
        <button type="button" class="lang-switcher-option" id="lang-switcher-option"></button>
      </div>
    `;
    return wrap;
  }

  function updateOption(lang) {
    const opt = document.getElementById("lang-switcher-option");
    if (!opt) return;
    const target = otherLang(lang);
    opt.textContent = LANGS[target].label;
    opt.dataset.lang = target;
  }

  function wire(wrap) {
    const trigger = wrap.querySelector("#lang-switcher-trigger");
    const menu = wrap.querySelector("#lang-switcher-menu");
    const option = wrap.querySelector("#lang-switcher-option");

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("is-open");
    });
    document.addEventListener("click", () => menu.classList.remove("is-open"));

    option.addEventListener("click", async () => {
      menu.classList.remove("is-open");
      // updateOption() runs via the harth:langchange listener below, which
      // setLanguage() fires synchronously before this await resolves —
      // calling it again here would re-read the already-mutated dataset
      // and flip the label right back.
      await window.HarthI18n.setLanguage(option.dataset.lang);
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
    window.HarthI18n.ready().then(() => updateOption(window.HarthI18n.getLanguage()));
    document.addEventListener("harth:langchange", (e) => updateOption(e.detail.lang));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
