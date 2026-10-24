"use strict";
// Resumen de comercios: mismo resultado en Postgres real y en memoria.
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
  nombreDb = "t_acom_" + crypto.randomBytes(4).toString("hex");
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

async function sembrar(store) {
  const a = await store.crearComercio({ nombre: "Beta", rubro: "Moda", ciudad: "Asunción", logo: "/assets/x.png" });
  await store.updateComercio(a.id, { lat: -25.3, lng: -57.6, usuario: "beta", password_hash: "x" });
  const b = await store.crearBeneficio({ comercio_id: a.id, titulo: "20%", valor: "20%" });
  const pend = await store.crearBeneficio({ comercio_id: a.id, titulo: "Pendiente", valor: "5%" });
  await store.updateBeneficio(pend.id, { estado: "borrador" });
  const s = await store.createSocio({ email: "k@ejemplo.com", passwordHash: "x", nombre: "K" });
  await store.registrarCanje({ beneficioId: b.id, socioId: s.id, comercioId: a.id, monto: 50000, ahorro: 10000, validadoPor: "t" });
  await store.crearComercio({ nombre: "alfa", rubro: "", ciudad: "" });
}
const forma = (r) => r.map((c) => ({ n: c.nombre, logo: !!c.logo, ubicado: c.lat != null, acceso: !!c.usuario, pub: c.beneficios_pub, apr: c.por_aprobar, canjes: c.canjes_mes, ahorro: Number(c.ahorro_mes) }));

test("resumen de comercios: igual en Postgres y en memoria", opts, async () => {
  await sembrar(pg); await sembrar(mem);
  const desde = new Date(Date.now() - 24 * 3600000).toISOString();
  const p = forma(await pg.resumenComercios({ desde })), m = forma(await mem.resumenComercios({ desde }));
  assert.deepStrictEqual(p, m);
  assert.deepStrictEqual(p, [
    { n: "alfa", logo: false, ubicado: false, acceso: false, pub: 0, apr: 0, canjes: 0, ahorro: 0 },
    { n: "Beta", logo: true, ubicado: true, acceso: true, pub: 1, apr: 1, canjes: 1, ahorro: 10000 },
  ]);
  const futuro = forma(await pg.resumenComercios({ desde: new Date(Date.now() + 3600000).toISOString() }));
  assert.strictEqual(futuro.find((c) => c.n === "Beta").canjes, 0, "los canjes anteriores al período no cuentan");
});
