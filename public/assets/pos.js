const login = document.querySelector("#pos-login");
const loginForm = document.querySelector("#pos-login-form");
const loginError = document.querySelector("#pos-login-error");
const app = document.querySelector("#pos-app");
const shiftArea = document.querySelector("#shift-area");
const menuGrid = document.querySelector("#pos-menu");
const categoryBox = document.querySelector("#pos-categories");
const cartBox = document.querySelector("#pos-cart");
const chargeButton = document.querySelector("#pos-charge");
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
let csrf = "";
let items = [];
let cart = new Map();
let shift = null;
let category = "Todo";
let busy = false;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo completar la acción.");
  return data;
}
function showApp() { login.hidden = true; app.hidden = false; document.querySelector("#pos-logout").hidden = false; refreshAll(); }
function showError(node, message) { node.textContent = message; }
function renderCategories() {
  const names = ["Todo", ...new Set(items.map(item => item.category))];
  categoryBox.innerHTML = names.map(name => `<button type="button" class="pos-category ${name === category ? "active" : ""}" data-pos-category="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  categoryBox.querySelectorAll("[data-pos-category]").forEach(button => button.addEventListener("click", () => { category = button.dataset.posCategory; renderCategories(); renderMenu(); }));
}
function renderMenu() {
  const shown = items.filter(item => item.available && (category === "Todo" || item.category === category));
  menuGrid.innerHTML = shown.map(item => `<button type="button" class="pos-product" data-pos-add="${escapeHtml(item.id)}"><span class="pos-product-category">${escapeHtml(item.category)}</span><strong>${escapeHtml(item.name)}</strong><span>${money.format(item.price)}</span></button>`).join("") || '<p class="pos-empty-menu">No hay productos disponibles en esta categoría.</p>';
  menuGrid.querySelectorAll("[data-pos-add]").forEach(button => button.addEventListener("click", () => { const id = button.dataset.posAdd; cart.set(id, Math.min(30, (cart.get(id) || 0) + 1)); renderCart(); }));
}
function renderCart() {
  const rows = [...cart].map(([id, quantity]) => ({ item: items.find(row => row.id === id), quantity })).filter(row => row.item);
  if (!rows.length) cartBox.innerHTML = '<div class="pos-cart-empty">Agrega productos para iniciar una venta.</div>';
  else cartBox.innerHTML = rows.map(({ item, quantity }) => `<div class="pos-cart-row"><div><strong>${escapeHtml(item.name)}</strong><span>${money.format(item.price)} c/u</span></div><div class="pos-qty"><button type="button" data-pos-qty="${escapeHtml(item.id)}" data-delta="-1" aria-label="Quitar uno">−</button><span>${quantity}</span><button type="button" data-pos-qty="${escapeHtml(item.id)}" data-delta="1" aria-label="Agregar uno">+</button></div><b>${money.format(item.price * quantity)}</b></div>`).join("");
  cartBox.querySelectorAll("[data-pos-qty]").forEach(button => button.addEventListener("click", () => { const id = button.dataset.posQty; const next = (cart.get(id) || 0) + Number(button.dataset.delta); if (next <= 0) cart.delete(id); else cart.set(id, Math.min(next, 30)); renderCart(); }));
  const total = rows.reduce((sum, row) => sum + row.item.price * row.quantity, 0);
  document.querySelector("#pos-total").textContent = money.format(total);
  chargeButton.disabled = !rows.length || !shift || busy;
}
async function loadShift() {
  const data = await api("/api/admin/pos/shift");
  shift = data.shift;
  if (!shift) {
    shiftArea.innerHTML = `<div class="shift-closed"><div><span class="shift-indicator off"></span><strong>Caja cerrada</strong><p>Registra el fondo inicial para abrir la caja de hoy.</p></div><form id="open-shift-form"><label>Fondo inicial en efectivo<input name="openingCash" type="number" min="0" max="1000000" step="1" value="0" required /></label><button class="button button-dark" type="submit">Abrir caja <span>→</span></button><div class="form-error" id="shift-error" role="alert"></div></form></div>`;
    document.querySelector("#open-shift-form").addEventListener("submit", async event => {
      event.preventDefault(); const error = document.querySelector("#shift-error"); error.textContent = "";
      try { await api("/api/admin/pos/shift/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openingCash: Number(new FormData(event.currentTarget).get("openingCash")), openedBy: "Equipo ZY" }) }); await loadShift(); renderCart(); }
      catch (failure) { error.textContent = failure.message; }
    });
    renderCart(); return;
  }
  const summary = data.summary;
  shiftArea.innerHTML = `<div class="shift-open"><div class="shift-open-title"><span class="shift-indicator"></span><div><strong>Caja abierta</strong><small>Turno #${shift.id} · Fondo inicial ${money.format(shift.opening_cash)}</small></div></div><div class="shift-metrics"><span><strong>${summary.sales_count}</strong> ventas</span><span><strong>${money.format(summary.total_sales)}</strong> total</span><span><strong>${money.format(summary.cash_sales)}</strong> efectivo</span><span><strong>${money.format(summary.card_sales)}</strong> terminal</span></div><div class="shift-close-box"><span>En caja se esperan <strong>${money.format(summary.expected_cash)}</strong></span><button id="close-shift-button" class="button button-outline" type="button">Cerrar turno</button></div></div>`;
  document.querySelector("#close-shift-button").addEventListener("click", closeShift);
  renderCart();
}
async function closeShift() {
  const amount = prompt("Cuenta el efectivo en caja e indica el total en pesos:");
  if (amount === null) return;
  const closingCash = Number(amount);
  if (!Number.isInteger(closingCash) || closingCash < 0) { alert("Ingresa un total válido en pesos."); return; }
  try {
    const result = await api("/api/admin/pos/shift/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ closingCash, closedBy: "Equipo ZY" }) });
    alert(`Turno cerrado. Diferencia de caja: ${money.format(result.difference)}.`);
    shift = null; await loadShift();
  } catch (error) { alert(error.message); }
}
async function refreshAll() {
  try {
    const [menuData] = await Promise.all([api("/api/admin/menu")]);
    items = menuData.items; renderCategories(); renderMenu(); await loadShift();
  } catch (error) { showError(document.querySelector("#pos-message"), error.message); }
}
loginForm.addEventListener("submit", async event => {
  event.preventDefault(); loginError.textContent = "";
  try {
    const data = await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: new FormData(loginForm).get("password") }) });
    csrf = data.csrf; loginForm.reset(); showApp();
  } catch (error) { showError(loginError, error.message); }
});
document.querySelector("#pos-logout").addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST" }); } catch {}
  csrf = ""; shift = null; cart.clear(); app.hidden = true; login.hidden = false; document.querySelector("#pos-logout").hidden = true;
});
document.querySelector("#pos-clear").addEventListener("click", () => { cart.clear(); renderCart(); });
chargeButton.addEventListener("click", async () => {
  if (!shift || busy || !cart.size) return;
  const total = [...cart].reduce((sum, [id, quantity]) => sum + (items.find(item => item.id === id)?.price || 0) * quantity, 0);
  const paymentMethod = document.querySelector("#pos-payment").value;
  if (!confirm(`Registrar venta por ${money.format(total)} pagada con ${paymentMethod === "efectivo" ? "efectivo" : "tarjeta en terminal"}?`)) return;
  busy = true; renderCart(); showError(document.querySelector("#pos-message"), "Registrando venta…");
  try {
    const data = await api("/api/admin/pos/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [...cart].map(([id, quantity]) => ({ id, quantity })), paymentMethod, customerName: document.querySelector("#pos-customer").value }) });
    cart.clear(); document.querySelector("#pos-customer").value = ""; document.querySelector("#pos-message").textContent = `Venta #${data.receipt} registrada · ${money.format(data.total)}`;
    await loadShift();
  } catch (error) { showError(document.querySelector("#pos-message"), error.message); }
  finally { busy = false; renderCart(); }
});
(async () => { try { const session = await api("/api/admin/session"); csrf = session.csrf; showApp(); } catch {} })();
