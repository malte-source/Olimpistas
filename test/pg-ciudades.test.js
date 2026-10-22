"use strict";
// Ciudades contra Postgres real (TEST_DATABASE_URL): la migración 0011, la carga idempotente de GeoNames y las
// búsquedas (prefijo sin acentos, comodines, país, ciudad más cercana) con el mismo resultado que memory-store.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const ciudades = require("../lib/ciudades");

let admin, nombreDb, pg, mem, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const c = (id, nombre, pais_iso, lat, lng, poblacion) => ({ id, nombre, nombre_norm: ciudades.norm(nombre), pais_iso, lat, lng, poblacion });
const FILAS = [
  c(1, "Lambaré", "PY", -25.34682, -57.60647, 126377), c(2, "Nemby", "PY", -25.3949, -57.53574, 94641),
  c(3, "Asunción", "PY", -25.28646, -57.647, 521559), c(4, "Asunción", "GT", 14.5, -90.5, 20000),
  c(5, "San Lorenzo", "PY", -25.33968, -57.50879, 227876), c(6, "Rio_100%", "BR", -22.9, -43.2, 1000),
];
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_ciu_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sqlMig = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
  await require("../lib/migrar").migrar(sqlMig, { log: {} });
  pg = require("../data/pg-store").createPgStore({ databaseUrl: urlDe(nombreDb) });
  mem = require("../data/memory-store").createMemoryStore({ filePath: null });
  await pg.importarCiudades(FILAS); await mem.importarCiudades(FILAS);
});
after(async () => {
  if (!BASE) return;
  try { await pg._sql.end({ timeout: 5 }); } catch (e) {}
  try { await sqlMig.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

test("0011: tabla de ciudades, ciudad_id en socios y lat/lng en peñas y comercios", opts, async () => {
  const cols = async (t) => (await pg._sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${t}`).map((x) => x.column_name);
  for (const k of ["id", "nombre", "nombre_norm", "pais_iso", "lat", "lng", "poblacion"]) assert.ok((await cols("ciudades")).includes(k), "ciudades." + k);
  assert.ok((await cols("socios")).includes("ciudad_id"));
  for (const t of ["penas", "comercios"]) for (const k of ["lat", "lng"]) assert.ok((await cols(t)).includes(k), `${t}.${k}`);
});

test("pg: importar es idempotente (volver a correrlo actualiza, no duplica)", opts, async () => {
  assert.strictEqual(await pg.contarCiudades(), FILAS.length);
  await pg.importarCiudades([c(1, "Lambaré", "PY", -25.35, -57.61, 130000)]);
  assert.strictEqual(await pg.contarCiudades(), FILAS.length);
  assert.strictEqual((await pg.getCiudad(1)).poblacion, 130000);
  await pg.importarCiudades([c(1, "Lambaré", "PY", -25.34682, -57.60647, 126377)]);
});

for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  test(`${nombre}: buscar por prefijo sin acentos, por población, con país y sin comodines`, opts, async () => {
    const s = get();
    assert.deepStrictEqual((await s.buscarCiudades({ q: "Ñem", pais: "PY" })).map((x) => x.nombre), ["Nemby"]);
    assert.deepStrictEqual((await s.buscarCiudades({ q: "asun" })).map((x) => x.pais_iso), ["PY", "GT"]);
    assert.deepStrictEqual((await s.buscarCiudades({ q: "asun", pais: "GT" })).map((x) => x.id), [4]);
    assert.deepStrictEqual(await s.buscarCiudades({ q: "a" }), []);
    assert.strictEqual((await s.buscarCiudades({ q: "%%" })).length, 0, "los comodines no matchean todo");
    assert.deepStrictEqual((await s.buscarCiudades({ q: "rio_100%" })).map((x) => x.id), [6], "un _ o % literal se busca literal");
  });
  test(`${nombre}: ciudadPorNombre, getCiudad y la más cercana (con tope de km)`, opts, async () => {
    const s = get();
    assert.strictEqual((await s.ciudadPorNombre({ nombre: "ASUNCION", pais: "PY" })).id, 3);
    assert.strictEqual((await s.ciudadPorNombre({ nombre: "asuncion", pais: "GT" })).id, 4);
    assert.strictEqual(await s.ciudadPorNombre({ nombre: "Inventada", pais: "PY" }), null);
    assert.strictEqual((await s.getCiudad(5)).nombre, "San Lorenzo");
    assert.strictEqual(await s.getCiudad(999999), null);
    const cerca = await s.ciudadMasCercana({ lat: -25.29, lng: -57.6, pais: "PY" });
    assert.strictEqual(cerca.id, 3);
    assert.ok(cerca.km > 0 && cerca.km < 10);
    assert.strictEqual(await s.ciudadMasCercana({ lat: -23.0, lng: -58.9, pais: "PY" }), null, "más de 60 km de todo");
    assert.strictEqual((await s.ciudadMasCercana({ lat: -25.34, lng: -57.5, pais: "PY", maxKm: 5 })).id, 5);
  });
}
