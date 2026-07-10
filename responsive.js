/**
 * HARTH RESPONSIVE / HAMBURGER MENU
 * ----------------------------------------------------------------
 * Adds a hamburger button + slide-in mobile nav on every page that
 * has navigation, regardless of which of the project's three header
 * patterns is in use:
 *
 *   1. .header-capsule (capsule nav: index, tools, basket, track,
 *      check, owner-dashboard) — slide-in panel from the side
 *   2. .hs-header (loyalty, kyc) — collapse nav into
 *      an in-flow accordion under the header
 *
 * Pages with no nav (.header / .topbar / .top-navigation only — back
 * button or simple title) get nothing, by design.
 *
 * Self-contained, idempotent. ESC + backdrop + link-tap all close.
 */
(function () {
  "use strict";

  // Avoid double init across pages cached in back/forward
  if (window.__harthResponsiveInit) return;
  window.__harthResponsiveInit = true;

  const DESKTOP_BREAKPOINT = 1024;

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  // -----------------------------------------------------------------
  // Pattern 1: .header-capsule  (slide-in side panel)
  // -----------------------------------------------------------------
  function setupCapsulePattern() {
    const capsule = document.querySelector(".header-capsule");
    if (!capsule) return false;
    if (capsule.querySelector(".hs-hamburger")) return true; // already wired

    // Build the hamburger button
    const btn = makeHamburger("main-nav");
    capsule.appendChild(btn);

    // Mark the nav for aria-controls
    const navSection = capsule.querySelector(".section.center");
    if (navSection) {
      navSection.id = "main-nav";
      navSection.setAttribute("role", "navigation");
      navSection.setAttribute("aria-label", "القائمة الرئيسية");
    }

    // Backdrop
    const backdrop = ensureBackdrop();

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleBody(btn);
    });
    backdrop.addEventListener("click", function () {
      closeBody(btn);
    });

    // Close on link tap
    if (navSection) {
      navSection.addEventListener("click", function (e) {
        if (e.target.closest("a")) closeBody(btn);
      });
    }

    return true;
  }

  // -----------------------------------------------------------------
  // Pattern 2: .hs-header  (in-flow dropdown nav)
  // -----------------------------------------------------------------
  function setupHsHeaderPattern() {
    const header = document.querySelector(".hs-header");
    if (!header) return false;
    const nav = header.querySelector("nav");
    if (!nav) return false; // no nav → no hamburger
    if (header.querySelector(".hs-hamburger")) return true; // already wired

    const btn = makeHamburger("hs-nav");
    btn.classList.add("hs-hamburger--inline");
    nav.id = "hs-nav";

    // Insert hamburger BEFORE the nav so it sits next to the logo on mobile
    header.insertBefore(btn, nav);

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      header.classList.toggle("menu-open");
      const open = header.classList.contains("menu-open");
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "إغلاق القائمة" : "فتح القائمة");
    });

    // Close on link tap
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        header.classList.remove("menu-open");
        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-label", "فتح القائمة");
      }
    });

    return true;
  }

  // -----------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------
  function makeHamburger(controlsId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hs-hamburger";
    btn.setAttribute("aria-label", "فتح القائمة");
    btn.setAttribute("aria-expanded", "false");
    if (controlsId) btn.setAttribute("aria-controls", controlsId);
    btn.innerHTML =
      '<span class="hs-hamburger__lines" aria-hidden="true">' +
      "<span></span><span></span><span></span>" +
      "</span>";
    return btn;
  }

  function ensureBackdrop() {
    let backdrop = document.querySelector(".menu-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "menu-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      document.body.appendChild(backdrop);
    }
    return backdrop;
  }

  function openBody(btn) {
    document.body.classList.add("menu-open");
    if (btn) {
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-label", "إغلاق القائمة");
    }
  }

  function closeBody(btn) {
    document.body.classList.remove("menu-open");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", "فتح القائمة");
    }
  }

  function toggleBody(btn) {
    if (document.body.classList.contains("menu-open")) {
      closeBody(btn);
    } else {
      openBody(btn);
    }
  }

  // -----------------------------------------------------------------
  // Bootstrap
  // -----------------------------------------------------------------
  function setup() {
    setupCapsulePattern();
    setupHsHeaderPattern();

    // Global key/resize handlers — wired once even if neither pattern
    // matched (e.g. headerless pages); cheap no-ops in that case.
    if (!window.__harthGlobalHandlers) {
      window.__harthGlobalHandlers = true;

      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        // Capsule
        if (document.body.classList.contains("menu-open")) {
          const btn = document.querySelector(
            ".header-capsule .hs-hamburger",
          );
          closeBody(btn);
        }
        // hs-header
        const hsh = document.querySelector(".hs-header.menu-open");
        if (hsh) {
          hsh.classList.remove("menu-open");
          const btn = hsh.querySelector(".hs-hamburger");
          if (btn) {
            btn.setAttribute("aria-expanded", "false");
            btn.setAttribute("aria-label", "فتح القائمة");
          }
        }
      });

      let rt;
      window.addEventListener("resize", function () {
        clearTimeout(rt);
        rt = setTimeout(function () {
          if (window.innerWidth >= DESKTOP_BREAKPOINT) {
            // Force-close everything when crossing into desktop
            if (document.body.classList.contains("menu-open")) {
              const btn = document.querySelector(
                ".header-capsule .hs-hamburger",
              );
              closeBody(btn);
            }
            const hsh = document.querySelector(".hs-header.menu-open");
            if (hsh) {
              hsh.classList.remove("menu-open");
              const btn = hsh.querySelector(".hs-hamburger");
              if (btn) {
                btn.setAttribute("aria-expanded", "false");
                btn.setAttribute("aria-label", "فتح القائمة");
              }
            }
          }
        }, 100);
      });
    }
  }

  ready(setup);

  // pageshow handles back/forward cache: state may be stale
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) {
      document.body.classList.remove("menu-open");
      document.querySelectorAll(".hs-hamburger").forEach(function (btn) {
        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-label", "فتح القائمة");
      });
      document.querySelectorAll(".hs-header.menu-open").forEach(function (h) {
        h.classList.remove("menu-open");
      });
    }
  });
})();
