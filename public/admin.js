const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const list = document.querySelector("#orders-list");
const dashError = document.querySelector("#dashboard-error");
const stats = document.querySelector("#order-stats");
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
let csrf = "";
const statusName = { nueva: "Nueva", preparando: "Preparando", lista: "Lista", cancelada: "Cancelada" };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, { ...options, headers });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || "Ocurrió un error.");
  return data;
}
function showDashboard() { loginPanel.hidden = true; dashboard.hidden = false; }
function statusOptions(status) { return Object.keys(statusName).map(key => `<option value="${key}" ${status === key ? "selected" : ""}>${statusName[key]}</option>`).join(""); }
function renderOrders(orders) {
  const counts = { nueva: 0, preparando: 0, lista: 0, cancelada: 0 };
  orders.forEach(order => { counts[order.status] = (counts[order.status] || 0) + 1; });
  stats.innerHTML = `<div class="stat-card"><strong>${orders.length}</strong><span>Solicitudes</span></div><div class="stat-card"><strong>${counts.nueva}</strong><span>Nuevas</span></div><div class="stat-card"><strong>${counts.preparando}</strong><span>En preparación</span></div><div class="stat-card"><strong>${counts.lista}</strong><span>Listas</span></div>`;
  if (!orders.length) { list.innerHTML = '<div class="empty-orders"><strong>La bandeja está tranquila.</strong>Cuando llegue una solicitud nueva, la verás aquí.</div>'; return; }
  list.innerHTML = orders.map(order => {
    const date = new Date(`${order.created_at.replace(" ", "T")}Z`).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
    const items = order.items.map(item => `${item.quantity} × ${escapeHtml(item.name)}`).join(" · ");
    const note = order.notes ? `<div class="admin-note">Nota: ${escapeHtml(order.notes)}</div>` : "";
    return `<article class="admin-order"><div class="admin-order-head"><div><div class="admin-order-title">Pedido #${order.id} <span class="status-pill ${escapeHtml(order.status)}">${statusName[order.status]}</span></div><div class="admin-order-meta">${date}${order.pickup_time ? ` · Recoger: ${escapeHtml(order.pickup_time)}` : ""}</div></div><strong>${money.format(order.total)}</strong></div><div class="admin-items">${items}</div>${note}<div class="admin-order-foot"><div class="admin-customer">${escapeHtml(order.customer_name)} · <a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a></div><label class="sr-only" for="status-${order.id}">Estado del pedido ${order.id}</label><select id="status-${order.id}" data-status="${order.id}">${statusOptions(order.status)}</select></div></article>`;
  }).join("");
  list.querySelectorAll("[data-status]").forEach(select => select.addEventListener("change", async () => {
    try { await api(`/api/admin/orders/${select.dataset.status}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: select.value }) }); await loadOrders(); }
    catch (error) { dashError.textContent = error.message; }
  }));
}
async function loadOrders() {
  dashError.textContent = "";
  try { const data = await api("/api/admin/orders"); renderOrders(data.orders); }
  catch (error) { dashError.textContent = error.message; }
}
loginForm.addEventListener("submit", async event => {
  event.preventDefault(); loginError.textContent = "";
  const password = new FormData(loginForm).get("password");
  try { const data = await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }); csrf = data.csrf; showDashboard(); loginForm.reset(); await loadOrders(); }
  catch (error) { loginError.textContent = error.message; }
});
document.querySelector("#refresh-orders").addEventListener("click", loadOrders);
document.querySelector("#logout").addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST" }); } catch {}
  csrf = ""; dashboard.hidden = true; loginPanel.hidden = false;
});
(async () => { try { const data = await api("/api/admin/session"); csrf = data.csrf; showDashboard(); await loadOrders(); } catch {} })();
