"use strict";
// Admisión de consultas del pool (data/pg-store.js): nunca hay más consultas en vuelo que conexiones.
// Motivo: contra el pooler de Supabase (modo transacción), las consultas que postgres.js dejaba encoladas por encima
// del tamaño del pool se colgaban para siempre (reproducido en staging con postgres.js suelto: max=3 y 9 consultas
// distintas a la vez → 4 colgadas). Acá se prueba el contrato contra Postgres real; el cuelgue en sí solo se
// reproduce con el pooler de Supabase (ver docs/staging-y-promocion.md).
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const pausa = (pg, seg) => pg._sql`SELECT pg_sleep(${seg})`;
function crear(env) {
  const guardado = {}; for (const k of Object.keys(env)) { guardado[k] = process.env[k]; process.env[k] = env[k]; }
  try { return require("../data/pg-store").createPgStore({ databaseUrl: BASE }); }
  finally { for (const k of Object.keys(env)) { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; } }
}
const stores = [];
const nuevo = (env) => { const s = crear(env); stores.push(s); return s; };
after(async () => { for (const s of stores) { try { await s._sql.end({ timeout: 3 }); } catch (e) {} } });
before(() => { void BASE; });

test("20 consultas a la vez con pool de 2: todas terminan y nunca corren más de 2 juntas", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "2" });
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: 20 }, () => pausa(pg, 0.1)));
  const ms = Date.now() - t0;
  assert.strictEqual(res.length, 20);
  assert.ok(ms >= 900, `con 2 cupos y 20 × 100 ms tienen que ser ≥ 1 s (fueron ${ms} ms): corrieron más de 2 juntas`);
  assert.ok(ms < 5000);
});

test("una ráfaga mayor que el pool no deja nada colgado ni pierde cupos (varias rondas)", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "3" });
  for (let ronda = 0; ronda < 3; ronda++) {
    const r = await Promise.all(Array.from({ length: 12 }, (_, i) => pg._sql`SELECT ${i}::int AS i, pg_sleep(${0.02 + (i % 3) * 0.03})`));
    assert.deepStrictEqual(r.map((x) => x[0].i), Array.from({ length: 12 }, (_, i) => i));
  }
});

test("esperar cupo demasiado falla rápido con un error claro (DB_BUSY) y no pierde el cupo", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "1", DB_ESPERA_MS: "150" });
  const larga = pausa(pg, 0.6).then((x) => x); // las consultas de postgres.js son perezosas: .then las dispara
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await assert.rejects(() => pg._sql`SELECT 1`, (e) => e.code === "DB_BUSY" && /saturada/.test(e.message));
  assert.ok(Date.now() - t0 < 500, "falla cerca de DB_ESPERA_MS, no cuando termina la larga");
  await larga;
  const [r] = await pg._sql`SELECT 7::int AS n`;
  assert.strictEqual(r.n, 7, "el cupo se liberó al terminar la larga");
});

test("una transacción retiene su cupo mientras dura y lo suelta aunque falle", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "1" });
  const t0 = Date.now();
  const tx = pg._sql.begin(async (q) => { await q`SELECT pg_sleep(0.3)`; return "listo"; });
  await new Promise((r) => setTimeout(r, 30));
  const fuera = pg._sql`SELECT 1::int AS n`.then((x) => x);
  assert.strictEqual(await tx, "listo");
  assert.strictEqual((await fuera)[0].n, 1);
  assert.ok(Date.now() - t0 >= 300, "la consulta de afuera esperó a que cerrara la transacción");
  await assert.rejects(() => pg._sql.begin(async (q) => { await q`SELECT 1`; throw new Error("boom"); }), /boom/);
  assert.strictEqual((await pg._sql`SELECT 2::int AS n`)[0].n, 2, "tras una transacción fallida el cupo vuelve");
});

test("el plazo por consulta sigue cortando y libera el cupo", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "1", DB_TIMEOUT_MS: "200" });
  await assert.rejects(() => pausa(pg, 2), (e) => /57014|cancel/i.test(String(e.code) + e.message));
  const [r] = await pg._sql`SELECT 3::int AS n`;
  assert.strictEqual(r.n, 3);
});

test("los fragmentos de SQL anidados siguen funcionando (no toman cupo ni se ejecutan solos)", opts, async () => {
  const pg = nuevo({ DB_POOL_MAX: "1" });
  const vacio = pg._sql``, filtro = pg._sql`WHERE x = ${5}`;
  const [r] = await pg._sql`SELECT * FROM (SELECT 5 AS x) t ${filtro}`;
  assert.strictEqual(r.x, 5);
  const [s] = await pg._sql`SELECT 9::int AS n ${vacio}`;
  assert.strictEqual(s.n, 9);
});
