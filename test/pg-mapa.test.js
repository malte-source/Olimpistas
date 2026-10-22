"use strict";
// Mapa contra Postgres real (TEST_DATABASE_URL): las posiciones públicas para las celdas H3 salen sin datos personales
// y solo de quienes eligieron mostrarse; mismo resultado que memory-store.
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
  nombreDb = "t_mapa_" + crypto.randomBytes(4).toString("hex");
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
for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  test(`${nombre}: puntosPublicosEnBBox devuelve solo lat/lng de quienes eligieron mostrarse, dentro del recuadro`, opts, async () => {
    const s = get();
    const mk = async (lat, lng, mostrar) => { const x = await s.createSocio({ email: `p-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Persona" }); await s.updateSocio(x.id, { lat, lng, mostrar_exacto: mostrar }); return x; };
    await mk(-25.30, -57.60, true);
    await mk(-25.31, -57.61, true);
    await mk(-25.30, -57.60, false);   // no eligió mostrarse
    await mk(-10.0, -50.0, true);      // fuera del recuadro
    const r = await s.puntosPublicosEnBBox({ minLng: -58, minLat: -26, maxLng: -57, maxLat: -25 });
    assert.strictEqual(r.length, 2);
    for (const p of r) assert.deepStrictEqual(Object.keys(p).sort(), ["lat", "lng"]);
  });
}
