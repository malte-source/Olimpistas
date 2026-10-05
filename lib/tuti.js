"use strict";

/**
 * lib/tuti.js — Cliente de la API de Consulta de Socios del Club Olimpia (ITI / Tuti).
 *
 * Valida EN VIVO, por cédula, si alguien es socio y en qué estado está de su cuota.
 * Reemplaza (donde alcanza) al padrón estático: el padrón es una foto del día que se
 * exportó, esta API es el estado de hoy.
 *
 *   GET {HOST}/bff-service/OLIMPIA/subscription/members?documentNumber={cédula}
 *   Headers: X-Api-Key (ambiente) + X-Merchant-Key (de este comercio)
 *
 * Env (secretos — nunca al repo ni al frontend):
 *   TUTI_API_KEY, TUTI_MERCHANT_KEY   — sin ambas el módulo queda deshabilitado
 *   TUTI_API_HOST (default https://bff.tuti.com.py), TUTI_TIMEOUT_MS (default 2500)
 *
 * IMPORTANTE (probado contra producción 2026-10-05): la API devuelve SOLO al titular.
 * Los adherentes de un plan familiar dan 404 aunque sí sean socios — por eso un 404
 * es "no concluyente" y quien llama NO debe usarlo para rechazar: tiene que caer al
 * padrón, donde los adherentes sí están. Sólo un 200 es una respuesta autoritativa.
 *
 * Reglas de la guía del proveedor que se respetan acá: timeout corto, NO reintentar
 * en loop ante 401 (credenciales, no red), no cachear el estado (depende de deuda).
 */

const log = require("./log");
const { alertar } = require("./alert");

const HOST = (process.env.TUTI_API_HOST || "https://bff.tuti.com.py").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.TUTI_TIMEOUT_MS) || 2500;

// Estados según la guía: ACTIVE, DEBT (mora), INACTIVE, UNSUBSCRIBED (baja de ciclo),
// LIFETIME (vitalicio). "Al día" = activo o vitalicio. DEBT NO cuenta: es mora.
const AL_DIA = new Set(["ACTIVE", "LIFETIME"]);
const esAlDia = (status) => AL_DIA.has(String(status || "").toUpperCase());

const habilitado = () => !!(process.env.TUTI_API_KEY && process.env.TUTI_MERCHANT_KEY);

// Si las credenciales fallan (401) no insistimos durante un rato: la guía pide no
// reintentar en loop, y además cada intento fallido solo suma ruido. Lo mismo con el
// límite de velocidad (429): el proveedor responde `Retry-After` (visto: 20s) y hay que
// respetarlo — mientras dura, quien llama usa el padrón en vez de golpear la API.
let _bloqueadoHasta = 0, _bloqueoMotivo = "";
const BLOQUEO_401_MS = 5 * 60 * 1000;

const soloDigitos = (s) => String(s == null ? "" : s).replace(/\D/g, "");

/**
 * @returns {Promise<
 *   {ok:true, encontrado:true, socio:object} |
 *   {ok:true, encontrado:false} |
 *   {ok:false, motivo:string}
 * >}
 */
async function consultarSocio(documento, { fetchImpl } = {}) {
  if (!habilitado()) return { ok: false, motivo: "deshabilitado" };
  const doc = soloDigitos(documento);
  if (doc.length < 5 || doc.length > 12) return { ok: true, encontrado: false };
  if (Date.now() < _bloqueadoHasta) return { ok: false, motivo: _bloqueoMotivo, reintentarEnMs: _bloqueadoHasta - Date.now() };

  const f = fetchImpl || fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(`${HOST}/bff-service/OLIMPIA/subscription/members?documentNumber=${encodeURIComponent(doc)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Api-Key": process.env.TUTI_API_KEY,
        "X-Merchant-Key": process.env.TUTI_MERCHANT_KEY,
      },
      signal: ctl.signal,
    });

    if (r.status === 404) return { ok: true, encontrado: false };
    if (r.status === 429) {
      const seg = Number(r.headers && r.headers.get && r.headers.get("retry-after"));
      const espera = (Number.isFinite(seg) && seg > 0 ? Math.min(seg, 120) : 20) * 1000;
      _bloqueadoHasta = Date.now() + espera; _bloqueoMotivo = "limite";
      log.warn({ esperaSeg: espera / 1000 }, "tuti: límite de velocidad (429)");
      return { ok: false, motivo: "limite", reintentarEnMs: espera };
    }
    if (r.status === 401 || r.status === 403) {
      _bloqueadoHasta = Date.now() + BLOQUEO_401_MS; _bloqueoMotivo = "credenciales";
      log.error({ status: r.status }, "tuti: credenciales rechazadas");
      alertar("tuti-credenciales", "API de socios (Tuti): credenciales rechazadas",
        `HTTP ${r.status}. Revisar TUTI_API_KEY / TUTI_MERCHANT_KEY (¿vencida o revocada?). Se pausan las consultas 5 min; la validación de socios sigue con el padrón.`);
      return { ok: false, motivo: "credenciales" };
    }
    if (!r.ok) {
      log.warn({ status: r.status }, "tuti: respuesta inesperada");
      return { ok: false, motivo: "http_" + r.status };
    }

    const d = await r.json();
    return {
      ok: true,
      encontrado: true,
      socio: {
        documento: String(d.documentNumber || doc),
        tipoDocumento: d.documentType || "CI",
        nombre: d.firstName || "",
        apellido: d.lastName || "",
        numeroSocio: d.subscriptionNumber != null ? String(d.subscriptionNumber) : "",
        telefono: d.phoneNumber || "",
        email: d.email ? String(d.email).toLowerCase().trim() : "",
        plan: d.plan || "",
        modalidadPago: d.paymentModality || "",
        debitoAutomatico: !!d.autoDebitEnabled,
        status: String(d.status || "").toUpperCase(),
        deudor: !!d.debtor,
        deuda: Number(d.totalDebt) || 0,
        alDia: esAlDia(d.status),
      },
    };
  } catch (e) {
    const motivo = e && e.name === "AbortError" ? "timeout" : "red";
    log.warn({ motivo, err: e && e.message }, "tuti: consulta fallida");
    return { ok: false, motivo };
  } finally {
    clearTimeout(t);
  }
}

// Sólo para tests: limpia el bloqueo temporal (401 / 429) entre casos.
const __resetBloqueo = () => { _bloqueadoHasta = 0; _bloqueoMotivo = ""; };

module.exports = { consultarSocio, esAlDia, habilitado, AL_DIA, __resetBloqueo };
