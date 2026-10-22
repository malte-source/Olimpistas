"use strict";
// Campañas contra Postgres real (TEST_DATABASE_URL): la migración 0010, el reclamo atómico de envíos entre
// corridas simultáneas del cron, la audiencia sin tope y que memory-store y pg-store se comporten igual.
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
  nombreDb = "t_camp_" + crypto.randomBytes(4).toString("hex");
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
const mkSocio = (store, extra) => store.createSocio({ email: `s-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Hincha", ...extra });
const datos = (extra = {}) => ({ nombre: "Camp " + tag(), canal: "email", plantilla: "novedad", asunto: "Asunto de prueba", titulo: "Título", cuerpo: "Cuerpo de prueba largo", cta_texto: "Ver", cta_url: "/miembro", filtros: { q: "s-" }, por: "test", ...extra });

test("0010: columnas nuevas y la campaña vieja ('Completá tu pago') queda como enviada", opts, async () => {
  const cols = (await pg._sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'campanas'`).map((c) => c.column_name);
  for (const c of ["canal", "plantilla", "asunto", "titulo", "cuerpo", "cta_texto", "cta_url", "cta_valor", "filtros", "estado", "creada_por", "finalizada"]) assert.ok(cols.includes(c), c);
  const legado = await pg.crearCampana({ nombre: "Completá tu pago", tipo: "pago" });
  assert.strictEqual(legado.estado, "enviada");
  assert.strictEqual(legado.canal, "email");
});

for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  test(`${nombre}: la audiencia trae marketing_baja y teléfono, sin tope de 5.000`, opts, async () => {
    const s = get();
    const a = await mkSocio(s, { telefono: "0981111111" });
    const b = await mkSocio(s, {});
    await s.updateSocio(b.id, { marketing_baja: true });
    const filas = await s.filtrarSocios({ paraEnvio: true });
    const fa = filas.find((x) => x.id === a.id), fb = filas.find((x) => x.id === b.id);
    assert.strictEqual(fa.telefono, "0981111111");
    assert.strictEqual(!!fa.marketing_baja, false);
    assert.strictEqual(!!fb.marketing_baja, true);
    assert.ok(fa.tier_slug);
  });

  test(`${nombre}: ciclo completo — pendientes, reclamo, resultado, cierre y cancelación`, opts, async () => {
    const s = get();
    const ss = [await mkSocio(s, {}), await mkSocio(s, {}), await mkSocio(s, {})];
    const c = await s.crearCampanaEnvio(datos());
    assert.strictEqual(c.estado, "enviando");
    assert.ok((await s.campanasEnCurso()).some((x) => x.id === c.id));
    await s.agregarEnviosPendientes(c.id, ss.map((x) => ({ id: x.id, email: x.email, tier_slug: "olimpista" })));
    const t1 = await s.tomarPendientesCampana(c.id, 2);
    assert.strictEqual(t1.length, 2);
    const t2 = await s.tomarPendientesCampana(c.id, 5);
    assert.strictEqual(t2.length, 1, "lo ya reclamado no se vuelve a entregar");
    assert.strictEqual((await s.tomarPendientesCampana(c.id, 5)).length, 0);
    await s.marcarEnvioResultado(t1[0].id, { ok: true });
    await s.marcarEnvioResultado(t1[1].id, { ok: false, error: "rebotó" });
    assert.deepStrictEqual(await s.cerrarCampanasTerminadas(), [], "falta uno por resolver");
    await s.marcarEnvioResultado(t2[0].id, { omitido: true, error: "baja" });
    assert.deepStrictEqual(await s.cerrarCampanasTerminadas(), [c.id]);
    const d = await s.getCampanaDetalle(c.id);
    assert.strictEqual(d.campana.estado, "enviada");
    assert.deepStrictEqual(d.conteo, { enviado: 1, fallido: 1, omitido: 1 });
    assert.strictEqual(d.fallos[0].error, "rebotó");
    const fila = (await s.listCampanas()).find((x) => x.id === c.id);
    assert.strictEqual(fila.enviados_ok, 1);
    assert.strictEqual(fila.fallidos, 1);
    assert.strictEqual(fila.pendientes, 0);

    const c2 = await s.crearCampanaEnvio(datos());
    await s.agregarEnviosPendientes(c2.id, ss.map((x) => ({ id: x.id, email: x.email })));
    const cancelada = await s.cancelarCampana(c2.id);
    assert.strictEqual(cancelada.estado, "cancelada");
    assert.strictEqual((await s.tomarPendientesCampana(c2.id, 5)).length, 0);
    assert.strictEqual(await s.cancelarCampana(c2.id), null);
  });
}

test("pg: dos corridas simultáneas del cron nunca toman el mismo envío (FOR UPDATE SKIP LOCKED)", opts, async () => {
  const ss = [];
  for (let i = 0; i < 40; i++) ss.push(await mkSocio(pg, {}));
  const c = await pg.crearCampanaEnvio(datos());
  await pg.agregarEnviosPendientes(c.id, ss.map((x) => ({ id: x.id, email: x.email })));
  const lotes = await Promise.all(Array.from({ length: 8 }, () => pg.tomarPendientesCampana(c.id, 7)));
  const ids = lotes.flat().map((e) => e.id);
  assert.strictEqual(new Set(ids).size, ids.length, "ningún envío repetido entre corridas");
  assert.strictEqual(ids.length, 40, "se reparten todos");
});

test("pg: un envío 'tomado' que quedó colgado más de 10 minutos se reintenta", opts, async () => {
  const s = await mkSocio(pg, {});
  const c = await pg.crearCampanaEnvio(datos());
  await pg.agregarEnviosPendientes(c.id, [{ id: s.id, email: s.email }]);
  const [e] = await pg.tomarPendientesCampana(c.id, 1);
  assert.strictEqual((await pg.tomarPendientesCampana(c.id, 1)).length, 0, "recién tomado: nadie más lo toca");
  await pg._sql`UPDATE campana_envios SET tomado_en = now() - interval '11 minutes' WHERE id = ${e.id}`;
  const otra = await pg.tomarPendientesCampana(c.id, 1);
  assert.strictEqual(otra.length, 1);
  assert.strictEqual(otra[0].id, e.id);
});
