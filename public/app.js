const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const grid = document.querySelector("#menu-grid");
const categories = document.querySelector("#categories");
const cartBox = document.querySelector("#cart-items");
const cartTotal = document.querySelector("#cart-total");
const checkout = document.querySelector("#checkout-button");
const dialog = document.querySelector("#order-dialog");
const form = document.querySelector("#order-form");
const errorBox = document.querySelector("#dialog-error");
const successPanel = document.querySelector("#order-success");
const toast = document.querySelector("#toast");
let menu = [];
let selectedCategory = "Todo";
const cart = new Map();
const labels = { "Todo": "Todo", "Café": "Café", "Fríos": "Fríos", "Postres": "Postres" };

function showToast(message) { toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2200); }
function renderCategories() {
  const names = ["Todo", ...new Set(menu.map(item => item.category))];
  categories.innerHTML = names.map(name => `<button class="category-tab ${selectedCategory === name ? "active" : ""}" type="button" role="tab" aria-selected="${selectedCategory === name}" data-category="${escapeHtml(name)}">${escapeHtml(labels[name] || name)}</button>`).join("");
  categories.querySelectorAll("button").forEach(button => button.addEventListener("click", () => { selectedCategory = button.dataset.category; renderCategories(); renderMenu(); }));
}
function renderMenu() {
  const visible = menu.filter(item => selectedCategory === "Todo" || item.category === selectedCategory);
  grid.innerHTML = visible.map(item => `<article class="menu-item"><div><div class="item-top"><span class="item-category">${escapeHtml(item.category.toUpperCase())}</span>${item.tag ? `<span class="item-tag">${escapeHtml(item.tag)}</span>` : ""}</div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p></div><div class="item-bottom"><span class="item-price">${money.format(item.price)}</span><button class="add-item" type="button" aria-label="Agregar ${escapeHtml(item.name)}" data-add="${escapeHtml(item.id)}">+</button></div></article>`).join("");
  grid.querySelectorAll("[data-add]").forEach(button => button.addEventListener("click", () => { const id = button.dataset.add; cart.set(id, (cart.get(id) || 0) + 1); renderCart(); showToast("Agregado a tu pedido"); }));
}
function renderCart() {
  const entries = [...cart.entries()].map(([id, quantity]) => ({ item: menu.find(row => row.id === id), quantity })).filter(row => row.item);
  if (!entries.length) cartBox.innerHTML = '<p class="empty-cart">Todavía no agregas nada.<br><span>Elige algo rico del menú.</span></p>';
  else cartBox.innerHTML = entries.map(({ item, quantity }) => `<div class="cart-row"><span class="cart-row-name">${escapeHtml(item.name)}</span><span class="cart-row-price">${money.format(item.price * quantity)}</span><div class="cart-row-controls"><button class="qty-button" data-qty="${escapeHtml(item.id)}" data-change="-1" aria-label="Quitar uno de ${escapeHtml(item.name)}">−</button><span>${quantity}</span><button class="qty-button" data-qty="${escapeHtml(item.id)}" data-change="1" aria-label="Agregar uno de ${escapeHtml(item.name)}">+</button><button class="remove-item" data-remove="${escapeHtml(item.id)}">Quitar</button></div></div>`).join("");
  cartBox.querySelectorAll("[data-qty]").forEach(button => button.addEventListener("click", () => { const id = button.dataset.qty; const next = (cart.get(id) || 0) + Number(button.dataset.change); if (next <= 0) cart.delete(id); else cart.set(id, next); renderCart(); }));
  cartBox.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => { cart.delete(button.dataset.remove); renderCart(); }));
  const total = entries.reduce((sum, row) => sum + row.item.price * row.quantity, 0);
  cartTotal.textContent = money.format(total);
  checkout.disabled = !entries.length;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

async function loadMenu() {
  try {
    const response = await fetch("/api/menu");
    if (!response.ok) throw new Error("No se pudo cargar el menú.");
    ({ items: menu } = await response.json());
    renderCategories(); renderMenu(); renderCart();
  } catch {
    grid.innerHTML = '<div class="loading-card">No pudimos cargar el menú. Actualiza la página para intentarlo de nuevo.</div>';
  }
}
checkout.addEventListener("click", () => { errorBox.textContent = ""; successPanel.hidden = true; form.hidden = false; dialog.showModal(); });
dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
document.querySelector("#close-success").addEventListener("click", () => dialog.close());
form.addEventListener("submit", async event => {
  event.preventDefault(); errorBox.textContent = "";
  const data = Object.fromEntries(new FormData(form));
  data.items = [...cart.entries()].map(([id, quantity]) => ({ id, quantity }));
  try {
    const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo enviar el pedido.");
    form.hidden = true; successPanel.hidden = false;
    document.querySelector("#success-copy").textContent = `Tu solicitud #${result.orderNumber} llegó al equipo de ZY Coffee. Te contactarán para confirmar los detalles.`;
    cart.clear(); renderCart(); form.reset();
  } catch (error) { errorBox.textContent = error.message || "No pudimos enviar el pedido. Vuelve a intentarlo."; }
});
loadMenu();
