/**
 * unified-nav.js — Harth Platform
 * Injects a consistent, role-aware navigation into every page.
 *
 * What it does:
 *   1. Replaces <ul class="nav-links"> content with the canonical item list.
 *   2. Marks the current page as "active".
 *   3. Does NOT touch auth sections — each page's own JS handles login/logout state.
 *
 * Pages that are explicitly skipped (they manage their own nav):
 *   admin-dashboard.html, register.html, forgot-password.html, checkout.html
 */
(function () {
  "use strict";

  /* ─── Pages to skip entirely ────────────────────────────────────── */
  const SKIP = [
    "admin-dashboard.html",
    "register.html",
    "forgot-password.html",
    "checkout.html",
  ];

  /* ─── Canonical desktop nav items ───────────────────────────────── */
  // roles: "*"   → shown to everyone (including guests)
  // roles: [..] → shown only when logged-in user's role is in the array
  // label: translation key, resolved at render time via window.HarthI18n.
  function navItems() {
    const t = window.HarthI18n ? window.HarthI18n.t : (k) => k;
    return [
      { href: "index.html", label: t("nav.home"), icon: "fa-home", roles: "*" },
      { href: "tools.html", label: t("nav.rentEquipment"), icon: "fa-tractor", roles: "*" },
      { href: "basket.html", label: t("nav.sellEquipment"), icon: "fa-store", roles: "*" },
      { href: "owner-dashboard.html", label: t("nav.ownerDashboard"), icon: "fa-tachometer-alt", roles: ["owner", "admin"] },
      { href: "my-orders.html", label: t("nav.myOrders"), icon: "fa-box", roles: ["renter", "owner", "admin"] },
      { href: "delivery.html", label: t("nav.delivery"), icon: "fa-truck", roles: ["delivery", "admin"] },
      { href: "track.html", label: t("nav.trackOrders"), icon: "fa-map-marker-alt", roles: ["renter", "owner", "delivery"] },
      { href: "loyalty.html", label: t("nav.loyalty"), icon: "fa-medal", roles: ["renter", "owner"] },
      { href: "support.html", label: t("nav.support"), icon: "fa-headset", roles: "*" },
    ];
  }

  /* ─── Helpers ────────────────────────────────────────────────────── */
  function getUser() {
    try { return JSON.parse(localStorage.getItem("user") || "null"); }
    catch { return null; }
  }

  function currentPage() {
    return window.location.pathname.split("/").pop() || "index.html";
  }

  function allowed(item, role) {
    if (item.roles === "*") return true;
    if (!role) return false;
    return item.roles.includes(role);
  }

  function isActive(href) {
    return currentPage() === href;
  }

  /* ─── CSS injection ──────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById("un-nav-css")) return;
    const s = document.createElement("style");
    s.id = "un-nav-css";
    s.textContent = `
      /* ── Active state for desktop nav items ─────────────── */
      .nav-links .nav-item.active,
      .nav-links a.active {
        color: #6ab04c !important;
        font-weight: 700;
        position: relative;
      }
      .nav-links .nav-item.active::after,
      .nav-links a.active::after {
        content: "";
        display: block;
        position: absolute;
        bottom: -4px;
        inset-inline-start: 0;
        inset-inline-end: 0;
        height: 2px;
        background: #6ab04c;
        border-radius: 2px;
      }
    `;
    document.head.appendChild(s);
  }

  /* ─── Desktop nav update ─────────────────────────────────────────── */
  function updateDesktopNav(user) {
    const ul = document.querySelector("ul.nav-links");
    if (!ul) return;

    const role = user?.role || null;
    ul.innerHTML = navItems()
      .filter(i => allowed(i, role))
      .map(i => `<li><a href="${i.href}" class="nav-item${isActive(i.href) ? " active" : ""}">
          <i class="fas ${i.icon}"></i><span class="nav-item__label">${i.label}</span>
        </a></li>`)
      .join("");
  }

  /* ─── Entry point ────────────────────────────────────────────────── */
  function run() {
    const page = currentPage();
    if (SKIP.includes(page)) return;

    injectCSS();

    const render = () => updateDesktopNav(getUser());
    if (window.HarthI18n) {
      window.HarthI18n.ready().then(render);
      document.addEventListener("harth:langchange", render);
    } else {
      render();
    }
  }

  // Run after DOM is ready (works whether script is defer or at body end)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
