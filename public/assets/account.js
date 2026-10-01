const loginPanel = document.querySelector("#account-login");
const registerPanel = document.querySelector("#account-register");
const profilePanel = document.querySelector("#account-profile");
let csrf = "";
let customer = null;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
function show(section) { loginPanel.hidden = section !== "login"; registerPanel.hidden = section !== "register"; profilePanel.hidden = section !== "profile"; }
async function send(path, body, authenticated = false) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated && csrf) headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudo completar la solicitud.");
  return result;
}
async function showCustomer(data, token) {
  customer = data; csrf = token;
  document.querySelector("#customer-name").textContent = customer.name.split(" ")[0];
  show("profile"); await loadOrders();
}
async function loadOrders() {
  const host = document.querySelector("#customer-history");
  const error = document.querySelector("#customer-history-error");
  host.innerHTML = '<p class="history-loading">Cargando tus solicitudes…</p>'; error.textContent = "";
  try {
    const response = await fetch("/api/customer/orders", { headers: { "X-CSRF-Token": csrf } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "No pudimos cargar tu historial.");
    const labels = { nueva: "Recibida", preparando: "En preparación", lista: "Lista para recoger", cancelada: "Cancelada" };
    if (!data.orders.length) { host.innerHTML = '<p class="history-empty">Aún no tienes solicitudes. Explora el menú para pedir algo rico.</p>'; return; }
    host.innerHTML = data.orders.map(order => {
      const date = new Date(`${order.created_at.replace(" ", "T")}Z`).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
      const products = order.items.map(item => `${item.quantity} × ${escapeHtml(item.name)}`).join(" · ");
      return `<article class="history-row"><div class="history-row-top"><strong>Pedido #${order.id}</strong><span>${date} · ${money.format(order.total)}</span></div><p>${products}</p><span class="history-status ${escapeHtml(order.status)}">${labels[order.status] || "Recibida"}</span></article>`;
    }).join("");
  } catch (failure) { host.innerHTML = ""; error.textContent = failure.message; }
}
document.querySelectorAll("[data-show]").forEach(button => button.addEventListener("click", () => show(button.dataset.show)));
document.querySelector("#customer-login-form").addEventListener("submit", async event => {
  event.preventDefault(); const error = document.querySelector("#customer-login-error"); error.textContent = "";
  try { const result = await send("/api/customer/login", Object.fromEntries(new FormData(event.currentTarget))); await showCustomer(result.customer, result.csrf); event.currentTarget.reset(); }
  catch (failure) { error.textContent = failure.message; }
});
document.querySelector("#customer-register-form").addEventListener("submit", async event => {
  event.preventDefault(); const error = document.querySelector("#customer-register-error"); error.textContent = "";
  const data = Object.fromEntries(new FormData(event.currentTarget)); data.privacyConsent = event.currentTarget.elements.privacyConsent.checked;
  try { const result = await send("/api/customer/register", data); await showCustomer(result.customer, result.csrf); event.currentTarget.reset(); }
  catch (failure) { error.textContent = failure.message; }
});
document.querySelector("#customer-logout").addEventListener("click", async () => {
  try { await send("/api/customer/logout", {}, true); } catch {}
  customer = null; csrf = ""; show("login");
});
(async () => {
  try { const response = await fetch("/api/customer/session"); if (!response.ok) return; const result = await response.json(); await showCustomer(result.customer, result.csrf); }
  catch {}
})();
