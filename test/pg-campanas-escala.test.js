"use strict";
// Campañas a escala (Postgres real): 6.000 destinatarios repartidos entre 8 trabajadores a la vez → cada uno recibe exactamente
// UN envío; y el procesador real (procesarLote) recorre la campaña completa con un correo falso, midiendo el costo por destinatario.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
process.env.CAMPANAS_ACTIVAS = "1";
process.env.CAMPANAS_PAUSA_MS = "0";
process.env.CAMPANAS_LOTE = "400";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL", timeout: 240000 };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const N = 6000;
let admin, nombreDb, pg, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_esc_" + crypto.randomBytes(4).toString("hex");
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

const datos = () => ({ nombre: "Escala " + crypto.randomBytes(3).toString("hex"), canal: "email", plantilla: "novedad", asunto: "Asunto de prueba", titulo: "Título", cuerpo: "Cuerpo de prueba largo", cta_texto: "Ver", cta_url: "https://www.olimpistas.com/", segmento: {} });

async function sembrar(n) {
  const ids = [];
  for (let i = 0; i < n; i += 100) {
    const lote = await Promise.all(Array.from({ length: Math.min(100, n - i) }, (_, k) => pg.createSocio({ email: `esc-${i + k}-${crypto.randomBytes(2).toString("hex")}@ejemplo.com`, passwordHash: "x", nombre: "Hincha " + (i + k) })));
    for (const s of lote) ids.push(s);
  }
  return ids;
}

test(`escala: ${N} destinatarios entre 8 trabajadores a la vez — ninguno repetido, ninguno perdido, la campaña cierra sola`, opts, async () => {
  const ss = await sembrar(N);
  const c = await pg.crearCampanaEnvio(datos());
  const t0 = Date.now();
  await pg.agregarEnviosPendientes(c.id, ss.map((x) => ({ id: x.id, email: x.email, tier_slug: "olimpista" })));
  const tCarga = Date.now() - t0;
  const vistos = new Set(); let duplicados = 0;
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const tanda = await pg.tomarPendientesCampana(c.id, 150);
      if (!tanda.length) return;
      for (const e of tanda) { if (vistos.has(e.id)) duplicados++; vistos.add(e.id); }
      await Promise.all(tanda.map((e) => pg.marcarEnvioResultado(e.id, { ok: true })));
    }
  }));
  const tReparto = Date.now() - t1;
  assert.strictEqual(duplicados, 0, "ningún envío se entregó a dos trabajadores");
  assert.strictEqual(vistos.size, N, "no se perdió ninguno");
  assert.deepStrictEqual(await pg.cerrarCampanasTerminadas(), [c.id]);
  const d = await pg.getCampanaDetalle(c.id);
  assert.strictEqual(d.conteo.enviado, N);
  console.log(`  [escala] cargar ${N} pendientes: ${tCarga} ms · repartir y marcar con 8 trabajadores: ${tReparto} ms (${(N / (tReparto / 1000)).toFixed(0)} envíos/s)`);
});

test(`escala: procesarLote real recorre ${N} destinatarios con un correo falso (costo por destinatario)`, opts, async () => {
  const campanas = require("../lib/campanas");
  const ss = await pg._sql`SELECT id, email FROM socios LIMIT ${N}`;
  const c = await pg.crearCampanaEnvio(datos());
  await pg.agregarEnviosPendientes(c.id, ss.map((x) => ({ id: x.id, email: x.email, tier_slug: "olimpista" })));
  const enviados = new Set();
  const enviarEmail = async ({ to }) => { enviados.add(to); return { ok: true }; };
  const t0 = Date.now(); let corridas = 0, total = 0;
  while (total < N && corridas < 100) { const r = await campanas.procesarLote({ store: pg, enviarEmail, log: () => {} }); total += r.enviados + r.fallidos + r.omitidos; corridas++; if (!r.campanas) break; }
  const ms = Date.now() - t0;
  assert.strictEqual(total, N);
  assert.strictEqual(enviados.size, N, "cada correo salió una sola vez");
  console.log(`  [escala] procesarLote: ${N} destinatarios en ${corridas} corridas de 400 · ${ms} ms · ${(ms / N).toFixed(1)} ms/destinatario de costo interno (sin la pausa del proveedor)`);
});
