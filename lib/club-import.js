"use strict";
/**
 * lib/club-import.js — limpieza de la base de socios del club (exportación del sistema administrativo) antes de cargarla
 * en `socios_club`. Es una tabla de REFERENCIA: sirve para enriquecer (antigüedad, grupo, número de socio) y para saber a quién
 * consultar en la API de estado; NUNCA otorga el nivel Socio (eso lo decide la API en vivo del club).
 *
 * Reglas (ver docs/analisis-base-socios.md):
 *  · Cédula: número sin ceros a la izquierda; una RUC "1234567-8" se reduce a lo anterior al guion; menos de 5 dígitos, letras
 *    o una fecha (Excel corrompe algunas cédulas) se descartan.
 *  · Grupos que no son socios (General No Socio, Sponsor, Vendedor, Hinchas Oficiales) no se cargan.
 *  · "Socio desde" queda SIEMPRE definido, con esta cadena de fuentes (la que gana queda en `fecha_fuente`):
 *      1. ingreso        la fecha de ingreso del club (entre 1950 y hoy); los días de carga masiva cuentan igual (`fecha_calidad` los marca);
 *      2. plan_familiar  si la fila no tiene fecha pero comparte número de socio con otras (plan familiar): la más antigua del plan;
 *      3. primer_cuota   el 1 de enero del año del primer registro de cuota;
 *      4. sin_dato       no hay ningún dato: se resuelve al validar la cuenta (cuenta desde el día en que se la reconoce como socia).
 *    La antigüedad (`antig_anios`) se calcula siempre desde "Socio desde"; la medida "pagada" del club queda aparte (`meses_pagados`).
 *  · Si una cédula aparece varias veces (planes familiares) manda la fila activa, con número propio y de grupo titular.
 */

const FUENTE = { INGRESO: "ingreso", PLAN: "plan_familiar", CUOTA: "primer_cuota", NADA: "sin_dato" };
const NO_SOCIOS = new Set(["General No Socio", "Sponsor", "Vendedor", "Hinchas Oficiales"]);
const PRIORIDAD_GRUPO = { PERSONAL: 5, ESTADIO: 5, INTERIOR: 5, EXTERIOR: 5, VITALICIO: 5, "Socio Protector": 5, "Campeones de América": 5, CADETE: 3, INFANTIL: 2, FAMILIAR: 1 };
const MASIVO_MIN = 300;

/** Clave de cédula: dígitos sin ceros a la izquierda. Devuelve "" si no es utilizable. */
function claveCedula(valor) {
  if (valor === null || valor === undefined || valor instanceof Date) return "";
  const s = String(valor).trim();
  const ruc = /^(\d+)-\d$/.exec(s);
  if (!ruc && /[^\d\s.\-]/.test(s)) return "";            // letras (pasaporte, etc.): no se cruza por cédula
  const d = (ruc ? ruc[1] : s.replace(/\D/g, "")).replace(/^0+/, "");
  return d.length >= 5 && d.length <= 12 ? d : "";
}

const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : "");

/** "JUAN PEREZ" → "Juan Perez"; "PEREZ, JUAN" se deja en el orden original (no se adivina cuál es el apellido). */
function nombrePropio(v) {
  if (v === null || v === undefined || typeof v === "number") return "";
  return String(v).replace(/\s+/g, " ").trim().toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase()).slice(0, 120);
}

/** Teléfono de Paraguay a formato internacional (+595…); lo que no se reconoce como tal se descarta. */
function telefono(v) {
  if (v === null || v === undefined || v === "") return "";
  const d = String(v).replace(/\D/g, "");
  if (/^595\d{9}$/.test(d)) return "+" + d;
  if (/^0\d{9}$/.test(d)) return "+595" + d.slice(1);
  if (/^9\d{8}$/.test(d)) return "+595" + d;
  return "";
}

function correo(v) {
  if (v === null || v === undefined) return "";
  const m = String(v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m) && m.length <= 160 ? m : "";
}

function nacimiento(v, hoy) {
  if (!(v instanceof Date) || isNaN(v)) return "";
  const edad = (hoy - v.getTime()) / 31557600000;
  return edad >= 0 && edad <= 110 && iso(v) !== "1899-12-31" ? iso(v) : "";
}

/** Cuenta cuántas altas hay por día para reconocer las cargas masivas. */
function diasMasivos(filas) {
  const por = {};
  for (const r of filas) { const f = r["Fecha ingreso Socio"]; if (f instanceof Date && !isNaN(f)) { const k = iso(f); por[k] = (por[k] || 0) + 1; } }
  return new Set(Object.keys(por).filter((k) => por[k] >= MASIVO_MIN));
}

function calidadFecha(f, masivos, hoy) {
  if (!(f instanceof Date) || isNaN(f)) return "sin_fecha";
  const d = iso(f);
  if (d === "1899-12-31") return "fecha_cero";
  if (f.getTime() > hoy) return "futura";
  if (f.getUTCFullYear() < 1950) return "anterior_1950";
  if (masivos.has(d)) return "carga_masiva";
  return "creible";
}

const aniosDesde = (fechaIso, hoy) => (fechaIso ? Math.round(((hoy - Date.parse(fechaIso + "T00:00:00Z")) / 31557600000) * 100) / 100 : null);
/** Fecha de ingreso utilizable como "Socio desde": cualquier fecha válida, incluidos los días de carga masiva. */
const fechaUsable = (calidad) => calidad === "creible" || calidad === "carga_masiva";

function puntaje(reg) {
  return (reg.activo_erp ? 8 : 0) + (reg.nro_socio ? 4 : 0) + (PRIORIDAD_GRUPO[reg.grupo] || 0) + (reg.socio_desde ? 1 : 0);
}

/**
 * Filas del Excel → registros listos para `socios_club` + un resumen sin datos personales.
 * `filas`: objetos con las columnas del archivo (fechas como Date).
 */
function procesarFilas(filas, { hoy = Date.now() } = {}) {
  const masivos = diasMasivos(filas);
  const resumen = { filas: filas.length, descartadas: { no_socio: 0, sin_cedula: 0, repetidas: 0 }, calidad_fecha: {}, grupos: {}, registros: 0 };
  const mejor = new Map();
  for (const r of filas) {
    const grupo = String(r["Nombre de grupo"] || "").trim();
    if (NO_SOCIOS.has(grupo)) { resumen.descartadas.no_socio++; continue; }
    const cedula = claveCedula(r["Número de identificación fiscal"]);
    if (!cedula) { resumen.descartadas.sin_cedula++; continue; }
    const f = r["Fecha ingreso Socio"], cal = calidadFecha(f, masivos, hoy);
    const total = typeof r["Antigüedad Total (Años)"] === "number" ? r["Antigüedad Total (Años)"] : null;
    const meses = typeof r["Meses Pagados por Cuotas"] === "number" ? Math.round(r["Meses Pagados por Cuotas"]) : null;
    const reg = {
      cedula,
      grupo: grupo.slice(0, 40),
      nro_socio: typeof r["Numero Socio"] === "number" ? String(Math.round(r["Numero Socio"])) : "",
      socio_desde: fechaUsable(cal) ? iso(f) : null,
      fecha_calidad: cal,
      fecha_fuente: fechaUsable(cal) ? FUENTE.INGRESO : FUENTE.NADA,
      anio_primer_cuota: typeof r["Año Primer Registro Cuota"] === "number" && r["Año Primer Registro Cuota"] >= 2001 && r["Año Primer Registro Cuota"] <= new Date(hoy).getUTCFullYear() ? Math.round(r["Año Primer Registro Cuota"]) : null,
      antig_anios: null,
      meses_pagados: meses,
      activo_erp: r["Activo"] === "Y",
      nombre: nombrePropio(r["Nombre SN"]),
      correo: correo(r["Correo electrónico"]),
      telefono: telefono(r["Teléfono 1"]),
      nacimiento: nacimiento(r["Fecha_Nacimiento"], hoy) || null,
    };
    const previo = mejor.get(cedula);
    if (!previo) mejor.set(cedula, reg);
    else { resumen.descartadas.repetidas++; if (puntaje(reg) > puntaje(previo)) mejor.set(cedula, reg); }
  }
  const registros = [...mejor.values()];
  // 2) plan familiar: la fecha más antigua entre quienes comparten número de socio
  const porNumero = new Map();
  for (const g of registros) if (g.nro_socio && g.socio_desde) { const p = porNumero.get(g.nro_socio); if (!p || g.socio_desde < p) porNumero.set(g.nro_socio, g.socio_desde); }
  for (const g of registros) {
    if (!g.socio_desde && g.nro_socio && porNumero.has(g.nro_socio)) { g.socio_desde = porNumero.get(g.nro_socio); g.fecha_fuente = FUENTE.PLAN; }
    // 3) primer registro de cuota
    if (!g.socio_desde && g.anio_primer_cuota) { g.socio_desde = g.anio_primer_cuota + "-01-01"; g.fecha_fuente = FUENTE.CUOTA; }
    g.antig_anios = aniosDesde(g.socio_desde, hoy);
    delete g.anio_primer_cuota;
  }
  resumen.fuente_fecha = {};
  for (const g of registros) resumen.fuente_fecha[g.fecha_fuente] = (resumen.fuente_fecha[g.fecha_fuente] || 0) + 1;
  for (const g of registros) { resumen.calidad_fecha[g.fecha_calidad] = (resumen.calidad_fecha[g.fecha_calidad] || 0) + 1; resumen.grupos[g.grupo] = (resumen.grupos[g.grupo] || 0) + 1; }
  resumen.registros = registros.length;
  resumen.con_socio_desde = registros.filter((g) => g.socio_desde).length;
  resumen.con_correo = registros.filter((g) => g.correo).length;
  resumen.con_telefono = registros.filter((g) => g.telefono).length;
  resumen.inactivos_erp = registros.filter((g) => !g.activo_erp).length;
  return { registros, resumen };
}

module.exports = { FUENTE, aniosDesde, claveCedula, nombrePropio, telefono, correo, nacimiento, diasMasivos, calidadFecha, procesarFilas, NO_SOCIOS };
