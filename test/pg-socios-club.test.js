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

test("historial del club y hitos del socio: mismo resultado en Postgres y en memoria", opts, async () => {
  async function caso(store, ced, correo) {
    const e = (estado, deuda = 0) => ({ estado, deuda, alDia: estado === "ACTIVE", plan: "S", numero: "1" });
    const desde = new Date(Date.now() - 3600000).toISOString();
    const r0 = await store.resumenHistorialClub({ desde }), c0 = (await store.cohortesDeAlta({ semanas: 2 }))[0] || { registrados: 0, canjearon: 0 };   // la base de pruebas ya tiene otros datos: se mide la diferencia
    await store.guardarEstadoTuti(ced, e("ACTIVE")); await store.guardarEstadoTuti(ced, e("ACTIVE")); await store.guardarEstadoTuti(ced, e("DEBT", 5000)); await store.guardarEstadoTuti(ced, e("DEBT", 4000)); await store.guardarEstadoTuti(ced, e("ACTIVE"));
    const h = (await store.historialClubDeCedula(ced)).map((x) => [x.clase, x.deuda, !!x.hasta, !!x.inicial]);
    const s = await store.createSocio({ email: correo, passwordHash: "x", nombre: "E" });
    await store.registrarEvento(s.id, "registro"); await store.registrarEvento(s.id, "registro"); await store.registrarEvento(s.id, "primer_canje"); await store.registrarEvento(s.id, "nivel_socio_pausado", { motivo: "mora" }); await store.registrarEvento(s.id, "nivel_socio_pausado", { motivo: "baja" });
    const ev = (await store.eventosDeSocio(s.id)).map((x) => x.tipo).sort();
    const r = await store.resumenHistorialClub({ desde });
    const c = (await store.cohortesDeAlta({ semanas: 2 }))[0];
    return { h, ev, r: [r.entraron_mora - r0.entraron_mora, r.entraron_baja - r0.entraron_baja, r.volvieron_al_dia - r0.volvieron_al_dia, r.dias_medios_en_mora !== null], c: [c.registrados - c0.registrados, c.canjearon - c0.canjearon] };
  }
  const esperado = { h: [["al_dia", 0, false, false], ["mora", 4000, true, false], ["al_dia", 0, true, false]], ev: ["nivel_socio_pausado", "nivel_socio_pausado", "primer_canje", "registro"], r: [1, 0, 1, true], c: [1, 1] };
  assert.deepStrictEqual(await caso(pg, "9300001", "hp@ejemplo.com"), esperado, "Postgres");
  assert.deepStrictEqual(await caso(mem, "9300001", "hm@ejemplo.com"), esperado, "memoria");
});

test("agregados de los tableros (ingresos, altas, canjes, nivel Socio, peñas): mismo resultado en Postgres y en memoria", opts, async () => {
  async function caso(store, tag) {
    const desde = new Date(Date.now() - 86400000).toISOString(), hasta = new Date(Date.now() + 60000).toISOString();
    const antes = { i: await store.ingresosEntre({ desde, hasta }), a: await store.altasEntre({ desde, hasta }), c: await store.resumenCanjesEntre({ desde, hasta }), n: await store.resumenNivelClub() };
    const s = await store.createSocio({ email: `agg-${tag}@ejemplo.com`, passwordHash: "x", nombre: "A" });
    const p = await store.createPedidoPago({ socioId: s.id, concepto: "Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio" });
    await store.updatePedidoPago(p.id, { estado: "pagado", pagado_en: new Date().toISOString() });
    const co = await store.crearComercio({ nombre: "Agg " + tag, ciudad: "Asunción", contacto: "a@ejemplo.com" });
    const b = await store.crearBeneficio({ comercio_id: co.id, titulo: "Agg", valor: "10%", pct: 10, niveles: "todos", estado: "aprobado", activo: true });
    await store.canjearBeneficio({ beneficioId: b.id, socioId: s.id, comercioId: co.id, validadoPor: "t", monto: 100000, ahorro: 10000, tierSlug: "olimpista" });
    await store.updateSocio(s.id, { club_estado: "mora", club_deuda: 70000, es_socio_olimpia: false });
    const pe = await store.crearPena({ nombre: "Peña Agg " + tag, ciudad: "Asunción", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" });
    await store.updatePena(pe.id, { estado: "verificada" });
    await store.updateSocio(s.id, { pena_id: pe.id });
    const d = { i: await store.ingresosEntre({ desde, hasta }), a: await store.altasEntre({ desde, hasta }), c: await store.resumenCanjesEntre({ desde, hasta }), n: await store.resumenNivelClub() };
    const mi = (await store.actividadPenas({ desde })).find((x) => x.id === pe.id);
    return { ingresos: [d.i.total - antes.i.total, d.i.n - antes.i.n], altas: d.a - antes.a, canjes: [d.c.canjes - antes.c.canjes, d.c.ahorro - antes.c.ahorro, d.c.monto - antes.c.monto], mora: [d.n.pausados_mora - antes.n.pausados_mora, d.n.deuda_en_mora - antes.n.deuda_en_mora], pena: mi && [mi.altas, mi.total] };
  }
  const esperado = { ingresos: [180000, 1], altas: 1, canjes: [1, 10000, 100000], mora: [1, 70000], pena: [1, 1] };
  assert.deepStrictEqual(await caso(pg, "pg"), esperado, "Postgres");
  assert.deepStrictEqual(await caso(mem, "mem"), esperado, "memoria");
});

test("anular un canje: se borra, vuelve el cupo y queda el registro; el plazo y el dueño se respetan (Postgres = memoria)", opts, async () => {
  async function caso(store, tag) {
    const s = await store.createSocio({ email: `an-${tag}@ejemplo.com`, passwordHash: "x", nombre: "A" });
    const co = await store.crearComercio({ nombre: "An " + tag, ciudad: "Asunción", contacto: "a@ejemplo.com" }), otro = await store.crearComercio({ nombre: "Otro " + tag, ciudad: "Asunción", contacto: "o@ejemplo.com" });
    const b = await store.crearBeneficio({ comercio_id: co.id, titulo: "An", valor: "10%", pct: 10, niveles: "todos", estado: "aprobado", activo: true });
    await store.updateBeneficio(b.id, { stock: 3 });
    const r = await store.canjearBeneficio({ beneficioId: b.id, socioId: s.id, comercioId: co.id, validadoPor: "t", monto: 100000, ahorro: 10000, tierSlug: "olimpista" });
    const stock1 = (await store.getBeneficio(b.id)).stock;
    const desde = new Date(Date.now() - 60000).toISOString(), hasta = new Date(Date.now() + 60000).toISOString();
    const antesAnulados = await store.contarCanjesAnulados({ desde, hasta });
    const ajeno = await store.anularCanje({ canjeId: r.canje.id, comercioId: otro.id, motivo: "x", por: "t" });
    await new Promise((x) => setTimeout(x, 30));
    const tarde = await store.anularCanje({ canjeId: r.canje.id, comercioId: co.id, motivo: "x", por: "t", ventanaMin: 0.0001 });
    const ok = await store.anularCanje({ canjeId: r.canje.id, comercioId: co.id, motivo: "monto mal", por: "t", ventanaMin: 30 });
    const otraVez = await store.anularCanje({ canjeId: r.canje.id, comercioId: co.id, motivo: "x", por: "t" });
    return { stock1, ajeno: ajeno.motivo, tarde: tarde.motivo, ok: ok.ok, otraVez: otraVez.motivo, stock2: (await store.getBeneficio(b.id)).stock, ahorro: (await store.resumenAhorroSocio(s.id)).total, anulados: (await store.contarCanjesAnulados({ desde, hasta })) - antesAnulados };
  }
  const esperado = { stock1: 2, ajeno: "no_existe", tarde: "fuera_de_plazo", ok: true, otraVez: "no_existe", stock2: 3, ahorro: 0, anulados: 1 };
  assert.deepStrictEqual(await caso(pg, "pg"), esperado, "Postgres");
  assert.deepStrictEqual(await caso(mem, "mem"), esperado, "memoria");
});

test("las cédulas con puntos o guiones también cruzan con la base del club (Postgres = memoria)", opts, async () => {
  async function caso(store) {
    const s = await store.createSocio({ email: "ced-puntos@ejemplo.com", passwordHash: "x", nombre: "P", cedula: "7.000.001" });
    await store.updateSocio(s.id, { es_socio_olimpia: true });
    await store.upsertSociosClub([reg("7000001", { socio_desde: "2011-01-01", fecha_calidad: "creible", fecha_fuente: "ingreso", nro_socio: "77" })]);
    await store.completarSociosDesdeClub();
    const x = await store.getSocioById(s.id);
    return [String(x.socio_desde).slice(0, 10), x.nro_socio];
  }
  assert.deepStrictEqual(await caso(pg), ["2011-01-01", "77"], "Postgres");
  assert.deepStrictEqual(await caso(mem), ["2011-01-01", "77"], "memoria");
});

test("fechas dudosas: se quita la que puso el sistema, no la declarada ni la de un admin, y no se inventa la de la membresía (Postgres = memoria)", opts, async () => {
  async function caso(store) {
    const mk = async (email, ced, extra) => { const s = await store.createSocio({ email, passwordHash: "x", nombre: "N", cedula: ced }); await store.updateSocio(s.id, { es_socio_olimpia: true, ...extra }); return s.id; };
    await store.upsertSociosClub([reg("6000001", { grupo: "VITALICIO", fecha_fuente: "dudosa" }), reg("6000002", { grupo: "VITALICIO", fecha_fuente: "dudosa" }), reg("6000003", { grupo: "VITALICIO", fecha_fuente: "dudosa" }), reg("6000004", { grupo: "VITALICIO", fecha_fuente: "dudosa" }), reg("6000005", { socio_desde: "2015-02-02", fecha_calidad: "creible", fecha_fuente: "ingreso" })]);
    const ids = [
      await mk("d1@ejemplo.com", "6000001", { socio_desde: "2001-08-26", socio_desde_fuente: "" }),
      await mk("d2@ejemplo.com", "6000002", { socio_desde: "2008-01-01", socio_desde_fuente: "declarada" }),
      await mk("d3@ejemplo.com", "6000003", { socio_desde: "2010-05-05", socio_desde_fuente: "admin" }),
      await mk("d4@ejemplo.com", "6000004", {}),
      await mk("d5@ejemplo.com", "6000005", {}),
    ];
    await store.setMembresia(ids[3], { tierSlug: "socio", ciclo: "anio", pagoRef: "socio:t" });
    const r = await store.completarSociosDesdeClub();
    const f = async (id) => String((await store.getSocioById(id)).socio_desde || "").slice(0, 10);
    return { quitadas: r.dudosas_quitadas, fechas: [await f(ids[0]), await f(ids[1]), await f(ids[2]), await f(ids[3]), await f(ids[4])] };
  }
  const esperado = { quitadas: 1, fechas: ["", "2008-01-01", "2010-05-05", "", "2015-02-02"] };
  assert.deepStrictEqual(await caso(pg), esperado, "Postgres");
  assert.deepStrictEqual(await caso(mem), esperado, "memoria");
});
