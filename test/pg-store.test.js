"use strict";
// pg-store contra un Postgres real (TEST_DATABASE_URL). Dos cosas:
//  1) la atomicidad del cobro/entrega, que en memoria no se puede probar de verdad;
//  2) contrato: memory-store y pg-store devuelven la misma forma en lo que la app consume.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

let admin, nombreDb, pg, mem, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };

before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_pg_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sqlMig = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
  await require("../lib/migrar").migrar(sqlMig, { log: {} });
  pg = require("../data/pg-store").createPgStore({ databaseUrl: urlDe(nombreDb) });
  mem = require("../data/memory-store").createMemoryStore({ filePath: null });
});
after(async () => {
  if (!BASE) return;
  try { await pg._sql.end({ timeout: 5 }); } catch (e) {}
  try { await sqlMig.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

let n = 0;
async function pedido(store, extra = {}) {
  n++;
  const socio = await store.createSocio({ email: `pg${n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Test" });
  return store.createPedidoPago({ socioId: socio.id, concepto: "Membresía Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: "h-" + crypto.randomBytes(5).toString("hex"), ...extra });
}

test("pg: 25 reclamos simultáneos del mismo pedido → lo gana exactamente uno", opts, async () => {
  const p = await pedido(pg);
  const res = await Promise.all(Array.from({ length: 25 }, () => pg.reclamarCumplimiento(p.id)));
  assert.strictEqual(res.filter(Boolean).length, 1, "un solo ganador");
  const fila = await pg.getPedidoPago(p.id);
  assert.strictEqual(fila.estado, "pagado");
  assert.ok(fila.pagado_en && fila.cumplimiento_desde && !fila.cumplido_en);
});

test("pg: mientras alguien entrega nadie más puede; si falla y libera, otro lo retoma; al cumplirse, queda cerrado", opts, async () => {
  const p = await pedido(pg);
  assert.ok(await pg.reclamarCumplimiento(p.id));
  assert.strictEqual(await pg.reclamarCumplimiento(p.id), null, "candado tomado");
  await pg.liberarCumplimiento(p.id);
  assert.ok(await pg.reclamarCumplimiento(p.id), "liberado → se puede retomar");
  assert.ok(await pg.marcarCumplido(p.id));
  assert.strictEqual(await pg.reclamarCumplimiento(p.id), null, "ya cumplido: no se reclama más");
  assert.strictEqual(await pg.marcarCumplido(p.id), null, "cumplir dos veces no hace nada");
});

test("pg: el candado vence a los 2 minutos (entrega abandonada por una instancia caída)", opts, async () => {
  const p = await pedido(pg);
  await pg.reclamarCumplimiento(p.id);
  await pg._sql`UPDATE pedidos_pago SET cumplimiento_desde = now() - interval '3 minutes' WHERE id = ${p.id}`;
  assert.ok(await pg.reclamarCumplimiento(p.id), "con el candado vencido otro puede retomarlo");
});

test("pg: pagado → reversado ocurre una sola vez aunque lleguen 10 reversiones", opts, async () => {
  const p = await pedido(pg);
  await pg.reclamarCumplimiento(p.id);
  await pg.marcarCumplido(p.id);
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.marcarReversado(p.id)));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual((await pg.getPedidoPago(p.id)).estado, "reversado");
  const otro = await pedido(pg); // pendiente: no se puede reversar
  assert.strictEqual(await pg.marcarReversado(otro.id), null);
});

test("pg: pedidosParaConciliar separa abiertos (con hash, entre 10 min y 7 días) de pagados sin entregar", opts, async () => {
  const reciente = await pedido(pg);
  const abierto = await pedido(pg);
  const viejo = await pedido(pg);
  const sinHash = await pedido(pg, { refExterna: null });
  const sinEntregar = await pedido(pg);
  const entregado = await pedido(pg);
  await pg._sql`UPDATE pedidos_pago SET creado = now() - interval '30 minutes' WHERE id IN (${abierto.id}, ${sinHash.id})`;
  await pg._sql`UPDATE pedidos_pago SET creado = now() - interval '10 days' WHERE id = ${viejo.id}`;
  await pg._sql`UPDATE pedidos_pago SET estado='pagado', pagado_en = now() - interval '20 minutes' WHERE id = ${sinEntregar.id}`;
  await pg._sql`UPDATE pedidos_pago SET estado='pagado', pagado_en = now() - interval '20 minutes', cumplido_en = now() WHERE id = ${entregado.id}`;
  const { abiertos, sinEntregar: pend } = await pg.pedidosParaConciliar();
  const ids = (a) => a.map((x) => x.id);
  assert.ok(ids(abiertos).includes(abierto.id));
  for (const no of [reciente, viejo, sinHash, sinEntregar, entregado]) assert.ok(!ids(abiertos).includes(no.id), "no debe estar entre abiertos: " + no.id);
  assert.ok(ids(pend).includes(sinEntregar.id));
  assert.ok(!ids(pend).includes(entregado.id));
});

test("contrato pg ↔ memoria: listSubastasPublicas devuelve las mismas claves, sin la foto", opts, async () => {
  const datos = { titulo: "Camiseta firmada", descripcion: "d", imagen: "data:image/png;base64,AAAA", estado: "activa", termina: new Date(Date.now() + 3600000).toISOString(), precio_inicial: 100000 };
  const a = await pg.crearSubasta(datos);
  const b = await mem.crearSubasta(datos);
  const fa = (await pg.listSubastasPublicas()).find((s) => s.id === a.id);
  const fb = (await mem.listSubastasPublicas()).find((s) => s.id === b.id);
  assert.ok(fa && fb);
  for (const f of [fa, fb]) {
    assert.ok(!("imagen" in f), "la foto no viaja en el listado");
    assert.strictEqual(f.tiene_imagen, true);
    assert.match(f.imagen_v, /^[0-9a-f]{10}$/);
  }
  // Las claves que consume routes.js existen en ambos.
  for (const k of ["id", "slug", "titulo", "descripcion", "emoji", "nivel_min", "precio_inicial", "incremento", "puja_actual", "termina", "estado", "pago_estado", "ganador_id", "pago_vence", "adjudicado_a", "ronda"])
    assert.ok(k in fa && k in fb, "falta la clave " + k + " en " + (k in fa ? "memoria" : "pg"));
  assert.strictEqual(fa.imagen_v, fb.imagen_v, "mismo hash de contenido en ambos stores");
  const img = await pg.imagenSubasta(a.slug);
  assert.strictEqual(img.imagen, datos.imagen);
});

// ── Sprint 1: plazo de pago y segundo postor — mismo escenario en pg y en memoria ──
const HORA = 3600000;
async function escenarioSub(store, { segundo = true } = {}) {
  const mk = async (nombre) => store.createSocio({ email: `${nombre}-${crypto.randomBytes(3).toString("hex")}@ejemplo.com`, passwordHash: "x", nombre });
  const A = await mk("Ana"), B = await mk("Beto"), C = await mk("Cami");
  const sub = await store.crearSubasta({ titulo: "Lote " + crypto.randomBytes(2).toString("hex"), estado: "activa", termina: new Date(Date.now() + HORA).toISOString(), precio_inicial: 100000, incremento: 10000 });
  if (segundo) {
    await store.pujar({ subastaId: sub.id, socioId: C.id, monto: 160000 });
    await store.pujar({ subastaId: sub.id, socioId: B.id, monto: 200000 });
    await store.pujar({ subastaId: sub.id, socioId: B.id, monto: 210000 }); // su MEJOR oferta cuenta, no la primera
  }
  await store.pujar({ subastaId: sub.id, socioId: A.id, monto: 250000 });
  await store.updateSubasta(sub.id, { termina: new Date(Date.now() - 1000).toISOString() });
  return { A, B, C, sub };
}

test("pg: cerrar adjudica y pone plazo; sin ganador no hay plazo", opts, async () => {
  const { A, sub } = await escenarioSub(pg);
  const sinPujas = await pg.crearSubasta({ titulo: "Vacío", estado: "activa", termina: new Date(Date.now() - 1000).toISOString(), precio_inicial: 100000 });
  const cerradas = await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  const s = cerradas.find((x) => x.id === sub.id), v = cerradas.find((x) => x.id === sinPujas.id);
  assert.strictEqual(s.adjudicado_a, A.id);
  assert.strictEqual(s.ronda, 1);
  const h = (new Date(s.pago_vence).getTime() - Date.now()) / HORA;
  assert.ok(h > 71.9 && h <= 72, "72 h (fue " + h + ")");
  assert.strictEqual(v.pago_vence, null);
  assert.strictEqual(v.adjudicado_a, null);
});

test("pg: 15 vencimientos simultáneos del mismo lote → se resuelve exactamente una vez", opts, async () => {
  const { sub } = await escenarioSub(pg);
  await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  await pg.updateSubasta(sub.id, { pago_vence: new Date(Date.now() - 1000).toISOString() });
  const res = await Promise.all(Array.from({ length: 15 }, () => pg.vencerPlazoSubasta(sub.id)));
  assert.strictEqual(res.filter(Boolean).length, 1, "una sola transición");
  assert.strictEqual((await pg.getSubasta(sub.id)).ronda, 2, "pasó a ronda 2 una vez, no a borrador por repetirse");
});

test("contrato pg ↔ memoria: el vencimiento da el mismo resultado en los dos stores", opts, async () => {
  const resultados = [];
  for (const store of [pg, mem]) {
    const { A, B, sub } = await escenarioSub(store);
    await store.cerrarSubastasVencidas({ plazoHoras: 72 });
    // pedido abierto del primero
    const ped = await store.createPedidoPago({ socioId: A.id, concepto: "x", monto: 250000, moneda: "PYG", subastaId: sub.id, refExterna: "h-" + crypto.randomBytes(4).toString("hex") });
    assert.strictEqual(await store.vencerPlazoSubasta(sub.id), null, "antes de vencer no pasa nada");
    await store.updateSubasta(sub.id, { pago_vence: new Date(Date.now() - 1000).toISOString() });
    const r1 = await store.vencerPlazoSubasta(sub.id);
    const s1 = await store.getSubasta(sub.id);
    resultados.push({
      accion1: r1.accion, segundoEsB: r1.segundo === B.id, monto: r1.monto, ronda: s1.ronda, adjudicadoEsB: s1.adjudicado_a === B.id, ganadorEsB: s1.ganador_id === B.id,
      puja: s1.puja_actual, pedido: (await store.getPedidoPago(ped.id)).estado,
      bloqueoPrimero: !!(await store.getSocioById(A.id)).subastas_bloqueo_hasta, bloqueoSegundo: !!(await store.getSocioById(B.id)).subastas_bloqueo_hasta,
      plazo2: Math.round((new Date(s1.pago_vence).getTime() - Date.now()) / HORA),
    });
    await store.updateSubasta(sub.id, { pago_vence: new Date(Date.now() - 1000).toISOString() });
    const r2 = await store.vencerPlazoSubasta(sub.id);
    const s2 = await store.getSubasta(sub.id);
    resultados[resultados.length - 1].fin = { accion: r2.accion, estado: s2.estado, adjudicado: s2.adjudicado_a, ganador: s2.ganador_id, plazo: s2.pago_vence, puja: s2.puja_actual === s2.precio_inicial };
  }
  assert.deepStrictEqual(resultados[0], resultados[1], "pg y memoria deben comportarse igual");
  assert.strictEqual(resultados[0].monto, 210000, "el segundo adjudica a SU MEJOR oferta (210.000), no a la primera");
  assert.strictEqual(resultados[0].plazo2, 48);
});

test("pg: el segundo postor ignora pujas de un ciclo anterior (el lote se republicó)", opts, async () => {
  const { A, B, sub } = await escenarioSub(pg);
  await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  // el lote se republica: nuevo ciclo, `inicia` posterior a todas las pujas viejas
  await pg.updateSubasta(sub.id, { inicia: new Date(Date.now() + 1000).toISOString() });
  await pg.updateSubasta(sub.id, { pago_vence: new Date(Date.now() - 1000).toISOString() });
  const r = await pg.vencerPlazoSubasta(sub.id);
  assert.strictEqual(r.accion, "borrador", "las pujas viejas no cuentan como segundo postor");
  assert.ok(A.id && B.id);
});

test("pg: pagado o sin adjudicar no se vence; extender sin plazo cuenta desde ahora", opts, async () => {
  const { sub } = await escenarioSub(pg);
  await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  await pg.updateSubasta(sub.id, { pago_vence: new Date(Date.now() - 1000).toISOString() });
  await pg.marcarSubastaPagada(sub.id);
  assert.strictEqual(await pg.vencerPlazoSubasta(sub.id), null, "pagado");
  assert.strictEqual(await pg.extenderPlazoSubasta(sub.id, 24), null, "pagado no se extiende");
  const { sub: s2 } = await escenarioSub(pg);
  await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  await pg.updateSubasta(s2.id, { pago_vence: null });
  const e = await pg.extenderPlazoSubasta(s2.id, 24);
  const h = (new Date(e.pago_vence).getTime() - Date.now()) / HORA;
  assert.ok(h > 23.9 && h <= 24);
});

test("pg: plazoVencido y porVencer listan lo correcto", opts, async () => {
  const a = await escenarioSub(pg), b = await escenarioSub(pg), c = await escenarioSub(pg);
  await pg.cerrarSubastasVencidas({ plazoHoras: 72 });
  await pg.updateSubasta(a.sub.id, { pago_vence: new Date(Date.now() - HORA).toISOString() });
  await pg.updateSubasta(b.sub.id, { pago_vence: new Date(Date.now() + 10 * HORA).toISOString() });
  await pg.updateSubasta(c.sub.id, { pago_vence: new Date(Date.now() + 40 * HORA).toISOString() });
  const venc = (await pg.subastasPlazoVencido()).map((x) => x.id);
  const porV = (await pg.subastasPagoPorVencer({ horas: 24 })).map((x) => x.id);
  assert.ok(venc.includes(a.sub.id) && !venc.includes(b.sub.id) && !venc.includes(c.sub.id));
  assert.ok(porV.includes(b.sub.id) && !porV.includes(a.sub.id) && !porV.includes(c.sub.id));
});

test("pg: decisiones del club — alta y cambio (upsert)", opts, async () => {
  await pg.setDecision("plazo", "48_24", "malte");
  await pg.setDecision("plazo", "72_48", "cd");
  const d = (await pg.listDecisiones()).find((x) => x.clave === "plazo");
  assert.deepStrictEqual({ v: d.valor, por: d.decidido_por }, { v: "72_48", por: "cd" });
});
