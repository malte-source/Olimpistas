"use strict";
// Limpieza de la base de socios del club antes de cargarla (filas sintéticas: sin datos reales).
const { test } = require("node:test");
const assert = require("node:assert");
const ci = require("../lib/club-import");

const HOY = Date.UTC(2026, 9, 24);
const d = (s) => new Date(s + "T00:00:00Z");
const fila = (o = {}) => ({
  "Nombre SN": "JUAN PEREZ", "Tipo Identificación Fiscal": "CEDULA", "Número de identificación fiscal": 1234567, "Correo electrónico": "Juan@Ejemplo.com", "Teléfono 1": "0981123456",
  "Nombre de grupo": "PERSONAL", "Numero Socio": 100, "Fecha ingreso Socio": d("2014-05-10"), Activo: "Y", Fecha_Nacimiento: d("1985-03-02"),
  "Año Primer Registro Cuota": 2017, "Antigüedad Base (Años)": 3, "Meses Pagados por Cuotas": 24, "Antigüedad Total (Años)": 5, ...o,
});

test("claveCedula: número sin ceros, RUC sin dígito verificador, y descarta lo que no es una cédula", () => {
  assert.strictEqual(ci.claveCedula(1234567), "1234567");
  assert.strictEqual(ci.claveCedula("1.234.567"), "1234567");
  assert.strictEqual(ci.claveCedula("0001234567"), "1234567");
  assert.strictEqual(ci.claveCedula("1234567-8"), "1234567", "RUC: la cédula es lo anterior al guion");
  assert.strictEqual(ci.claveCedula("80012345-6"), "80012345");
  for (const mala of [123, "1234", "AB123456", "P1234567", d("2020-01-01"), null, undefined, "", "1234567890123"]) assert.strictEqual(ci.claveCedula(mala), "", String(mala));
});

test("normalizaciones: nombre propio, teléfono de Paraguay, correo y nacimiento", () => {
  assert.strictEqual(ci.nombrePropio("  JUAN   CARLOS  de la CRUZ "), "Juan Carlos De La Cruz");
  assert.strictEqual(ci.nombrePropio("o'brien-pérez"), "O'Brien-Pérez");
  assert.strictEqual(ci.nombrePropio(12345), "");
  assert.strictEqual(ci.telefono("0981 123 456"), "+595981123456");
  assert.strictEqual(ci.telefono("981123456"), "+595981123456");
  assert.strictEqual(ci.telefono("595981123456"), "+595981123456");
  for (const mal of [0, "1", "123456", "021123456", null]) assert.strictEqual(ci.telefono(mal), "", String(mal));
  assert.strictEqual(ci.correo(" Ana@Gmail.COM "), "ana@gmail.com");
  assert.strictEqual(ci.correo("sin-arroba"), "");
  assert.strictEqual(ci.nacimiento(d("1990-01-01"), HOY), "1990-01-01");
  for (const mala of [d("1899-12-31"), d("9158-02-20"), d("1900-01-01"), "texto", null]) assert.strictEqual(ci.nacimiento(mala, HOY), "", String(mala));
});

test("calidad de la fecha de ingreso: solo la creíble se guarda como 'Socio desde'", () => {
  const masivos = new Set(["2020-02-08"]);
  const c = (f) => ci.calidadFecha(f, masivos, HOY);
  assert.strictEqual(c(d("2014-05-10")), "creible");
  assert.strictEqual(c(d("2020-02-08")), "carga_masiva");
  assert.strictEqual(c(d("1899-12-31")), "fecha_cero");
  assert.strictEqual(c(d("2026-11-05")), "futura");
  assert.strictEqual(c(d("1940-01-01")), "anterior_1950");
  assert.strictEqual(c(null), "sin_fecha");
  assert.strictEqual(c("texto"), "sin_fecha");
});

test("procesarFilas: excluye no-socios y cédulas inutilizables, resuelve repetidos y los días de carga masiva SÍ cuentan como fecha inicial", () => {
  const masivas = Array.from({ length: 300 }, (_, i) => fila({ "Número de identificación fiscal": 2000000 + i, "Fecha ingreso Socio": d("2020-02-08"), "Nombre SN": "MASIVO " + i, "Numero Socio": 9000 + i }));
  const filas = [
    fila(),                                                                                       // normal, creíble
    fila({ "Número de identificación fiscal": 1234567, "Nombre de grupo": "FAMILIAR", "Numero Socio": null, Activo: "Y" }),    // repetida de menor puntaje
    fila({ "Número de identificación fiscal": 3000001, "Nombre de grupo": "General No Socio" }),   // no es socio
    fila({ "Número de identificación fiscal": 3000002, "Nombre de grupo": "Sponsor" }),
    fila({ "Número de identificación fiscal": "123" }),                                            // marcador
    fila({ "Número de identificación fiscal": "4000001-3", "Nombre SN": "RUC PERSONA" }),         // RUC
    fila({ "Número de identificación fiscal": 5000001, "Fecha ingreso Socio": d("1899-12-31"), "Antigüedad Total (Años)": 124, "Año Primer Registro Cuota": 2019, "Numero Socio": 5001 }),  // fecha cero → año del primer registro de cuota
    fila({ "Número de identificación fiscal": 5000002, "Fecha ingreso Socio": null, Activo: "N", "Año Primer Registro Cuota": null, "Numero Socio": null }),   // sin ningún dato
    fila({ "Número de identificación fiscal": 6000001, "Fecha ingreso Socio": d("2012-03-15"), "Numero Socio": 7777, "Nombre de grupo": "PERSONAL" }),            // titular del plan
    fila({ "Número de identificación fiscal": 6000002, "Fecha ingreso Socio": null, "Año Primer Registro Cuota": null, "Numero Socio": 7777, "Nombre de grupo": "FAMILIAR" }), // adherente: hereda del plan
    ...masivas,
  ];
  const { registros, resumen } = ci.procesarFilas(filas, { hoy: HOY });
  const por = new Map(registros.map((r) => [r.cedula, r]));
  assert.strictEqual(resumen.descartadas.no_socio, 2);
  assert.strictEqual(resumen.descartadas.sin_cedula, 1);
  assert.strictEqual(resumen.descartadas.repetidas, 1);
  assert.ok(por.has("4000001"), "RUC reducida a la cédula");
  assert.ok(!por.has("3000001") && !por.has("3000002"));
  const normal = por.get("1234567");
  assert.deepStrictEqual({ grupo: normal.grupo, nro: normal.nro_socio, desde: normal.socio_desde, cal: normal.fecha_calidad, fuente: normal.fecha_fuente }, { grupo: "PERSONAL", nro: "100", desde: "2014-05-10", cal: "creible", fuente: "ingreso" }, "gana la fila del titular con número");
  assert.strictEqual(normal.nombre, "Juan Perez");
  assert.strictEqual(normal.correo, "juan@ejemplo.com");
  assert.strictEqual(normal.telefono, "+595981123456");
  assert.strictEqual(normal.nacimiento, "1985-03-02");
  // antigüedad: se calcula siempre desde "Socio desde" (2014-05-10 → 12,45 años al 2026-10-24)
  assert.ok(Math.abs(normal.antig_anios - 12.45) < 0.02, "antigüedad calculada: " + normal.antig_anios);
  // fecha cero: no inventa 124 años; usa el año del primer registro de cuota
  const cero = por.get("5000001");
  assert.deepStrictEqual({ desde: cero.socio_desde, cal: cero.fecha_calidad, fuente: cero.fecha_fuente }, { desde: "2019-01-01", cal: "fecha_cero", fuente: "primer_cuota" });
  assert.ok(cero.antig_anios > 7 && cero.antig_anios < 8);
  // sin ningún dato: queda sin fecha y se resuelve al validar la cuenta
  const nada = por.get("5000002");
  assert.deepStrictEqual({ activo: nada.activo_erp, desde: nada.socio_desde, fuente: nada.fecha_fuente, antig: nada.antig_anios }, { activo: false, desde: null, fuente: "sin_dato", antig: null });
  // plan familiar: el adherente sin fecha hereda la más antigua de su plan
  const adh = por.get("6000002");
  assert.deepStrictEqual({ desde: adh.socio_desde, fuente: adh.fecha_fuente }, { desde: "2012-03-15", fuente: "plan_familiar" });
  // días de carga masiva: la fecha cuenta como inicial (y queda marcada)
  const m = por.get("2000000");
  assert.deepStrictEqual({ desde: m.socio_desde, cal: m.fecha_calidad, fuente: m.fecha_fuente }, { desde: "2020-02-08", cal: "carga_masiva", fuente: "ingreso" });
  assert.strictEqual(resumen.calidad_fecha.carga_masiva, 300);
  assert.strictEqual(resumen.fuente_fecha.sin_dato, 1);
  assert.strictEqual(resumen.fuente_fecha.plan_familiar, 1);
  assert.strictEqual(resumen.fuente_fecha.primer_cuota, 1);
  assert.strictEqual(resumen.con_socio_desde, registros.length - 1, "todos tienen fecha salvo el que no tiene ningún dato");
});

test("el resumen de la limpieza no trae datos personales", () => {
  const { resumen } = ci.procesarFilas([fila()], { hoy: HOY });
  const txt = JSON.stringify(resumen);
  assert.ok(!/1234567|juan|ejemplo|981123456/i.test(txt));
  assert.deepStrictEqual(Object.keys(resumen).sort(), ["calidad_fecha", "con_correo", "con_socio_desde", "con_telefono", "descartadas", "filas", "fuente_fecha", "grupos", "inactivos_erp", "registros"]);
});
