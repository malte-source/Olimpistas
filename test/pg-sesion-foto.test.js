"use strict";
// La sesión (que se consulta en cada request) no arrastra la foto: trae `tiene_foto`; la foto se pide aparte. Igual en Postgres y en memoria.
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
  mem = require("../data/memory-store").createMemoryStore({ filePath: null });
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_ses_" + crypto.randomBytes(4).toString("hex");
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

const tag = () => crypto.randomBytes(3).toString("hex");
const FOTO = "data:image/jpeg;base64," + "A".repeat(200000);

for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  test(`${nombre}: getSession no trae la foto (trae tiene_foto) y getSocioFoto la devuelve`, opts, async () => {
    const s = get();
    const con = await s.createSocio({ email: `f-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Con" });
    await s.updateSocio(con.id, { foto: FOTO, ciudad: "Asunción" });
    const sin = await s.createSocio({ email: `f-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Sin" });
    const t1 = "tok_" + tag(), t2 = "tok_" + tag(), vence = new Date(Date.now() + 3600000).toISOString();
    await s.createSession(con.id, t1, vence); await s.createSession(sin.id, t2, vence);

    const a = await s.getSession(t1);
    assert.ok(!("foto" in a.socio) || !a.socio.foto, "la sesión no carga la foto");
    assert.strictEqual(a.socio.tiene_foto, true);
    assert.strictEqual(a.socio.id, con.id);
    assert.strictEqual(a.socio.ciudad, "Asunción", "el resto de las columnas siguen");
    assert.ok(a.socio.email && a.socio.nombre, "datos de siempre");
    assert.ok(JSON.stringify(a).length < 5000, "la sesión es liviana");
    assert.strictEqual(await s.getSocioFoto(con.id), FOTO);

    const b = await s.getSession(t2);
    assert.strictEqual(b.socio.tiene_foto, false);
    assert.strictEqual(await s.getSocioFoto(sin.id), "");
    assert.strictEqual(await s.getSession("tok_inexistente"), null);
  });
}
