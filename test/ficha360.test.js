"use strict";
// Sprint 1 — Billetera de Ahorro, Ficha 360, parecidos y segmentos guardados.
const PUERTO_TUTI = 29873;   // fuera del rango de puertos efímeros (32768+): en CI los servidores de prueba toman puertos de ahí y chocaban con este
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.PAGOPAR_PRIVATE_TOKEN = "privado-de-prueba";
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
beforeEach(() => tuti.__resetBloqueo());

const HORA = 3600000, DIA = 24 * HORA;
const iso = (ms) => new Date(ms).toISOString();
const ADMIN = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const admin = (ruta, o = {}) => api("/admin" + ruta, { ...o, h: { ...ADMIN, ...(o.h || {}) } });

let n = 0;
async function socio(nombre, extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `${nombre}${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre } });
  const { token, socio: s } = await r.json();
  await store.updateSocio(s.id, { cedula: String(5000000 + n * 7 + 1), pais_iso: "PY", pais: "Paraguay", ...extra });
  return { id: s.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
async function canje(socioId, ahorro, creadoMs) {
  const c = await store.registrarCanje({ beneficioId: "ben_x", socioId, comercioId: "com_x", validadoPor: "t", monto: ahorro * 5, ahorro });
  c.creado = iso(creadoMs); // memory-store devuelve la referencia: se reubica en el tiempo
  return c;
}
// Inicio del mes/año actual en hora de Paraguay (UTC-3).
const localAhora = () => new Date(Date.now() - 3 * HORA);
const inicioMesMs = () => { const L = localAhora(); return Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), 1) + 3 * HORA; };
const inicioAnioMs = () => Date.UTC(localAhora().getUTCFullYear(), 0, 1) + 3 * HORA;

// ── Billetera de Ahorro ──────────────────────────────────────────────────────
test("billetera: separa mes, año y total; un canje de último minuto del mes pasado NO cuenta en este mes", async () => {
  const s = await socio("Ahorra");
  await canje(s.id, 10000, Date.now());                         // este mes
  await canje(s.id, 5000, inicioMesMs() + 60000);                // recién empezado el mes
  await canje(s.id, 7000, inicioMesMs() - 60000);                // el último minuto del mes pasado (hora de Paraguay)
  await canje(s.id, 3000, inicioAnioMs() - 30 * DIA);            // el año pasado
  const r = await api("/beneficios/ahorro", { h: s.h });
  assert.strictEqual(r.status, 200);
  const a = await r.json();
  assert.strictEqual(a.mes, 15000, "mes");
  assert.strictEqual(a.canjes_mes, 2);
  assert.strictEqual(a.total, 25000, "total");
  const esEnero = localAhora().getUTCMonth() === 0;
  assert.strictEqual(a.anio, esEnero ? 15000 : 22000, "año calendario (el canje del año pasado no entra)");
});

test("billetera: sin canjes todo en cero; requiere sesión", async () => {
  const s = await socio("SinAhorro");
  assert.deepStrictEqual(await (await api("/beneficios/ahorro", { h: s.h })).json(), { mes: 0, anio: 0, total: 0, canjes_mes: 0 });
  assert.strictEqual((await api("/beneficios/ahorro")).status, 401);
});

test("billetera: /beneficios sigue trayendo el resumen (ahora con año)", async () => {
  const s = await socio("Resumen");
  await canje(s.id, 4000, Date.now());
  const b = await (await api("/beneficios", { h: s.h })).json();
  assert.strictEqual(b.ahorro.mes, 4000);
  assert.strictEqual(b.ahorro.anio, 4000);
});

// ── Gasto total ──────────────────────────────────────────────────────────────
const webhook = (hash, pagado = true) => api("/pagos/webhook", { metodo: "POST", cuerpo: { resultado: [{ hash_pedido: hash, token: crypto.createHash("sha1").update("privado-de-prueba" + hash).digest("hex"), pagado }] } });
async function pedidoPagable(socioId, monto = 180000) {
  const hash = "h-" + crypto.randomBytes(5).toString("hex");
  return { hash, pedido: await store.createPedidoPago({ socioId, concepto: "Membresía Plus", monto, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: hash }) };
}

test("gasto: suma UNA vez por pedido aunque lleguen 5 webhooks, y la reversión lo descuenta", async () => {
  const s = await socio("Gasta");
  const { hash } = await pedidoPagable(s.id, 180000);
  await Promise.all([1, 2, 3, 4, 5].map(() => webhook(hash)));
  assert.strictEqual((await store.getSocioById(s.id)).gasto_total, 180000);
  const otro = await pedidoPagable(s.id, 80000);
  await webhook(otro.hash);
  assert.strictEqual((await store.getSocioById(s.id)).gasto_total, 260000);
  await Promise.all([webhook(hash, false), webhook(hash, false)]);
  assert.strictEqual((await store.getSocioById(s.id)).gasto_total, 80000, "se descuenta una sola vez");
});

// ── Última actividad ─────────────────────────────────────────────────────────
test("última actividad: se actualiza si pasó más de una hora y no en cada request", async () => {
  const s = await socio("Activo");
  await store.updateSocio(s.id, { ultima_actividad: iso(Date.now() - 5 * HORA) });
  let toques = 0;
  const orig = store.tocarActividad;
  store.tocarActividad = async (id) => { toques++; return orig.call(store, id); };
  try {
    await api("/auth/yo", { h: s.h });
    await api("/auth/yo", { h: s.h });
    await api("/auth/yo", { h: s.h });
  } finally { store.tocarActividad = orig; }
  assert.strictEqual(toques, 1, "una sola escritura por hora");
  assert.ok(Date.now() - new Date((await store.getSocioById(s.id)).ultima_actividad).getTime() < 60000);
});

// ── Ficha 360 ────────────────────────────────────────────────────────────────
async function conHistoria() {
  const A = await socio("Ficha", { cedula: "4000001", ciudad: "Asunción" });  // el Tuti falso: termina en 1 = ACTIVE
  await store.setMembresia(A.id, { tierSlug: "premium", ciclo: "anio" });
  const { hash } = await pedidoPagable(A.id, 180000);
  await webhook(hash);
  await canje(A.id, 12000, Date.now() - 2 * DIA);
  const rival = await socio("Rival");
  const lote = await store.crearSubasta({ titulo: "Camiseta histórica", estado: "activa", termina: iso(Date.now() + HORA), precio_inicial: 100000, incremento: 10000 });
  await store.pujar({ subastaId: lote.id, socioId: A.id, monto: 120000 });
  await store.pujar({ subastaId: lote.id, socioId: rival.id, monto: 150000 });
  return { A, rival, lote };
}

test("360: indicadores, estado en el club (en vivo), plan guardado y línea de tiempo ordenada", async () => {
  const { A } = await conHistoria();
  const r = await admin(`/socios/${A.id}/360`);
  assert.strictEqual(r.status, 200);
  const f = await r.json();
  assert.strictEqual(f.socio.tier, "premium");
  assert.strictEqual(f.indicadores.gasto_total, 180000);
  assert.strictEqual(f.indicadores.pagos, 1);
  assert.strictEqual(f.indicadores.ahorro_mes, 12000);
  assert.strictEqual(f.indicadores.canjes, 1);
  assert.strictEqual(f.indicadores.lotes_pujados, 1);
  assert.strictEqual(f.pujas[0].resultado, "en_vivo");
  assert.deepStrictEqual({ fuente: f.estado_club.fuente, confirmado: f.estado_club.confirmado, status: f.estado_club.status, al_dia: f.estado_club.al_dia }, { fuente: "portal", confirmado: true, status: "ACTIVE", al_dia: true });
  await new Promise((x) => setTimeout(x, 50));
  assert.strictEqual((await store.getSocioById(A.id)).plan_club, "Socio Pleno", "el plan del Portal queda como copia de lectura");
  const fechas = f.eventos.map((e) => e.fecha);
  assert.deepStrictEqual(fechas, fechas.slice().sort((a, b) => String(b).localeCompare(String(a))), "lo más nuevo primero");
  for (const t of ["alta", "membresia", "pago", "canje", "puja"]) assert.ok(f.eventos.some((e) => e.tipo === t), "falta el evento " + t);
});

test("360: lo que depende de Tuti (abono) sale null, no se inventa; puntos y peña ya vienen; no se filtran datos privados", async () => {
  const { A } = await conHistoria();
  const f = await (await admin(`/socios/${A.id}/360`)).json();
  assert.deepStrictEqual({ p: f.puntos, pe: f.pena, ab: f.abono }, { p: { saldo: 0, escalon: "Inicial", movimientos: [] }, pe: null, ab: null });
  const txt = JSON.stringify(f);
  for (const prohibido of ["password_hash", "reset_token", "verif_token", "carnet_secreto"]) assert.ok(!txt.includes(prohibido), prohibido);
});

test("360: si el Portal de Socios no responde → 'sin confirmar' con lo que ya sabía Olimpistas", async () => {
  const A = await socio("Caido", { cedula: "4000007", es_socio_olimpia: true, plan_club: "Socio Pleno" }); // termina en 7: Tuti da 500
  const f = await (await admin(`/socios/${A.id}/360`)).json();
  assert.deepStrictEqual({ fuente: f.estado_club.fuente, confirmado: f.estado_club.confirmado }, { fuente: "padron", confirmado: false });
  assert.strictEqual(f.estado_club.es_socio_olimpia, true);
  assert.strictEqual(f.estado_club.plan_club, "Socio Pleno");
  assert.strictEqual(f.estado_club.status, undefined, "nunca se inventa un estado");
});

test("360: sin cédula no consulta; un lote que ganó sin pagar y la suspensión aparecen", async () => {
  const A = await socio("Moroso", { cedula: null });
  const rival = await socio("Otro");
  const lote = await store.crearSubasta({ titulo: "Lote moroso", estado: "activa", termina: iso(Date.now() + HORA), precio_inicial: 100000, incremento: 10000 });
  await store.pujar({ subastaId: lote.id, socioId: A.id, monto: 120000 });
  await store.updateSubasta(lote.id, { termina: iso(Date.now() - 1000) });
  await store.cerrarSubastasVencidas({ plazoHoras: 72 });
  await store.updateSocio(A.id, { subastas_bloqueo_hasta: iso(Date.now() + 30 * DIA) });
  const f = await (await admin(`/socios/${A.id}/360`)).json();
  assert.strictEqual(f.estado_club.motivo, "sin_cedula");
  assert.strictEqual(f.pujas[0].resultado, "gano_sin_pagar");
  assert.ok(f.suspension_subastas);
  assert.ok(f.eventos.some((e) => e.tipo === "suspension"));
  assert.ok(rival.id);
});

test("360: socio inexistente 404; sin credenciales de admin no se ve", async () => {
  assert.strictEqual((await admin("/socios/no-existe/360")).status, 404);
  const sin = await api("/admin/socios/cualquiera/360");
  assert.ok([401, 403].includes(sin.status));
});

// ── Parecidos y segmentos ────────────────────────────────────────────────────
test("parecidos por perfil: mismo país y nivel; no se cuenta a la persona misma", async () => {
  const A = await socio("PerfilA", { pais_iso: "AR", pais: "Argentina" });
  const B = await socio("PerfilB", { pais_iso: "AR", pais: "Argentina" });
  const C = await socio("PerfilC", { pais_iso: "BR", pais: "Brasil" });
  for (const s of [A, B, C]) await store.setMembresia(s.id, { tierSlug: "kids", ciclo: "anio" });
  const r = await (await admin(`/socios/${A.id}/parecidos?por=perfil`)).json();
  assert.deepStrictEqual({ por: r.por, tier: r.filtros.tier, pais: r.filtros.paisIso }, { por: "perfil", tier: "kids", pais: "AR" });
  const ids = r.muestra.map((m) => m.id);
  assert.ok(ids.includes(B.id) && !ids.includes(A.id) && !ids.includes(C.id));
  assert.strictEqual(r.total, 1);
});

test("parecidos por hábito: mismo nivel y mismo uso (canjes, pujas, gasto)", async () => {
  const A = await socio("HabA"), B = await socio("HabB"), C = await socio("HabC");
  for (const s of [A, B, C]) await store.setMembresia(s.id, { tierSlug: "premium", ciclo: "anio" });
  await canje(A.id, 1000, Date.now()); await canje(B.id, 2000, Date.now());   // A y B canjean; C no
  const r = await (await admin(`/socios/${A.id}/parecidos?por=habito`)).json();
  assert.deepStrictEqual({ canjes: r.filtros.canjes, pujas: r.filtros.pujas, gasto: r.filtros.gasto }, { canjes: true, pujas: false, gasto: false });
  const ids = r.muestra.map((m) => m.id);
  assert.ok(ids.includes(B.id));
  assert.ok(!ids.includes(C.id), "C no canjea: no es parecido");
});

test("segmentos: guardar valida y limpia filtros, lista, devuelve sus socios y se borra", async () => {
  assert.strictEqual((await admin("/segmentos", { metodo: "POST", cuerpo: { nombre: "x", filtros: { tier: "premium" } } })).status, 400, "nombre muy corto");
  assert.strictEqual((await admin("/segmentos", { metodo: "POST", cuerpo: { nombre: "Sin filtros", filtros: {} } })).status, 400);
  const S = await socio("SegS", { pais_iso: "UY", pais: "Uruguay" });
  await store.setMembresia(S.id, { tierSlug: "premium", ciclo: "anio" });
  const r = await admin("/segmentos", { metodo: "POST", cuerpo: { nombre: "Plus de Uruguay", filtros: { tier: "premium", paisIso: "uy", inventado: "x", password_hash: "y", canjes: "no-es-booleano" } } });
  assert.strictEqual(r.status, 201);
  const { segmento, total } = await r.json();
  assert.deepStrictEqual(segmento.filtros, { tier: "premium", paisIso: "UY" }, "solo filtros conocidos y bien tipados");
  assert.ok(total >= 1);
  const lista = await (await admin("/segmentos")).json();
  assert.ok(lista.items.some((x) => x.id === segmento.id));
  const socios = await (await admin(`/segmentos/${segmento.id}/socios`)).json();
  assert.ok(socios.items.some((x) => x.id === S.id));
  assert.strictEqual((await admin(`/segmentos/${segmento.id}`, { metodo: "DELETE" })).status, 200);
  assert.strictEqual((await admin(`/segmentos/${segmento.id}/socios`)).status, 404);
});

test("segmentos: guardar exige permiso de campañas; sin credenciales no entra", async () => {
  const sin = await api("/admin/segmentos", { metodo: "POST", cuerpo: { nombre: "Intruso", filtros: { tier: "premium" } } });
  assert.ok([401, 403].includes(sin.status));
});

// ── Validar socio guarda el plan ─────────────────────────────────────────────
test("validar socio: el plan del Portal queda guardado como copia de lectura", async () => {
  const A = await socio("Valida", { cedula: null });
  const r = await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "4000011" } }); // termina en 1: ACTIVE
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).validado, true);
  await new Promise((x) => setTimeout(x, 50));
  assert.strictEqual((await store.getSocioById(A.id)).plan_club, "Socio Pleno");
});
