"use strict";
// Motor de puntos contra Postgres real (TEST_DATABASE_URL): los puntos son un libro contable, así que la
// atomicidad se prueba de verdad, y el mismo escenario corre en memory-store para que los dos se comporten igual.
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
  nombreDb = "t_pts_" + crypto.randomBytes(4).toString("hex");
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

const tag = () => crypto.randomBytes(3).toString("hex");
const mkSocio = (store, extra) => store.createSocio({ email: `s-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Hincha", ...extra });
const dar = (store, socioId, puntos, ref) => store.sumarPuntos({ socioId, motivo: "test", refId: ref || tag(), puntos, detalle: "test" });
const premio = (store, extra) => store.crearPremio({ titulo: "Premio " + tag(), costo: 400, ...extra });

test("0006: tablas, reglas sembradas con los valores del paquete y restricciones", opts, async () => {
  const t = (await pg._sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('puntos_reglas','puntos_movimientos','premios','canjes_premio','misiones','mision_respuestas')`).length;
  assert.strictEqual(t, 6);
  const reglas = Object.fromEntries((await pg.listReglas()).map((r) => [r.clave, r.puntos]));
  assert.deepStrictEqual(reglas, { cuota: 100, debito: 500, estadio: 150, liberar: 200, mision: 50, mision_temporada: 300, pago_rapido: 50, perfil: 100, referido: 300 });
  await assert.rejects(() => pg._sql`INSERT INTO premios (id, titulo, costo) VALUES ('x', 'x', 0)`, "costo > 0");
  await assert.rejects(() => pg._sql`INSERT INTO premios (id, titulo, costo, stock) VALUES ('y', 'y', 5, -1)`, "stock >= 0");
});

test("pg: 25 sumas simultáneas del mismo hecho → suma UNA vez (clave única socio+regla+ref)", opts, async () => {
  const s = await mkSocio(pg);
  const res = await Promise.all(Array.from({ length: 25 }, () => pg.sumarPuntos({ socioId: s.id, motivo: "referido", refId: "invitado-1", puntos: 300, detalle: "x" })));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual(await pg.saldoPuntos(s.id), 300);
  assert.ok(await pg.sumarPuntos({ socioId: s.id, motivo: "referido", refId: "invitado-2", puntos: 300 }), "otro hecho sí suma");
  assert.strictEqual(await pg.saldoPuntos(s.id), 600);
});

test("pg: 8 canjes simultáneos con saldo para uno solo → entra exactamente uno y el saldo queda bien", opts, async () => {
  const s = await mkSocio(pg), p = await premio(pg, { costo: 400 });
  await dar(pg, s.id, 500);
  const res = await Promise.all(Array.from({ length: 8 }, () => pg.canjearPremio({ socioId: s.id, premioId: p.id })));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
  assert.strictEqual(await pg.saldoPuntos(s.id), 100);
  assert.strictEqual(res.filter((r) => !r.ok && r.motivo === "saldo").length, 7);
  assert.strictEqual((await pg.listCanjesPremio({ socioId: s.id })).length, 1);
});

test("pg: stock 2 y 6 hinchas con saldo → se entregan 2, el stock llega a 0 y a los demás no se les cobra", opts, async () => {
  const p = await premio(pg, { costo: 100, stock: 2 });
  const hs = [];
  for (let i = 0; i < 6; i++) { const s = await mkSocio(pg); await dar(pg, s.id, 150); hs.push(s); }
  const res = await Promise.all(hs.map((s) => pg.canjearPremio({ socioId: s.id, premioId: p.id })));
  assert.strictEqual(res.filter((r) => r.ok).length, 2);
  assert.strictEqual(res.filter((r) => r.motivo === "stock").length, 4);
  assert.strictEqual((await pg.getPremio(p.id)).stock, 0);
  const saldos = await Promise.all(hs.map((s) => pg.saldoPuntos(s.id)));
  assert.deepStrictEqual(saldos.slice().sort((x, y) => x - y), [50, 50, 150, 150, 150, 150]);
});

test("pg: un premio sin tope (stock NULL) no se agota; el que está oculto no se puede canjear", opts, async () => {
  const s = await mkSocio(pg); await dar(pg, s.id, 1000);
  const libre = await premio(pg, { costo: 100 });
  assert.strictEqual(libre.stock, null);
  for (let i = 0; i < 3; i++) assert.ok((await pg.canjearPremio({ socioId: s.id, premioId: libre.id })).ok);
  assert.strictEqual((await pg.getPremio(libre.id)).stock, null);
  const oculto = await premio(pg, { costo: 10, activo: false });
  assert.strictEqual((await pg.canjearPremio({ socioId: s.id, premioId: oculto.id })).motivo, "no_existe");
});

test("pg: cancelar 6 veces a la vez el mismo canje → reintegra los puntos y el stock UNA vez", opts, async () => {
  const s = await mkSocio(pg), p = await premio(pg, { costo: 300, stock: 4 });
  await dar(pg, s.id, 1000);
  const c = (await pg.canjearPremio({ socioId: s.id, premioId: p.id })).canje;
  assert.strictEqual(await pg.saldoPuntos(s.id), 700);
  const res = await Promise.all(Array.from({ length: 6 }, () => pg.resolverCanjePremio(c.id, { estado: "cancelado" })));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
  assert.strictEqual(await pg.saldoPuntos(s.id), 1000);
  assert.strictEqual((await pg.getPremio(p.id)).stock, 4);
  assert.strictEqual((await pg.resolverCanjePremio(c.id, { estado: "entregado" })).motivo, "ya_resuelto");
});

test("pg: vencer los puntos es una sola vez por ciclo aunque lo corran 10 a la vez, y los movimientos de 0 no se muestran", opts, async () => {
  const s = await mkSocio(pg);
  await dar(pg, s.id, 800);
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.vencerPuntosSocio(s.id, "inact:2025-01-01")));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual(await pg.saldoPuntos(s.id), 0);
  assert.strictEqual(await pg.vencerPuntosSocio(s.id, "inact:2025-06-01"), null, "sin saldo no hay nada que vencer");
  await pg.sumarPuntos({ socioId: s.id, motivo: "cuota", refId: "2026-10", puntos: 0, detalle: "marca" });
  assert.ok(!(await pg.movimientosPuntos(s.id)).some((m) => m.puntos === 0));
});

test("pg: una sola respuesta por socio y misión (10 simultáneas), una misión por semana", opts, async () => {
  const s = await mkSocio(pg), m = await pg.crearMision({ semana: "2026-W43", pregunta: "¿Pregunta?", opciones: ["a", "b", "c"], correcta: 1 });
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.responderMision({ misionId: m.id, socioId: s.id, opcion: 1, correcta: true })));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.deepStrictEqual((await pg.getMisionDeSemana("2026-W43")).opciones, ["a", "b", "c"]);
  await assert.rejects(() => pg.crearMision({ semana: "2026-W43", pregunta: "otra", opciones: ["x", "y"], correcta: 0 }), (e) => e.code === "23505");
  await pg.updateMision(m.id, { activa: false });
  assert.strictEqual(await pg.getMisionDeSemana("2026-W43"), null, "una misión inactiva no se ofrece");
});

test("pg: puntosInactivos y sociosParaCuota devuelven lo correcto", opts, async () => {
  const viejo = await mkSocio(pg), reciente = await mkSocio(pg), sinSaldo = await mkSocio(pg);
  await dar(pg, viejo.id, 100); await dar(pg, reciente.id, 100);
  await pg._sql`UPDATE socios SET ultima_actividad = now() - interval '13 months' WHERE id IN (${viejo.id}, ${sinSaldo.id})`;
  const ids = (await pg.puntosInactivos({ desde: "1970-01-01T00:00:00Z", hasta: new Date(Date.now() - 365 * 86400000).toISOString() })).map((x) => x.id);
  assert.ok(ids.includes(viejo.id) && !ids.includes(reciente.id) && !ids.includes(sinSaldo.id));
  const c1 = await mkSocio(pg), c2 = await mkSocio(pg);
  await pg.updateSocio(c1.id, { es_socio_olimpia: true, cedula: "9" + Math.floor(Math.random() * 1e6) });
  await pg.updateSocio(c2.id, { es_socio_olimpia: true, cedula: "8" + Math.floor(Math.random() * 1e6) });
  let cand = (await pg.sociosParaCuota({ mes: "2026-10", limit: 500 })).map((x) => x.id);
  assert.ok(cand.includes(c1.id) && cand.includes(c2.id));
  await pg.sumarPuntos({ socioId: c1.id, motivo: "cuota", refId: "2026-10", puntos: 0, detalle: "marca" });
  cand = (await pg.sociosParaCuota({ mes: "2026-10", limit: 500 })).map((x) => x.id);
  assert.ok(!cand.includes(c1.id) && cand.includes(c2.id), "el revisado no vuelve a salir este mes");
  assert.ok((await pg.sociosParaCuota({ mes: "2026-11", limit: 500 })).some((x) => x.id === c1.id), "pero sí el mes siguiente");
});

test("pg: resumenPuntos suma solo los saldos positivos", opts, async () => {
  const a0 = await pg.resumenPuntos();
  const a = await mkSocio(pg), b = await mkSocio(pg);
  await dar(pg, a.id, 700); await dar(pg, b.id, 300); await dar(pg, b.id, -300);
  const a1 = await pg.resumenPuntos();
  assert.strictEqual(a1.pasivo - a0.pasivo, 700);
  assert.strictEqual(a1.socios_con_saldo - a0.socios_con_saldo, 1);
});

test("contrato pg ↔ memoria: mismo flujo de puntos, canje y cancelación", opts, async () => {
  const salidas = [];
  for (const store of [pg, mem]) {
    const s = await mkSocio(store), p = await premio(store, { costo: 300, stock: 2 });
    const log = [];
    log.push(!!(await dar(store, s.id, 500, "a")), !!(await dar(store, s.id, 500, "a")));           // repetido
    log.push(await store.saldoPuntos(s.id));
    const c1 = await store.canjearPremio({ socioId: s.id, premioId: p.id });
    const c2 = await store.canjearPremio({ socioId: s.id, premioId: p.id });                         // no alcanza
    log.push(c1.ok, c1.saldo, c2.ok, c2.motivo, (await store.getPremio(p.id)).stock);
    log.push((await store.resolverCanjePremio(c1.canje.id, { estado: "cancelado" })).ok, await store.saldoPuntos(s.id), (await store.getPremio(p.id)).stock);
    log.push((await store.resolverCanjePremio(c1.canje.id, { estado: "entregado" })).motivo);
    log.push((await store.movimientosPuntos(s.id)).map((m) => m.motivo + ":" + m.puntos).sort().join("|"));
    log.push((await store.listCanjesPremio({ socioId: s.id })).map((c) => c.estado + ":" + c.premio.length).join("|"));
    salidas.push(log);
  }
  assert.deepStrictEqual(salidas[0], salidas[1]);
  assert.deepStrictEqual(salidas[0].slice(0, 9), [true, false, 500, true, 200, false, "saldo", 1, true]);
});
