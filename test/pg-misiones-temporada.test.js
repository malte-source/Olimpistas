"use strict";
// Misiones de temporada (G3): alta, vigencia, progreso por métrica y puntos ya otorgados, con el mismo resultado en Postgres real (TEST_DATABASE_URL) y en memory-store.
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
  nombreDb = "t_mst_" + crypto.randomBytes(4).toString("hex");
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

const dia = (d) => new Date(Date.now() - 3 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
async function escenario(s) {
  const mk = (e) => s.createSocio({ email: `${crypto.randomBytes(4).toString("hex")}@ejemplo.com`, passwordHash: "x", nombre: e });
  const yo = await mk("Yo"), otro = await mk("Otro");
  // alta, vigencia y pausa
  const vig = await s.crearMisionTemporada({ titulo: "Vigente", descripcion: "d", metrica: "canjes", meta: 2, desde: dia(-1), hasta: dia(5), puntos: 300 });
  const fut = await s.crearMisionTemporada({ titulo: "Futura", metrica: "canjes", meta: 1, desde: dia(3), hasta: dia(9), puntos: 100 });
  const ven = await s.crearMisionTemporada({ titulo: "Vencida", metrica: "canjes", meta: 1, desde: dia(-9), hasta: dia(-2), puntos: 100 });
  const hoyM = await s.crearMisionTemporada({ titulo: "Termina hoy", metrica: "pujas", meta: 1, desde: dia(-3), hasta: dia(0), puntos: 100 });
  const ids = (await s.listMisionesTemporada({ vigentesEn: dia(0) })).map((m) => m.id);
  assert.ok(ids.includes(vig.id) && ids.includes(hoyM.id) && !ids.includes(fut.id) && !ids.includes(ven.id));
  assert.strictEqual((await s.listMisionesTemporada()).length >= 4, true);
  assert.strictEqual((await s.updateMisionTemporada(vig.id, { activa: false })).activa, false);
  assert.ok(!(await s.listMisionesTemporada({ vigentesEn: dia(0) })).some((m) => m.id === vig.id), "pausada: no se ve");
  assert.strictEqual(await s.updateMisionTemporada("mst_inexistente", { activa: true }), null);
  // progreso por métrica dentro de la ventana
  const ini = iso(-1), fin = iso(1);
  const com = (rubro) => s.crearComercio({ nombre: "C" + crypto.randomBytes(2).toString("hex"), rubro, ciudad: "Asunción" });
  const [c1, c2, c3] = [await com("Gastronomía"), await com(" gastronomía "), await com("Salud")];
  const canje = async (socioId, c) => { const b = await s.crearBeneficio({ comercio_id: c.id, titulo: "10 %", valor: "10%", niveles: "todos" }); return s.registrarCanje({ beneficioId: b.id, socioId, comercioId: c.id, validadoPor: "t", monto: 1, ahorro: 1 }); };
  for (const c of [c1, c2]) await canje(yo.id, c);
  await canje(otro.id, c3);
  const lote = await s.crearSubasta({ titulo: "L", precio_inicial: 100000, incremento: 10000, estado: "activa", termina: iso(1) });
  await s.pujar({ subastaId: lote.id, socioId: yo.id, monto: 110000 }); await s.pujar({ subastaId: lote.id, socioId: yo.id, monto: 120000 });
  const ref = await mk("Referido"); await s.updateSocio(ref.id, { referido_por: yo.id });
  const prog = (metrica, socioId = yo.id, a = ini, b = fin) => s.progresoMisionTemporada({ socioId, metrica, ini: a, fin: b });
  assert.deepStrictEqual([await prog("canjes"), await prog("rubros"), await prog("pujas"), await prog("referidos"), await prog("inventada")], [2, 1, 1, 1, 0]);
  assert.deepStrictEqual([await prog("canjes", otro.id), await prog("rubros", otro.id)], [1, 1]);
  assert.deepStrictEqual([await prog("canjes", yo.id, iso(-30), iso(-20)), await prog("pujas", yo.id, iso(-30), iso(-20)), await prog("referidos", yo.id, iso(-30), iso(-20))], [0, 0, 0], "fuera del período no cuenta");
  // puntos ya otorgados: por motivo y persona
  await s.sumarPuntos({ socioId: yo.id, motivo: "mision_temporada", refId: vig.id, puntos: 300, detalle: "x" });
  await s.sumarPuntos({ socioId: yo.id, motivo: "mision", refId: "2026-W44", puntos: 50, detalle: "x" });
  assert.deepStrictEqual(await s.refsPuntos(yo.id, "mision_temporada"), [vig.id]);
  assert.strictEqual((await s.refsPuntos(otro.id, "mision_temporada")).length, 0);
  assert.strictEqual(await s.sumarPuntos({ socioId: yo.id, motivo: "mision_temporada", refId: vig.id, puntos: 300, detalle: "x" }), null, "una sola vez por misión");
  assert.ok((await s.listReglas()).some((r) => r.clave === "pago_rapido" && r.puntos === 50) && (await s.listReglas()).some((r) => r.clave === "mision_temporada" && r.puntos === 300));
}

test("misiones de temporada · memory-store", async () => { await escenario(createMemoryStore({ filePath: null })); });
test("misiones de temporada · Postgres", opts, async () => { await escenario(pg); });
