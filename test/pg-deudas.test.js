"use strict";
// Lotes ganados sin pagar (subastasPorPagar): el mismo resultado en Postgres real (TEST_DATABASE_URL) y en memory-store.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { createMemoryStore } = require("../data/memory-store");

let admin, nombreDb, pg, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_deu_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sqlMig = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
  await require("../lib/migrar").migrar(sqlMig, { log: {} });
  pg = require("../data/pg-store").createPgStore({ databaseUrl: urlDe(nombreDb) });
});
after(async () => {
  if (!BASE) return;
  try { await pg._sql.end({ timeout: 5 }); } catch (e) {}
  try { await sqlMig.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

const horas = (h) => new Date(Date.now() + h * 3600000).toISOString();
async function escenario(s) {
  const mk = (e) => s.createSocio({ email: `${crypto.randomBytes(4).toString("hex")}@ejemplo.com`, passwordHash: "x", nombre: e });
  const yo = await mk("Yo"), otro = await mk("Otro"), segundo = await mk("Segundo");
  const lote = async (titulo, ganador, extra = {}) => {
    const l = await s.crearSubasta({ titulo, precio_inicial: 100000, estado: "activa" });
    return s.updateSubasta(l.id, { estado: "cerrada", ganador_id: ganador, adjudicado_a: ganador, puja_actual: 250000, pago_vence: horas(40), pago_estado: null, ...extra });
  };
  const tarde = await lote("Tarde", yo.id, { pago_vence: horas(60) }), pronto = await lote("Pronto", yo.id, { pago_vence: horas(5) }), sinPlazo = await lote("Sin plazo", yo.id, { pago_vence: null });
  await lote("Pagado", yo.id, { pago_estado: "pagado" });
  await lote("Vencido", yo.id, { pago_vence: horas(-1) });
  await lote("Ajeno", otro.id);
  const activa = await s.crearSubasta({ titulo: "En vivo", precio_inicial: 1, estado: "activa" });
  await s.updateSubasta(activa.id, { ganador_id: yo.id });
  const ronda2 = await lote("Segunda ronda", yo.id, { adjudicado_a: segundo.id, ronda: 2 });   // lo ganó otro en la ronda 2: ya no lo debe quien lo ganó primero
  const mios = await s.subastasPorPagar(yo.id);
  assert.deepStrictEqual(mios.map((x) => x.titulo), ["Pronto", "Tarde", "Sin plazo"]);
  assert.deepStrictEqual(mios.map((x) => x.id), [pronto.id, tarde.id, sinPlazo.id]);
  assert.deepStrictEqual([mios[0].puja_actual, mios[0].ronda], [250000, 1]);
  assert.strictEqual(mios[2].pago_vence, null);
  assert.deepStrictEqual((await s.subastasPorPagar(segundo.id)).map((x) => x.id), [ronda2.id]);
  assert.deepStrictEqual((await s.subastasPorPagar(otro.id)).map((x) => x.titulo), ["Ajeno"]);
}

test("lotes por pagar · memory-store", async () => { await escenario(createMemoryStore({ filePath: null })); });
test("lotes por pagar · Postgres", opts, async () => { await escenario(pg); });
