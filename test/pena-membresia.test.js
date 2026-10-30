"use strict";
// Membresía de peña de los dos lados: una sola peña por socio y se entra cuando aceptan el socio Y la peña.
// El mismo escenario corre en memory-store y en Postgres real (TEST_DATABASE_URL) para que los dos almacenes den lo mismo.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { createMemoryStore } = require("../data/memory-store");

let admin, nombreDb, pg, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_psl_" + crypto.randomBytes(4).toString("hex");
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

let n = 0;
const peña = async (s, nombre) => { const p = await s.crearPena({ nombre: nombre + " " + (++n), ciudad: "Asunción", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" }); await s.updatePena(p.id, { estado: "verificada" }); return p; };
const cuenta = async (s, cedula = "") => { const x = await s.createSocio({ email: `pm${++n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Persona" }); if (cedula) await s.updateSocio(x.id, { cedula }); return x; };
const penaDe = async (s, id) => (await s.getSocioById(id)).pena_id || null;

async function escenario(s) {
  const A = await peña(s, "Peña A"), B = await peña(s, "Peña B");

  // 1. Pide el socio → pendiente; la peña acepta → entra. Quien pidió no se acepta a sí mismo.
  const ana = await cuenta(s);
  const p1 = await s.pedirPena({ socioId: ana.id, penaId: A.id, origen: "socio" });
  assert.strictEqual(p1.estado, "pendiente");
  assert.strictEqual(await penaDe(s, ana.id), null, "pedir no alcanza");
  assert.strictEqual((await s.pedirPena({ socioId: ana.id, penaId: A.id, origen: "socio" })).solicitud.id, p1.solicitud.id, "pedir dos veces no duplica");
  assert.strictEqual((await s.resolverSolicitudPena({ id: p1.solicitud.id, por: "socio", aceptar: true })).motivo, "no_corresponde");
  assert.strictEqual((await s.solicitudesPena(A.id)).length, 1);
  assert.strictEqual((await s.resolverSolicitudPena({ id: p1.solicitud.id, por: "pena", aceptar: true })).estado, "aceptada");
  assert.strictEqual(await penaDe(s, ana.id), A.id);
  assert.strictEqual((await s.resolverSolicitudPena({ id: p1.solicitud.id, por: "pena", aceptar: true })).motivo, "ya_resuelta", "no se resuelve dos veces");

  // 2. Una sola peña: con peña no se pide otra ni se la invita.
  assert.strictEqual((await s.pedirPena({ socioId: ana.id, penaId: B.id, origen: "socio" })).error, "ya_tiene");
  assert.strictEqual((await s.pedirPena({ socioId: ana.id, penaId: A.id, origen: "socio" })).error, "ya_es");
  assert.strictEqual((await s.pedirPena({ socioId: ana.id, penaId: B.id, origen: "pena" })).error, "ya_tiene");

  // 3. Un pedido nuevo reemplaza al anterior (una sola solicitud pendiente por persona); rechazar o retirar libera.
  const beto = await cuenta(s);
  const a = await s.pedirPena({ socioId: beto.id, penaId: A.id, origen: "socio" });
  const b = await s.pedirPena({ socioId: beto.id, penaId: B.id, origen: "socio" });
  assert.strictEqual((await s.solicitudPenaPendiente(beto.id)).pena_id, B.id);
  assert.strictEqual((await s.getSolicitudPena(a.solicitud.id)).estado, "cancelada");
  assert.strictEqual((await s.solicitudesPena(A.id)).length, 0);
  assert.strictEqual((await s.resolverSolicitudPena({ id: b.solicitud.id, por: "pena", aceptar: false })).estado, "rechazada");
  assert.strictEqual(await s.solicitudPenaPendiente(beto.id), null);
  const c = await s.pedirPena({ socioId: beto.id, penaId: A.id, origen: "socio" });
  assert.strictEqual((await s.resolverSolicitudPena({ id: c.solicitud.id, por: "socio", aceptar: false })).estado, "cancelada", "quien pidió lo retira");

  // 4. Si la peña ya lo tiene en su padrón (misma cédula) valen las dos aceptaciones y entra directo.
  await s.importarMiembrosPena(A.id, [{ cedula: "4444444", nombre: "Carla", nro_socio: "", estado_cuota: "al_dia", orden: 0 }], "test");
  const carla = await cuenta(s, "4.444.444");
  assert.strictEqual((await s.pedirPena({ socioId: carla.id, penaId: B.id, origen: "socio" })).estado, "pendiente", "en el padrón de otra peña no alcanza");
  assert.strictEqual((await s.pedirPena({ socioId: carla.id, penaId: A.id, origen: "socio" })).estado, "aceptada");
  assert.strictEqual(await penaDe(s, carla.id), A.id);

  // 5. El padrón INVITA: la persona confirma. Quien rechaza no se vuelve a invitar a esa peña; quien ya tiene peña o un pedido, no recibe invitaciones.
  await s.importarMiembrosPena(B.id, [{ cedula: "5555555", nombre: "Dario", nro_socio: "", estado_cuota: "sin_dato", orden: 0 }, { cedula: "6666666", nombre: "Eva", nro_socio: "", estado_cuota: "sin_dato", orden: 1 }], "test");
  const dario = await cuenta(s, "5555555"), eva = await cuenta(s, "6666666");
  const pedidoEva = await s.pedirPena({ socioId: eva.id, penaId: A.id, origen: "socio" });
  const r1 = await s.sincronizarMiembrosPena();
  assert.ok(r1.invitados >= 1);
  const inv = await s.solicitudPenaPendiente(dario.id);
  assert.deepStrictEqual([inv.origen, inv.pena_id], ["pena", B.id]);
  assert.strictEqual((await s.solicitudPenaPendiente(eva.id)).id, pedidoEva.solicitud.id, "su pedido propio no se pisa con una invitación");
  assert.strictEqual(await penaDe(s, dario.id), null, "invitar no alcanza: falta que confirme");
  assert.strictEqual((await s.solicitudesPena(B.id)).filter((x) => x.origen === "pena").length, 1);
  assert.strictEqual((await s.sincronizarMiembrosPena()).invitados, 0, "repetir no duplica invitaciones");
  assert.strictEqual((await s.resolverSolicitudPena({ id: inv.id, por: "socio", aceptar: false })).estado, "rechazada");
  assert.strictEqual((await s.sincronizarMiembrosPena()).invitados, 0, "quien rechazó no se vuelve a invitar");
  assert.strictEqual(await s.solicitudPenaPendiente(dario.id), null);
  const invB = await s.pedirPena({ socioId: dario.id, penaId: B.id, origen: "pena" });
  assert.strictEqual((await s.resolverSolicitudPena({ id: invB.solicitud.id, por: "socio", aceptar: true })).estado, "aceptada");
  assert.strictEqual(await penaDe(s, dario.id), B.id);

  // 6. Dejar una peña (la limpia) no vuelve a invitar a esa misma peña desde el padrón.
  await s.updateSocio(dario.id, { pena_id: null });
  assert.strictEqual((await s.sincronizarMiembrosPena()).invitados, 0);

  // 7. En carrera: 10 pedidos a la vez de la misma persona a peñas distintas dejan UNA sola pendiente y una sola peña al aceptar.
  const [P1, P2, P3] = [await peña(s, "Peña C1"), await peña(s, "Peña C2"), await peña(s, "Peña C3")];
  const fede = await cuenta(s);
  await Promise.all(Array.from({ length: 10 }, (_, i) => s.pedirPena({ socioId: fede.id, penaId: [P1, P2, P3][i % 3].id, origen: "socio" })));
  const pend = await s.solicitudPenaPendiente(fede.id);
  assert.ok(pend);
  const res = await Promise.all(Array.from({ length: 6 }, () => s.resolverSolicitudPena({ id: pend.id, por: "pena", aceptar: true })));
  assert.strictEqual(res.filter((x) => x.ok).length, 1, "se acepta una sola vez");
  assert.strictEqual(await penaDe(s, fede.id), pend.pena_id);
}

test("membresía de peña de los dos lados · memory-store", async () => { await escenario(createMemoryStore({ filePath: null })); });
test("membresía de peña de los dos lados · Postgres", opts, async () => { await escenario(pg); });
