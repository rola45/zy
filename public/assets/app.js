const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const grid = document.querySelector("#menu-grid");
const categories = document.querySelector("#categories");
const cartBox = document.querySelector("#cart-items");
const cartTotal = document.querySelector("#cart-total");
const checkout = document.querySelector("#checkout-button");
const whatsappButton = document.querySelector("#whatsapp-submit");
const dialog = document.querySelector("#order-dialog");
const form = document.querySelector("#order-form");
const errorBox = document.querySelector("#dialog-error");
const successPanel = document.querySelector("#order-success");
const toast = document.querySelector("#toast");
let menu = [];
let customer = null;
let onlineOrdersOpen = true;
let selectedCategory = "Todo";
const whatsappNumber = "526461481452";
const cart = new Map();
const labels = { "Todo": "Todo", "Café": "Café", "Fríos": "Fríos", "Postres": "Postres" };
const productPhotos = {
  espresso: "zy-coffee-espresso-ref.jpg", americano: "zy-coffee-americano-ref.jpg",
  "flat-white": "zy-coffee-flat-white-ref.jpg", latte: "zy-coffee-latte-ref.jpg",
  "iced-latte": "zy-coffee-iced-latte.jpg", "cold-brew": "zy-coffee-cold-brew.jpg",
  affogato: "zy-coffee-affogato.jpg", "pan-dulce": "zy-coffee-pastries.jpg"
};

function showToast(message) { toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2200); }
function renderCategories() {
  const names = ["Todo", ...new Set(menu.map(item => item.category))];
  categories.innerHTML = names.map(name => `<button class="category-tab ${selectedCategory === name ? "active" : ""}" type="button" role="tab" aria-selected="${selectedCategory === name}" data-category="${escapeHtml(name)}">${escapeHtml(labels[name] || name)}</button>`).join("");
  categories.querySelectorAll("button").forEach(button => button.addEventListener("click", () => { selectedCategory = button.dataset.category; renderCategories(); renderMenu(); }));
}
function renderMenu() {
  const visible = menu.filter(item => selectedCategory === "Todo" || item.category === selectedCategory);
  grid.innerHTML = visible.map(item => `<article class="menu-item"><img class="menu-item-photo" src="/assets/${productPhotos[item.id] || "zy-coffee-cold-brew.jpg"}" alt="${escapeHtml(item.name)} de ZY Coffee" loading="lazy"/><div class="menu-item-copy"><div class="item-top"><span class="item-category">${escapeHtml(item.category.toUpperCase())}</span>${item.tag ? `<span class="item-tag">${escapeHtml(item.tag)}</span>` : ""}</div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p></div><div class="item-bottom"><span class="item-price">${money.format(item.price)}</span><button class="add-item" type="button" aria-label="Agregar ${escapeHtml(item.name)}" data-add="${escapeHtml(item.id)}">+</button></div></article>`).join("");
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
  checkout.disabled = !entries.length || !onlineOrdersOpen;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

async function loadMenu() {
  try {
    const [menuResponse, statusResponse] = await Promise.all([fetch("/api/menu"), fetch("/api/store-status")]);
    if (!menuResponse.ok || !statusResponse.ok) throw new Error("No se pudo cargar el menú.");
    ({ items: menu } = await menuResponse.json());
    onlineOrdersOpen = (await statusResponse.json()).onlineOrdersOpen;
    const status = document.querySelector("#store-status");
    status.classList.toggle("closed", !onlineOrdersOpen);
    status.textContent = onlineOrdersOpen ? "Pedidos en línea abiertos · El equipo confirmará disponibilidad y hora de recogida." : "Por ahora no recibimos pedidos en línea. Consulta el horario y vuelve pronto.";
    renderCategories(); renderMenu(); renderCart();
  } catch {
    grid.innerHTML = '<div class="loading-card">No pudimos cargar el menú. Actualiza la página para intentarlo de nuevo.</div>';
  }
}
checkout.addEventListener("click", () => {
  if (!onlineOrdersOpen) return;
  errorBox.textContent = ""; successPanel.hidden = true; form.hidden = false;
  if (customer) {
    form.elements.name.value = customer.name;
    form.elements.phone.value = customer.phone;
    form.elements.email.value = customer.email;
  }
  dialog.showModal();
});
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
    document.querySelector("#success-copy").textContent = `Tu solicitud #${result.orderNumber} llegó al equipo de ZY Coffee. Te contactarán para confirmar disponibilidad y hora de recogida.`;
    cart.clear(); renderCart(); form.reset();
  } catch (error) { errorBox.textContent = error.message || "No pudimos enviar el pedido. Vuelve a intentarlo."; }
});
whatsappButton.addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  errorBox.textContent = "";
  whatsappButton.disabled = true;
  const whatsappTab = window.open("about:blank", "_blank");
  const data = Object.fromEntries(new FormData(form));
  data.items = [...cart.entries()].map(([id, quantity]) => ({ id, quantity }));
  data.source = "whatsapp";
  let orderNumber = null;
  let fallbackError = "";
  try {
    const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await response.json().catch(() => ({}));
    if (response.ok) orderNumber = result.orderNumber;
    else if (response.status !== 404 && response.status !== 405 && response.status < 500) throw new Error(result.error || "No se pudo registrar el pedido.");
    else fallbackError = "Esta versión no pudo guardar la solicitud en el panel.";
  } catch (error) {
    if (error instanceof TypeError) fallbackError = "Esta versión no pudo guardar la solicitud en el panel.";
    else {
      if (whatsappTab) whatsappTab.close();
      whatsappButton.disabled = false;
      errorBox.textContent = error.message || "No se pudo registrar el pedido.";
      return;
    }
  }
  const itemLines = data.items.map(({ id, quantity }) => {
    const item = menu.find(row => row.id === id);
    return `• ${quantity} × ${item.name} — ${money.format(item.price * quantity)}`;
  }).join("\n");
  const total = data.items.reduce((sum, row) => {
    const item = menu.find(entry => entry.id === row.id);
    return sum + item.price * row.quantity;
  }, 0);
  const message = [
    "Hola, quiero solicitar este pedido para recoger en ZY Coffee:",
    "",
    itemLines,
    `Total estimado: ${money.format(total)}`,
    "",
    `Nombre: ${data.name}`,
    `Teléfono: ${data.phone}`,
    data.pickupTime ? `Hora de recogida: ${data.pickupTime}` : "",
    data.email ? `Correo: ${data.email}` : "",
    data.notes ? `Nota: ${data.notes}` : "",
    orderNumber ? `Solicitud #${orderNumber} registrada en el panel.` : ""
  ].filter(Boolean).join("\n");
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
  if (whatsappTab) whatsappTab.location.href = whatsappUrl;
  else window.location.assign(whatsappUrl);
  form.hidden = true;
  successPanel.hidden = false;
  document.querySelector("#success-copy").textContent = orderNumber
    ? `La solicitud #${orderNumber} quedó en el panel del café. Se abrió WhatsApp con el pedido; revisa el mensaje y envíalo para avisar al equipo.`
    : "Se abrió WhatsApp con los detalles. Envía el mensaje para que el café reciba tu solicitud. Esta vez no se pudo guardar en el panel.";
  cart.clear(); renderCart(); form.reset(); whatsappButton.disabled = false;
});
fetch("/api/customer/session").then(response => response.ok ? response.json() : null).then(result => {
  if (!result?.customer) return;
  customer = result.customer;
  document.querySelector("#account-button").textContent = `Mi cuenta · ${customer.name.split(" ")[0]} ↗`;
}).catch(() => {});
loadMenu();
