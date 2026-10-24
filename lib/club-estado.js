"use strict";
/**
 * lib/club-estado.js — cómo se interpreta lo que dice el club de una persona y cuánta confianza hay de que la cuenta es de esa persona.
 *
 * Estados (a partir de lo que devuelve la API de socios, ITI/Tuti):
 *   al_dia   ACTIVE sin deuda y LIFETIME            → se activa el nivel Socio solo.
 *   mora     DEBT, o ACTIVE con deuda               → no se activa; se le pide que pague en el portal de socios y se revisa de nuevo.
 *   baja     INACTIVE / UNSUBSCRIBED                → no se activa; puede reactivar su membresía en el portal.
 *   (la API 404 = "no figura como titular": puede ser un adherente de plan familiar, no es concluyente.)
 * SOCIO_MORA=permitir vuelve a tratar la mora como al día (decisión del club del 2026-10-06, antes de pedir que pague).
 *
 * Confianza: la cédula no es secreta, así que el detalle del estado (mora, baja, monto) solo se le muestra a quien además coincide con la
 * persona del club: "alta" = su correo confirmado es el del club; "media" = coinciden su nombre y apellido; "baja" = nada coincide (se le
 * da una respuesta neutra, igual que a quien no figura, para que probar cédulas ajenas no revele el estado de pago de nadie).
 */

const PORTAL_URL = () => process.env.CLUB_PORTAL_URL || "https://socios.clubolimpia.com.py";
const moraBloquea = () => process.env.SOCIO_MORA !== "permitir";

/** `socio` con la forma que arma lib/tuti.js ({ status, alDia, deuda }). */
function clasificar(socio) {
  const st = String((socio && socio.status) || "").toUpperCase();
  const deuda = Math.max(0, Number(socio && socio.deuda) || 0);
  if (st === "LIFETIME") return { estado: "al_dia", deuda: 0 };
  if (st === "ACTIVE") return deuda > 0 && moraBloquea() ? { estado: "mora", deuda } : { estado: "al_dia", deuda };
  if (st === "DEBT") return moraBloquea() ? { estado: "mora", deuda } : { estado: "al_dia", deuda };
  if (st === "INACTIVE" || st === "UNSUBSCRIBED") return { estado: "baja", deuda };
  return socio && socio.alDia ? { estado: "al_dia", deuda } : { estado: "baja", deuda };   // un estado nuevo que no conocemos: manda lo que dice la API
}

/**
 * Clase del estado en el club para el HISTORIAL (al_dia | mora | baja), objetiva: no depende de SOCIO_MORA (eso es una decisión de negocio sobre qué se activa,
 * esto es lo que de verdad dice el club). Misma regla que la reconstrucción de la migración 0022.
 */
function claseClub({ estado, deuda, alDia } = {}) {
  const st = String(estado || "").toUpperCase(), d = Math.max(0, Number(deuda) || 0);
  if (st === "LIFETIME") return "al_dia";
  if (st === "ACTIVE") return d > 0 ? "mora" : "al_dia";
  if (st === "DEBT") return "mora";
  if (st === "INACTIVE" || st === "UNSUBSCRIBED") return "baja";
  return alDia ? "al_dia" : "baja";
}

const sinAcentos = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palabras = (s) => sinAcentos(s).split(/[^a-z0-9ñ]+/).filter((t) => t.length >= 2);

/** @returns {"alta"|"media"|"baja"} */
function confianza({ cuenta, tutiSocio, ref }) {
  const c = cuenta || {};
  const correos = [tutiSocio && tutiSocio.email, ref && ref.correo].filter(Boolean).map((e) => String(e).toLowerCase().trim());
  if (c.email_verificado && c.email && correos.includes(String(c.email).toLowerCase().trim())) return "alta";
  const nom = palabras(c.nombre), ape = palabras(c.apellido);
  const candidatos = [[tutiSocio && tutiSocio.nombre, tutiSocio && tutiSocio.apellido].filter(Boolean).join(" "), ref && ref.nombre].filter(Boolean);
  for (const n of candidatos) {
    const p = new Set(palabras(n));
    if (nom.length && ape.length && nom.some((x) => p.has(x)) && ape.some((x) => p.has(x))) return "media";
  }
  return "baja";
}

module.exports = { clasificar, claseClub, confianza, PORTAL_URL, moraBloquea };
