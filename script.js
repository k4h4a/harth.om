// COMPLETE AUTH + CART - Harth Platform

// Global cart
let cart = JSON.parse(localStorage.getItem("cart")) || [];

// API config
const API_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000/api/v1"
    : "/api/v1";

// Get token from localStorage
function getToken() {
  return localStorage.getItem("token");
}

// Get user from localStorage
function getUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "{}");
  } catch {
    return null;
  }
}

// Universal API fetch w/ auto token.
// Returns the parsed JSON regardless of HTTP status so callers can inspect
// { success, error } themselves. Does NOT auto-redirect on 401 — that's a
// per-page decision (some pages like basket.html need to work for guests).
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  // If the token got rejected, wipe it locally so the next navigation
  // presents a fresh login form — but don't hijack THIS page.
  if (response.status === 401 && token) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  }

  // Some endpoints (like /invoice.pdf) return non-JSON. Try JSON first.
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return response.json();
  }
  // Non-JSON: return a minimal shape with a placeholder error if not ok.
  if (!response.ok) {
    return { success: false, error: { code: response.status, message: response.statusText } };
  }
  return response;
}

// Auth functions updated
async function checkEmail(email) {
  const data = await apiFetch("/auth/check-email", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return data.exists;
}

async function login(email, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (data.success) {
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
  }
  return data;
}

async function registerUser(userData) {
  const data = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify(userData),
  });
  if (data.success) {
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
  }
  return data;
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  // localStorage.removeItem('userRole'); // legacy
}

function t(key) {
  return window.HarthI18n ? window.HarthI18n.t(key) : key;
}

// Render header auth state
function renderHeaderAuthState() {
  const authHeader = document.getElementById("auth-header");
  // A previous render may have already swapped #login-link for the user
  // dropdown <div> — find whichever is currently in the DOM.
  const loginLink = document.getElementById("login-link");

  if (!authHeader || !loginLink) return;

  const user = getUser();
  const token = getToken();

  if (token && user.id) {
    // Logged in: replace the <a> tag entirely with a <div> to avoid href navigation
    const initials = (user.name || user.email || "؟")[0];
    const dd = document.createElement("div");
    dd.id = "login-link";
    dd.style.cssText = "display:inline-block";
    loginLink.replaceWith(dd);
    const loginLink2 = dd;
    loginLink2.innerHTML = `
      <div class="hs-user-dd" style="position:relative;display:inline-block">
        <button class="hs-user-trigger" style="
          display:flex;align-items:center;gap:8px;
          background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);
          color:#fff;padding:7px 14px;border-radius:24px;
          font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;
          transition:.2s;white-space:nowrap;
        ">
          <span style="
            width:28px;height:28px;border-radius:50%;
            background:linear-gradient(135deg,#6ab04c,#4ab625);
            display:flex;align-items:center;justify-content:center;
            font-size:13px;font-weight:800;flex-shrink:0;
          ">${initials}</span>
          ${user.name || user.email}
          <i class="fas fa-chevron-down" style="font-size:11px;opacity:.7"></i>
        </button>
        <div class="hs-user-menu" style="
          position:absolute;top:calc(100% + 8px);left:0;
          background:#1a2e0f;border:1px solid rgba(106,176,76,.3);
          border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.5);
          min-width:200px;overflow:hidden;
          opacity:0;visibility:hidden;transform:translateY(-6px);
          transition:opacity .18s,visibility .18s,transform .18s;
          z-index:9999;
        ">
          <div style="padding:12px 16px 10px;border-bottom:1px solid rgba(255,255,255,.08)">
            <div style="font-size:13px;font-weight:700;color:#fff">${user.name || ""}</div>
            <div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:1px">${user.email || ""}</div>
          </div>
          <a href="profile.html" style="
            display:flex;align-items:center;gap:10px;
            padding:11px 16px;color:rgba(255,255,255,.85);
            text-decoration:none;font-size:14px;transition:.15s;
          " onmouseover="this.style.background='rgba(106,176,76,.12)';this.style.color='#fff'"
             onmouseout="this.style.background='';this.style.color='rgba(255,255,255,.85)'">
            <i class="fas fa-user-circle" style="color:#6ab04c;width:16px;text-align:center"></i>
            ${t("common.buttons.profile")}
          </a>
          <a href="kyc.html" style="
            display:flex;align-items:center;gap:10px;
            padding:11px 16px;color:rgba(255,255,255,.85);
            text-decoration:none;font-size:14px;transition:.15s;
          " onmouseover="this.style.background='rgba(106,176,76,.12)';this.style.color='#fff'"
             onmouseout="this.style.background='';this.style.color='rgba(255,255,255,.85)'">
            <i class="fas fa-shield-alt" style="color:#f1c40f;width:16px;text-align:center"></i>
            ${t("common.buttons.verifyIdentity")}
          </a>
          <div style="height:1px;background:rgba(255,255,255,.07);margin:0 12px"></div>
          <button onclick="logout();window.location.reload();" style="
            width:100%;display:flex;align-items:center;gap:10px;
            padding:11px 16px;border:none;background:none;
            color:rgba(255,255,255,.75);font-family:inherit;font-size:14px;
            cursor:pointer;transition:.15s;
          " onmouseover="this.style.background='rgba(231,76,60,.12)';this.style.color='#ff7675'"
             onmouseout="this.style.background='';this.style.color='rgba(255,255,255,.75)'">
            <i class="fas fa-sign-out-alt" style="color:#ff7675;width:16px;text-align:center"></i>
            ${t("common.buttons.logout")}
          </button>
        </div>
      </div>
    `;

    // Toggle on trigger click (stopPropagation prevents immediate close)
    const trigger = loginLink2.querySelector(".hs-user-trigger");
    const menu    = loginLink2.querySelector(".hs-user-menu");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.style.opacity === "1";
      menu.style.opacity    = open ? "0" : "1";
      menu.style.visibility = open ? "hidden" : "visible";
      menu.style.transform  = open ? "translateY(-6px)" : "translateY(0)";
    });

    // Close on outside click
    document.addEventListener("click", () => {
      menu.style.opacity    = "0";
      menu.style.visibility = "hidden";
      menu.style.transform  = "translateY(-6px)";
    });
  } else {
    // Not logged
    loginLink.textContent = t("common.buttons.login");
    loginLink.href = "register.html";
  }
}

// === CART FUNCTIONS (unchanged) ===
function updateCartBadge() {
  const badges = document.querySelectorAll(".cart-badge");
  badges.forEach((badge) => {
    badge.textContent = cart.reduce((sum, item) => sum + item.qty, 0) || 0;
  });
}

function addToCart(item) {
  const existingIndex = cart.findIndex((c) => c.id === item.id);
  if (existingIndex > -1) {
    cart[existingIndex].qty += 1;
  } else {
    item.qty = 1;
    cart.push(item);
  }
  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartBadge();
  const count = cart.reduce((sum, c) => sum + c.qty, 0);
  alert(
    window.HarthI18n
      ? window.HarthI18n.t("basket.addedToCartAlert", { name: item.name, count })
      : `${item.name} مضاف للسلة (${count} عناصر)`,
  );
}

function removeFromCart(id) {
  cart = cart.filter((item) => item.id !== id);
  localStorage.setItem("cart", JSON.stringify(cart));
  updateCartBadge();
  updateCartDisplay();
}

function updateQty(id, newQty) {
  const item = cart.find((c) => c.id === id);
  if (item) {
    item.qty = parseInt(newQty) || 1;
    if (item.qty <= 0) removeFromCart(id);
    localStorage.setItem("cart", JSON.stringify(cart));
    updateCartDisplay();
  }
}

function updateCartDisplay() {
  const tbody = document.getElementById("cartItems");
  const currency = t("common.currency");
  if (tbody && cart.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#a2fba2">${t("basket.cartEmpty")} 🛒</td></tr>`;
    document.getElementById("subtotal").textContent = `0.00 ${currency}`;
    calculateTotal();
    return;
  }

  tbody.innerHTML = cart
    .map(
      (item) => `
    <tr>
      <td data-label="${t("basket.table.product")}"><img src="${item.img}" alt="${
        item.name
      }" class="cart-img" onerror="this.src='https://via.placeholder.com/65x65/2c3e50/fff?text=📦'" /></td>
      <td data-label="${t("basket.table.details")}">${item.name}</td>
      <td data-label="${t("basket.table.quantity")}"><input type="number" class="qty-input" value="${
        item.qty
      }" min="1" onchange="updateQty('${item.id}', this.value)" /></td>
      <td data-label="${t("basket.table.unitPrice")}" class="price">${item.price.toFixed(
        2,
      )} ${currency}</td>
      <td data-label="${t("basket.table.total")}" class="price">${(item.price * item.qty).toFixed(
        2,
      )} ${currency}</td>
      <td data-label="${t("basket.table.action")}"><button class="remove-btn" onclick="removeFromCart('${
        item.id
      }')"><i class="fas fa-trash"></i> ${t("common.buttons.remove")}</button></td>
    </tr>
  `,
    )
    .join("");
}

// Register page specific logic (updated)
function initRegisterPage() {
  const authForm = document.getElementById("authForm");
  if (authForm) {
    const createSection = document.getElementById("createAccountSection");
    const showCreateBtn = document.getElementById("showCreateAccount");
    const registerBtn = document.getElementById("registerBtn");

    if (showCreateBtn) {
      showCreateBtn.addEventListener("click", (e) => {
        e.preventDefault();
        createSection.style.display = "block";
      });
    }

    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;

      const exists = await checkEmail(email);
      if (exists) {
        const result = await login(email, password);
        if (result.success) {
          window.location.href = "index.html";
        } else {
          alert(t("register.alerts.invalidCredentials"));
        }
      } else {
        createSection.style.display = "block";
      }
    });

    if (registerBtn) {
      registerBtn.addEventListener("click", async () => {
        const role =
          document.querySelector('input[name="role"]:checked')?.value ||
          "farmer";
        const userData = {
          email: document.getElementById("email").value,
          password: document.getElementById("password").value,
          full_name: document.getElementById("full_name").value,
          identity: document.getElementById("identity").value,
          phone: document.getElementById("phone").value,
          location: document.getElementById("location").value,
          role,
        };

        if (!userData.email || !userData.password || !userData.full_name) {
          alert(t("register.alerts.missingFields"));
          return;
        }

        const result = await registerUser(userData);
        if (result.success) {
          window.location.href = "index.html";
        } else {
          alert(t("register.alerts.registerError") + ": " + (result.error || t("register.alerts.dataExists")));
        }
      });
    }
  }
}

// DOMContentLoaded - main init
document.addEventListener("DOMContentLoaded", () => {
  updateCartBadge();

  function renderTranslatedUi() {
    if (document.getElementById("cartItems")) updateCartDisplay();
    renderHeaderAuthState(); // Always call header render
  }

  if (window.HarthI18n) {
    window.HarthI18n.ready().then(renderTranslatedUi);
    document.addEventListener("harth:langchange", renderTranslatedUi);
  } else {
    renderTranslatedUi();
  }

    initRegisterPage(); // Only if register page
});

// ============================================================
// COMMISSION CALCULATION (10% platform fee on farmer price)
// ============================================================

// Commission percentage (10%)
const PLATFORM_COMMISSION_PCT = 10;

/**
 * Calculate final price including platform commission
 * @param {number} farmerPrice - The farmer's base price
 * @returns {object} { farmerPrice, commission, finalPrice }
 */
function calculateCommission(farmerPrice) {
    const price = parseFloat(farmerPrice) || 0;
    const commission = price * (PLATFORM_COMMISSION_PCT / 100);
    const finalPrice = price + commission;
    return {
        farmerPrice: price,
        commission: commission,
        finalPrice: finalPrice
    };
}

/**
 * Auto-calculate commission when farmer enters price
 * Works on any input with class "farmer-price-input" or id ending with "-farmer-price"
 */
function setupCommissionAutoCalc() {
    // Find all farmer price inputs
    const farmerPriceInputs = document.querySelectorAll(
        'input.farmer-price-input, input[id$="-farmer-price"]'
    );
    
    farmerPriceInputs.forEach(input => {
        input.addEventListener('input', function() {
            const value = parseFloat(this.value) || 0;
            const result = calculateCommission(value);
            
            // Find the corresponding final price display
            const container = this.closest('.price-group') || this.parentElement;
            const finalPriceDisplay = container.querySelector('.final-price-display') || 
                                      document.getElementById('final-price-display');
            
            if (finalPriceDisplay) {
                finalPriceDisplay.textContent = result.finalPrice.toFixed(2);
            }
            
            // Also update a hidden input if it exists
            const finalPriceInput = container.querySelector('input.final-price-input') ||
                                    document.getElementById('final-price-input');
            if (finalPriceInput) {
                finalPriceInput.value = result.finalPrice.toFixed(2);
            }
        });
    });
}

// Auto-setup when DOM is ready - using a separate listener
// This will run AFTER the main DOMContentLoaded above
document.addEventListener('DOMContentLoaded', function() {
    setupCommissionAutoCalc();
});
