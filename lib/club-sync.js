"use strict";
/**
 * lib/club-sync.js — consulta, de a poquito, el estado de cada cédula en la API de socios del club (ITI/Tuti) y lo deja guardado en
 * `socios_club`. Así, cuando alguien se inscribe en olimpistas.com con su cédula, su estado ya está (o se consulta una sola vez).
 *
 * Cuida el límite de la API (probado: 429 con Retry-After de 20 s a las ~500 consultas seguidas):
 *   · un lote chico por corrida (cron horario) y una pausa entre consulta y consulta;
 *   · si la API pide frenar (429) o rechaza las credenciales, el lote se corta ahí y sigue en la próxima corrida;
 *   · tras 5 errores seguidos de red también se corta.
 * Orden: primero las cuentas de Olimpistas con cédula, después las de la base con correo que ya tiene cuenta, al final el resto.
 * Interruptor: TUTI_BARRIDO=off. Tamaño del lote: TUTI_LOTE (por defecto 120). Pausa: TUTI_PAUSA_MS (por defecto 400).
 */
const log = require("./log");
const { clasificar } = require("./club-estado");

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lo que la API devuelve → lo que se guarda. */
function aEstado(v) {
  if (v.ok && v.encontrado) {
    const s = v.socio;
    // alDia = al día de verdad (sin deuda): una persona en mora figura con su deuda y alDia = false
    return { estado: s.status || "DESCONOCIDO", plan: s.plan, numero: s.numeroSocio, alDia: clasificar(s).estado === "al_dia", deuda: s.deuda, correo: s.email || "", nombre: [s.nombre, s.apellido].filter(Boolean).join(" ") };
  }
  return { estado: "NO_ENCONTRADO", plan: "", numero: "", alDia: null, deuda: null };   // 404: adherente de plan familiar o no es socio (no concluyente)
}

async function procesarLote({ store, tuti, limite, pausaMs, staleDias = 7, dormirFn = dormir } = {}) {
  const n = Math.min(Math.max(parseInt(limite != null ? limite : process.env.TUTI_LOTE, 10) || 120, 1), 500);
  const pausa = pausaMs != null ? pausaMs : (Number(process.env.TUTI_PAUSA_MS) || 400);
  const out = { pedidas: 0, consultadas: 0, encontradas: 0, no_encontradas: 0, errores: 0, cortado_por: null };
  if (process.env.TUTI_BARRIDO === "off") { out.cortado_por = "apagado"; return out; }
  if (!tuti.habilitado() || !store.siguientesParaConsultar) { out.cortado_por = "api_no_habilitada"; return out; }
  const lista = await store.siguientesParaConsultar({ limite: n, staleDias });
  out.pedidas = lista.length;
  let seguidos = 0;
  for (const cedula of lista) {
    const v = await tuti.consultarSocio(cedula);
    if (!v.ok) {
      // límite de velocidad o credenciales: no se insiste (el módulo de la API ya se pausa solo)
      if (/limite|429|credenciales|401|bloque/i.test(String(v.motivo || ""))) { out.cortado_por = String(v.motivo); break; }
      out.errores++; seguidos++;
      if (seguidos >= 5) { out.cortado_por = "errores_seguidos"; break; }
    } else {
      seguidos = 0;
      await store.guardarEstadoTuti(cedula, aEstado(v));
      out.consultadas++;
      if (v.encontrado) out.encontradas++; else out.no_encontradas++;
    }
    if (pausa > 0) await dormirFn(pausa);
  }
  if (out.consultadas || out.errores || out.cortado_por) log.info(out, "club-sync: lote");
  return out;
}

module.exports = { procesarLote, aEstado };
