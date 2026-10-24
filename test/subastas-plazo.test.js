"use strict";
// Sprint 1 — subastas con plazo de pago, segundo postor, suspensión y decisiones del club.
const PUERTO_TUTI = 29872;   // fuera del rango de puertos efímeros (32768+): en CI los servidores de prueba toman puertos de ahí y chocaban con este
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.PAGOPAR_PRIVATE_TOKEN = "privado-de-prueba"; // solo valida webhooks (sin público → Pagopar queda simulado)
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "mock";
process.env.TUTI_MERCHANT_KEY = "mock";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const express = require("express");

const app = require("../server");
const { getStore } = require("../data/store");
const mailer = require("../lib/email");
const tuti = require("../lib/tuti");
const store = getStore();

let srv, url, fakeTuti;
before(async () => {
  const t = express();
  t.use(require("../lib/tuti-mock").router());
  fakeTuti = await new Promise((res) => { const s = http.createServer(t).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); fakeTuti && fakeTuti.close(); });

// Espías de correo: qué se mandó, a quién y con qué datos.
let correos;
const orig = {};
const NOMBRES = ["enviarSubastaGanador", "enviarSubastaPagoPorVencer", "enviarSubastaCancelada", "enviarSubastaSegundaOportunidad"];
before(() => NOMBRES.forEach((n) => { orig[n] = mailer[n]; }));
after(() => NOMBRES.forEach((n) => { mailer[n] = orig[n]; }));
beforeEach(async () => {
  correos = [];
  NOMBRES.forEach((n) => { mailer[n] = async (socio, datos) => { correos.push({ n, a: socio.id, datos }); return { ok: true }; }; });
  await Promise.all(["plazo", "deuda"].map((c) => store.setDecision(c, c === "plazo" ? "72_48" : "no_bloquear", "test")));
  await adminPut("plazo", "72_48"); // invalida la caché de decisiones
  tuti.__resetBloqueo();
});

// ── Utilidades ───────────────────────────────────────────────────────────────
const HORA = 3600000;
const ahora = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const cron = () => fetch(url + "/api/cron/horario", { method: "POST", headers: { "x-cron-token": "secreto-de-cron-de-prueba" } }).then((r) => r.json());
const adminPut = (clave, valor) => fetch(url + "/api/admin/decisiones/" + clave, { method: "PUT", headers: { "Content-Type": "application/json", "x-admin-key": "clave-admin-de-prueba" }, body: JSON.stringify({ valor }) });
const adminPost = (ruta, body = {}) => fetch(url + "/api/admin" + ruta, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-key": "clave-admin-de-prueba" }, body: JSON.stringify(body) });
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });

let n = 0;
async function socio(nombre, cedula) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `${nombre}${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre } });
  const { token, socio: s } = await r.json();
  await store.setMembresia(s.id, { tierSlug: "premium", ciclo: "anio" });
  await store.updateSocio(s.id, { cedula: cedula || String(7000000 + n * 11 + 1) });
  return { id: s.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}

// Lote activo con pujas: A gana a 250.000; B su última oferta es 200.000; C 160.000.
async function escenario({ segundo = true } = {}) {
  const A = await socio("Ana"), B = await socio("Beto"), C = await socio("Cami");
  const sub = await store.crearSubasta({ titulo: "Camiseta firmada " + n, estado: "activa", termina: iso(ahora() + HORA), precio_inicial: 100000, incremento: 10000 });
  if (segundo) {
    await store.pujar({ subastaId: sub.id, socioId: C.id, monto: 160000 });
    await store.pujar({ subastaId: sub.id, socioId: B.id, monto: 200000 });
  }
  await store.pujar({ subastaId: sub.id, socioId: A.id, monto: 250000 });
  return { A, B, C, sub };
}
const cerrar = async (sub) => { await store.updateSubasta(sub.id, { termina: iso(ahora() - 1000) }); await cron(); return store.getSubasta(sub.id); };
const vencerPlazo = async (sub) => { await store.updateSubasta(sub.id, { pago_vence: iso(ahora() - 1000) }); return cron(); };

// ── Cierre ───────────────────────────────────────────────────────────────────
test("al cerrar: queda adjudicado al líder con 72 h para pagar, y el correo lo dice", async () => {
  const { A, sub } = await escenario();
  const s = await cerrar(sub);
  assert.strictEqual(s.estado, "cerrada");
  assert.strictEqual(s.adjudicado_a, A.id);
  assert.strictEqual(s.ronda, 1);
  const horas = (new Date(s.pago_vence).getTime() - ahora()) / HORA;
  assert.ok(horas > 71.9 && horas <= 72, "pago_vence ≈ ahora + 72 h (fue " + horas.toFixed(2) + " h)");
  const c = correos.filter((x) => x.n === "enviarSubastaGanador");
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].a, A.id);
  assert.strictEqual(c[0].datos.horas, 72);
});

test("decisión plazo=48_24: el cierre da 48 h (y vuelve a 72 al restituirla)", async () => {
  assert.strictEqual((await adminPut("plazo", "48_24")).status, 200);
  const { sub } = await escenario();
  const s = await cerrar(sub);
  const horas = (new Date(s.pago_vence).getTime() - ahora()) / HORA;
  assert.ok(horas > 47.9 && horas <= 48, "48 h (fue " + horas.toFixed(2) + ")");
});

test("un lote sin pujas cierra sin plazo ni adjudicado", async () => {
  const sub = await store.crearSubasta({ titulo: "Sin pujas", estado: "activa", termina: iso(ahora() + HORA), precio_inicial: 100000 });
  const s = await cerrar(sub);
  assert.strictEqual(s.estado, "cerrada");
  assert.ok(!s.pago_vence && !s.adjudicado_a);
});

// ── Pagar ────────────────────────────────────────────────────────────────────
test("pagar: solo el adjudicado y solo antes del vencimiento", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  assert.strictEqual((await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: B.h })).status, 403, "otro postor no puede pagar");
  assert.strictEqual((await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: A.h })).status, 200, "el adjudicado sí");
  await store.updateSubasta(sub.id, { pago_vence: iso(ahora() - 1000) });
  const tarde = await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: A.h });
  assert.strictEqual(tarde.status, 409);
  assert.match((await tarde.json()).error, /plazo de pago/);
});

test("el adjudicado ve su plazo en el listado; los demás no ven nada", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  const buscar = async (h) => (await (await api("/subastas", { h })).json()).items.find((i) => i.id === sub.id);
  const mio = await buscar(A.h), ajeno = await buscar(B.h), anon = await buscar({});
  assert.ok(mio.pago_vence && mio.gano === true);
  assert.strictEqual(ajeno.pago_vence, null);
  assert.strictEqual(ajeno.gano, false);
  assert.strictEqual(anon.pago_vence, null);
});

// ── Vencimiento y segundo postor ─────────────────────────────────────────────
test("vence la ronda 1: suspende al que no pagó 90 días, cancela su pedido y adjudica al segundo a SU última oferta", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: A.h }); // deja un pedido pendiente
  correos = [];
  const out = await vencerPlazo(sub);
  assert.deepStrictEqual({ v: out.subastas.vencidos, r2: out.subastas.ronda2 }, { v: 1, r2: 1 });

  const s = await store.getSubasta(sub.id);
  assert.strictEqual(s.ronda, 2);
  assert.strictEqual(s.adjudicado_a, B.id);
  assert.strictEqual(s.ganador_id, B.id, "el ganador visible pasa a ser el segundo");
  assert.strictEqual(s.puja_actual, 200000, "el precio es la última oferta del segundo, no la del primero");
  const horas = (new Date(s.pago_vence).getTime() - ahora()) / HORA;
  assert.ok(horas > 47.9 && horas <= 48, "ronda 2: 48 h");

  const dias = (new Date((await store.getSocioById(A.id)).subastas_bloqueo_hasta).getTime() - ahora()) / (24 * HORA);
  assert.ok(dias > 89.9 && dias <= 90, "suspendido 90 días");
  assert.strictEqual((await store.getSocioById(B.id)).subastas_bloqueo_hasta || null, null, "el segundo no queda suspendido");
  assert.strictEqual((await store.getPedidoPorSubasta(sub.id)).estado, "cancelado", "el pedido abierto del primero se cancela");

  assert.deepStrictEqual(correos.map((c) => [c.n, c.a]).sort(), [["enviarSubastaCancelada", A.id], ["enviarSubastaSegundaOportunidad", B.id]].sort());
  assert.strictEqual(correos.find((c) => c.n === "enviarSubastaSegundaOportunidad").datos.monto, 200000);
});

test("el suspendido no puede pujar y el mensaje dice hasta cuándo", async () => {
  const { A, sub } = await escenario();
  await cerrar(sub);
  await vencerPlazo(sub);
  const otro = await store.crearSubasta({ titulo: "Otro lote", estado: "activa", termina: iso(ahora() + HORA), precio_inicial: 100000, incremento: 10000 });
  const r = await api(`/subastas/${otro.id}/pujar`, { metodo: "POST", h: A.h, cuerpo: { monto: 120000 } });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /suspendido de las subastas hasta el/);
});

test("el primero ya no puede pagar y el segundo sí, al precio de su oferta", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  await vencerPlazo(sub);
  assert.strictEqual((await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: A.h })).status, 403);
  assert.strictEqual((await api(`/subastas/${sub.id}/pagar`, { metodo: "POST", h: B.h })).status, 200);
  const ped = await store.getPedidoPorSubasta(sub.id);
  assert.strictEqual(ped.socio_id, B.id);
  assert.strictEqual(ped.monto, 200000);
});

test("vence la ronda 2: el lote vuelve a borrador y el segundo NO queda suspendido", async () => {
  const { B, sub } = await escenario();
  await cerrar(sub);
  await vencerPlazo(sub);            // ronda 1 → 2
  correos = [];
  await vencerPlazo(sub);            // ronda 2 → borrador
  const s = await store.getSubasta(sub.id);
  assert.strictEqual(s.estado, "borrador");
  assert.ok(!s.adjudicado_a && !s.ganador_id && !s.pago_vence && !s.termina);
  assert.strictEqual(s.puja_actual, s.precio_inicial);
  assert.strictEqual((await store.getSocioById(B.id)).subastas_bloqueo_hasta || null, null);
  assert.deepStrictEqual(correos.map((c) => [c.n, c.a]), [["enviarSubastaCancelada", B.id]]);
});

test("sin otro postor elegible: el lote vuelve a borrador directo", async () => {
  const { A, sub } = await escenario({ segundo: false });
  await cerrar(sub);
  await vencerPlazo(sub);
  const s = await store.getSubasta(sub.id);
  assert.strictEqual(s.estado, "borrador");
  assert.ok((await store.getSocioById(A.id)).subastas_bloqueo_hasta, "igual se suspende al que no pagó");
});

test("un segundo postor suspendido se saltea: pasa al siguiente", async () => {
  const { B, C, sub } = await escenario();
  await store.updateSocio(B.id, { subastas_bloqueo_hasta: iso(ahora() + 30 * 24 * HORA) });
  await cerrar(sub);
  await vencerPlazo(sub);
  const s = await store.getSubasta(sub.id);
  assert.strictEqual(s.adjudicado_a, C.id);
  assert.strictEqual(s.puja_actual, 160000);
});

test("idempotente: el cron repetido o simultáneo resuelve el vencimiento UNA vez", async () => {
  const { sub } = await escenario();
  await cerrar(sub);
  await store.updateSubasta(sub.id, { pago_vence: iso(ahora() - 1000) });
  correos = [];
  const salidas = await Promise.all([cron(), cron(), cron(), cron(), cron()]);
  assert.strictEqual(salidas.reduce((a, o) => a + o.subastas.vencidos, 0), 1);
  assert.strictEqual(correos.filter((c) => c.n === "enviarSubastaSegundaOportunidad").length, 1);
  assert.strictEqual((await store.getSubasta(sub.id)).ronda, 2, "no saltó a borrador por repetirse");
});

test("lotes anteriores a la función (sin pago_vence) NO se vencen ni suspenden a nadie", async () => {
  const { A, sub } = await escenario();
  await cerrar(sub);
  await store.updateSubasta(sub.id, { pago_vence: null }); // como los lotes ya cerrados antes de la migración
  const out = await cron();
  assert.strictEqual(out.subastas.vencidos, 0);
  assert.strictEqual((await store.getSubasta(sub.id)).ronda, 1);
  assert.strictEqual((await store.getSocioById(A.id)).subastas_bloqueo_hasta || null, null);
});

test("un lote ya pagado no se vence aunque pase la fecha", async () => {
  const { sub } = await escenario();
  await cerrar(sub);
  await store.marcarSubastaPagada(sub.id);
  await store.updateSubasta(sub.id, { pago_vence: iso(ahora() - 1000) });
  assert.strictEqual((await cron()).subastas.vencidos, 0);
});

// ── Recordatorio de 24 h ─────────────────────────────────────────────────────
test("recordatorio: un solo aviso a las 24 h del vencimiento, aunque el cron corra cada hora", async () => {
  const { A, sub } = await escenario();
  await cerrar(sub);
  correos = [];
  await store.updateSubasta(sub.id, { pago_vence: iso(ahora() + 20 * HORA) });
  await cron(); await cron(); await cron();
  const avisos = correos.filter((c) => c.n === "enviarSubastaPagoPorVencer");
  assert.strictEqual(avisos.length, 1);
  assert.strictEqual(avisos[0].a, A.id);
  assert.strictEqual(avisos[0].datos.monto, 250000);
});

test("recordatorio: no avisa si falta más de 24 h", async () => {
  const { sub } = await escenario();
  await cerrar(sub);
  correos = [];
  await cron();
  assert.strictEqual(correos.filter((c) => c.n === "enviarSubastaPagoPorVencer").length, 0);
});

// ── Admin ────────────────────────────────────────────────────────────────────
test("admin: extender suma horas al plazo vigente; si ya venció, cuenta desde ahora", async () => {
  const { sub } = await escenario();
  const antes = new Date((await cerrar(sub)).pago_vence).getTime();
  const r = await adminPost(`/subastas/${sub.id}/extender`, { horas: 24 });
  assert.strictEqual(r.status, 200);
  assert.ok(Math.abs(new Date((await store.getSubasta(sub.id)).pago_vence).getTime() - (antes + 24 * HORA)) < 5000);
  await store.updateSubasta(sub.id, { pago_vence: iso(ahora() - 5 * HORA) });
  await adminPost(`/subastas/${sub.id}/extender`, { horas: 24 });
  const desdeAhora = (new Date((await store.getSubasta(sub.id)).pago_vence).getTime() - ahora()) / HORA;
  assert.ok(desdeAhora > 23.9 && desdeAhora <= 24, "cuenta desde ahora (fue " + desdeAhora.toFixed(2) + ")");
  assert.strictEqual((await adminPost(`/subastas/${sub.id}/extender`, { horas: 500 })).status, 400);
});

test("admin: extender el plazo de un lote antiguo (sin plazo) le da uno desde ahora", async () => {
  const { sub } = await escenario();
  await cerrar(sub);
  await store.updateSubasta(sub.id, { pago_vence: null });
  assert.strictEqual((await adminPost(`/subastas/${sub.id}/extender`, { horas: 48 })).status, 200);
  assert.ok((await store.getSubasta(sub.id)).pago_vence);
});

test("admin: 'pasar al segundo ahora' funciona una vez; en ronda 2 responde 409", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  const r = await adminPost(`/subastas/${sub.id}/segundo`);
  assert.strictEqual(r.status, 200);
  const cuerpo = await r.json();
  assert.strictEqual(cuerpo.accion, "ronda2");
  assert.strictEqual(cuerpo.segundo, B.id);
  assert.ok((await store.getSocioById(A.id)).subastas_bloqueo_hasta, "también suspende al primero");
  assert.strictEqual((await adminPost(`/subastas/${sub.id}/segundo`)).status, 409);
});

test("admin: extender y segundo exigen permiso; sin credenciales, 401", async () => {
  const { sub } = await escenario();
  await cerrar(sub);
  const sin = await fetch(url + `/api/admin/subastas/${sub.id}/segundo`, { method: "POST" });
  assert.ok([401, 403].includes(sin.status));
  const sin2 = await fetch(url + `/api/admin/decisiones/plazo`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ valor: "48_24" }) });
  assert.ok([401, 403].includes(sin2.status));
});

test("decisiones: se listan con su valor, rechazan opciones inválidas y quedan registradas", async () => {
  const lista = await (await fetch(url + "/api/admin/decisiones", { headers: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  assert.deepStrictEqual(lista.items.map((i) => i.clave).sort(), ["base", "deuda", "oro", "pct", "plazo", "venc"]);
  assert.strictEqual(lista.items.find((i) => i.clave === "deuda").defecto, "no_bloquear");
  assert.strictEqual((await adminPut("plazo", "5_5")).status, 400);
  assert.strictEqual((await adminPut("inexistente", "x")).status, 404);
  assert.strictEqual((await adminPut("plazo", "48_24")).status, 200);
  const otra = await (await fetch(url + "/api/admin/decisiones", { headers: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  const p = otra.items.find((i) => i.clave === "plazo");
  assert.strictEqual(p.valor, "48_24");
  assert.strictEqual(p.decidido, true);
});

// ── Deuda (decisión del club) ────────────────────────────────────────────────
async function pujaDe(socioX) {
  const lote = await store.crearSubasta({ titulo: "Lote deuda " + (++n), estado: "activa", termina: iso(ahora() + HORA), precio_inicial: 100000, incremento: 10000 });
  return api(`/subastas/${lote.id}/pujar`, { metodo: "POST", h: socioX.h, cuerpo: { monto: 120000 } });
}

test("deuda=no_bloquear (por defecto): un socio con pago pendiente en Tuti PUEDE pujar", async () => {
  const conDeuda = await socio("Debe", "4000003"); // el Tuti falso: termina en 3 = DEBT, debtor, ₲ 180.000
  assert.strictEqual((await pujaDe(conDeuda)).status, 200);
});

test("deuda=cualquier: bloquea al que debe; no al que está al día ni cuando Tuti falla", async () => {
  await adminPut("deuda", "cualquier");
  assert.strictEqual((await pujaDe(await socio("Debe", "4000003"))).status, 403);
  assert.strictEqual((await pujaDe(await socio("AlDia", "4000001"))).status, 200);
  assert.strictEqual((await pujaDe(await socio("TutiCaido", "4000007"))).status, 200, "si Tuti no responde se deja pujar");
  assert.strictEqual((await pujaDe(await socio("NoEsSocio", "4000000"))).status, 200, "404 de Tuti: no concluyente, se deja pujar");
});

test("deuda=mas_2_cuotas: bloquea solo si la deuda supera 2 veces la cuota configurada", async () => {
  await adminPut("deuda", "mas_2_cuotas");
  process.env.CUOTA_SOCIO_GS = "50000";   // deuda 180.000 > 100.000
  try { assert.strictEqual((await pujaDe(await socio("Debe2", "4000003"))).status, 403); }
  finally { process.env.CUOTA_SOCIO_GS = "100000"; }   // 180.000 <= 200.000
  try { assert.strictEqual((await pujaDe(await socio("Debe3", "4000003"))).status, 200); }
  finally { delete process.env.CUOTA_SOCIO_GS; }
  assert.strictEqual((await pujaDe(await socio("Debe4", "4000003"))).status, 200, "sin CUOTA_SOCIO_GS no se bloquea a nadie");
});

// ── Pago de un pedido que ya no corresponde ──────────────────────────────────
test("si llega el pago del primero DESPUÉS de perder el lote: no se marca pagado y queda avisado para reembolsar", async () => {
  const { A, B, sub } = await escenario();
  await cerrar(sub);
  const hash = "hash-" + crypto.randomBytes(5).toString("hex");
  const pedido = await store.createPedidoPago({ socioId: A.id, concepto: "Subasta: lote", monto: 250000, moneda: "PYG", subastaId: sub.id, refExterna: hash });
  await vencerPlazo(sub); // el lote pasa a B y el pedido de A se cancela
  assert.strictEqual((await store.getPedidoPago(pedido.id)).estado, "cancelado");

  const token = crypto.createHash("sha1").update("privado-de-prueba" + hash).digest("hex");
  const r = await fetch(url + "/api/pagos/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resultado: [{ hash_pedido: hash, token, pagado: true }] }) });
  assert.strictEqual(r.status, 200, "se responde 200 para que Pagopar no reintente");
  const s = await store.getSubasta(sub.id);
  assert.notStrictEqual(s.pago_estado, "pagado", "el lote NO queda pagado: es de otra persona");
  assert.strictEqual(s.adjudicado_a, B.id);
  assert.ok((await store.getPedidoPago(pedido.id)).cumplido_en, "el pedido queda cerrado (no se reintenta)");
});
