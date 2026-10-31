"use strict";
// Seguir una subasta (P6): cierran en 3 minutos, cerradas recientes y seguidores, con el mismo resultado en Postgres real (TEST_DATABASE_URL) y en memory-store.
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
  nombreDb = "t_seg_" + crypto.randomBytes(4).toString("hex");
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

const min = (m) => new Date(Date.now() + m * 60000).toISOString();
async function escenario(s) {
  const mk = (e) => s.createSocio({ email: `${crypto.randomBytes(4).toString("hex")}@ejemplo.com`, passwordHash: "x", nombre: e });
  const [a, b] = [await mk("A"), await mk("B")];
  const lote = async (titulo, extra = {}) => {
    const l = await s.crearSubasta({ titulo, precio_inicial: 100000, incremento: 10000, estado: "activa", termina: min(600) });
    await s.pujar({ subastaId: l.id, socioId: a.id, monto: 110000 });
    await s.pujar({ subastaId: l.id, socioId: b.id, monto: 120000 });
    await s.pujar({ subastaId: l.id, socioId: a.id, monto: 130000 });
    return s.updateSubasta(l.id, extra);
  };
  const cerca = await lote("Cierra pronto", { termina: min(2) }), lejos = await lote("Cierra lejos", { termina: min(120) }), pasado = await lote("Ya cerró", { estado: "cerrada", termina: min(-5), ganador_id: a.id, adjudicado_a: a.id });
  const viejo = await lote("Cerró ayer", { estado: "cerrada", termina: min(-60 * 30), ganador_id: a.id, adjudicado_a: a.id });
  const cierran = (await s.subastasCierranEn(3)).map((x) => x.id);
  assert.ok(cierran.includes(cerca.id) && !cierran.includes(lejos.id) && !cierran.includes(pasado.id));
  assert.deepStrictEqual(Object.keys((await s.subastasCierranEn(3))[0]).sort(), ["ganador_id", "id", "puja_actual", "slug", "termina", "titulo"]);
  const cerradas = (await s.subastasCerradasRecientes(24)).map((x) => x.id);
  assert.ok(cerradas.includes(pasado.id) && !cerradas.includes(viejo.id) && !cerradas.includes(cerca.id));
  assert.deepStrictEqual(Object.keys((await s.subastasCerradasRecientes(24))[0]).sort(), ["adjudicado_a", "ganador_id", "id", "puja_actual", "slug", "termina", "titulo"]);
  const seg = (await s.seguidoresSubasta(cerca.id)).sort((x, y) => x.mejor - y.mejor);
  assert.deepStrictEqual(seg.map((x) => [x.socio_id, x.mejor]), [[b.id, 120000], [a.id, 130000]], "cada postor una sola vez, con su mejor puja");
  assert.strictEqual((await s.seguidoresSubasta("sub_inexistente")).length, 0);
}

test("seguir una subasta · memory-store", async () => { await escenario(createMemoryStore({ filePath: null })); });
test("seguir una subasta · Postgres", opts, async () => { await escenario(pg); });
