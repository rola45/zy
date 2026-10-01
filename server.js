import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const dbDir = path.join(root, "data");
fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(path.join(dbDir, "zy-coffee.sqlite"));
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
`);
const count = db.prepare("SELECT COUNT(*) AS count FROM menu_items").get().count;
if (!count) {
  const insert = db.prepare("INSERT INTO menu_items (id, category, name, description, price, tag, available) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const item of initialMenu) insert.run(item.id, item.category, item.name, item.description, item.price, item.tag, 1);
}

const sessions = new Map();
const attempts = new Map();
const sessionSecret = crypto.randomBytes(32);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

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
function normalizePhone(value) { return String(value || "").replace(/[^0-9+() -]/g, "").trim().slice(0, 32); }

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/menu") {
    const items = db.prepare("SELECT id, category, name, description, price, tag, available FROM menu_items WHERE available=1 ORDER BY rowid").all();
    return json(res, 200, { items });
  }
  if (req.method === "POST" && pathname === "/api/orders") {
    try {
      const data = await readBody(req);
      const name = String(data.name || "").trim().slice(0, 80);
      const phone = normalizePhone(data.phone);
      const pickup = String(data.pickupTime || "").trim().slice(0, 60);
      const notes = String(data.notes || "").trim().slice(0, 500);
      if (name.length < 2 || phone.replace(/\D/g, "").length < 7) return json(res, 400, { error: "Escribe tu nombre y un teléfono válido." });
      if (!Array.isArray(data.items) || !data.items.length || data.items.length > 20) return json(res, 400, { error: "Agrega al menos un producto al pedido." });
      const requested = new Map();
      for (const row of data.items) {
        const id = String(row.id || "");
        const quantity = Number(row.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return json(res, 400, { error: "Revisa las cantidades del pedido." });
        requested.set(id, (requested.get(id) || 0) + quantity);
      }
      const ids = [...requested.keys()];
      const available = db.prepare(`SELECT id, name, price FROM menu_items WHERE available=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
      if (available.length !== ids.length) return json(res, 400, { error: "Un producto ya no está disponible. Actualiza el menú e inténtalo de nuevo." });
      const itemById = new Map(available.map(item => [item.id, item]));
      const items = ids.map(id => ({ id, name: itemById.get(id).name, price: itemById.get(id).price, quantity: requested.get(id) }));
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const result = db.prepare("INSERT INTO orders (customer_name, customer_phone, pickup_time, notes, items_json, total) VALUES (?, ?, ?, ?, ?, ?)").run(name, phone, pickup, notes, JSON.stringify(items), total);
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
    const orders = db.prepare("SELECT * FROM orders ORDER BY CASE status WHEN 'nueva' THEN 0 WHEN 'preparando' THEN 1 ELSE 2 END, created_at DESC").all().map(row => ({ ...row, items: JSON.parse(row.items_json) }));
    return json(res, 200, { orders });
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
  if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/admin/")) {
    const file = pathname === "/" ? "index.html" : "admin.html";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(path.join(root, "public", file)).pipe(res);
  }
  if (req.method === "GET" && pathname.startsWith("/assets/")) {
    const asset = path.basename(pathname);
    const file = path.join(root, "public", asset);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("No encontrado"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("No encontramos esa página.");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => { console.error("Error interno:", error); if (!res.headersSent) json(res, 500, { error: "Ocurrió un error. Inténtalo de nuevo." }); });
});
server.listen(port, () => console.log(`ZY Coffee está listo en http://localhost:${port}`));
