"use strict";
// Padrón de las peñas contra Postgres real: carga idempotente (con y sin cédula), vínculo con las cuentas y la primera peña manda.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { armarPlan, aplicarPlan } = require("../lib/penas-padron");

let admin, nombreDb, pg, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_pmb_" + crypto.randomBytes(4).toString("hex");
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

test("pg: carga del padrón idempotente, miembros sin cédula incluidos, vínculo con la cuenta y la primera peña manda", opts, async () => {
  const filas = [
    ["Peña Uno", "Ana Pérez", "10", "1234567", "AL DÍA"],
    ["Peña Uno", "Beto Gómez", "", "", "EN MORA"],
    ["Peña Uno", "Carla Díaz", "12", "2222222", "SIN DATO"],
    ["Peña Dos", "Ana Pérez", "10", "1234567", "EN MORA"],
    ["Peña Dos", "Dario Sosa", "", "", "AL DÍA"],
  ];
  const cuenta = await pg.createSocio({ email: "ana@ejemplo.com", passwordHash: "x", nombre: "Ana" });
  await pg.updateSocio(cuenta.id, { cedula: "1.234.567" });                  // con puntos: se vincula igual
  const plan = armarPlan(filas);
  const r1 = await aplicarPlan(pg, plan, { fuente: "test" });
  assert.deepStrictEqual([r1.penas_creadas, r1.miembros_nuevos, r1.miembros_actualizados], [2, 5, 0]);
  assert.strictEqual(r1.vinculados, 2);
  assert.strictEqual(r1.asignados, 1);
  const uno = (await pg.listPenas()).find((p) => p.nombre === "Peña Uno");
  assert.strictEqual((await pg.getSocioById(cuenta.id)).pena_id, uno.id, "la primera del informe");
  assert.strictEqual(uno.estado, "verificada");
  assert.deepStrictEqual([uno.miembros, uno.vinculados, uno.altas, uno.hinchada], [3, 1, 1, 3]);

  const r2 = await aplicarPlan(pg, plan, { fuente: "test" });
  assert.deepStrictEqual([r2.penas_creadas, r2.miembros_nuevos, r2.miembros_actualizados], [0, 0, 5], "idempotente, también sin cédula");
  const dos = (await pg.listPenas()).find((p) => p.nombre === "Peña Dos");
  assert.strictEqual(dos.miembros, 2);
  assert.deepStrictEqual((await pg.resumenMiembrosPena()).filter((x) => x.pena_id === uno.id).map((x) => [x.al_dia, x.en_mora, x.sin_dato, x.con_cuenta]), [[1, 1, 1, 1]]);
  const lista = await pg.listarMiembrosPena(uno.id);
  assert.strictEqual(lista.length, 3);
  assert.strictEqual(lista.find((m) => m.nombre === "Ana Pérez").es_su_pena, true);
  assert.strictEqual(lista.find((m) => m.nombre === "Ana Pérez").socio_id, cuenta.id);

  // la cédula se carga después → se suma sola
  const dario = await pg.createSocio({ email: "dario@ejemplo.com", passwordHash: "x", nombre: "Dario" });
  await pg.updateSocio(dario.id, { cedula: "2222222" });
  const r3 = await pg.sincronizarMiembrosPena({ socioId: dario.id });
  assert.strictEqual(r3.asignados, 1);
  assert.strictEqual((await pg.getSocioById(dario.id)).pena_id, uno.id);
  // una peña pendiente no recibe a nadie por el padrón
  const pend = await pg.crearPena({ nombre: "Pendiente", ciudad: "X", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" });
  await pg.importarMiembrosPena(pend.id, [{ cedula: "3333333", nombre: "Elena", nro_socio: "", estado_cuota: "al_dia", orden: 0 }], "test");
  const elena = await pg.createSocio({ email: "elena@ejemplo.com", passwordHash: "x", nombre: "Elena" });
  await pg.updateSocio(elena.id, { cedula: "3333333" });
  assert.strictEqual((await pg.sincronizarMiembrosPena({ socioId: elena.id })).asignados, 0);
});
