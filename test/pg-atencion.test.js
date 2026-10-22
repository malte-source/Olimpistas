"use strict";
// Atención contra Postgres real (TEST_DATABASE_URL): el mismo escenario corre en memory-store para que los dos
// se comporten igual, y la unicidad de "una conversación abierta por hincha y canal" se prueba con concurrencia real.
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
  nombreDb = "t_atc_" + crypto.randomBytes(4).toString("hex");
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
const tiempo = (v) => new Date(v).getTime();

test("0008: tablas, restricciones y configuración inicial (liberar_lugar apagada)", opts, async () => {
  const t = (await pg._sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('atencion_conversaciones','atencion_mensajes','atencion_config','atencion_uso')`).length;
  assert.strictEqual(t, 4);
  assert.deepStrictEqual(await pg.getAtencionConfig(), { consultar_cuenta: true, listar_beneficios: true, liberar_lugar: false, abrir_pago_subasta: true, derivar_a_humano: true });
  assert.deepStrictEqual(await pg.getAtencionConfig(), await mem.getAtencionConfig(), "mismo valor inicial en memoria");
  const s = await mkSocio(pg), c = await pg.abrirConversacionAtencion({ socioId: s.id });
  await assert.rejects(() => pg._sql`UPDATE atencion_conversaciones SET estado = 'zzz' WHERE id = ${c.id}`, "estado válido");
  await assert.rejects(() => pg._sql`INSERT INTO atencion_conversaciones (id, canal) VALUES ('x1', 'telegrama')`, "canal válido");
  await assert.rejects(() => pg._sql`INSERT INTO atencion_mensajes (id, conversacion_id, de, texto) VALUES ('m1', ${c.id}, 'robot', 'x')`, "emisor válido");
});

test("pg: 12 mensajes simultáneos del mismo hincha → UNA sola conversación abierta", opts, async () => {
  const s = await mkSocio(pg);
  const res = await Promise.all(Array.from({ length: 12 }, () => pg.abrirConversacionAtencion({ socioId: s.id, canal: "app" })));
  assert.strictEqual(new Set(res.map((c) => c.id)).size, 1);
  assert.strictEqual((await pg._sql`SELECT count(*)::int AS n FROM atencion_conversaciones WHERE socio_id = ${s.id}`)[0].n, 1);
  const wa = await pg.abrirConversacionAtencion({ socioId: s.id, canal: "whatsapp" });
  assert.notStrictEqual(wa.id, res[0].id, "otro canal, otra conversación");
  await pg.cambiarEstadoAtencion(res[0].id, { desde: ["ia"], a: "resuelta", patch: { resuelta_en: new Date().toISOString() } });
  const nueva = await pg.abrirConversacionAtencion({ socioId: s.id, canal: "app" });
  assert.notStrictEqual(nueva.id, res[0].id, "resuelta la anterior, se abre una nueva");
});

test("pg: derivar y resolver son atómicos: de 10 intentos simultáneos solo uno cambia el estado", opts, async () => {
  const s = await mkSocio(pg), c = await pg.abrirConversacionAtencion({ socioId: s.id });
  const ahora = new Date().toISOString();
  const r = await Promise.all(Array.from({ length: 10 }, () => pg.cambiarEstadoAtencion(c.id, { desde: ["ia"], a: "humano", patch: { motivo: "x", derivada_en: ahora } })));
  assert.strictEqual(r.filter(Boolean).length, 1);
  const rr = await Promise.all(Array.from({ length: 10 }, () => pg.cambiarEstadoAtencion(c.id, { desde: ["ia", "humano"], a: "resuelta", patch: { resuelta_en: ahora } })));
  assert.strictEqual(rr.filter(Boolean).length, 1);
  assert.strictEqual(await pg.cambiarEstadoAtencion(c.id, { desde: ["ia", "humano"], a: "resuelta" }), null, "ya resuelta");
});

// El mismo guion en los dos stores: tienen que devolver lo mismo.
async function escenario(store) {
  const rango = { desdeDia: new Date(Date.now() - 3600000).toISOString(), desde7: new Date(Date.now() - 7 * 86400000).toISOString() };
  const ind0 = await store.indicadoresAtencion(rango);
  const a = await mkSocio(store, { nombre: "Ana", apellido: "Gómez", ciudad: "Luque" }), b = await mkSocio(store, { nombre: "Beto" });
  const ca = await store.abrirConversacionAtencion({ socioId: a.id });
  const cb = await store.abrirConversacionAtencion({ socioId: b.id, canal: "whatsapp" });
  await store.addMensajeAtencion({ conversacionId: ca.id, de: "hincha", texto: "hola" });
  await store.addMensajeAtencion({ conversacionId: ca.id, de: "ia", texto: "¿en qué te ayudo?", meta: { via: "ia" } });
  await store.addMensajeAtencion({ conversacionId: ca.id, de: "tarjeta", texto: "Te paso con una persona del club", meta: { tipo: "derivado" } });
  await store.addMensajeAtencion({ conversacionId: cb.id, de: "hincha", texto: "buenas" });
  const derivada = new Date(Date.now() - 20 * 60000).toISOString();
  await store.cambiarEstadoAtencion(ca.id, { desde: ["ia"], a: "humano", patch: { motivo: "Reclamo", resumen: "Reclamo · Olimpista · Luque", derivada_en: derivada } });
  await store.updateConversacionAtencion(ca.id, { asignado_a: "sofia", humano_responde_en: new Date(Date.now() - 10 * 60000).toISOString() });
  await store.addMensajeAtencion({ conversacionId: ca.id, de: "humano", texto: "Hola Ana", meta: { agente: "sofia" } });
  const msgs = await store.listMensajesAtencion(ca.id);
  const bandeja = await store.listBandejaAtencion({});
  const filaA = bandeja.find((c) => c.id === ca.id), filaB = bandeja.find((c) => c.id === cb.id);
  const ind = await store.indicadoresAtencion(rango);
  return {
    orden: msgs.map((m) => m.de),
    meta: JSON.parse(msgs[1].meta),
    ultimoA: filaA.ultimo, nA: filaA.n_mensajes, nombreA: [filaA.socio_nombre, filaA.socio_apellido, filaA.socio_ciudad || ""],
    ultimoB: filaB.ultimo, canalB: filaB.canal,
    estados: [filaA.estado, filaB.estado], motivo: filaA.motivo, asignado: filaA.asignado_a,
    filtro: (await store.listBandejaAtencion({ estado: "humano" })).some((c) => c.id === ca.id),
    filtroIa: (await store.listBandejaAtencion({ estado: "ia" })).some((c) => c.id === ca.id),
    ind: { solo_ia: ind.solo_ia - ind0.solo_ia, semana: ind.semana - ind0.semana, hoy: ind.hoy - ind0.hoy, humano: ind.abiertas_humano - ind0.abiertas_humano },
    resp: ind.primera_resp_min,
    deSocio: (await store.listConversacionesDeSocio(a.id)).map((c) => c.id === ca.id),
    abiertaDe: (await store.getConversacionAbiertaAtencion(a.id, "app")).id === ca.id,
  };
}
test("contrato: memory-store y Postgres devuelven lo mismo (orden, última línea, nombres, canal, indicadores)", opts, async () => {
  const [m, p] = [await escenario(mem), await escenario(pg)];
  assert.deepStrictEqual(m, p);
  assert.deepStrictEqual(p.orden, ["hincha", "ia", "tarjeta", "humano"]);
  assert.strictEqual(p.ultimoA, "Hola Ana", "la tarjeta no cuenta como último mensaje");
  assert.strictEqual(p.nA, 4);
  assert.deepStrictEqual(p.ind, { solo_ia: 1, semana: 2, hoy: 2, humano: 1 }, "dos conversaciones nuevas: una la atendió solo la IA, otra pasó a una persona");
  assert.ok(p.resp >= 9 && p.resp <= 11, "primera respuesta ≈ 10 min: " + p.resp);
});

test("contrato: configuración del asistente y tope diario (contador atómico) idénticos en los dos stores", opts, async () => {
  for (const st of [mem, pg]) {
    await st.setAtencionConfig("listar_beneficios", false);
    assert.strictEqual((await st.getAtencionConfig()).listar_beneficios, false);
    await st.setAtencionConfig("listar_beneficios", true);
    assert.strictEqual((await st.getAtencionConfig()).listar_beneficios, true);
  }
  const s = await mkSocio(pg), dia = "2026-10-21";
  const res = await Promise.all(Array.from({ length: 20 }, () => pg.incrementarUsoAtencion(s.id, dia)));
  assert.deepStrictEqual(res.slice().sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1), "cada incremento recibe un número distinto: ningún mensaje se cuela sin contar");
  assert.strictEqual(await pg.incrementarUsoAtencion(s.id, "2026-10-22"), 1, "otro día, contador nuevo");
  const sm = await mkSocio(mem);
  assert.strictEqual(await mem.incrementarUsoAtencion(sm.id, dia), 1);
  assert.strictEqual(await mem.incrementarUsoAtencion(sm.id, dia), 2);
});

test("pg: borrar un hincha no borra la conversación (queda sin dueño) y borrar la conversación borra sus mensajes", opts, async () => {
  const s = await mkSocio(pg), c = await pg.abrirConversacionAtencion({ socioId: s.id });
  await pg.addMensajeAtencion({ conversacionId: c.id, de: "hincha", texto: "hola" });
  await pg._sql`DELETE FROM socios WHERE id = ${s.id}`;
  const c2 = await pg.getConversacionAtencion(c.id);
  assert.strictEqual(c2.socio_id, null);
  assert.strictEqual((await pg.listMensajesAtencion(c.id)).length, 1);
  await pg._sql`DELETE FROM atencion_conversaciones WHERE id = ${c.id}`;
  assert.strictEqual((await pg._sql`SELECT count(*)::int AS n FROM atencion_mensajes WHERE conversacion_id = ${c.id}`)[0].n, 0);
  assert.ok(tiempo(c2.creado) > 0);
});
