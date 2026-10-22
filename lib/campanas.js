"use strict";
/**
 * lib/campanas.js — compositor y envío de campañas del club (correo y WhatsApp).
 *
 * Una campaña = a quién (segmento o filtros) + canal + plantilla editable. Al enviarla se congela la lista de
 * destinatarios en `campana_envios` (estado `pendiente`) y un proceso por tandas (`procesarLote`, llamado por el
 * cron cada minuto) los va mandando: nunca se manda desde el request del admin, porque 21 mil correos no entran en uno
 * y porque así una caída no deja la campaña a medias ni duplica envíos.
 *
 * Reglas fijas (en código, no en la pantalla):
 *   · quien se dio de baja de novedades (`marketing_baja`) NUNCA recibe una campaña;
 *   · cada correo lleva el link de baja y los headers List-Unsubscribe; cada WhatsApp, el link de baja;
 *   · el texto que escribe el club se escapa: no entra HTML ni scripts en los correos;
 *   · el link del botón es una ruta del sitio o un https:// (nada de javascript:);
 *   · INTERRUPTOR GENERAL: sin CAMPANAS_ACTIVAS=1 no se prueba ni se envía ninguna campaña, y el cron no manda nada
 *     (se puede armar y ver la vista previa). Arranca apagado a propósito: se enciende cuando el club lo decida.
 */
const email = require("./email");
const { tierBySlug } = require("../config");

const activas = (env = process.env) => env.CAMPANAS_ACTIVAS === "1";
const APP_URL = () => String(process.env.APP_URL || "https://www.olimpistas.com").replace(/\/+$/, "");
const MAX_ASUNTO = 120, MAX_TITULO = 90, MAX_CUERPO = 2000, MAX_CTA = 40;
const LOTE = () => Math.max(1, Math.min(Number(process.env.CAMPANAS_LOTE) || 120, 400));
const PAUSA_MS = () => (process.env.CAMPANAS_PAUSA_MS !== undefined ? Number(process.env.CAMPANAS_PAUSA_MS) : 340); // ~3 correos/s, bajo el límite de Resend (5/s)

const PLANTILLAS = [
  { id: "novedad", nombre: "Novedad del club", descripcion: "Un comunicado general para los hinchas.",
    asunto: "Una novedad para vos, {{nombre}}", titulo: "Una novedad del club",
    cuerpo: "Hola {{nombre}},\n\nTenemos una novedad para contarte.\n\n[Escribí acá el mensaje]", cta_texto: "Entrar a mi cuenta", cta_url: "/miembro", cta_valor: false },
  { id: "beneficio", nombre: "Beneficio nuevo", descripcion: "Un comercio o una oferta nueva en la Red de Beneficios.",
    asunto: "Hay un beneficio nuevo para vos, {{nombre}}", titulo: "Un beneficio nuevo en la Red",
    cuerpo: "Hola {{nombre}},\n\nSumamos un beneficio nuevo a la Red del Decano.\n\n[Contá qué comercio es y cuánto ahorra]\n\nMostrá tu QR en caja para usarlo.", cta_texto: "Ver beneficios", cta_url: "/miembro/beneficios", cta_valor: false },
  { id: "subasta", nombre: "Subasta abierta", descripcion: "Avisar que hay una subasta en curso.",
    asunto: "Se abrió una subasta, {{nombre}}", titulo: "Hay una subasta abierta",
    cuerpo: "Hola {{nombre}},\n\nYa podés pujar por un lote exclusivo del club.\n\n[Contá qué lote es y hasta cuándo]", cta_texto: "Ver subastas", cta_url: "/miembro/descubrir/subastas", cta_valor: false },
  { id: "nivel", nombre: "Pasate a Plus", descripcion: "Invitar a subir de nivel (la acción cuesta dinero: el botón va en dorado).",
    asunto: "{{nombre}}, tu carnet puede dar más", titulo: "Pasate a Olimpista Plus",
    cuerpo: "Hola {{nombre}},\n\nHoy estás en el nivel {{nivel}}. Con Olimpista Plus tenés más beneficios, sorteos y contenido exclusivo.\n\n[Contá la promo vigente, si hay]", cta_texto: "Ver Olimpista Plus", cta_url: "/miembro", cta_valor: true },
];

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const primerNombre = (s) => { const n = String((s && s.nombre) || "").trim().split(/\s+/)[0] || ""; return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "hincha"; };
const nombreNivel = (s) => { const t = tierBySlug((s && s.tier_slug) || "olimpista"); return (t && t.nombre) || "Olimpista"; };
const variables = (s) => ({ nombre: primerNombre(s), nivel: nombreNivel(s) });
const reemplazar = (txt, vars) => String(txt || "").replace(/\{\{\s*(nombre|nivel)\s*\}\}/g, (_, k) => vars[k]);

/** Valida y normaliza lo que escribe el club. Devuelve { ok, campos } o { ok:false, error }. */
function validarCampos(b = {}) {
  const t = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
  const campos = { asunto: t(b.asunto, MAX_ASUNTO), titulo: t(b.titulo, MAX_TITULO), cuerpo: t(b.cuerpo, MAX_CUERPO), cta_texto: t(b.cta_texto, MAX_CTA), cta_url: t(b.cta_url, 500), cta_valor: b.cta_valor === true };
  if (campos.asunto.length < 3) return { ok: false, error: "Poné un asunto de al menos 3 letras." };
  if (campos.cuerpo.length < 10) return { ok: false, error: "El mensaje es muy corto." };
  if (campos.cta_texto && !campos.cta_url) return { ok: false, error: "El botón necesita un link." };
  if (campos.cta_url) {
    if (campos.cta_url.startsWith("/") && !campos.cta_url.startsWith("//")) { /* ruta del sitio */ }
    else if (!/^https:\/\/[^\s]+$/i.test(campos.cta_url)) return { ok: false, error: "El link del botón tiene que empezar con / (una página del sitio) o con https://." };
    if (!campos.cta_texto) campos.cta_texto = "Abrir";
  }
  return { ok: true, campos };
}
const urlCta = (c) => (c.cta_url.startsWith("/") ? APP_URL() + c.cta_url : c.cta_url);
const parrafos = (txt) => escHtml(txt).split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>")).join("<br><br>");

/** Correo de marketing para un socio: { subject, html, headers }. */
function renderEmail(c, socio) {
  const v = variables(socio);
  const unsub = socio && socio.id ? email.unsubUrl(socio.id) : "";
  const html = email.layout({
    titulo: escHtml(reemplazar(c.titulo || c.asunto, v)), intro: parrafos(reemplazar(c.cuerpo, v)),
    ctaText: c.cta_texto ? escHtml(c.cta_texto) : "", ctaUrl: c.cta_texto ? escHtml(urlCta(c)) : "", ctaValor: !!c.cta_valor,
    unsubUrl: unsub, lang: "es",
  });
  return { subject: reemplazar(c.asunto, v), html, headers: socio && socio.id ? email.headersMarketing(socio.id) : undefined };
}
/** Mensaje de WhatsApp (texto plano) para un socio. */
function renderWhatsApp(c, socio) {
  const v = variables(socio);
  const unsub = socio && socio.id ? email.unsubUrl(socio.id) : "";
  return [reemplazar(c.cuerpo, v), c.cta_texto ? `${c.cta_texto}: ${urlCta(c)}` : "", unsub ? `Para no recibir más mensajes: ${unsub}` : ""].filter(Boolean).join("\n\n");
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ""));
const telefonoDe = (s) => { const d = String((s && (s.whatsapp || s.telefono)) || "").replace(/[^\d]/g, ""); return d.length >= 8 && d.length <= 15 ? d : ""; };
/** Por qué un socio NO recibe la campaña por ese canal (null = sí la recibe). */
function motivoExclusion(s, canal) {
  if (s.marketing_baja) return "baja";
  if (canal === "whatsapp") return telefonoDe(s) ? null : "sin_telefono";
  return emailValido(s.email) ? null : "sin_email";
}
/** Reparte la audiencia entre quienes reciben y los excluidos por motivo. */
function clasificarAudiencia(socios, canal) {
  const reciben = [], excluidos = { baja: 0, sin_email: 0, sin_telefono: 0 };
  for (const s of socios) { const m = motivoExclusion(s, canal); if (m) excluidos[m]++; else reciben.push(s); }
  return { reciben, excluidos };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let _procesando = false;

/**
 * Manda una tanda de envíos pendientes de las campañas en curso. Seguro de llamar en paralelo: cada envío se reclama
 * de forma atómica (`tomarPendientesCampana`), así que dos corridas nunca mandan lo mismo.
 * deps: { store, enviarEmail?, enviarWhatsApp?, log? }
 */
async function procesarLote(deps) {
  const { store, log = () => {} } = deps;
  const enviarEmail = deps.enviarEmail || email.enviar;
  const enviarWhatsApp = deps.enviarWhatsApp || (async ({ telefono, texto, campanaId }) => {
    const url = String(process.env.GHL_WHATSAPP_URL || "").trim();
    if (!/^https:\/\//i.test(url)) return { ok: false, error: "GHL_WHATSAPP_URL no configurada" };
    try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tipo: "campana", campana_id: campanaId, telefono, texto }) }); return r.ok ? { ok: true } : { ok: false, error: "GHL " + r.status }; }
    catch (e) { return { ok: false, error: "GHL " + (e && e.message) }; }
  });
  if (!activas()) return { enviados: 0, fallidos: 0, omitidos: 0, campanas: 0, pausado: true };
  if (_procesando) return { enviados: 0, fallidos: 0, ocupado: true };
  _procesando = true;
  const out = { enviados: 0, fallidos: 0, omitidos: 0, campanas: 0 };
  try {
    let cupo = LOTE();
    for (const camp of await store.campanasEnCurso()) {
      if (cupo <= 0) break;
      out.campanas++;
      const tanda = await store.tomarPendientesCampana(camp.id, cupo);
      for (const e of tanda) {
        cupo--;
        let res;
        try {
          const socio = e.socio_id ? await store.getSocioById(e.socio_id) : null;
          if (!socio) res = { ok: false, error: "el hincha ya no existe" };
          else if (socio.marketing_baja) { await store.marcarEnvioResultado(e.id, { omitido: true, error: "se dio de baja después de armar la campaña" }); out.omitidos++; continue; }
          else {
            const m = await store.getMembresia(socio.id).catch(() => null);
            const conNivel = { ...socio, tier_slug: (m && m.tier_slug) || "olimpista" };
            if (camp.canal === "whatsapp") {
              const tel = telefonoDe(socio);
              res = tel ? await enviarWhatsApp({ telefono: tel, texto: renderWhatsApp(camp, conNivel), campanaId: camp.id }) : { ok: false, error: "sin teléfono" };
            } else {
              const r = renderEmail(camp, conNivel);
              res = emailValido(socio.email) ? await enviarEmail({ to: socio.email, subject: r.subject, html: r.html, headers: r.headers }) : { ok: false, error: "correo inválido" };
            }
          }
        } catch (err) { res = { ok: false, error: String((err && err.message) || err).slice(0, 200) }; }
        await store.marcarEnvioResultado(e.id, res.ok ? { ok: true } : { ok: false, error: res.error || "no se pudo enviar" });
        if (res.ok) out.enviados++; else out.fallidos++;
        const pausa = PAUSA_MS();
        if (pausa > 0) await dormir(pausa);
      }
    }
    const cerradas = await store.cerrarCampanasTerminadas();
    if (cerradas && cerradas.length) log("campañas terminadas", cerradas.join(","));
  } finally { _procesando = false; }
  return out;
}

module.exports = { activas, PLANTILLAS, MAX_ASUNTO, MAX_TITULO, MAX_CUERPO, validarCampos, renderEmail, renderWhatsApp, motivoExclusion, clasificarAudiencia, telefonoDe, procesarLote, variables };
