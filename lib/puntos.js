"use strict";

/**
 * lib/puntos.js — reglas puras del motor de puntos (sin base de datos).
 */

// Escalones por saldo (como el prototipo del paquete de diseño). Debajo de Bronce = "inicial".
const ESCALONES = [
  { clave: "bronce", nombre: "Bronce", desde: 200 },
  { clave: "plata", nombre: "Plata", desde: 1000 },
  { clave: "oro", nombre: "Oro", desde: 5000 },
];

function escalonDe(saldo) {
  const s = Math.max(0, Number(saldo) || 0);
  let actual = null;
  for (const e of ESCALONES) if (s >= e.desde) actual = e;
  const siguiente = ESCALONES.find((e) => s < e.desde) || null;
  const base = actual ? actual.desde : 0;
  return {
    clave: actual ? actual.clave : "inicial",
    nombre: actual ? actual.nombre : "Inicial",
    siguiente: siguiente ? { clave: siguiente.clave, nombre: siguiente.nombre, desde: siguiente.desde } : null,
    faltan: siguiente ? siguiente.desde - s : 0,
    pct: siguiente ? Math.round(((s - base) / (siguiente.desde - base)) * 100) : 100,
  };
}

// Cómo se ganan. `pendiente` = depende de endpoints de Tuti que todavía no existen: la regla se ve y se
// puede ajustar, pero no suma hasta que llegue el dato. `quien` decide a quién le aplica (UI).
const REGLAS_META = {
  referido: { t: "Referido que se registra", fuente: "Olimpistas", quien: "todos" },
  mision: { t: "Misión semanal o encuesta", fuente: "Olimpistas", quien: "todos" },
  perfil: { t: "Completar tu perfil", fuente: "Olimpistas", quien: "todos" },
  estadio: { t: "Ir al estadio (molinete)", fuente: "Tuti", quien: "todos", pendiente: true },
  liberar: { t: "Liberar el lugar de abono", fuente: "Tuti", quien: "abonados", pendiente: true },
  cuota: { t: "Cuota al día, cada mes", fuente: "Portal de Socios", quien: "socios" },
  debito: { t: "Activar débito automático", fuente: "Portal de Socios", quien: "socios" },
};

// Semana ISO (lunes a domingo) en hora de Paraguay (UTC-3): "2026-W43".
function semanaIso(fecha = new Date()) {
  const l = new Date(new Date(fecha).getTime() - 3 * 3600000);
  const d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);               // el jueves de esa semana decide el año ISO
  const ini = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const sem = Math.ceil(((d - ini) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(sem).padStart(2, "0");
}

// Mes calendario en hora de Paraguay: "2026-10".
const mesPy = (fecha = new Date()) => new Date(new Date(fecha).getTime() - 3 * 3600000).toISOString().slice(0, 7);
const diaDelMesPy = (fecha = new Date()) => new Date(new Date(fecha).getTime() - 3 * 3600000).getUTCDate();

module.exports = { ESCALONES, escalonDe, REGLAS_META, semanaIso, mesPy, diaDelMesPy };
