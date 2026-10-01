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
function showDashboard() { loginPanel.hidden = true; dashboard.hidden = false; loadMenu(); loadStoreStatus(); }
function statusOptions(status) { return Object.keys(statusName).map(key => `<option value="${key}" ${status === key ? "selected" : ""}>${statusName[key]}</option>`).join(""); }
function renderOrders(orders) {
  const counts = { nueva: 0, preparando: 0, lista: 0, cancelada: 0 };
  orders.forEach(order => { counts[order.status] = (counts[order.status] || 0) + 1; });
  const online = orders.filter(order => order.source !== "pos").length;
  const counter = orders.filter(order => order.source === "pos").length;
  stats.innerHTML = `<div class="stat-card"><strong>${orders.length}</strong><span>Registros</span></div><div class="stat-card"><strong>${online}</strong><span>Pedidos en línea</span></div><div class="stat-card"><strong>${counter}</strong><span>Ventas de mostrador</span></div><div class="stat-card"><strong>${counts.nueva}</strong><span>Nuevas por preparar</span></div>`;
  if (!orders.length) { list.innerHTML = '<div class="empty-orders"><strong>La bandeja está tranquila.</strong>Cuando llegue una solicitud nueva, la verás aquí.</div>'; return; }
  list.innerHTML = orders.map(order => {
    const date = new Date(`${order.created_at.replace(" ", "T")}Z`).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
    const items = order.items.map(item => `${item.quantity} × ${escapeHtml(item.name)}`).join(" · ");
    const note = order.notes ? `<div class="admin-note">Nota: ${escapeHtml(order.notes)}</div>` : "";
    const kind = order.source === "pos" ? "Venta mostrador" : order.source === "whatsapp" ? "Pedido por WhatsApp" : "Pedido web";
    const payment = order.payment_method ? ` · ${order.payment_method === "terminal" ? "Terminal" : "Efectivo"}` : "";
    const contact = [order.customer_phone && order.customer_phone !== "—" ? `<a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a>` : "", order.customer_email ? `<a href="mailto:${escapeHtml(order.customer_email)}">${escapeHtml(order.customer_email)}</a>` : ""].filter(Boolean).join(" · ");
    return `<article class="admin-order"><div class="admin-order-head"><div><div class="admin-order-title">${kind} #${order.id} <span class="status-pill ${escapeHtml(order.status)}">${statusName[order.status]}</span></div><div class="admin-order-meta">${date}${order.pickup_time ? ` · Recoger: ${escapeHtml(order.pickup_time)}` : ""}${payment}</div></div><strong>${money.format(order.total)}</strong></div><div class="admin-items">${items}</div>${note}<div class="admin-order-foot"><div class="admin-customer">${escapeHtml(order.customer_name)}${contact ? ` · ${contact}` : ""}</div><label class="sr-only" for="status-${order.id}">Estado del pedido ${order.id}</label><select id="status-${order.id}" data-status="${order.id}">${statusOptions(order.status)}</select></div></article>`;
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
function slugify(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}
async function loadMenu() {
  const menuList = document.querySelector("#menu-admin-list");
  if (!menuList) return;
  try {
    const data = await api("/api/admin/menu");
    if (!data.items.length) { menuList.innerHTML = '<p class="menu-empty">Aún no hay productos en el menú.</p>'; return; }
    menuList.innerHTML = data.items.map(item => `<form class="menu-edit-card ${item.available ? "" : "is-unavailable"}" data-menu-id="${escapeHtml(item.id)}"><label>Producto<input name="name" value="${escapeHtml(item.name)}" required minlength="2" maxlength="80" /></label><label>Categoría<input name="category" value="${escapeHtml(item.category)}" required maxlength="40" /></label><label>Precio MXN<input name="price" value="${item.price}" type="number" min="0" step="1" required /></label><label>Descripción<input name="description" value="${escapeHtml(item.description)}" maxlength="180" /></label><label>Etiqueta<input name="tag" value="${escapeHtml(item.tag)}" maxlength="32" /></label><label class="available-switch"><input name="available" type="checkbox" ${item.available ? "checked" : ""} /> Disponible</label><button class="button button-outline" type="submit">Guardar</button></form>`).join("");
    menuList.querySelectorAll("[data-menu-id]").forEach(form => form.addEventListener("submit", async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      values.available = form.elements.available.checked;
      try {
        await api(`/api/admin/menu/${form.dataset.menuId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
        await loadMenu();
      } catch (error) { document.querySelector("#menu-admin-error").textContent = error.message; }
    }));
  } catch (error) { document.querySelector("#menu-admin-error").textContent = error.message; }
}
async function loadStoreStatus() {
  const host = document.querySelector("#store-status-admin");
  try {
    const data = await api("/api/admin/store-status");
    host.innerHTML = `<div><span class="store-admin-dot ${data.onlineOrdersOpen ? "" : "closed"}"></span><strong>Pedidos web ${data.onlineOrdersOpen ? "abiertos" : "pausados"}</strong><p>${data.onlineOrdersOpen ? "Los clientes pueden enviar solicitudes desde el menú." : "El menú sigue visible; los clientes no pueden enviar solicitudes."}</p></div><button id="toggle-store-status" class="button ${data.onlineOrdersOpen ? "button-outline" : "button-dark"}" type="button">${data.onlineOrdersOpen ? "Pausar pedidos web" : "Abrir pedidos web"}</button>`;
    document.querySelector("#toggle-store-status").addEventListener("click", async () => {
      try { await api("/api/admin/store-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onlineOrdersOpen: !data.onlineOrdersOpen }) }); await loadStoreStatus(); }
      catch (error) { document.querySelector("#dashboard-error").textContent = error.message; }
    });
  } catch (error) { host.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`; }
}
document.querySelector("#product-form").addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.querySelector("#menu-admin-error"); message.textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.id = slugify(values.name);
  try {
    await api("/api/admin/menu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    event.currentTarget.reset(); await loadMenu();
  } catch (error) { message.textContent = error.message; }
});
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
