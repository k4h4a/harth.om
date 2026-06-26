/**
 * Role-based navigation helper. Reads the logged-in user (if any) from
 * localStorage and adjusts which buttons appear in the header:
 *
 *  - owner    → "إضافة منتج" linking to owner-dashboard.html
 *  - delivery → "توصيل" linking to delivery.html
 *  - admin    → "لوحة الأدمن" linking to admin-dashboard.html
 *  - renter / anonymous → no role-specific button
 *
 * Behaviour:
 *  - The header HTML always contains the base links (Home, basket, tools, track)
 *  - This script also replaces the "تسجيل دخول" button with a user menu
 *    (name + logout) when logged in.
 *  - Runs on DOMContentLoaded so it works regardless of where it's injected.
 *
 * Usage: include <script src="nav.js"></script> AFTER script.js on any page
 * that has the standard header.
 */
(function () {
  "use strict";

  function getUserSafe() {
    try {
      const raw = localStorage.getItem("user");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function getTokenSafe() {
    try { return localStorage.getItem("token"); } catch { return null; }
  }

  // The common header renders its central <ul class="nav-links">. We insert
  // a role-specific <li> at the front (visually rightmost in RTL).
  function t(key) {
    return window.HarthI18n ? window.HarthI18n.t(key) : key;
  }

  function injectRoleLink(user) {
    const list = document.querySelector(".nav-links");
    if (!list) return;

    // Remove any existing role link we injected on a previous page load —
    // pages cached back/forward could otherwise double-inject.
    const existing = list.querySelector("[data-role-link]");
    if (existing) existing.remove();

    if (!user) return;

    let href, label, icon;
    switch (user.role) {
      case "owner":
        href = "owner-dashboard.html";
        label = t("nav.addProduct");
        icon = "fa-plus-circle";
        break;
      case "delivery":
        href = "delivery.html";
        label = t("nav.delivery");
        icon = "fa-truck";
        break;
      case "admin":
        href = "admin-dashboard.html";
        label = t("nav.adminPanel");
        icon = "fa-shield-alt";
        break;
      default:
        return; // renter / anonymous → nothing extra
    }

    const li = document.createElement("li");
    li.setAttribute("data-role-link", user.role);
    li.innerHTML = `<a href="${href}" class="nav-item"><i class="fas ${icon}" style="margin-inline-end:4px"></i>${label}</a>`;
    list.insertBefore(li, list.firstChild);
  }

  // Inject discoverability links that apply to ALL logged-in users
  // (the loyalty page lives under /loyalty/me/tier — every authenticated
  // user has a tier, even Bronze with 0 points).
  function injectUniversalLinks(user) {
    if (!user) return;
    const list = document.querySelector(".nav-links");
    if (!list) return;

    // Re-injecting (e.g. on a language change) replaces the old labels
    // instead of stacking duplicates.
    list.querySelectorAll("[data-universal]").forEach((el) => el.remove());

    const after = list.querySelector("[data-role-link]") || null;

    // "طلباتي" link — available to every authenticated user
    const liOrders = document.createElement("li");
    liOrders.setAttribute("data-universal", "my-orders");
    liOrders.innerHTML = `
      <a href="my-orders.html" class="nav-item">
        <i class="fas fa-receipt" style="margin-inline-end:4px"></i>${t("nav.myOrders")}
      </a>
    `;
    if (after && after.nextSibling) {
      list.insertBefore(liOrders, after.nextSibling);
    } else {
      list.insertBefore(liOrders, list.firstChild);
    }

    // Loyalty link
    const liLoyalty = document.createElement("li");
    liLoyalty.setAttribute("data-universal", "loyalty");
    liLoyalty.innerHTML = `
      <a href="loyalty.html" class="nav-item">
        <i class="fas fa-medal" style="color:#f1c40f;margin-inline-end:4px"></i>${t("nav.loyaltyShort")}
      </a>
    `;
    const ordersRef = list.querySelector("[data-universal=my-orders]");
    if (ordersRef && ordersRef.nextSibling) {
      list.insertBefore(liLoyalty, ordersRef.nextSibling);
    } else {
      list.insertBefore(liLoyalty, list.firstChild);
    }
  }

  // Swap the "login" button for a user menu when signed in.
  function renderUserCorner(user) {
    if (!user) return; // keep the login button

    // A previous run (e.g. before a language change) may have already
    // replaced the login button — just refresh its text in that case.
    const existing = document.getElementById("nav-user-corner");
    const corner = existing || document.querySelector(".login-nav-button");
    if (!corner) return;

    const wrap = existing || document.createElement("div");
    wrap.id = "nav-user-corner";
    wrap.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    wrap.innerHTML = `
      <a href="my-orders.html" style="
        color:#6ab04c;
        font-size:13px;
        text-decoration:none;
        background:rgba(106,176,76,0.12);
        border:1px solid rgba(106,176,76,0.35);
        padding:5px 10px;
        border-radius:6px;
        white-space:nowrap;
      ">
        <i class="fas fa-receipt" style="margin-inline-end:4px"></i>${t("nav.myOrders")}
      </a>
      <span style="color:#fff;font-size:13px;white-space:nowrap;">
        <i class="fas fa-user-circle" style="margin-inline-end:4px"></i>
        ${escapeHtml(user.name || user.email)}
      </span>
      <button id="nav-logout" style="background:rgba(231,76,60,0.8);color:#fff;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;white-space:nowrap">
        ${t("common.buttons.logoutShort")}
      </button>
    `;
    if (!existing) corner.replaceWith(wrap);
    document.getElementById("nav-logout").addEventListener("click", () => {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "index.html";
    });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  function render() {
    const token = getTokenSafe();
    const user = token ? getUserSafe() : null;
    injectRoleLink(user);
    injectUniversalLinks(user);
    renderUserCorner(user);
  }

  function run() {
    if (window.HarthI18n) {
      window.HarthI18n.ready().then(render);
      document.addEventListener("harth:langchange", render);
    } else {
      render();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
