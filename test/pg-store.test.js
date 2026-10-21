"use strict";
// pg-store contra un Postgres real (TEST_DATABASE_URL). Dos cosas:
//  1) la atomicidad del cobro/entrega, que en memoria no se puede probar de verdad;
//  2) contrato: memory-store y pg-store devuelven la misma forma en lo que la app consume.
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
  nombreDb = "t_pg_" + crypto.randomBytes(4).toString("hex");
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

let n = 0;
async function pedido(store, extra = {}) {
  n++;
  const socio = await store.createSocio({ email: `pg${n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Test" });
  return store.createPedidoPago({ socioId: socio.id, concepto: "Membresía Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: "h-" + crypto.randomBytes(5).toString("hex"), ...extra });
}

test("pg: 25 reclamos simultáneos del mismo pedido → lo gana exactamente uno", opts, async () => {
  const p = await pedido(pg);
  const res = await Promise.all(Array.from({ length: 25 }, () => pg.reclamarCumplimiento(p.id)));
  assert.strictEqual(res.filter(Boolean).length, 1, "un solo ganador");
  const fila = await pg.getPedidoPago(p.id);
  assert.strictEqual(fila.estado, "pagado");
  assert.ok(fila.pagado_en && fila.cumplimiento_desde && !fila.cumplido_en);
});

test("pg: mientras alguien entrega nadie más puede; si falla y libera, otro lo retoma; al cumplirse, queda cerrado", opts, async () => {
  const p = await pedido(pg);
  assert.ok(await pg.reclamarCumplimiento(p.id));
  assert.strictEqual(await pg.reclamarCumplimiento(p.id), null, "candado tomado");
  await pg.liberarCumplimiento(p.id);
  assert.ok(await pg.reclamarCumplimiento(p.id), "liberado → se puede retomar");
  assert.ok(await pg.marcarCumplido(p.id));
  assert.strictEqual(await pg.reclamarCumplimiento(p.id), null, "ya cumplido: no se reclama más");
  assert.strictEqual(await pg.marcarCumplido(p.id), null, "cumplir dos veces no hace nada");
});

test("pg: el candado vence a los 2 minutos (entrega abandonada por una instancia caída)", opts, async () => {
  const p = await pedido(pg);
  await pg.reclamarCumplimiento(p.id);
  await pg._sql`UPDATE pedidos_pago SET cumplimiento_desde = now() - interval '3 minutes' WHERE id = ${p.id}`;
  assert.ok(await pg.reclamarCumplimiento(p.id), "con el candado vencido otro puede retomarlo");
});

test("pg: pagado → reversado ocurre una sola vez aunque lleguen 10 reversiones", opts, async () => {
  const p = await pedido(pg);
  await pg.reclamarCumplimiento(p.id);
  await pg.marcarCumplido(p.id);
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.marcarReversado(p.id)));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual((await pg.getPedidoPago(p.id)).estado, "reversado");
  const otro = await pedido(pg); // pendiente: no se puede reversar
  assert.strictEqual(await pg.marcarReversado(otro.id), null);
});

test("pg: pedidosParaConciliar separa abiertos (con hash, entre 10 min y 7 días) de pagados sin entregar", opts, async () => {
  const reciente = await pedido(pg);
  const abierto = await pedido(pg);
  const viejo = await pedido(pg);
  const sinHash = await pedido(pg, { refExterna: null });
  const sinEntregar = await pedido(pg);
  const entregado = await pedido(pg);
  await pg._sql`UPDATE pedidos_pago SET creado = now() - interval '30 minutes' WHERE id IN (${abierto.id}, ${sinHash.id})`;
  await pg._sql`UPDATE pedidos_pago SET creado = now() - interval '10 days' WHERE id = ${viejo.id}`;
  await pg._sql`UPDATE pedidos_pago SET estado='pagado', pagado_en = now() - interval '20 minutes' WHERE id = ${sinEntregar.id}`;
  await pg._sql`UPDATE pedidos_pago SET estado='pagado', pagado_en = now() - interval '20 minutes', cumplido_en = now() WHERE id = ${entregado.id}`;
  const { abiertos, sinEntregar: pend } = await pg.pedidosParaConciliar();
  const ids = (a) => a.map((x) => x.id);
  assert.ok(ids(abiertos).includes(abierto.id));
  for (const no of [reciente, viejo, sinHash, sinEntregar, entregado]) assert.ok(!ids(abiertos).includes(no.id), "no debe estar entre abiertos: " + no.id);
  assert.ok(ids(pend).includes(sinEntregar.id));
  assert.ok(!ids(pend).includes(entregado.id));
});

test("contrato pg ↔ memoria: listSubastasPublicas devuelve las mismas claves, sin la foto", opts, async () => {
  const datos = { titulo: "Camiseta firmada", descripcion: "d", imagen: "data:image/png;base64,AAAA", estado: "activa", termina: new Date(Date.now() + 3600000).toISOString(), precio_inicial: 100000 };
  const a = await pg.crearSubasta(datos);
  const b = await mem.crearSubasta(datos);
  const fa = (await pg.listSubastasPublicas()).find((s) => s.id === a.id);
  const fb = (await mem.listSubastasPublicas()).find((s) => s.id === b.id);
  assert.ok(fa && fb);
  for (const f of [fa, fb]) {
    assert.ok(!("imagen" in f), "la foto no viaja en el listado");
    assert.strictEqual(f.tiene_imagen, true);
    assert.match(f.imagen_v, /^[0-9a-f]{10}$/);
  }
  // Las claves que consume routes.js existen en ambos.
  for (const k of ["id", "slug", "titulo", "descripcion", "emoji", "nivel_min", "precio_inicial", "incremento", "puja_actual", "termina", "estado", "pago_estado", "ganador_id"])
    assert.ok(k in fa && k in fb, "falta la clave " + k + " en " + (k in fa ? "memoria" : "pg"));
  assert.strictEqual(fa.imagen_v, fb.imagen_v, "mismo hash de contenido en ambos stores");
  const img = await pg.imagenSubasta(a.slug);
  assert.strictEqual(img.imagen, datos.imagen);
});
