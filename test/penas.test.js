"use strict";
// Sprint 2 — peñas oficiales: solicitud, verificación, acceso de la comisión, link de captación y fondo.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.PENA_FONDO_ACTIVO = "1"; // el aporte al fondo está apagado por defecto (decisión del club); acá se prueba el mecanismo encendido
process.env.PAGOPAR_PRIVATE_TOKEN = "privado-de-prueba"; // valida webhooks; sin público Pagopar queda simulado

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const app = require("../server");
const { getStore } = require("../data/store");
const mailer = require("../lib/email");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

// Espías de correo
let correos;
const orig = {}, NOMBRES = ["enviarPenaVerificada", "enviarPenaSumoSocio", "enviarBienvenidaCompra"];
before(() => NOMBRES.forEach((n) => { orig[n] = mailer[n]; }));
after(() => NOMBRES.forEach((n) => { mailer[n] = orig[n]; }));
beforeEach(async () => {
  correos = [];
  NOMBRES.forEach((n) => { mailer[n] = async (dest, datos) => { correos.push({ n, a: dest && (dest.email || dest.id), datos }); return { ok: true }; }; });
  await adminPut("pct", "10");
});

const ADMIN = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const admin = (ruta, o = {}) => api("/admin" + ruta, { ...o, h: { ...ADMIN, ...(o.h || {}) } });
const adminPut = (clave, valor) => admin("/decisiones/" + clave, { metodo: "PUT", cuerpo: { valor } });
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const webhook = (hash, pagado = true) => api("/pagos/webhook", { metodo: "POST", cuerpo: { resultado: [{ hash_pedido: hash, token: sha1("privado-de-prueba" + hash), pagado }] } });

let n = 0;
const emailUnico = (p) => `${p}${++n}-${Date.now()}@ejemplo.com`;
async function socio(nombre, extra = {}) {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: emailUnico(nombre), password: "clave-larga-123", nombre, apellido: "Prueba", ...extra } });
  const { token, socio: s } = await r.json();
  return { id: s.id, pena_id: s.pena_id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
// Una peña verificada con comisión que ya eligió contraseña; devuelve el token de sesión del panel.
async function penaLista(nombre = "Peña Olimpista Test") {
  const s = await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: nombre + " " + (++n), ciudad: "Encarnación", pais_iso: "PY", presidente: "Doña Presi", contacto: emailUnico("presi") } });
  const { id } = await s.json();
  const v = await (await admin(`/penas/${id}/verificar`, { metodo: "POST" })).json();
  const pena = await store.getPena(id);
  const correo = correos.filter((c) => c.n === "enviarPenaVerificada").pop(); // el de ESTA peña (puede haber varias en un test)
  const token = new URL(correo.datos.urlClave).searchParams.get("token");
  const c = await (await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "clave-penia-123" } })).json();
  return { id, pena, usuario: v.usuario, tokenSesion: c.token, hp: { "x-pena-token": c.token } };
}
const pedidoPago = async (socioId, monto, extra = {}) => {
  const hash = "h-" + crypto.randomBytes(5).toString("hex");
  const pedido = await store.createPedidoPago({ socioId, concepto: "Membresía Plus", monto, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: hash, ...extra });
  return { hash, pedido };
};

// ── Solicitud y verificación ─────────────────────────────────────────────────
test("solicitud: valida los datos, queda PENDIENTE y no aparece en el ranking público", async () => {
  const base = { nombre: "Peña Los Leales", ciudad: "Luque", pais_iso: "PY", presidente: "Carlos Ríos", contacto: emailUnico("leales") };
  for (const [campo, malo] of [["nombre", "ab"], ["ciudad", ""], ["presidente", "x"], ["contacto", "no-es-email"], ["pais_iso", "ZZ"]])
    assert.strictEqual((await api("/penas/solicitud", { metodo: "POST", cuerpo: { ...base, [campo]: malo } })).status, 400, campo);
  const ok = await api("/penas/solicitud", { metodo: "POST", cuerpo: base });
  assert.strictEqual(ok.status, 201);
  const { id } = await ok.json();
  assert.strictEqual((await store.getPena(id)).estado, "pendiente");
  assert.strictEqual((await api("/penas/solicitud", { metodo: "POST", cuerpo: base })).status, 409, "mismo contacto pendiente");
  const lista = await (await api("/penas")).json();
  assert.ok(!lista.items.some((p) => p.id === id));
  assert.strictEqual((await api("/penas/" + (await store.getPena(id)).slug)).status, 404);
});

test("solicitud: el texto se limpia (sin etiquetas)", async () => {
  const r = await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña <script>x</script> Limpia", ciudad: "CDE", presidente: "Ana <b>B</b>", contacto: emailUnico("limpia") } });
  const p = await store.getPena((await r.json()).id);
  assert.ok(!/[<>]/.test(p.nombre + p.presidente));
});

test("verificar: crea el acceso, manda UN correo con link de un solo uso (sin contraseña) y la peña entra al ranking", async () => {
  const p = await penaLista("Peña Verificada");
  const correo = correos.filter((c) => c.n === "enviarPenaVerificada");
  assert.strictEqual(correo.length, 1);
  assert.match(correo[0].datos.urlClave, /\/pena\?token=/);
  assert.ok(!JSON.stringify(correo[0].datos).includes("clave-penia"), "ninguna contraseña por correo");
  const lista = await (await api("/penas")).json();
  const mia = lista.items.find((x) => x.id === p.id);
  assert.ok(mia && mia.ranking >= 1);
  assert.ok(!("saldo" in mia) && !("contacto" in mia) && !("presidente" in mia), "el listado público no expone contacto ni fondo");
});

test("verificar sin correo válido: devuelve el link al admin en vez de perderlo", async () => {
  const pena = await store.crearPena({ nombre: "Peña Sin Correo " + (++n), ciudad: "Asunción", pais_iso: "PY", presidente: "Fulano", contacto: "" });
  const r = await (await admin(`/penas/${pena.id}/verificar`, { metodo: "POST" })).json();
  assert.strictEqual(r.correo_enviado, false);
  assert.match(r.url_clave, /\/pena\?token=/);
});

test("verificar y canjes exigen permisos de admin", async () => {
  const pena = await store.crearPena({ nombre: "Peña Intrusa " + (++n), ciudad: "x", pais_iso: "PY", presidente: "yo", contacto: emailUnico("i") });
  const sin = await api(`/admin/penas/${pena.id}/verificar`, { metodo: "POST" });
  assert.ok([401, 403].includes(sin.status));
  assert.strictEqual((await store.getPena(pena.id)).estado, "pendiente");
});

// ── Acceso de la comisión ────────────────────────────────────────────────────
test("clave: el link sirve una sola vez, exige 8+ caracteres y vence", async () => {
  const s = await (await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Clave " + (++n), ciudad: "Luque", presidente: "Presi", contacto: emailUnico("c") } })).json();
  await admin(`/penas/${s.id}/verificar`, { metodo: "POST" });
  const token = new URL(correos.find((c) => c.n === "enviarPenaVerificada").datos.urlClave).searchParams.get("token");
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "corta" } })).status, 400);
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token: "inventado", password: "clave-larga-123" } })).status, 400);
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "clave-larga-123" } })).status, 200);
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "otra-clave-123" } })).status, 400, "ya se usó");
  // vencido
  const u = await store.getPenaUsuarioDePena(s.id);
  await store.updatePenaUsuario(u.id, { setup_token: "vencido-tk", setup_exp: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token: "vencido-tk", password: "clave-larga-123" } })).status, 400);
});

test("login: entra con su contraseña; mal usuario o contraseña → 401 igual; peña pausada no entra", async () => {
  const p = await penaLista("Peña Login");
  assert.strictEqual((await api("/pena/login", { metodo: "POST", cuerpo: { usuario: p.usuario, password: "clave-penia-123" } })).status, 200);
  assert.strictEqual((await api("/pena/login", { metodo: "POST", cuerpo: { usuario: p.usuario, password: "mala" } })).status, 401);
  assert.strictEqual((await api("/pena/login", { metodo: "POST", cuerpo: { usuario: "no-existe", password: "clave-penia-123" } })).status, 401);
  await admin(`/penas/${p.id}/estado`, { metodo: "POST", cuerpo: { estado: "pausada" } });
  assert.strictEqual((await api("/pena/login", { metodo: "POST", cuerpo: { usuario: p.usuario, password: "clave-penia-123" } })).status, 403);
  assert.strictEqual((await api("/pena/panel", { h: p.hp })).status, 401, "pausar cierra las sesiones abiertas");
});

test("panel y fondo exigen sesión de peña", async () => {
  for (const ruta of ["/pena/panel", "/pena/fondo"]) assert.strictEqual((await api(ruta)).status, 401, ruta);
  assert.strictEqual((await api("/pena/fondo", { h: { "x-pena-token": "inventado" } })).status, 401);
  assert.strictEqual((await api("/pena/fondo/canje", { metodo: "POST", cuerpo: { item: "bus", monto: 5000 } })).status, 401);
});

test("reenviar acceso: link nuevo y se cierran las sesiones anteriores", async () => {
  const p = await penaLista("Peña Acceso");
  const r = await admin(`/penas/${p.id}/acceso`, { metodo: "POST" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await api("/pena/panel", { h: p.hp })).status, 401);
  assert.strictEqual(correos.filter((c) => c.n === "enviarPenaVerificada").length >= 2, true);
});

// ── Link de captación y pertenencia ──────────────────────────────────────────
test("registro con ?pena=slug: el hincha queda en la peña y la comisión recibe UN aviso por día", async () => {
  const p = await penaLista("Peña Captación");
  correos = [];
  const a = await socio("Ana", { pena: p.pena.slug });
  await socio("Beto", { pena: p.pena.slug });
  assert.strictEqual(a.pena_id, p.id);
  assert.strictEqual((await store.getSocioById(a.id)).pena_id, p.id);
  await new Promise((x) => setTimeout(x, 80));
  const avisos = correos.filter((c) => c.n === "enviarPenaSumoSocio");
  assert.strictEqual(avisos.length, 1, "un aviso por día aunque se sumen varios");
  assert.match(avisos[0].datos.invitado, /^Ana P\.$/, "solo nombre e inicial del apellido");
});

test("registro con un slug inválido o de una peña NO verificada: el alta sale bien y sin peña", async () => {
  const pend = await store.crearPena({ nombre: "Peña Pendiente " + (++n), ciudad: "x", pais_iso: "PY", presidente: "p", contacto: emailUnico("p") });
  for (const slug of ["no-existe", pend.slug, "<script>"]) {
    const s = await api("/auth/registro", { metodo: "POST", cuerpo: { email: emailUnico("x"), password: "clave-larga-123", nombre: "X", pena: slug } });
    assert.strictEqual(s.status, 201, slug);
    assert.ok(!(await s.json()).socio.pena_id, slug);
  }
});

test("sumarse y dejar la peña desde el perfil; una peña no verificada no se puede elegir", async () => {
  const p = await penaLista("Peña Perfil");
  const s = await socio("Cami");
  assert.strictEqual((await api("/perfil", { metodo: "PATCH", h: s.h, cuerpo: { pena_id: p.id } })).status, 200);
  assert.strictEqual((await store.getSocioById(s.id)).pena_id, p.id);
  const lista = await (await api("/penas", { h: s.h })).json();
  assert.strictEqual(lista.mia, p.id);
  assert.strictEqual(lista.items.find((x) => x.id === p.id).es_tuya, true);
  assert.strictEqual((await api("/perfil", { metodo: "PATCH", h: s.h, cuerpo: { pena_id: null } })).status, 200);
  assert.ok(!(await store.getSocioById(s.id)).pena_id);
  const pend = await store.crearPena({ nombre: "Peña Aun No " + (++n), ciudad: "x", pais_iso: "PY", presidente: "p", contacto: emailUnico("p") });
  assert.strictEqual((await api("/perfil", { metodo: "PATCH", h: s.h, cuerpo: { pena_id: pend.id } })).status, 400);
  assert.strictEqual((await api("/perfil", { metodo: "PATCH", h: s.h, cuerpo: { pena_id: "pen_inventada" } })).status, 400);
});

test("ranking: ordena por altas y numera", async () => {
  const chica = await penaLista("Peña Chica"), grande = await penaLista("Peña Grande");
  for (let i = 0; i < 3; i++) await socio("G" + i, { pena: grande.pena.slug });
  await socio("C0", { pena: chica.pena.slug });
  const lista = (await (await api("/penas")).json()).items;
  const g = lista.find((x) => x.id === grande.id), c = lista.find((x) => x.id === chica.id);
  assert.ok(g.ranking < c.ranking);
  assert.strictEqual(g.altas, 3);
  const panel = await (await api("/pena/panel", { h: grande.hp })).json();
  assert.strictEqual(panel.ranking, g.ranking);
});

// ── Panel: privacidad ────────────────────────────────────────────────────────
test("panel: KPIs, link con QR y últimas altas SIN datos personales sensibles", async () => {
  const p = await penaLista("Peña Panel");
  const a = await socio("Rocío", { pena: p.pena.slug });
  await store.updateSocio(a.id, { cedula: "1234567", whatsapp: "0981123456", ciudad: "Encarnación" });
  const d = await (await api("/pena/panel", { h: p.hp })).json();
  assert.strictEqual(d.kpis.altas, 1);
  assert.match(d.link, new RegExp("/\\?pena=" + p.pena.slug + "$"));
  assert.deepStrictEqual(Object.keys(d.ultimas_altas[0]).sort(), ["ciudad", "creado", "nivel", "nombre"]);
  assert.strictEqual(d.ultimas_altas[0].nombre, "Rocío P.");
  const txt = JSON.stringify(d);
  // El correo de contacto de la propia peña sí viaja (son sus datos, los edita la comisión); el del hincha, no.
  for (const privado of ["1234567", "0981123456", a.email, "password"]) assert.ok(!txt.includes(privado), privado);
});

// ── Fondo ────────────────────────────────────────────────────────────────────
async function hinchaConPena(p, nombre = "Hugo") { const s = await socio(nombre, { pena: p.pena.slug }); await store.setMembresia(s.id, { tierSlug: "premium", ciclo: "anio" }); return s; }
const fondo = async (p) => (await api("/pena/fondo", { h: p.hp })).json();

test("fondo: un pago de un hincha de la peña aporta el 10 % (decisión pct) y 5 webhooks acreditan UNA vez", async () => {
  const p = await penaLista("Peña Fondo");
  const h = await hinchaConPena(p);
  const { hash } = await pedidoPago(h.id, 180000);
  await Promise.all([1, 2, 3, 4, 5].map(() => webhook(hash)));
  const f = await fondo(p);
  assert.strictEqual(f.saldo, 18000);
  assert.strictEqual(f.movimientos.filter((m) => m.motivo === "ingreso").length, 1);
  assert.match(f.movimientos[0].detalle, /Hugo P\. \(10%\)/);
});

test("fondo: la decisión pct=15 cambia el aporte de los pagos siguientes", async () => {
  await adminPut("pct", "15");
  const p = await penaLista("Peña Quince");
  const h = await hinchaConPena(p);
  await webhook((await pedidoPago(h.id, 200000)).hash);
  assert.strictEqual((await fondo(p)).saldo, 30000);
});

test("fondo: aporta también con entradas y subastas, no solo con la membresía", async () => {
  const p = await penaLista("Peña Todo");
  const h = await hinchaConPena(p);
  const lote = await store.crearSubasta({ titulo: "Lote", estado: "cerrada", termina: new Date().toISOString(), precio_inicial: 100000 });
  await store.updateSubasta(lote.id, { ganador_id: h.id, adjudicado_a: h.id });
  const { hash } = await pedidoPago(h.id, 500000, { tierSlug: null, subastaId: lote.id, concepto: "Subasta: Lote" });
  await webhook(hash);
  assert.strictEqual((await fondo(p)).saldo, 50000);
});

test("fondo: no aporta si el hincha no tiene peña, si la peña está pausada, ni por un pago huérfano", async () => {
  const p = await penaLista("Peña Sin Aporte");
  const sin = await socio("Sin"); await store.setMembresia(sin.id, { tierSlug: "premium", ciclo: "anio" });
  await webhook((await pedidoPago(sin.id, 180000)).hash);
  const h = await hinchaConPena(p);
  await admin(`/penas/${p.id}/estado`, { metodo: "POST", cuerpo: { estado: "pausada" } });
  await webhook((await pedidoPago(h.id, 180000)).hash);
  const [fila] = await store.listPenas({ id: p.id });
  assert.strictEqual(fila.saldo, 0);
  // huérfano: el lote ya no es de ese hincha
  await admin(`/penas/${p.id}/estado`, { metodo: "POST", cuerpo: { estado: "verificada" } });
  const lote = await store.crearSubasta({ titulo: "Otro", estado: "cerrada", termina: new Date().toISOString(), precio_inicial: 100000 });
  const { hash } = await pedidoPago(h.id, 300000, { tierSlug: null, subastaId: lote.id, concepto: "Subasta: Otro" });
  await webhook(hash);
  assert.strictEqual((await store.listPenas({ id: p.id }))[0].saldo, 0, "un pago que se va a reembolsar no suma al fondo");
});

test("fondo: si se revierte el pago se descuenta el aporte, una sola vez", async () => {
  const p = await penaLista("Peña Reversa");
  const h = await hinchaConPena(p);
  const { hash } = await pedidoPago(h.id, 180000);
  await webhook(hash);
  assert.strictEqual((await fondo(p)).saldo, 18000);
  await Promise.all([webhook(hash, false), webhook(hash, false), webhook(hash, false)]);
  const f = await fondo(p);
  assert.strictEqual(f.saldo, 0);
  assert.strictEqual(f.movimientos[0].estado, "revertido");
});

// ── Canjes ───────────────────────────────────────────────────────────────────
async function conSaldo(monto = 100000) {
  const p = await penaLista("Peña Canje");
  const h = await hinchaConPena(p);
  await webhook((await pedidoPago(h.id, monto * 10)).hash); // 10 % = monto
  return p;
}
const pedirCanje = (p, item, monto) => api("/pena/fondo/canje", { metodo: "POST", h: p.hp, cuerpo: { item, monto } });

test("canje: queda pendiente, no se puede pedir más de lo disponible y lo pendiente reserva saldo", async () => {
  const p = await conSaldo(100000);
  assert.strictEqual((await pedirCanje(p, "ab", 5000)).status, 400, "describir qué se canjea");
  assert.strictEqual((await pedirCanje(p, "Bus al estadio", 500)).status, 400, "monto mínimo");
  const r = await pedirCanje(p, "Bus al estadio", 60000);
  assert.strictEqual(r.status, 201);
  let f = await fondo(p);
  assert.deepStrictEqual({ saldo: f.saldo, pendiente: f.pendiente, disponible: f.disponible }, { saldo: 100000, pendiente: 60000, disponible: 40000 });
  const demas = await pedirCanje(p, "Otra cosa", 50000);
  assert.strictEqual(demas.status, 409);
  assert.match((await demas.json()).error, /40\.000/);
  assert.strictEqual((await pedirCanje(p, "Entradas", 40000)).status, 201);
});

test("canje: 5 pedidos simultáneos que juntos pasan del fondo → no se cuela ninguno de más", async () => {
  const p = await conSaldo(100000);
  const res = await Promise.all(Array.from({ length: 5 }, (_, i) => pedirCanje(p, "Pedido " + i, 30000)));
  assert.strictEqual(res.filter((r) => r.status === 201).length, 3, "3 × 30.000 ≤ 100.000; el 4.º ya no entra");
});

test("canje: el club aprueba (resta del saldo) o rechaza (no cambia nada), una sola vez", async () => {
  const p = await conSaldo(100000);
  const a = (await (await pedirCanje(p, "Bus", 70000)).json()).movimiento.id;
  const b = (await (await pedirCanje(p, "Entradas", 30000)).json()).movimiento.id;
  assert.strictEqual((await admin(`/penas/canje/${a}`, { metodo: "POST", cuerpo: {} })).status, 200);
  assert.strictEqual((await store.listPenas({ id: p.id }))[0].saldo, 30000);
  assert.strictEqual((await admin(`/penas/canje/${a}`, { metodo: "POST", cuerpo: {} })).status, 409, "no se aprueba dos veces");
  assert.strictEqual((await admin(`/penas/canje/${b}`, { metodo: "POST", cuerpo: { rechazar: true } })).status, 200);
  assert.strictEqual((await store.listPenas({ id: p.id }))[0].saldo, 30000);
  assert.strictEqual((await admin(`/penas/canje/${b}`, { metodo: "POST", cuerpo: {} })).status, 409, "uno rechazado no se aprueba después");
  assert.strictEqual((await admin("/penas/canje/pmv_inventado", { metodo: "POST", cuerpo: {} })).status, 404);
  const f = await fondo(p);
  assert.deepStrictEqual(f.movimientos.filter((m) => m.motivo === "canje").map((m) => m.estado).sort(), ["aplicado", "rechazado"]);
});

test("canje: si el aporte se revierte antes de aprobar y ya no alcanza, la aprobación falla", async () => {
  const p = await penaLista("Peña Justa");
  const h = await hinchaConPena(p);
  const { hash } = await pedidoPago(h.id, 100000); await webhook(hash);               // fondo: 10.000
  const id = (await (await pedirCanje(p, "Todo", 10000)).json()).movimiento.id;
  await webhook(hash, false);                                                          // se revierte: saldo 0
  const r = await admin(`/penas/canje/${id}`, { metodo: "POST", cuerpo: {} });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await store.listPenas({ id: p.id }))[0].saldo, 0, "el saldo no queda negativo por aprobar");
});

test("admin: lista las peñas con sus números y los canjes pendientes", async () => {
  const p = await conSaldo(100000);
  await pedirCanje(p, "Bus", 20000);
  const d = await (await admin("/penas")).json();
  const fila = d.items.find((x) => x.id === p.id);
  assert.deepStrictEqual({ altas: fila.altas, plus: fila.plus, saldo: fila.saldo, canje_pendiente: fila.canje_pendiente }, { altas: 1, plus: 1, saldo: 100000, canje_pendiente: 20000 });
  assert.ok(d.canjes.some((c) => c.pena === fila.nombre && c.monto === -20000));
  assert.strictEqual(d.pct, 10);
});

// ── Ficha 360 ────────────────────────────────────────────────────────────────
test("ficha 360: muestra la peña del hincha", async () => {
  const p = await penaLista("Peña Ficha");
  const h = await socio("Ficha", { pena: p.pena.slug });
  const f = await (await admin(`/socios/${h.id}/360`)).json();
  assert.strictEqual(f.pena.nombre, p.pena.nombre);
  const sin = await socio("SinPena");
  assert.strictEqual((await (await admin(`/socios/${sin.id}/360`)).json()).pena, null);
});
