"use strict";
/**
 * lib/resumen-comercio.js — resumen mensual al comercio (P15).
 *
 * El día 1 de cada mes (cron diario; se aceptan los días 1 a 3 por si un día falla) cada comercio activo recibe por correo cómo le fue el mes
 * que pasó en la Red de Beneficios: canjes, ahorro entregado, ventas registradas en caja, comparación con el mes anterior y qué ofertas vencen.
 * Es el aviso que lo invita a renovar su oferta sin que el club tenga que perseguirlo. Un correo por comercio y mes (reservarNotificacion).
 * Solo cifras de su propio comercio: nada de hinchas con nombre ni datos de otros comercios.
 */
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const emailOk = (e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const dia10 = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : "");

// Mes calendario en hora de Paraguay (UTC-3): [desde, hasta) como instantes UTC.
function limitesMes(anio, mes0) {
  return { desde: new Date(Date.UTC(anio, mes0, 1, 3)).toISOString(), hasta: new Date(Date.UTC(anio, mes0 + 1, 1, 3)).toISOString() };
}
// El mes anterior a una fecha de Paraguay "AAAA-MM-DD".
function mesAnterior(hoyPy) {
  let anio = Number(hoyPy.slice(0, 4)), mes0 = Number(hoyPy.slice(5, 7)) - 2;
  if (mes0 < 0) { mes0 = 11; anio--; }
  return { anio, mes0, clave: anio + "-" + String(mes0 + 1).padStart(2, "0"), nombre: MESES[mes0], etiqueta: MESES[mes0] + " de " + anio };
}
const fechaLarga = (iso) => { const [a, m, d] = iso.split("-").map(Number); return d + " de " + MESES[m - 1]; };

// Las cifras de un comercio para un mes, contra el mes anterior, y sus ofertas (activas y las que vencen en los próximos 30 días).
async function armarResumen({ store, comercio, mes, hoyPy, beneficios }) {
  const previo = mesAnterior(mes.clave + "-15");
  const [actual, anterior] = await Promise.all([
    store.estadisticasComercio({ comercioId: comercio.id, ...limitesMes(mes.anio, mes.mes0) }),
    store.estadisticasComercio({ comercioId: comercio.id, ...limitesMes(previo.anio, previo.mes0) }),
  ]);
  const tope = new Date(new Date(hoyPy + "T12:00:00Z").getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const activas = (beneficios || []).filter((b) => b.comercio_id === comercio.id && b.activo !== false && b.estado === "aprobado" && (!dia10(b.vigencia_hasta) || dia10(b.vigencia_hasta) >= hoyPy));
  const vencen = activas.filter((b) => dia10(b.vigencia_hasta) && dia10(b.vigencia_hasta) <= tope).sort((a, b) => dia10(a.vigencia_hasta).localeCompare(dia10(b.vigencia_hasta)))
    .map((b) => ({ titulo: b.titulo, hasta: dia10(b.vigencia_hasta), texto: fechaLarga(dia10(b.vigencia_hasta)) }));
  return { comercio, mes, mesPrevio: previo, actual, anterior, activas: activas.length, vencen };
}

// ¿Vale la pena escribirle? Si no hubo canjes ni tiene ofertas activas, un resumen vacío solo molesta.
const hayQueContar = (r) => r.actual.canjes > 0 || r.activas > 0;

async function enviarResumenesMensuales({ store, mailer, hoyPy, log, pausaMs, forzar = false }) {
  const out = { enviados: 0, omitidos: 0, errores: 0 };
  if (!forzar && Number(hoyPy.slice(8, 10)) > 3) return { ...out, fuera_de_fecha: true };
  const mes = mesAnterior(hoyPy);
  const reservar = store.reservarNotificacion ? (k) => store.reservarNotificacion(k) : async () => true;
  const beneficios = store.listBeneficios ? await store.listBeneficios() : [];
  const espera = pausaMs != null ? pausaMs : (process.env.CORREO_RESPIRO_MS !== undefined ? Number(process.env.CORREO_RESPIRO_MS) : 300);
  for (const c of await store.listComercios()) {
    if (c.estado !== "activo" || !emailOk(c.contacto)) { out.omitidos++; continue; }
    try {
      const r = await armarResumen({ store, comercio: c, mes, hoyPy, beneficios });
      if (!hayQueContar(r)) { out.omitidos++; continue; }
      if (!(await reservar("comercio:resumen:" + c.id + ":" + mes.clave))) continue;
      const e = await mailer.enviarResumenComercio({ email: c.contacto }, r);
      if (e && e.ok === false) { out.errores++; log && log.error({ comercio: c.id }, "resumen mensual: no se pudo enviar"); } else out.enviados++;
      if (espera) await new Promise((done) => setTimeout(done, espera));
    } catch (e) { out.errores++; log && log.error({ err: e && e.message, comercio: c.id }, "resumen mensual"); }
  }
  return out;
}

module.exports = { MESES, limitesMes, mesAnterior, armarResumen, hayQueContar, enviarResumenesMensuales };
