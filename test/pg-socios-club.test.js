"use strict";
// Base del club en Postgres real y en memoria: misma carga, mismo orden de consulta, mismo resumen.
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
  nombreDb = "t_club_" + crypto.randomBytes(4).toString("hex");
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

const reg = (cedula, extra = {}) => ({ cedula, grupo: "PERSONAL", nro_socio: "", socio_desde: null, fecha_calidad: "sin_fecha", antig_anios: null, meses_pagados: 0, activo_erp: true, nombre: "", correo: "", telefono: "", nacimiento: null, ...extra });
async function sembrar(store) {
  await store.createSocio({ email: "cuenta-a@ejemplo.com", passwordHash: "x", nombre: "A", cedula: "1000001" });
  await store.createSocio({ email: "cuenta-b@ejemplo.com", passwordHash: "x", nombre: "B" });
  await store.upsertSociosClub([
    reg("1000001", { socio_desde: "2010-01-01", fecha_calidad: "creible", nro_socio: "12", grupo: "ESTADIO", nacimiento: "1980-05-05", antig_anios: 12.5, meses_pagados: 24 }),
    reg("2000002", { correo: "cuenta-b@ejemplo.com" }),
    reg("2000005", { grupo: "FAMILIAR" }),
    reg("2000006"),
  ]);
}

test("carga, orden de consulta y resumen: igual en Postgres y en memoria", opts, async () => {
  await sembrar(pg); await sembrar(mem);
  const op = await pg.siguientesParaConsultar({ limite: 10 }), om = await mem.siguientesParaConsultar({ limite: 10 });
  assert.deepStrictEqual(op, ["1000001", "2000002", "2000006", "2000005"]);
  assert.deepStrictEqual(om, op);
  for (const st of [pg, mem]) {
    await st.guardarEstadoTuti("1000001", { estado: "ACTIVE", plan: "Socio Pleno", numero: "12", alDia: true, deuda: 0 });
    await st.guardarEstadoTuti("2000002", { estado: "NO_ENCONTRADO" });
    await st.guardarEstadoTuti("9999999", { estado: "DEBT", plan: "Socio", numero: "1", alDia: true, deuda: 50000 });   // cédula de la app que no está en el archivo
  }
  const a = await pg.getSocioClub("1000001"), b = await mem.getSocioClub("1000001");
  for (const k of ["grupo", "nro_socio", "fecha_calidad", "tuti_estado", "tuti_plan", "tuti_numero", "tuti_al_dia", "tuti_deuda", "activo_erp", "en_base"]) assert.deepStrictEqual([k, a[k]], [k, b[k]]);
  assert.strictEqual(String(a.socio_desde).slice(0, 10), "2010-01-01");
  assert.strictEqual((await pg.getSocioClub("9999999")).en_base, false);
  assert.strictEqual((await pg.getSocioClub("0000000")), null);
  const sp = await pg.resumenSociosClub(), sm = await mem.resumenSociosClub();
  const forma = (r) => ({ total: r.total, en_base: r.en_base, consultados: r.consultados, pendientes: r.pendientes, con_socio_desde: r.con_socio_desde, estados: [...r.estados].sort((x, y) => x.estado.localeCompare(y.estado)), reco: r.cuentas_para_reconocer });
  assert.deepStrictEqual(forma(sp), forma(sm));
  assert.deepStrictEqual(forma(sp), { total: 5, en_base: 4, consultados: 3, pendientes: 2, con_socio_desde: 1, estados: [{ estado: "ACTIVE", n: 1 }, { estado: "DEBT", n: 1 }, { estado: "NO_ENCONTRADO", n: 1 }], reco: 1 });
});

test("volver a cargar no duplica ni pisa el estado ya consultado; el estado guardado cuenta los intentos", opts, async () => {
  await pg.upsertSociosClub([reg("1000001", { grupo: "VITALICIO", nro_socio: "99" })]);
  const a = await pg.getSocioClub("1000001");
  assert.deepStrictEqual([a.grupo, a.nro_socio, a.tuti_estado, a.tuti_al_dia], ["VITALICIO", "99", "ACTIVE", true]);
  assert.strictEqual((await pg.resumenSociosClub()).total, 5);
  await pg.guardarEstadoTuti("1000001", { estado: "ACTIVE", alDia: true });
  assert.strictEqual((await pg.getSocioClub("1000001")).tuti_intentos, 2);
});

test("la consulta en lote del importador carga 2.500 filas en trozos sin perder ninguna", opts, async () => {
  const filas = Array.from({ length: 2500 }, (_, i) => reg(String(7000000 + i), { correo: i % 3 === 0 ? `masivo${i}@ejemplo.com` : "" }));
  assert.strictEqual(await pg.upsertSociosClub(filas), 2500);
  assert.strictEqual((await pg.resumenSociosClub()).total, 5 + 2500);
});
