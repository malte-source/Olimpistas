"use strict";
// Sprint 6 — apariencia del hincha (socios.tema): validación, persistencia y restricción en Postgres.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function socio() {
  n++;
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `tema${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Tema", apellido: "Prueba" } })).json();
  return { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
}

test("la apariencia arranca sin elegir y se guarda en la cuenta (auto, claro, oscuro)", async () => {
  const h = await socio();
  assert.ok(!(await (await api("/auth/yo", { h })).json()).socio.tema, "sin elegir: se conserva el comportamiento de siempre");
  for (const t of ["claro", "oscuro", "auto"]) {
    const r = await api("/perfil", { metodo: "PATCH", h, cuerpo: { tema: t } });
    assert.strictEqual(r.status, 200, t);
    assert.strictEqual((await (await api("/auth/yo", { h })).json()).socio.tema, t, "queda para el próximo dispositivo");
  }
});

test("valores inválidos se rechazan con un error claro y no cambian nada", async () => {
  const h = await socio();
  await api("/perfil", { metodo: "PATCH", h, cuerpo: { tema: "claro" } });
  for (const mal of ["azul", "", null, 1, "CLARO"]) {
    const r = await api("/perfil", { metodo: "PATCH", h, cuerpo: { tema: mal } });
    assert.strictEqual(r.status, 400, JSON.stringify(mal));
    assert.match((await r.json()).error, /Apariencia inválida/);
  }
  assert.strictEqual((await (await api("/auth/yo", { h })).json()).socio.tema, "claro");
});

test("sin sesión no se puede cambiar", async () => {
  assert.strictEqual((await api("/perfil", { metodo: "PATCH", cuerpo: { tema: "claro" } })).status, 401);
});

// ── Postgres real ────────────────────────────────────────────────────────────
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };
test("0009: la columna existe, admite NULL y rechaza valores fuera de lista", opts, async () => {
  process.env.DB_SSL = "disable";
  const crypto = require("crypto"), postgres = require("postgres");
  const admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  const db = "t_tema_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const u = new URL(BASE); u.pathname = "/" + db;
  const sql = postgres(u.toString(), { prepare: false, max: 1, onnotice: () => {} });
  try {
    await require("../lib/migrar").migrar(sql, { log: {} });
    await sql`INSERT INTO socios (id, email, password_hash, nombre) VALUES ('s1', 'a@x.com', 'x', 'A')`;
    assert.strictEqual((await sql`SELECT tema FROM socios WHERE id = 's1'`)[0].tema, null);
    for (const t of ["auto", "claro", "oscuro", null]) await sql`UPDATE socios SET tema = ${t} WHERE id = 's1'`;
    await assert.rejects(() => sql`UPDATE socios SET tema = 'azul' WHERE id = 's1'`, /socios_tema_valido/);
  } finally {
    await sql.end({ timeout: 3 }); await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {}); await admin.end({ timeout: 3 });
  }
});
