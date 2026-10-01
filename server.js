import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { menu as initialMenu } from "./menu.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
const password = process.env.ADMIN_PASSWORD?.trim();
if (!password || password.length < 12 || password === "pon-aqui-una-clave-larga-y-unica") {
  console.error("Configura ADMIN_PASSWORD (mínimo 12 caracteres) en el archivo .env antes de iniciar.");
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
const dbDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(path.join(dbDir, "zy-coffee.sqlite"));
const scrypt = promisify(crypto.scrypt);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL, price INTEGER NOT NULL, tag TEXT NOT NULL DEFAULT '',
    available INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL, pickup_time TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL, total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'nueva', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customer_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    privacy_accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    privacy_version TEXT NOT NULL DEFAULT '2026-10-01-v1'
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    session_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS business_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_by TEXT NOT NULL DEFAULT 'Equipo', opening_cash INTEGER NOT NULL,
    closed_at TEXT, closed_by TEXT, closing_cash INTEGER, status TEXT NOT NULL DEFAULT 'open'
  );
`);
db.prepare("INSERT OR IGNORE INTO business_settings (key, value) VALUES ('online_orders_open', 'true')").run();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_open_shift ON shifts(status) WHERE status='open'");
const customerColumns = new Set(db.prepare("PRAGMA table_info(customer_users)").all().map(column => column.name));
if (!customerColumns.has("privacy_accepted_at")) db.exec("ALTER TABLE customer_users ADD COLUMN privacy_accepted_at TEXT");
if (!customerColumns.has("privacy_version")) db.exec("ALTER TABLE customer_users ADD COLUMN privacy_version TEXT NOT NULL DEFAULT '2026-10-01-v1'");
const orderColumns = new Set(db.prepare("PRAGMA table_info(orders)").all().map(column => column.name));
if (!orderColumns.has("customer_email")) db.exec("ALTER TABLE orders ADD COLUMN customer_email TEXT NOT NULL DEFAULT ''");
if (!orderColumns.has("customer_id")) db.exec("ALTER TABLE orders ADD COLUMN customer_id INTEGER");
if (!orderColumns.has("source")) db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'online'");
if (!orderColumns.has("payment_method")) db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
if (!orderColumns.has("paid")) db.exec("ALTER TABLE orders ADD COLUMN paid INTEGER NOT NULL DEFAULT 0");
if (!orderColumns.has("shift_id")) db.exec("ALTER TABLE orders ADD COLUMN shift_id INTEGER");
if (!orderColumns.has("cashier")) db.exec("ALTER TABLE orders ADD COLUMN cashier TEXT NOT NULL DEFAULT ''");
const count = db.prepare("SELECT COUNT(*) AS count FROM menu_items").get().count;
if (!count) {
  const insert = db.prepare("INSERT INTO menu_items (id, category, name, description, price, tag, available) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const item of initialMenu) insert.run(item.id, item.category, item.name, item.description, item.price, item.tag, 1);
}

const sessions = new Map();
const attempts = new Map();
const sessionSecret = crypto.randomBytes(32);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
function readBody(req, limit = 16_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > limit) { reject(new Error("El formulario es demasiado grande.")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("El formato de la solicitud no es válido.")); } });
    req.on("error", reject);
  });
}
function cookieValue(req, key) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(v => v.trim().split("=").map(decodeURIComponent)))[key] || "";
}
function adminSession(req) {
  const token = cookieValue(req, "zy_admin");
  const record = sessions.get(token);
  if (!record || record.expires < Date.now()) { sessions.delete(token); return null; }
  return token;
}
function customerSession(req) {
  const token = cookieValue(req, "zy_customer");
  if (!token) return null;
  const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
  const record = db.prepare("SELECT customer_id, expires_at FROM customer_sessions WHERE session_hash=?").get(sessionHash);
  if (!record || record.expires_at < Date.now()) {
    db.prepare("DELETE FROM customer_sessions WHERE session_hash=?").run(sessionHash);
    return null;
  }
  return { token, sessionHash, customerId: record.customer_id };
}
function csrfToken(token) { return crypto.createHmac("sha256", sessionSecret).update(token).digest("hex"); }
function csrfOk(req, token) { return req.headers["x-csrf-token"] === csrfToken(token); }
function safeEqual(a, b) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function adminGuard(req, res, write = false) {
  const token = adminSession(req);
  if (!token) { json(res, 401, { error: "Inicia sesión para continuar." }); return null; }
  if (write && !csrfOk(req, token)) { json(res, 403, { error: "La sesión venció. Inicia sesión nuevamente." }); return null; }
  return token;
}
function customerGuard(req, res, write = false) {
  const session = customerSession(req);
  if (!session) { json(res, 401, { error: "Inicia sesión para continuar." }); return null; }
  if (write && !csrfOk(req, session.token)) { json(res, 403, { error: "La sesión venció. Inicia sesión nuevamente." }); return null; }
  return session;
}
function setCustomerSession(res, customerId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + 30 * 24 * 60 * 60_000;
  const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO customer_sessions (session_hash, customer_id, expires_at) VALUES (?, ?, ?)").run(sessionHash, customerId, expires);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return { token, headers: { "Set-Cookie": `zy_customer=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` } };
}
function publicCustomer(customer) { return { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone }; }
async function hashPassword(value, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = await scrypt(value, salt, 64);
  return { salt, hash: hash.toString("hex") };
}
async function verifyPassword(value, salt, expected) {
  const actual = await scrypt(value, salt, 64);
  return safeEqual(actual.toString("hex"), expected);
}
function normalizePhone(value) { return String(value || "").replace(/[^0-9+() -]/g, "").trim().slice(0, 32); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase().slice(0, 254); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/menu") {
    const items = db.prepare("SELECT id, category, name, description, price, tag, available FROM menu_items WHERE available=1 ORDER BY rowid").all();
    return json(res, 200, { items });
  }
  if (req.method === "GET" && pathname === "/api/store-status") {
    const setting = db.prepare("SELECT value FROM business_settings WHERE key='online_orders_open'").get();
    return json(res, 200, { onlineOrdersOpen: setting?.value !== "false" });
  }
  if (req.method === "POST" && pathname === "/api/customer/register") {
    try {
      const data = await readBody(req, 4_000);
      const name = String(data.name || "").trim().slice(0, 80);
      const email = normalizeEmail(data.email);
      const phone = normalizePhone(data.phone);
      const newPassword = String(data.password || "");
      if (name.length < 2) return json(res, 400, { error: "Escribe tu nombre." });
      if (!validEmail(email)) return json(res, 400, { error: "Escribe un correo válido." });
      if (phone.replace(/\D/g, "").length < 7) return json(res, 400, { error: "Escribe un teléfono válido." });
      if (newPassword.length < 10 || newPassword.length > 128) return json(res, 400, { error: "La contraseña debe tener entre 10 y 128 caracteres." });
      if (data.privacyConsent !== true) return json(res, 400, { error: "Confirma el aviso de uso de datos para crear tu cuenta." });
      const credentials = await hashPassword(newPassword);
      const result = db.prepare("INSERT INTO customer_users (name, email, phone, password_salt, password_hash, privacy_accepted_at, privacy_version) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, '2026-10-01-v1')").run(name, email, phone, credentials.salt, credentials.hash);
      const customer = db.prepare("SELECT id, name, email, phone FROM customer_users WHERE id=?").get(Number(result.lastInsertRowid));
      const session = setCustomerSession(res, customer.id);
      return json(res, 201, { ok: true, customer: publicCustomer(customer), csrf: csrfToken(session.token) }, session.headers);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) return json(res, 409, { error: "Ya existe una cuenta con ese correo. Inicia sesión." });
      return json(res, 400, { error: "No pudimos crear la cuenta. Revisa tus datos e inténtalo otra vez." });
    }
  }
  if (req.method === "POST" && pathname === "/api/customer/login") {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attemptKey = `customer:${ip}`;
    const attempt = attempts.get(attemptKey) || { count: 0, until: 0 };
    if (attempt.until > now) return json(res, 429, { error: "Demasiados intentos. Espera unos minutos." });
    try {
      const data = await readBody(req, 4_000);
      const email = normalizeEmail(data.email);
      const customer = db.prepare("SELECT * FROM customer_users WHERE email=?").get(email);
      const passwordMatches = customer && await verifyPassword(String(data.password || ""), customer.password_salt, customer.password_hash);
      if (!passwordMatches) {
        attempt.count += 1;
        if (attempt.count >= 6) { attempt.count = 0; attempt.until = now + 5 * 60_000; }
        attempts.set(attemptKey, attempt);
        return json(res, 401, { error: "Correo o contraseña incorrectos." });
      }
      attempts.delete(attemptKey);
      const session = setCustomerSession(res, customer.id);
      return json(res, 200, { ok: true, customer: publicCustomer(customer), csrf: csrfToken(session.token) }, session.headers);
    } catch { return json(res, 400, { error: "No se pudo iniciar sesión." }); }
  }
  if (req.method === "GET" && pathname === "/api/customer/session") {
    const session = customerSession(req);
    if (!session) return json(res, 401, { ok: false });
    const customer = db.prepare("SELECT id, name, email, phone FROM customer_users WHERE id=?").get(session.customerId);
    return customer ? json(res, 200, { ok: true, customer: publicCustomer(customer), csrf: csrfToken(session.token) }) : json(res, 401, { ok: false });
  }
  if (req.method === "POST" && pathname === "/api/customer/logout") {
    const session = customerGuard(req, res, true); if (!session) return;
    db.prepare("DELETE FROM customer_sessions WHERE session_hash=?").run(session.sessionHash);
    return json(res, 200, { ok: true }, { "Set-Cookie": "zy_customer=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }
  if (req.method === "GET" && pathname === "/api/customer/orders") {
    const session = customerGuard(req, res); if (!session) return;
    const orders = db.prepare("SELECT id, customer_name, customer_phone, customer_email, pickup_time, notes, items_json, total, status, created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 20").all(session.customerId).map(row => ({ ...row, items: JSON.parse(row.items_json) }));
    return json(res, 200, { orders });
  }
  if (req.method === "POST" && pathname === "/api/orders") {
    try {
      const onlineOrders = db.prepare("SELECT value FROM business_settings WHERE key='online_orders_open'").get();
      if (onlineOrders?.value === "false") return json(res, 409, { error: "Ahora no recibimos pedidos en línea. Consulta nuestro horario y vuelve a intentarlo." });
      const data = await readBody(req);
      const name = String(data.name || "").trim().slice(0, 80);
      const phone = normalizePhone(data.phone);
      const email = normalizeEmail(data.email);
      const customer = customerSession(req);
      const source = data.source === "whatsapp" ? "whatsapp" : "online";
      const pickup = String(data.pickupTime || "").trim().slice(0, 60);
      const notes = String(data.notes || "").trim().slice(0, 500);
      if (name.length < 2 || phone.replace(/\D/g, "").length < 7) return json(res, 400, { error: "Escribe tu nombre y un teléfono válido." });
      if (email && !validEmail(email)) return json(res, 400, { error: "Revisa el correo electrónico." });
      if (!Array.isArray(data.items) || !data.items.length || data.items.length > 20) return json(res, 400, { error: "Agrega al menos un producto al pedido." });
      const requested = new Map();
      for (const row of data.items) {
        const id = String(row.id || "");
        const quantity = Number(row.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return json(res, 400, { error: "Revisa las cantidades del pedido." });
        requested.set(id, (requested.get(id) || 0) + quantity);
        if (requested.get(id) > 20) return json(res, 400, { error: "La cantidad máxima por producto es 20." });
      }
      const ids = [...requested.keys()];
      const available = db.prepare(`SELECT id, name, price FROM menu_items WHERE available=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
      if (available.length !== ids.length) return json(res, 400, { error: "Un producto ya no está disponible. Actualiza el menú e inténtalo de nuevo." });
      const itemById = new Map(available.map(item => [item.id, item]));
      const items = ids.map(id => ({ id, name: itemById.get(id).name, price: itemById.get(id).price, quantity: requested.get(id) }));
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const result = db.prepare("INSERT INTO orders (customer_name, customer_phone, customer_email, customer_id, pickup_time, notes, items_json, total, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(name, phone, email, customer?.customerId ?? null, pickup, notes, JSON.stringify(items), total, source);
      return json(res, 201, { ok: true, orderNumber: Number(result.lastInsertRowid) });
    } catch (error) { return json(res, 400, { error: error.message || "No se pudo guardar el pedido." }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/login") {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempt = attempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > now) return json(res, 429, { error: "Demasiados intentos. Espera unos minutos." });
    try {
      const data = await readBody(req, 2_000);
      if (!safeEqual(String(data.password || ""), password)) {
        attempt.count += 1;
        if (attempt.count >= 6) { attempt.count = 0; attempt.until = now + 5 * 60_000; }
        attempts.set(ip, attempt);
        return json(res, 401, { error: "La clave no coincide." });
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { expires: now + 8 * 60 * 60_000 });
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return json(res, 200, { ok: true, csrf: csrfToken(token) }, { "Set-Cookie": `zy_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}` });
    } catch { return json(res, 400, { error: "No se pudo iniciar sesión." }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/logout") {
    const token = adminGuard(req, res, true); if (!token) return;
    sessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": "zy_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
  }
  if (req.method === "GET" && pathname === "/api/admin/session") {
    const token = adminSession(req);
    return token ? json(res, 200, { ok: true, csrf: csrfToken(token) }) : json(res, 401, { ok: false });
  }
  if (req.method === "GET" && pathname === "/api/admin/orders") {
    if (!adminGuard(req, res)) return;
    const orders = db.prepare("SELECT * FROM orders ORDER BY CASE WHEN source IN ('online','whatsapp') AND status='nueva' THEN 0 WHEN status='preparando' THEN 1 ELSE 2 END, created_at DESC").all().map(row => ({ ...row, items: JSON.parse(row.items_json) }));
    return json(res, 200, { orders });
  }
  if (req.method === "GET" && pathname === "/api/admin/menu") {
    if (!adminGuard(req, res)) return;
    return json(res, 200, { items: db.prepare("SELECT id, category, name, description, price, tag, available FROM menu_items ORDER BY category, name").all() });
  }
  if (req.method === "GET" && pathname === "/api/admin/store-status") {
    if (!adminGuard(req, res)) return;
    const setting = db.prepare("SELECT value FROM business_settings WHERE key='online_orders_open'").get();
    return json(res, 200, { onlineOrdersOpen: setting?.value !== "false" });
  }
  if (req.method === "POST" && pathname === "/api/admin/store-status") {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 2_000);
      if (typeof data.onlineOrdersOpen !== "boolean") return json(res, 400, { error: "Indica si el café recibe pedidos en línea." });
      db.prepare("INSERT INTO business_settings (key, value) VALUES ('online_orders_open', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(data.onlineOrdersOpen));
      return json(res, 200, { ok: true, onlineOrdersOpen: data.onlineOrdersOpen });
    } catch { return json(res, 400, { error: "No pudimos cambiar la recepción de pedidos." }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/menu") {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 4_000);
      const id = String(data.id || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 48);
      const name = String(data.name || "").trim().slice(0, 80);
      const category = String(data.category || "").trim().slice(0, 40);
      const description = String(data.description || "").trim().slice(0, 180);
      const price = Number(data.price);
      const tag = String(data.tag || "").trim().slice(0, 32);
      if (!id || name.length < 2 || category.length < 2 || !Number.isInteger(price) || price < 0 || price > 100000) return json(res, 400, { error: "Completa nombre, categoría y un precio entero válido." });
      db.prepare("INSERT INTO menu_items (id, category, name, description, price, tag, available) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, category, name, description, price, tag, data.available === false ? 0 : 1);
      return json(res, 201, { ok: true });
    } catch (error) {
      return json(res, 400, { error: String(error.message).includes("UNIQUE constraint failed") ? "Ya existe un producto con ese identificador." : "No pudimos guardar el producto." });
    }
  }
  const menuItemPath = pathname.match(/^\/api\/admin\/menu\/([a-z0-9-]+)$/);
  if (req.method === "PATCH" && menuItemPath) {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 4_000);
      const name = String(data.name || "").trim().slice(0, 80);
      const category = String(data.category || "").trim().slice(0, 40);
      const description = String(data.description || "").trim().slice(0, 180);
      const price = Number(data.price);
      const tag = String(data.tag || "").trim().slice(0, 32);
      if (name.length < 2 || category.length < 2 || !Number.isInteger(price) || price < 0 || price > 100000) return json(res, 400, { error: "Completa nombre, categoría y un precio entero válido." });
      const result = db.prepare("UPDATE menu_items SET name=?, category=?, description=?, price=?, tag=?, available=? WHERE id=?").run(name, category, description, price, tag, data.available ? 1 : 0, menuItemPath[1]);
      return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: "No encontramos ese producto." });
    } catch { return json(res, 400, { error: "No pudimos actualizar el producto." }); }
  }
  if (req.method === "GET" && pathname === "/api/admin/pos/shift") {
    if (!adminGuard(req, res)) return;
    const shift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    if (!shift) return json(res, 200, { shift: null, summary: null });
    const summary = db.prepare("SELECT COUNT(*) AS sales_count, COALESCE(SUM(total),0) AS total_sales, COALESCE(SUM(CASE WHEN payment_method='efectivo' THEN total ELSE 0 END),0) AS cash_sales, COALESCE(SUM(CASE WHEN payment_method='terminal' THEN total ELSE 0 END),0) AS card_sales FROM orders WHERE shift_id=? AND source='pos' AND paid=1").get(shift.id);
    return json(res, 200, { shift, summary: { ...summary, expected_cash: shift.opening_cash + summary.cash_sales } });
  }
  if (req.method === "POST" && pathname === "/api/admin/pos/shift/open") {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 2_000);
      const openingCash = Number(data.openingCash);
      if (!Number.isInteger(openingCash) || openingCash < 0 || openingCash > 1000000) return json(res, 400, { error: "Indica el efectivo inicial de caja." });
      const existing = db.prepare("SELECT id FROM shifts WHERE status='open'").get();
      if (existing) return json(res, 409, { error: "Ya hay una caja abierta." });
      const result = db.prepare("INSERT INTO shifts (opened_by, opening_cash) VALUES (?, ?)").run(String(data.openedBy || "Equipo").trim().slice(0, 60) || "Equipo", openingCash);
      return json(res, 201, { ok: true, shiftId: Number(result.lastInsertRowid) });
    } catch { return json(res, 400, { error: "No pudimos abrir la caja." }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/pos/shift/close") {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 2_000);
      const closingCash = Number(data.closingCash);
      if (!Number.isInteger(closingCash) || closingCash < 0 || closingCash > 1000000) return json(res, 400, { error: "Indica el efectivo contado al cierre." });
      const shift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
      if (!shift) return json(res, 409, { error: "No hay una caja abierta." });
      const cashSales = db.prepare("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE shift_id=? AND source='pos' AND paid=1 AND payment_method='efectivo'").get(shift.id).total;
      const expectedCash = shift.opening_cash + cashSales;
      const result = db.prepare("UPDATE shifts SET status='closed', closed_at=CURRENT_TIMESTAMP, closed_by=?, closing_cash=? WHERE id=? AND status='open'").run(String(data.closedBy || "Equipo").trim().slice(0, 60) || "Equipo", closingCash, shift.id);
      return json(res, 200, { ok: true, expectedCash, closingCash, difference: closingCash - expectedCash, shiftId: shift.id });
    } catch { return json(res, 400, { error: "No pudimos cerrar la caja." }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/pos/sales") {
    if (!adminGuard(req, res, true)) return;
    try {
      const data = await readBody(req, 8_000);
      const shift = db.prepare("SELECT id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
      if (!shift) return json(res, 409, { error: "Abre la caja antes de registrar una venta." });
      if (!["efectivo", "terminal"].includes(data.paymentMethod)) return json(res, 400, { error: "Elige efectivo o terminal." });
      if (!Array.isArray(data.items) || !data.items.length || data.items.length > 30) return json(res, 400, { error: "Agrega productos a la venta." });
      const requested = new Map();
      for (const row of data.items) {
        const id = String(row.id || "");
        const quantity = Number(row.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 30) return json(res, 400, { error: "Revisa las cantidades." });
        requested.set(id, (requested.get(id) || 0) + quantity);
        if (requested.get(id) > 30) return json(res, 400, { error: "La cantidad máxima por producto es 30." });
      }
      const ids = [...requested.keys()];
      const available = db.prepare(`SELECT id, name, price FROM menu_items WHERE available=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
      if (available.length !== ids.length) return json(res, 400, { error: "Un producto ya no está disponible. Actualiza la venta." });
      const itemById = new Map(available.map(item => [item.id, item]));
      const items = ids.map(id => ({ id, name: itemById.get(id).name, price: itemById.get(id).price, quantity: requested.get(id) }));
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const result = db.prepare("INSERT INTO orders (customer_name, customer_phone, items_json, total, status, source, payment_method, paid, shift_id, cashier) VALUES (?, '', ?, ?, 'lista', 'pos', ?, 1, ?, ?)").run(String(data.customerName || "Venta de mostrador").trim().slice(0, 80), JSON.stringify(items), total, data.paymentMethod, shift.id, String(data.cashier || "Barra").trim().slice(0, 60));
      return json(res, 201, { ok: true, receipt: Number(result.lastInsertRowid), total });
    } catch { return json(res, 400, { error: "No pudimos registrar la venta." }); }
  }
  const orderStatus = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (req.method === "PATCH" && orderStatus) {
    if (!adminGuard(req, res, true)) return;
    try {
      const body = await readBody(req, 2_000);
      if (!["nueva", "preparando", "lista", "cancelada"].includes(body.status)) return json(res, 400, { error: "Estado no válido." });
      const result = db.prepare("UPDATE orders SET status=? WHERE id=?").run(body.status, Number(orderStatus[1]));
      return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: "No encontramos ese pedido." });
    } catch { return json(res, 400, { error: "No se pudo actualizar el pedido." }); }
  }
  if (req.method === "GET" && pathname.startsWith("/api/")) return json(res, 404, { error: "No encontramos esa opción." });
  if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/admin/" || pathname === "/pos" || pathname === "/pos/" || pathname === "/cuenta" || pathname === "/aviso-de-privacidad")) {
    const file = pathname === "/" ? "index.html" : pathname === "/aviso-de-privacidad" ? "privacy.html" : pathname === "/pos" || pathname === "/pos/" ? "pos.html" : pathname === "/cuenta" ? "account.html" : "admin.html";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(path.join(root, "public", file)).pipe(res);
  }
  if (req.method === "GET" && pathname.startsWith("/assets/")) {
    const assetsDir = path.join(root, "public", "assets");
    const file = path.resolve(assetsDir, pathname.slice("/assets/".length));
    if (!file.startsWith(`${assetsDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("No encontrado"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("No encontramos esa página.");
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  handle(req, res).catch(error => { console.error("Error interno:", error); if (!res.headersSent) json(res, 500, { error: "Ocurrió un error. Inténtalo de nuevo." }); });
});
server.listen(port, () => console.log(`ZY Coffee está listo en http://localhost:${port}`));
