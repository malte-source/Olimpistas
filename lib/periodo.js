"use strict";

/**
 * lib/periodo.js — período de un reporte en días calendario de Paraguay (UTC-3).
 * `desde` y `hasta` llegan como YYYY-MM-DD (ambos inclusivos). Sin datos: del día 1 del mes actual a hoy.
 * Devuelve el intervalo semiabierto [desde, hasta) en ISO, listo para la consulta.
 */
const DIA = 86400000, OFFSET = 3 * 3600000, MAX_DIAS = 366;

function periodo({ desde, hasta } = {}, ahora = Date.now()) {
  const local = new Date(ahora - OFFSET);
  const hoy = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const parse = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
    const [y, m, d] = String(s).split("-").map(Number), t = Date.UTC(y, m - 1, d);
    const ok = new Date(t); // rechaza 2026-02-31
    return ok.getUTCFullYear() === y && ok.getUTCMonth() === m - 1 && ok.getUTCDate() === d ? t : null;
  };
  const ini = desde ? parse(desde) : Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  const fin = hasta ? parse(hasta) : hoy;
  if (ini == null || fin == null) { const e = new Error("Fechas inválidas (usá AAAA-MM-DD)"); e.status = 400; throw e; }
  if (fin < ini) { const e = new Error("La fecha final es anterior a la inicial"); e.status = 400; throw e; }
  if ((fin - ini) / DIA + 1 > MAX_DIAS) { const e = new Error("El período no puede pasar de un año"); e.status = 400; throw e; }
  const iso = (t) => new Date(t + OFFSET).toISOString();       // medianoche de Paraguay = 03:00 UTC
  return { desde: iso(ini), hasta: iso(fin + DIA), etiqueta: new Date(ini).toISOString().slice(0, 10) + " a " + new Date(fin).toISOString().slice(0, 10) };
}

module.exports = { periodo };
