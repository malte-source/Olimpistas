"use strict";
// Contra Postgres real: las columnas `date` llegan como texto 'AAAA-MM-DD' (antes eran objetos Date y los sorteos nunca cerraban),
// y las estadísticas públicas no publican coordenadas de una ciudad con menos de 3 hinchas.
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
  nombreDb = "t_fec_" + crypto.randomBytes(4).toString("hex");
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
  test(`${nombre}: el cierre de un sorteo y la fecha de nacimiento son texto AAAA-MM-DD (y el sorteo vencido se ve cerrado)`, opts, async () => {
    const s = get();
    const sor = await s.crearSorteo({ titulo: "Sorteo " + tag(), cierra: "2020-01-31", activo: true });
    const x = (await s.listSorteos()).find((q) => q.id === sor.id);
    assert.strictEqual(typeof x.cierra, "string");
    assert.strictEqual(String(x.cierra).slice(0, 10), "2020-01-31", "sin corrimiento de huso horario");
    const hoy = new Date().toISOString().slice(0, 10);
    assert.strictEqual(!x.cierra || String(x.cierra).slice(0, 10) >= hoy, false, "el sorteo de 2020 está cerrado");
    const abierto = await s.crearSorteo({ titulo: "Abierto " + tag(), cierra: "2099-12-31", activo: true });
    assert.strictEqual(String((await s.listSorteos()).find((q) => q.id === abierto.id).cierra).slice(0, 10), "2099-12-31");
    const h = await s.createSocio({ email: `f-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "F", fechaNacimiento: "1990-05-10" });
    const got = await s.getSocioById(h.id);
    assert.strictEqual(typeof got.fecha_nacimiento, "string");
    assert.strictEqual(got.fecha_nacimiento, "1990-05-10");
    await s.updateSocio(h.id, { fecha_nacimiento: "1985-12-31" });
    assert.strictEqual((await s.getSocioById(h.id)).fecha_nacimiento, "1985-12-31");
  });
}

test("pg: un Date de JavaScript se guarda en una columna date sin correrse de día", opts, async () => {
  const h = await pg.createSocio({ email: `f-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "F" });
  await pg.updateSocio(h.id, { fecha_nacimiento: new Date("2001-02-03T12:00:00Z") });
  assert.strictEqual((await pg.getSocioById(h.id)).fecha_nacimiento, "2001-02-03");
});

for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  test(`${nombre}: contarPorCiudad no publica coordenadas de una ciudad con menos de 3 hinchas (pero sí los cuenta)`, opts, async () => {
    const s = get();
    const mk = async (ciudad, lat, lng) => { const x = await s.createSocio({ email: `c-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "C" }); await s.updateSocio(x.id, { pais_iso: "PY", pais: "Paraguay", ciudad, lat, lng }); };
    for (let i = 0; i < 3; i++) await mk("Ciudad Grande Test", -25.3 + i * 0.01, -57.6);
    await mk("Pueblo De Dos Test", -26.1, -56.1); await mk("Pueblo De Dos Test", -26.1, -56.1);
    const filas = await s.contarPorCiudad();
    const grande = filas.find((f) => f.ciudad === "Ciudad Grande Test"), chico = filas.find((f) => f.ciudad === "Pueblo De Dos Test");
    assert.strictEqual(Number(grande.count), 3);
    assert.ok(grande.lat != null && grande.lng != null, "3 o más: se publica el promedio");
    assert.strictEqual(Number(chico.count), 2, "los cuenta");
    assert.ok(chico.lat == null && chico.lng == null, "menos de 3: sin coordenadas");
  });
}
