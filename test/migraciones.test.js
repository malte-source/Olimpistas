"use strict";
// Ejecutor de migraciones contra un Postgres real. Se activa con TEST_DATABASE_URL
// (en CI hay un servicio Postgres; en local: docker run -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17).
// Cada test usa su propia base descartable.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

let postgres, admin;
const creadas = [];
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };

async function baseNueva() {
  const nombre = "t_mig_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombre}`);
  creadas.push(nombre);
  return postgres(urlDe(nombre), { prepare: false, max: 4, onnotice: () => {} });
}

before(async () => {
  if (!BASE) return;
  postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
});
after(async () => {
  if (!BASE) return;
  for (const n of creadas) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

const { migrar, listar } = require("../lib/migrar");
const tablas = async (sql) => (await sql`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations'`)[0].n;

test("base vacía: aplica todas las migraciones y deja el esquema completo", opts, async () => {
  const sql = await baseNueva();
  try {
    const r = await migrar(sql, { log: {} });
    assert.deepStrictEqual(r.aplicadas, listar().map((m) => m.id));
    assert.strictEqual(r.baseline, false);
    assert.strictEqual(await tablas(sql), 33, "27 de producción + decisiones_club (0003) + segmentos_guardados (0004) + 4 de peñas (0005)");
    const colsSub = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='subastas'`).map((c) => c.column_name);
    for (const c of ["pago_vence", "adjudicado_a", "ronda"]) assert.ok(colsSub.includes(c), "falta subastas." + c);
    const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='pedidos_pago'`).map((c) => c.column_name);
    for (const c of ["pagado_en", "cumplido_en", "cumplimiento_desde"]) assert.ok(cols.includes(c), "falta " + c);
    assert.strictEqual((await sql`SELECT count(*)::int n FROM schema_migrations`)[0].n, listar().length);
  } finally { await sql.end({ timeout: 5 }); }
});

test("segunda corrida: no hace nada (idempotente)", opts, async () => {
  const sql = await baseNueva();
  try {
    await migrar(sql, { log: {} });
    const r = await migrar(sql, { log: {} });
    assert.deepStrictEqual(r.aplicadas, []);
  } finally { await sql.end({ timeout: 5 }); }
});

test("base de producción (esquema sin historial): registra 0001 sin ejecutarla y aplica solo lo nuevo", opts, async () => {
  const sql = await baseNueva();
  try {
    await sql.unsafe(listar().find((m) => m.id === "0001").sql); // "producción" = esquema ya existente
    await sql`INSERT INTO socios (id, email, password_hash) VALUES ('soc_prod', 'real@ejemplo.com', 'x')`; // dato que no se debe tocar
    const plan = await migrar(sql, { soloVer: true });
    assert.strictEqual(plan.baseline, true);
    assert.ok(!plan.pendientes.includes("0001"));
    const r = await migrar(sql, { log: {} });
    assert.strictEqual(r.baseline, true);
    assert.ok(!r.aplicadas.includes("0001"), "0001 NO se re-ejecuta sobre producción");
    assert.ok(r.aplicadas.includes("0002"));
    assert.strictEqual((await sql`SELECT count(*)::int n FROM schema_migrations WHERE id='0001'`)[0].n, 1);
    assert.strictEqual((await sql`SELECT count(*)::int n FROM socios WHERE id='soc_prod'`)[0].n, 1, "los datos existentes siguen intactos");
  } finally { await sql.end({ timeout: 5 }); }
});

test("0002 da por entregados los pedidos que ya estaban pagados", opts, async () => {
  const sql = await baseNueva();
  try {
    await sql.unsafe(listar().find((m) => m.id === "0001").sql);
    await sql`INSERT INTO socios (id, email, password_hash) VALUES ('soc_1', 'a@ejemplo.com', 'x')`;
    await sql`INSERT INTO pedidos_pago (id, socio_id, concepto, monto, estado) VALUES ('ped_pagado','soc_1','x',1000,'pagado'), ('ped_pend','soc_1','y',2000,'pendiente')`;
    await migrar(sql, { log: {} });
    const [pagado] = await sql`SELECT pagado_en, cumplido_en FROM pedidos_pago WHERE id='ped_pagado'`;
    const [pend] = await sql`SELECT pagado_en, cumplido_en FROM pedidos_pago WHERE id='ped_pend'`;
    assert.ok(pagado.pagado_en && pagado.cumplido_en, "el ya pagado queda como cumplido");
    assert.strictEqual(pend.pagado_en, null);
    assert.strictEqual(pend.cumplido_en, null);
  } finally { await sql.end({ timeout: 5 }); }
});

test("dos instancias migrando a la vez: una sola aplica, la otra espera y no falla", opts, async () => {
  const sql = await baseNueva();
  try {
    const [a, b] = await Promise.all([migrar(sql, { log: {} }), migrar(sql, { log: {} })]);
    const total = a.aplicadas.length + b.aplicadas.length;
    assert.strictEqual(total, listar().length, "cada migración se aplicó exactamente una vez");
    assert.strictEqual((await sql`SELECT count(*)::int n FROM schema_migrations`)[0].n, listar().length);
  } finally { await sql.end({ timeout: 5 }); }
});

test("una migración aplicada que se edita después es un error", opts, async () => {
  const sql = await baseNueva();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE socios (id text);\n");
    await migrar(sql, { dir, log: {} });
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE socios (id text, extra text);\n");
    await assert.rejects(() => migrar(sql, { dir, log: {} }), /ya estaba aplicada y su contenido cambió/);
  } finally { await sql.end({ timeout: 5 }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("una migración que falla no deja nada a medias", opts, async () => {
  const sql = await baseNueva();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE socios (id text);\n");
    fs.writeFileSync(path.join(dir, "0002_mala.sql"), "CREATE TABLE nueva_x (id text);\nSELECT * FROM tabla_que_no_existe;\n");
    await assert.rejects(() => migrar(sql, { dir, log: {} }));
    const [{ existe }] = await sql`SELECT to_regclass('public.nueva_x') IS NOT NULL AS existe`;
    assert.strictEqual(existe, false, "la tabla de la migración fallida se revirtió");
    const [{ hist }] = await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS hist`;
    assert.strictEqual(hist, false, "ni la tabla de historial ni 0001 quedaron: todo se revirtió junto");
    const [{ socios }] = await sql`SELECT to_regclass('public.socios') IS NOT NULL AS socios`;
    assert.strictEqual(socios, false);
  } finally { await sql.end({ timeout: 5 }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("una base con una migración desconocida falla, salvo que se tolere (rollback de código)", opts, async () => {
  const sql = await baseNueva();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE socios (id text);\n");
    fs.writeFileSync(path.join(dir, "0002_b.sql"), "CREATE TABLE otra (id text);\n");
    await migrar(sql, { dir, log: {} });
    fs.rmSync(path.join(dir, "0002_b.sql"));
    await assert.rejects(() => migrar(sql, { dir, log: {} }), /no conoce/);
    const r = await migrar(sql, { dir, log: {}, tolerarDesconocidas: true });
    assert.deepStrictEqual(r.aplicadas, []);
  } finally { await sql.end({ timeout: 5 }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("el esquema base no contiene SET de sesión ni comandos de psql", () => {
  const base = listar().find((m) => m.id === "0001").sql;
  assert.ok(!/^SET /m.test(base), "SET de sesión se filtraría por el pooler");
  assert.ok(!/^\\/m.test(base), "comandos de psql (\\restrict) no los entiende el driver");
  assert.ok(!/set_config/.test(base));
});
