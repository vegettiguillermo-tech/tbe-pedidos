const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CASH_FILE = path.join(DATA_DIR, 'cash.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed_messages.json');

const META_TOKEN = process.env.WHATSAPP_TOKEN || '';
const META_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const META_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const TBE_ADMIN_KEY = process.env.TBE_ADMIN_KEY || '';
const DEMO_ACCESS_KEY = process.env.DEMO_ACCESS_KEY || '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Argentina/Buenos_Aires';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ENABLE_SIMULATOR = String(process.env.ENABLE_SIMULATOR || (NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const BUNDLED_DATA_DIR = path.join(__dirname, 'data');
function loadOrSeed(targetFile, bundledName, fallback) {
  const current = readJson(targetFile, null);
  if (current != null) return current;
  const seed = readJson(path.join(BUNDLED_DATA_DIR, bundledName), fallback);
  writeJson(targetFile, seed);
  return seed;
}

let store = loadOrSeed(STORE_FILE, 'store.json', { businessName: 'TBE Pedidos', prepMinutes: 25, categories: [], products: [] });
if (!Number.isFinite(Number(store.prepMinutes))) { store.prepMinutes = 25; writeJson(STORE_FILE, store); }
let orders = loadOrSeed(ORDERS_FILE, 'orders.json', []);
let migratedOrders = false;
for (const o of orders) {
  if (!o.readyAt) {
    const base = new Date(o.createdAt || Date.now());
    o.readyAt = new Date((Number.isFinite(base.getTime()) ? base.getTime() : Date.now()) + Math.max(0, Number(store.prepMinutes || 25)) * 60000).toISOString();
    migratedOrders = true;
  }
}
if (migratedOrders) writeJson(ORDERS_FILE, orders);
let cash = loadOrSeed(CASH_FILE, 'cash.json', { current: null, closures: [] });
if (!cash || typeof cash !== 'object') cash = { current: null, closures: [] };
if (!Array.isArray(cash.closures)) cash.closures = [];

const savedSessions = readJson(SESSIONS_FILE, {});
const sessions = new Map(Object.entries(savedSessions && typeof savedSessions === 'object' ? savedSessions : {}));
const sseClients = new Set();
const processedMessageIds = new Set(readJson(PROCESSED_FILE, []));

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TBE-Key, X-Demo-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  });
  res.end(body);
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}
function notFound(res) { json(res, 404, { ok: false, error: 'No encontrado' }); }
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function parseBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch (_) { throw new Error('JSON inválido'); }
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hasAdminAccess(req, u) {
  if (!TBE_ADMIN_KEY) return NODE_ENV !== 'production';
  const provided = String(req.headers['x-tbe-key'] || (u && u.searchParams.get('key')) || '');
  return safeEqual(provided, TBE_ADMIN_KEY);
}
function requireAdmin(req, res, u) {
  if (hasAdminAccess(req, u)) return true;
  json(res, 401, { ok: false, error: 'Clave del servidor incorrecta o no configurada' });
  return false;
}
function hasDemoAccess(req, u) {
  if (!ENABLE_SIMULATOR) return false;
  if (!DEMO_ACCESS_KEY) return NODE_ENV !== 'production';
  const provided = String(req.headers['x-demo-key'] || (u && u.searchParams.get('demoKey')) || '');
  return safeEqual(provided, DEMO_ACCESS_KEY);
}
function requireDemo(req, res, u) {
  if (hasDemoAccess(req, u)) return true;
  json(res, 401, { ok: false, error: 'Clave de demo incorrecta' });
  return false;
}
function verifyMetaSignature(rawBody, signatureHeader) {
  if (!META_APP_SECRET) return NODE_ENV !== 'production';
  if (!signatureHeader || !String(signatureHeader).startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  return safeEqual(expected, signatureHeader);
}
function persistSessions() {
  const obj = Object.fromEntries(sessions.entries());
  writeJson(SESSIONS_FILE, obj);
}
function markProcessedMessage(id) {
  if (!id) return;
  processedMessageIds.add(id);
  while (processedMessageIds.size > 5000) processedMessageIds.delete(processedMessageIds.values().next().value);
  writeJson(PROCESSED_FILE, [...processedMessageIds]);
}
function money(n) { return '$' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 }); }
function nowIso() { return new Date().toISOString(); }
function prepMinutesValue() { return Math.min(240, Math.max(0, Math.round(Number(store.prepMinutes == null ? 25 : store.prepMinutes) || 0))); }
function defaultReadyAt() { return new Date(Date.now() + prepMinutesValue() * 60000).toISOString(); }
function normalizeReadyAt(value) {
  if (!value) return defaultReadyAt();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : defaultReadyAt();
}
function businessTimeLabel(value) {
  try {
    return new Intl.DateTimeFormat('es-AR', { timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  } catch (_) { return ''; }
}
function nextOrderNumber() {
  const max = orders.reduce((m, o) => Math.max(m, Number(o.number || 0)), 0);
  return max + 1;
}
function getActiveProducts() { return store.products.filter(p => p.active !== false); }
function productById(id) { return store.products.find(p => String(p.id) === String(id)); }
function categoryById(id) { return store.categories.find(c => String(c.id) === String(id)); }
function normalizePhone(v) { return String(v || '').replace(/\D/g, ''); }
function normalizePayment(v) {
  const x = String(v || '').toUpperCase();
  return ['EFECTIVO', 'ELECTRONICO', 'A_DEFINIR'].includes(x) ? x : 'A_DEFINIR';
}
function normalizeDelivery(v) {
  const x = String(v || '').toUpperCase();
  return x === 'DELIVERY' ? 'DELIVERY' : 'RETIRO';
}
function slugId(prefix, name) {
  const base = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'item';
  return `${prefix}_${base}_${Date.now().toString(36)}`;
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

function businessDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}
function inferBusinessDate(session) {
  if (session && session.businessDate) return session.businessDate;
  try { return businessDateKey(new Date(session && session.openedAt || Date.now())); } catch (_) { return businessDateKey(); }
}
function openDailyCashSession() {
  if (cash.current) return cash.current;
  cash.current = {
    id: 'cash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    businessDate: businessDateKey(),
    openedAt: nowIso(),
    automatic: true
  };
  writeJson(CASH_FILE, cash);
  broadcast('cash:changed', { current: cash.current });
  return cash.current;
}
function cashSummary(session) {
  if (!session) return null;
  const validOrders = orders.filter(o => o.cashSessionId === session.id && o.status !== 'CANCELADO');
  const summary = {
    sessionId: session.id,
    orderCount: validOrders.length,
    total: 0,
    cash: 0,
    electronic: 0,
    undefinedPayment: 0,
    whatsapp: 0,
    tablet: 0,
    delivery: 0,
    pickup: 0,
    products: []
  };
  const products = new Map();
  for (const o of validOrders) {
    const t = Number(o.total || 0);
    summary.total += t;
    if (o.paymentMethod === 'EFECTIVO') summary.cash += t;
    else if (o.paymentMethod === 'ELECTRONICO') summary.electronic += t;
    else summary.undefinedPayment += t;
    if (o.source === 'WHATSAPP') summary.whatsapp += t; else summary.tablet += t;
    if (o.deliveryType === 'DELIVERY') summary.delivery += t; else summary.pickup += t;
    for (const it of o.items || []) {
      const key = String(it.productId || it.name);
      const old = products.get(key) || { productId: it.productId || '', name: it.name, qty: 0, total: 0 };
      old.qty += Number(it.qty || 0);
      old.total += Number(it.subtotal != null ? it.subtotal : Number(it.price || 0) * Number(it.qty || 0));
      products.set(key, old);
    }
  }
  summary.products = [...products.values()].sort((a, b) => b.qty - a.qty);
  summary.expectedCash = summary.cash;
  return summary;
}
function closeCurrentCashAutomatically(reason = 'Cambio de día') {
  if (!cash.current) return null;
  const session = cash.current;
  const summary = cashSummary(session);
  const closure = {
    id: 'close_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    sessionId: session.id,
    businessDate: inferBusinessDate(session),
    openedAt: session.openedAt,
    closedAt: nowIso(),
    automatic: true,
    reason,
    summary
  };
  cash.closures = Array.isArray(cash.closures) ? cash.closures : [];
  cash.closures.unshift(closure);
  cash.closures = cash.closures.slice(0, 730);
  cash.current = null;
  writeJson(CASH_FILE, cash);
  return closure;
}
function ensureDailyCashSession() {
  const today = businessDateKey();
  if (cash.current && inferBusinessDate(cash.current) !== today) {
    closeCurrentCashAutomatically('Cierre diario automático');
  }
  if (!cash.current) openDailyCashSession();
  if (!cash.current.businessDate) {
    cash.current.businessDate = today;
    writeJson(CASH_FILE, cash);
  }
  return cash.current;
}
function currentCashPayload() {
  const current = ensureDailyCashSession();
  return { current, summary: cashSummary(current), timezone: BUSINESS_TIMEZONE };
}

function createOrder({ customerName, phone = '', source = 'TABLET', items = [], notes = '', deliveryType = 'RETIRO', address = '', paymentMethod = 'A_DEFINIR', readyAt = '' }) {
  const cleanItems = [];
  let total = 0;
  for (const it of items) {
    const p = productById(it.productId || it.id);
    const name = String(it.name || (p && p.name) || 'Producto').trim();
    const price = Number(it.price != null ? it.price : (p && p.price) || 0);
    const qty = Math.max(1, Math.floor(Number(it.qty || it.cant || 1)));
    const subtotal = price * qty;
    cleanItems.push({ productId: p ? p.id : (it.productId || it.id || ''), name, price, qty, subtotal });
    total += subtotal;
  }
  const service = normalizeDelivery(deliveryType);
  const cleanAddress = service === 'DELIVERY' ? String(address || '').trim().slice(0, 180) : '';
  if (service === 'DELIVERY' && !cleanAddress) throw new Error('Falta la dirección para el delivery');
  const session = ensureDailyCashSession();
  const order = {
    id: 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    number: nextOrderNumber(),
    customerName: String(customerName || 'Sin nombre').trim().slice(0, 80),
    phone: normalizePhone(phone),
    source: source === 'WHATSAPP' ? 'WHATSAPP' : 'TABLET',
    status: 'NUEVO',
    deliveryType: service,
    address: cleanAddress,
    paymentMethod: normalizePayment(paymentMethod),
    cashSessionId: session.id,
    items: cleanItems,
    notes: String(notes || '').trim().slice(0, 500),
    total,
    createdAt: nowIso(),
    readyAt: normalizeReadyAt(readyAt),
    updatedAt: nowIso(),
    readyNotifiedAt: null
  };
  orders.unshift(order);
  orders = orders.slice(0, 2000);
  writeJson(ORDERS_FILE, orders);
  broadcast('order:new', order);
  broadcast('cash:changed', currentCashPayload());
  return order;
}

function emptySession(phone) {
  return { phone: normalizePhone(phone), stage: 'INIT', name: '', deliveryType: '', address: '', paymentMethod: '', cart: [], currentCategory: '' };
}
function getSession(phone) {
  const key = normalizePhone(phone);
  if (!sessions.has(key)) sessions.set(key, emptySession(key));
  return sessions.get(key);
}
function resetSession(phone) {
  const key = normalizePhone(phone);
  const s = emptySession(key);
  sessions.set(key, s);
  return s;
}
function cartSummary(session) {
  if (!session.cart.length) return 'Tu pedido está vacío.';
  let total = 0;
  const lines = session.cart.map((it, idx) => {
    total += it.price * it.qty;
    return `${idx + 1}. ${it.qty} x ${it.name} = ${money(it.price * it.qty)}`;
  });
  return `${lines.join('\n')}\n\nTOTAL: ${money(total)}`;
}
function serviceSummary(session) {
  return session.deliveryType === 'DELIVERY' ? `Delivery\nDirección: ${session.address}` : 'Retiro en el carribar';
}
function paymentLabel(v) { return v === 'EFECTIVO' ? 'Efectivo' : v === 'ELECTRONICO' ? 'Electrónico' : 'A definir'; }
function categoriesMessage(page = 0, lead = '') {
  const cats = store.categories.filter(c => c.active !== false && getActiveProducts().some(p => String(p.categoryId) === String(c.id)));
  const pageNum = Math.max(0, Number(page || 0));
  const start = pageNum * 9;
  const pageItems = cats.slice(start, start + 9);
  const rows = pageItems.map(c => ({ id: `cat:${c.id}`, title: c.name, description: '' }));
  if (start + 9 < cats.length) rows.push({ id: `catpage:${pageNum + 1}`, title: 'Más categorías', description: 'Ver más opciones' });
  return {
    type: 'list',
    text: (lead ? lead + '\n' : '') + (pageNum ? `Elegí una categoría (página ${pageNum + 1}):` : 'Elegí una categoría:'),
    buttonText: 'Ver menú',
    rows
  };
}
function productsMessage(categoryId, page = 0) {
  const c = categoryById(categoryId);
  const products = getActiveProducts().filter(p => String(p.categoryId) === String(categoryId));
  const pageNum = Math.max(0, Number(page || 0));
  const start = pageNum * 9;
  const pageItems = products.slice(start, start + 9);
  const rows = pageItems.map(p => ({ id: `prod:${p.id}`, title: p.name.slice(0, 24), description: money(p.price) }));
  if (start + 9 < products.length) rows.push({ id: `prodpage:${categoryId}:${pageNum + 1}`, title: 'Más productos', description: 'Ver más opciones' });
  return {
    type: 'list',
    text: `${c ? c.name : 'Productos'}${pageNum ? ` · pág. ${pageNum + 1}` : ''}
Elegí un producto:`,
    buttonText: 'Elegir',
    rows
  };
}
function serviceButtons(name = '') {
  return {
    type: 'buttons',
    text: name ? `Perfecto, ${name}. ¿Retiro o delivery?` : '¿Retiro o delivery?',
    buttons: [
      { id: 'service:pickup', title: 'Retiro' },
      { id: 'service:delivery', title: 'Delivery' }
    ]
  };
}
function paymentButtons(session) {
  return {
    type: 'buttons',
    text: `${cartSummary(session)}\n\n${serviceSummary(session)}\n\nElegí cómo vas a pagar para confirmar:`,
    buttons: [
      { id: 'payment:cash', title: 'Efectivo' },
      { id: 'payment:electronic', title: 'Electrónico' },
      { id: 'action:cancel', title: 'Cancelar' }
    ]
  };
}
function postAddButtons(productName) {
  return {
    type: 'buttons',
    text: `✅ Agregado: ${productName}. ¿Seguimos?`,
    buttons: [
      { id: 'action:more', title: 'Agregar otro' },
      { id: 'action:cart', title: 'Ver pedido' },
      { id: 'action:finish', title: 'Finalizar' }
    ]
  };
}
function confirmButtons(session) {
  return {
    type: 'buttons',
    text: `Pedido de ${session.name}:\n${serviceSummary(session)}\nPago: ${paymentLabel(session.paymentMethod)}\n\n${cartSummary(session)}\n\n¿Confirmamos?`,
    buttons: [
      { id: 'action:confirm', title: 'Confirmar' },
      { id: 'action:more', title: 'Agregar' },
      { id: 'action:cancel', title: 'Cancelar' }
    ]
  };
}

function finishSessionOrder(phone, session, paymentMethod) {
  session.paymentMethod = paymentMethod;
  const order = createOrder({
    customerName: session.name, phone, source: 'WHATSAPP', items: session.cart,
    deliveryType: session.deliveryType, address: session.address, paymentMethod: session.paymentMethod
  });
  resetSession(phone);
  const deliveryLine = order.deliveryType === 'DELIVERY' ? `Delivery: ${order.address}` : 'Retiro en el carribar';
  const salida = businessTimeLabel(order.readyAt);
  return [{ type: 'text', text: `✅ Pedido #${order.number} confirmado.
${order.customerName} · ${deliveryLine}
Pago: ${paymentLabel(order.paymentMethod)} · Total: ${money(order.total)}
🕒 Salida estimada: ${salida} hs

Ya lo recibió el carribar.` }];
}

function processCustomerInput(phone, input) {
  let s = getSession(phone);
  const messages = [];
  const textValue = (input && input.type === 'text' ? input.text : '').trim();
  const interactiveId = input && input.type === 'interactive' ? String(input.id || '') : '';

  if (textValue.toLowerCase() === 'cancelar') {
    resetSession(phone);
    return [{ type: 'text', text: 'Pedido cancelado. Cuando quieras empezar de nuevo, escribí Hola.' }];
  }

  if (s.stage === 'INIT') {
    s.stage = 'ASK_NAME';
    return [{ type: 'text', text: `¡Hola! Bienvenido a ${store.businessName}. ¿Cómo te llamas?` }];
  }

  if (s.stage === 'ASK_NAME') {
    if (!textValue) return [{ type: 'text', text: `¡Hola! Bienvenido a ${store.businessName}. ¿Cómo te llamas?` }];
    s.name = textValue.slice(0, 60);
    s.stage = 'ASK_SERVICE';
    return [serviceButtons(s.name)];
  }

  if (interactiveId === 'service:pickup') {
    s.deliveryType = 'RETIRO';
    s.address = '';
    s.stage = 'CHOOSE_CATEGORY';
    return [categoriesMessage()];
  }
  if (interactiveId === 'service:delivery') {
    s.deliveryType = 'DELIVERY';
    s.stage = 'ASK_ADDRESS';
    return [{ type: 'text', text: 'Perfecto. Escribí la dirección completa donde querés recibir el pedido.' }];
  }
  if (s.stage === 'ASK_ADDRESS') {
    if (!textValue || textValue.length < 4) return [{ type: 'text', text: 'Necesito una dirección para poder enviar el delivery. Escribila completa, por favor.' }];
    s.address = textValue.slice(0, 180);
    s.stage = 'CHOOSE_CATEGORY';
    return [categoriesMessage(0, `🛵 Delivery a ${s.address}`)];
  }

  if (interactiveId.startsWith('catpage:')) {
    const page = Number(interactiveId.slice(8) || 0);
    s.stage = 'CHOOSE_CATEGORY';
    return [categoriesMessage(page)];
  }
  if (interactiveId.startsWith('prodpage:')) {
    const parts = interactiveId.split(':');
    const categoryId = parts[1] || s.currentCategory;
    const page = Number(parts[2] || 0);
    s.currentCategory = categoryId;
    s.stage = 'CHOOSE_PRODUCT';
    return [productsMessage(categoryId, page)];
  }

  if (interactiveId.startsWith('cat:')) {
    const categoryId = interactiveId.slice(4);
    s.currentCategory = categoryId;
    s.stage = 'CHOOSE_PRODUCT';
    return [productsMessage(categoryId)];
  }

  if (interactiveId.startsWith('prod:')) {
    const productId = interactiveId.slice(5);
    const p = productById(productId);
    if (!p || p.active === false) return [{ type: 'text', text: 'Ese producto ya no está disponible. Elegí otro.' }, categoriesMessage()];
    const found = s.cart.find(x => String(x.productId) === String(p.id));
    if (found) found.qty += 1;
    else s.cart.push({ productId: p.id, name: p.name, price: Number(p.price), qty: 1 });
    s.stage = 'POST_ADD';
    return [postAddButtons(p.name)];
  }

  if (interactiveId === 'action:more') {
    s.stage = 'CHOOSE_CATEGORY';
    return [categoriesMessage()];
  }
  if (interactiveId === 'action:cart') {
    if (!s.cart.length) return [{ type: 'text', text: 'Todavía no agregaste productos.' }, categoriesMessage()];
    return [{
      type: 'buttons',
      text: `${cartSummary(s)}\n\n¿Qué hacemos ahora?`,
      buttons: [
        { id: 'action:more', title: 'Agregar otro' },
        { id: 'action:finish', title: 'Finalizar' },
        { id: 'action:cancel', title: 'Cancelar' }
      ]
    }];
  }
  if (interactiveId === 'action:finish') {
    if (!s.cart.length) return [{ type: 'text', text: 'Todavía no agregaste productos.' }, categoriesMessage()];
    s.stage = 'ASK_PAYMENT';
    return [paymentButtons(s)];
  }
  if (interactiveId === 'payment:cash') {
    if (!s.cart.length) return [{ type: 'text', text: 'El pedido está vacío.' }, categoriesMessage()];
    return finishSessionOrder(phone, s, 'EFECTIVO');
  }
  if (interactiveId === 'payment:electronic') {
    if (!s.cart.length) return [{ type: 'text', text: 'El pedido está vacío.' }, categoriesMessage()];
    return finishSessionOrder(phone, s, 'ELECTRONICO');
  }
  if (interactiveId === 'action:cancel') {
    resetSession(phone);
    return [{ type: 'text', text: 'Pedido cancelado. Para empezar otro, escribí Hola.' }];
  }
  if (interactiveId === 'action:confirm') {
    if (!s.cart.length) return [{ type: 'text', text: 'El pedido está vacío.' }, categoriesMessage()];
    if (!s.deliveryType) { s.stage = 'ASK_SERVICE'; return [serviceButtons(s.name)]; }
    if (s.deliveryType === 'DELIVERY' && !s.address) { s.stage = 'ASK_ADDRESS'; return [{ type: 'text', text: 'Antes de confirmar, escribí la dirección del delivery.' }]; }
    if (!s.paymentMethod) { s.stage = 'ASK_PAYMENT'; return [paymentButtons(s)]; }
    return finishSessionOrder(phone, s, s.paymentMethod);
  }

  if (textValue) {
    if (['menu', 'menú', 'pedido', 'hola', 'buenas'].includes(textValue.toLowerCase())) {
      if (!s.name) { s.stage = 'ASK_NAME'; return [{ type: 'text', text: `¡Hola! Bienvenido a ${store.businessName}. ¿Cómo te llamas?` }]; }
      if (!s.deliveryType) { s.stage = 'ASK_SERVICE'; return [serviceButtons(s.name)]; }
      return [categoriesMessage()];
    }
    if (s.stage === 'ASK_SERVICE') return [serviceButtons(s.name)];
    if (s.stage === 'ASK_PAYMENT') return [paymentButtons(s)];
    return [{ type: 'text', text: 'Usá las opciones del menú para continuar.' }, categoriesMessage()];
  }

  return [{ type: 'text', text: 'No pude interpretar esa opción. Volvamos al menú.' }, categoriesMessage()];
}


function processCustomerInputPersisted(phone, input) {
  const replies = processCustomerInput(phone, input);
  const session = getSession(phone);
  session.updatedAt = nowIso();
  persistSessions();
  return replies;
}

async function sendWhatsApp(phone, message) {
  const cleanPhone = normalizePhone(phone);
  broadcast('whatsapp:outbound', { phone: cleanPhone, message, sentAt: nowIso() });
  if (!META_TOKEN || !META_PHONE_NUMBER_ID) {
    if (NODE_ENV === 'production') throw new Error('WhatsApp no está configurado en el servidor');
    console.log('[WhatsApp MOCK]', cleanPhone, message);
    return { mock: true };
  }
  const endpoint = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: cleanPhone };
  let payload;
  if (message.type === 'text') {
    payload = { ...base, type: 'text', text: { body: message.text } };
  } else if (message.type === 'buttons') {
    payload = {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.text },
        action: { buttons: message.buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) }
      }
    };
  } else if (message.type === 'list') {
    payload = {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: message.text },
        action: {
          button: (message.buttonText || 'Elegir').slice(0, 20),
          sections: [{
            title: 'Opciones',
            rows: message.rows.slice(0, 10).map(r => ({ id: r.id, title: r.title.slice(0, 24), description: (r.description || '').slice(0, 72) }))
          }]
        }
      }
    };
  } else return;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${META_TOKEN}` },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data && data.error && (data.error.message || data.error.error_user_msg) || `HTTP ${response.status}`;
    throw new Error(`WhatsApp API: ${detail}`);
  }
  return data;
}

async function handleWebhookPayload(payload) {
  const entries = payload && payload.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {
        if (msg.id && processedMessageIds.has(msg.id)) continue;
        if (msg.id) markProcessedMessage(msg.id);
        const phone = msg.from;
        let input = null;
        if (msg.type === 'text') input = { type: 'text', text: msg.text && msg.text.body || '' };
        if (msg.type === 'interactive' && msg.interactive) {
          if (msg.interactive.type === 'button_reply') input = { type: 'interactive', id: msg.interactive.button_reply && msg.interactive.button_reply.id || '' };
          if (msg.interactive.type === 'list_reply') input = { type: 'interactive', id: msg.interactive.list_reply && msg.interactive.list_reply.id || '' };
        }
        if (!input) continue;
        const replies = processCustomerInputPersisted(phone, input);
        for (const reply of replies) {
          try { await sendWhatsApp(phone, reply); } catch (e) { console.error('sendWhatsApp:', e.message); }
        }
      }
    }
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res);
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TBE-Key, X-Demo-Key',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    });
    return res.end();
  }

  try {
    const isSimulatorApi = pathname.startsWith('/api/sim/');
    const publicApi = req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/store');
    if (isSimulatorApi) {
      if (!ENABLE_SIMULATOR) return notFound(res);
      if (!requireDemo(req, res, u)) return;
    } else if (pathname.startsWith('/api/') && !publicApi && !requireAdmin(req, res, u)) return;
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, {
      ok: true,
      businessName: store.businessName,
      version: '4.0.0-prod',
      whatsappConfigured: !!(META_TOKEN && META_PHONE_NUMBER_ID),
      timezone: BUSINESS_TIMEZONE
    });
    if (req.method === 'GET' && pathname === '/api/store') return json(res, 200, { ok: true, store });
    if (req.method === 'PUT' && pathname === '/api/store') {
      const b = await parseBody(req);
      let changed = false;
      if (b.businessName != null) {
        const businessName = String(b.businessName || '').trim();
        if (!businessName) return json(res, 400, { ok: false, error: 'Ingresá el nombre del carribar' });
        store.businessName = businessName.slice(0, 80);
        changed = true;
      }
      if (b.prepMinutes != null) {
        const mins = Math.round(Number(b.prepMinutes));
        if (!Number.isFinite(mins) || mins < 0 || mins > 240) return json(res, 400, { ok: false, error: 'El tiempo de preparación debe estar entre 0 y 240 minutos' });
        store.prepMinutes = mins;
        changed = true;
      }
      if (!changed) return json(res, 400, { ok: false, error: 'No hay cambios para guardar' });
      writeJson(STORE_FILE, store);
      broadcast('store:changed', store);
      return json(res, 200, { ok: true, store });
    }
    if (req.method === 'GET' && pathname === '/api/system/info') return json(res, 200, {
      ok: true,
      version: '4.0.0-prod',
      environment: NODE_ENV,
      timezone: BUSINESS_TIMEZONE,
      webhookUrl: (PUBLIC_BASE_URL || `${u.protocol}//${req.headers.host}`) + '/webhook',
      simulatorEnabled: ENABLE_SIMULATOR,
      demoKeyConfigured: !!DEMO_ACCESS_KEY,
      demoUrl: (PUBLIC_BASE_URL || `${u.protocol}//${req.headers.host}`) + '/demo-whatsapp',
      prepMinutes: prepMinutesValue(),
      adminKeyConfigured: !!TBE_ADMIN_KEY,
      whatsapp: {
        configured: !!(META_TOKEN && META_PHONE_NUMBER_ID),
        signatureVerification: !!META_APP_SECRET,
        graphVersion: META_GRAPH_VERSION
      }
    });

    if (req.method === 'POST' && pathname === '/api/categories') {
      const b = await parseBody(req);
      const name = String(b.name || '').trim();
      if (!name) return json(res, 400, { ok: false, error: 'Ingresá el nombre de la categoría' });
      const c = { id: slugId('cat', name), name: name.slice(0, 60), active: b.active !== false };
      store.categories.push(c);
      writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 201, { ok: true, category: c });
    }
    const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch && req.method === 'PUT') {
      const b = await parseBody(req);
      const c = categoryById(categoryMatch[1]);
      if (!c) return notFound(res);
      if (b.name != null && String(b.name).trim()) c.name = String(b.name).trim().slice(0, 60);
      if (b.active != null) c.active = !!b.active;
      writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 200, { ok: true, category: c });
    }
    if (categoryMatch && req.method === 'DELETE') {
      const c = categoryById(categoryMatch[1]);
      if (!c) return notFound(res);
      const removedProducts = store.products.filter(p => String(p.categoryId) === String(c.id)).length;
      store.products = store.products.filter(p => String(p.categoryId) !== String(c.id));
      store.categories = store.categories.filter(x => String(x.id) !== String(c.id));
      writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 200, { ok: true, removedProducts });
    }

    if (req.method === 'POST' && pathname === '/api/products') {
      const b = await parseBody(req);
      const name = String(b.name || '').trim();
      const category = categoryById(b.categoryId);
      if (!name) return json(res, 400, { ok: false, error: 'Ingresá el nombre del producto' });
      if (!category) return json(res, 400, { ok: false, error: 'Categoría inválida' });
      const p = { id: slugId('p', name), categoryId: category.id, name: name.slice(0, 80), price: Math.max(0, Number(b.price || 0)), active: b.active !== false };
      store.products.push(p); writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 201, { ok: true, product: p });
    }
    const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && req.method === 'PUT') {
      const b = await parseBody(req); const p = productById(productMatch[1]); if (!p) return notFound(res);
      if (b.name != null && String(b.name).trim()) p.name = String(b.name).trim().slice(0, 80);
      if (b.price != null) p.price = Math.max(0, Number(b.price));
      if (b.categoryId != null) {
        if (!categoryById(b.categoryId)) return json(res, 400, { ok: false, error: 'Categoría inválida' });
        p.categoryId = b.categoryId;
      }
      if (b.active != null) p.active = !!b.active;
      writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 200, { ok: true, product: p });
    }
    if (productMatch && req.method === 'DELETE') {
      const p = productById(productMatch[1]); if (!p) return notFound(res);
      store.products = store.products.filter(x => String(x.id) !== String(p.id));
      writeJson(STORE_FILE, store); broadcast('store:changed', store);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/orders') {
      const status = u.searchParams.get('status');
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') || 100)));
      const list = (status ? orders.filter(o => o.status === status) : orders).slice(0, limit);
      return json(res, 200, { ok: true, orders: list });
    }
    if (req.method === 'POST' && pathname === '/api/orders') {
      const b = await parseBody(req);
      if (!b.items || !Array.isArray(b.items) || !b.items.length) return json(res, 400, { ok: false, error: 'El pedido no tiene productos' });
      const order = createOrder({
        customerName: b.customerName,
        phone: b.phone,
        source: b.source || 'TABLET',
        items: b.items,
        notes: b.notes,
        deliveryType: b.deliveryType,
        address: b.address,
        paymentMethod: b.paymentMethod,
        readyAt: b.readyAt
      });
      return json(res, 201, { ok: true, order });
    }
    const orderReadyMatch = pathname.match(/^\/api\/orders\/([^/]+)\/ready-at$/);
    if (orderReadyMatch && req.method === 'PATCH') {
      const b = await parseBody(req);
      const o = orders.find(x => x.id === orderReadyMatch[1]);
      if (!o) return notFound(res);
      const d = new Date(b.readyAt);
      if (!b.readyAt || !Number.isFinite(d.getTime())) return json(res, 400, { ok: false, error: 'Hora de salida inválida' });
      o.readyAt = d.toISOString();
      o.updatedAt = nowIso();
      writeJson(ORDERS_FILE, orders);
      broadcast('order:updated', o);
      return json(res, 200, { ok: true, order: o });
    }

    const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
    if (orderStatusMatch && req.method === 'PATCH') {
      const b = await parseBody(req);
      const o = orders.find(x => x.id === orderStatusMatch[1]);
      if (!o) return notFound(res);
      const allowed = ['NUEVO', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'CANCELADO'];
      if (!allowed.includes(b.status)) return json(res, 400, { ok: false, error: 'Estado inválido' });
      const oldStatus = o.status;
      o.status = b.status;
      o.updatedAt = nowIso();
      let readyMessage = null;
      let whatsappNotification = null;
      if (o.source === 'WHATSAPP' && o.phone && b.status === 'LISTO' && oldStatus !== 'LISTO' && !o.readyNotifiedAt) {
        readyMessage = o.deliveryType === 'DELIVERY'
          ? { type: 'text', text: `✅ ${o.customerName}, tu pedido #${o.number} ya está listo. En breve sale para delivery a: ${o.address}.` }
          : { type: 'text', text: `✅ ${o.customerName}, tu pedido #${o.number} está listo para retirar.` };
      }
      writeJson(ORDERS_FILE, orders);
      if (readyMessage) {
        try {
          const wa = await sendWhatsApp(o.phone, readyMessage);
          o.readyNotifiedAt = nowIso();
          o.readyNotificationError = '';
          o.readyMessageId = wa && wa.messages && wa.messages[0] && wa.messages[0].id || '';
          whatsappNotification = { ok: true };
        } catch (err) {
          o.readyNotificationError = String(err.message || err).slice(0, 300);
          whatsappNotification = { ok: false, error: o.readyNotificationError };
          console.error('Aviso listo:', err);
        }
        writeJson(ORDERS_FILE, orders);
      }
      broadcast('order:updated', o);
      broadcast('cash:changed', currentCashPayload());
      return json(res, 200, { ok: true, order: o, whatsappNotification });
    }

    if (req.method === 'GET' && pathname === '/api/cash/current') return json(res, 200, { ok: true, ...currentCashPayload() });
    if (req.method === 'GET' && pathname === '/api/cash/closures') {
      ensureDailyCashSession();
      const limit = Math.min(365, Math.max(1, Number(u.searchParams.get('limit') || 30)));
      return json(res, 200, { ok: true, closures: cash.closures.slice(0, limit) });
    }

    if (req.method === 'GET' && pathname === '/api/orders/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, time: nowIso() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sim/status') return json(res, 200, { ok: true, businessName: store.businessName, prepMinutes: prepMinutesValue() });
    if (req.method === 'GET' && pathname === '/api/sim/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, time: nowIso() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/sim/message') {
      const b = await parseBody(req);
      const phone = normalizePhone(b.phone || '5491100000000');
      const replies = processCustomerInputPersisted(phone, b.input || { type: 'text', text: '' });
      return json(res, 200, { ok: true, replies });
    }
    if (req.method === 'POST' && pathname === '/api/sim/reset') {
      const b = await parseBody(req);
      resetSession(normalizePhone(b.phone || '5491100000000'));
      persistSessions();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/webhook') {
      const mode = u.searchParams.get('hub.mode');
      const token = u.searchParams.get('hub.verify_token');
      const challenge = u.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === META_VERIFY_TOKEN) return text(res, 200, challenge || '');
      return text(res, 403, 'Forbidden');
    }
    if (req.method === 'POST' && pathname === '/webhook') {
      const raw = await readRawBody(req);
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'])) return text(res, 401, 'Invalid signature');
      let payload = {};
      try { payload = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (_) { return text(res, 400, 'Invalid JSON'); }
      json(res, 200, { ok: true });
      handleWebhookPayload(payload).catch(err => console.error('Webhook:', err));
      return;
    }

    if (pathname === '/simulator.html' || pathname === '/demo-whatsapp' || pathname === '/demo-whatsapp/') {
      if (!ENABLE_SIMULATOR) return notFound(res);
      return serveStatic(res, '/simulator.html');
    }
    return serveStatic(res, pathname);
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message || 'Error interno' });
  }
});

ensureDailyCashSession();

server.listen(PORT, HOST, () => {
  console.log(`TBE Pedidos PROD escuchando en http://localhost:${PORT}`);
  console.log(`WhatsApp configurado: ${!!(META_TOKEN && META_PHONE_NUMBER_ID)}`);
  console.log(`Verificación de firma Meta: ${!!META_APP_SECRET}`);
  console.log(`Simulador habilitado: ${ENABLE_SIMULATOR}`);
  console.log(`Zona horaria: ${BUSINESS_TIMEZONE}`);
  console.log(`Datos persistentes: ${DATA_DIR}`);
  if (NODE_ENV === 'production' && !TBE_ADMIN_KEY) console.warn('ADVERTENCIA: falta TBE_ADMIN_KEY');
  if (NODE_ENV === 'production' && (!META_TOKEN || !META_PHONE_NUMBER_ID || !META_APP_SECRET)) console.warn('ADVERTENCIA: WhatsApp de producción incompleto');
});
