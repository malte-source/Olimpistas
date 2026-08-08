"use strict";

/**
 * lib/email.js — Emails transaccionales (Resend). Plantillas branded Olimpia.
 *
 * Activación: RESEND_API_KEY + EMAIL_FROM (ej. "Olimpistas <hola@olimpistas.com>").
 * Sin RESEND_API_KEY → modo simulado (solo loguea).
 */

const crypto = require("crypto");
const log = require("./log");
const FROM = process.env.EMAIL_FROM || "Olimpistas <hola@olimpistas.com>";
const APP_URL = process.env.APP_URL || "https://www.olimpistas.com";
const habilitado = !!process.env.RESEND_API_KEY;

// ── Baja de marketing (unsubscribe) ──────────────────────────────────────────
// Token firmado (HMAC) con el id del socio: no requiere login ni es adivinable.
const UNSUB_SECRET = process.env.UNSUB_SECRET || process.env.ADMIN_KEY || "olimpistas-unsub-v1";
function unsubToken(socioId) {
  if (!socioId) return "";
  const sig = crypto.createHmac("sha256", UNSUB_SECRET).update(String(socioId)).digest("hex").slice(0, 24);
  return `${socioId}.${sig}`;
}
function unsubValido(token) {
  const s = String(token || "");
  const i = s.lastIndexOf(".");
  if (i < 1) return null;
  const id = s.slice(0, i), sig = s.slice(i + 1);
  const esperado = crypto.createHmac("sha256", UNSUB_SECRET).update(id).digest("hex").slice(0, 24);
  return sig === esperado ? id : null;
}
function unsubUrl(socioId) {
  const t = unsubToken(socioId);
  return t ? `${APP_URL}/api/baja?u=${encodeURIComponent(t)}` : "";
}
// Headers de un correo de MARKETING (List-Unsubscribe + one-click). Vacío si no hay id.
function headersMarketing(socioId) {
  const u = unsubUrl(socioId);
  return u ? { "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
}

// ── Idioma del socio para correos bilingües (es|en) ──────────────────────────
// Usa el idioma guardado; si no hay, lo infiere del país (fuera de países hispanos → EN).
const ISO_ES = new Set(["PY", "AR", "UY", "BO", "CL", "PE", "EC", "CO", "VE", "MX", "CR", "PA", "DO", "GT", "HN", "NI", "SV", "CU", "ES", "GQ"]);
function langDe(socio) {
  const l = socio && socio.idioma;
  if (l === "en" || l === "es") return l;
  const iso = (socio && (socio.pais_iso || "")).toUpperCase();
  if (iso && !ISO_ES.has(iso)) return "en";
  return "es";
}

// ── Formato de plata y fecha, reutilizados por varias plantillas ────────────
function gs(n) {
  return "₲ " + Number(n || 0).toLocaleString("es-PY");
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DIAS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "2026-08-23" → "domingo 23 de agosto" (o "Sunday, August 23" con { en: true })
function formatearFecha(f, { conDia = true, en = false } = {}) {
  if (!f) return "";
  const d = f instanceof Date ? f : new Date(String(f).slice(0, 10) + "T12:00:00-03:00");
  if (isNaN(d)) return String(f);
  if (en) {
    const base = `${MESES_EN[d.getMonth()]} ${d.getDate()}`;
    return conDia ? `${DIAS_EN[d.getDay()]}, ${base}` : base;
  }
  const base = `${d.getDate()} de ${MESES[d.getMonth()]}`;
  return conDia ? `${DIAS[d.getDay()]} ${base}` : base;
}

// Hora de Paraguay, sin zona en el string (la zona se escribe en el copy)
function formatearHora(f) {
  if (!f) return "";
  const d = f instanceof Date ? f : new Date(f);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Asuncion" });
}

async function enviar({ to, subject, html, headers }) {
  if (!habilitado) {
    log.info({ to, subject }, "email simulado (sin RESEND_API_KEY)");
    return { ok: true, modo: "simulado" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to, subject, html, ...(headers ? { headers } : {}) }),
    });
    if (!r.ok) { log.error({ status: r.status, body: await r.text().catch(() => "") }, "email Resend rechazó"); return { ok: false }; }
    return { ok: true, modo: "resend" };
  } catch (e) {
    log.error({ err: e.message }, "email error");
    return { ok: false };
  }
}

// ── Layout branded reutilizable (rediseño 2026-08, v2) ───────────────────────
// Tema real del sitio (tinta = oscuro, claro = claro — mismos roles que styles.css),
// botón de tinta por defecto (el oro queda reservado a las 6 acciones que cuestan
// dinero, igual que .btn-valor en el sitio), bloques `dato` y `lista` para sacar
// los números y beneficios del párrafo corrido, tabla en vez de <div> anidados
// (Outlook/Word engine), Saira con fallback Arial.
const TEMAS = {
  tinta: {
    page: "#0a0a0a", card: "#292824", inset: "#0d0d13", border: "#55534e",
    textPrimary: "#ffffff", textSecondary: "#9aa0a6", textTertiary: "#8a90a0",
    textValue: "#b08d2e", actionBg: "#ffffff", actionText: "#0a0a0a",
  },
  claro: {
    page: "#fafaf8", card: "#ffffff", inset: "#f5efdd", insetBorder: "#e8dcb8",
    border: "#e6e4df", textPrimary: "#0a0a0a", textSecondary: "#55534e", textTertiary: "#6b7280",
    textValue: "#7a5f14", actionBg: "#0a0a0a", actionText: "#ffffff",
  },
};
const ORO = "#b08d2e";     // --oro-500 · el único oro
const RADIO = "16px";      // --radio
const RADIO_BTN = "11px";  // .btn
const ANCHO = 600;
const FONT_DISPLAY = "'Saira', Arial, Helvetica, sans-serif";
const FONT_TEXTO = "'Saira', Arial, Helvetica, sans-serif";
const FONT_DATO = FONT_DISPLAY;

function layout({
  titulo, intro, ctaText, ctaUrl,
  ctaValor = false, // true SOLO si la acción cuesta dinero
  nota, badge,
  dato,   // { label, valor, nota }
  lista,  // [{ t, d }]
  unsubUrl, tema = "tinta",
} = {}) {
  const t = TEMAS[tema] || TEMAS.tinta;
  const logo = `${APP_URL}/assets/logo-email.png?v=4`;
  const insetBg = t.inset;
  const insetBorder = t.insetBorder || t.border;

  const btnBg = ctaValor ? ORO : t.actionBg;
  const btnFg = ctaValor ? "#ffffff" : t.actionText;

  const bloqueDato = dato
    ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          <tr><td style="background:${insetBg};border:1px solid ${insetBorder};border-radius:${RADIO};padding:18px 20px">
            <div style="font-family:${FONT_DISPLAY};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${t.textTertiary}">${dato.label}</div>
            <div style="font-family:${FONT_DATO};font-size:27px;font-weight:700;letter-spacing:-0.5px;color:${t.textValue};padding:5px 0 4px">${dato.valor}</div>
            ${dato.nota ? `<div style="font-family:${FONT_TEXTO};font-size:13px;line-height:1.45;color:${t.textSecondary}">${dato.nota}</div>` : ""}
          </td></tr>
        </table>`
    : "";

  const bloqueLista = Array.isArray(lista) && lista.length
    ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          ${lista.map((li) => `
          <tr>
            <td width="20" valign="top" style="padding:7px 0 7px 0">
              <div style="width:6px;height:6px;border-radius:50%;background:${ORO};margin-top:7px"></div>
            </td>
            <td valign="top" style="padding:7px 0">
              <div style="font-family:${FONT_TEXTO};font-size:15px;font-weight:700;line-height:1.3;color:${t.textPrimary}">${li.t}</div>
              ${li.d ? `<div style="font-family:${FONT_TEXTO};font-size:13px;line-height:1.5;color:${t.textSecondary};padding-top:2px">${li.d}</div>` : ""}
            </td>
          </tr>`).join("")}
        </table>`
    : "";

  return `
  <div style="background:${t.page};padding:40px 16px;font-family:${FONT_TEXTO}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="${ANCHO}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${ANCHO}px;background:${t.card};border:1px solid ${t.border};border-radius:${RADIO};overflow:hidden">

        <tr><td style="padding:20px 32px;background:${TEMAS.tinta.page};border-bottom:1px solid ${t.border}">
          <table role="presentation" width="100%"><tr>
            <td align="left"><img src="${logo}" alt="Olimpistas" width="130" style="width:130px;max-width:45%;height:auto;display:block;border:0" /></td>
            <td align="right" style="font-family:${FONT_TEXTO};font-size:12px;color:${TEMAS.tinta.textSecondary}">
              <a href="${APP_URL}" style="color:${TEMAS.tinta.textSecondary};text-decoration:none">Ver en el navegador</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:34px 32px 30px">
          ${badge ? `<div style="display:inline-block;padding:5px 12px;border:1px solid ${t.border};border-radius:999px;font-family:${FONT_DISPLAY};font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${t.textTertiary};margin:0 0 18px">${badge}</div>` : ""}
          <h1 style="margin:0 0 16px;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;line-height:1.1;letter-spacing:-0.5px;color:${t.textPrimary}">${titulo}</h1>
          <p style="margin:0 0 28px;font-family:${FONT_TEXTO};font-size:16px;line-height:1.6;color:${t.textSecondary}">${intro}</p>
          ${bloqueDato}
          ${bloqueLista}
          ${ctaText ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 4px"><tr><td style="background:${btnBg};border-radius:${RADIO_BTN}">
            <a href="${ctaUrl}" style="display:inline-block;padding:14px 26px;font-family:${FONT_TEXTO};font-size:15px;font-weight:700;color:${btnFg};text-decoration:none">${ctaText}</a>
          </td></tr></table>` : ""}
          ${nota ? `<p style="margin:24px 0 0;font-family:${FONT_TEXTO};font-size:13.5px;line-height:1.55;color:${t.textTertiary}">${nota}</p>` : ""}
        </td></tr>

        <tr><td style="padding:20px 32px 24px;background:${TEMAS.tinta.page};border-top:1px solid ${t.border}">
          <div style="font-family:${FONT_TEXTO};font-size:13px;font-weight:600;color:${TEMAS.tinta.textSecondary};padding-bottom:8px">
            <a href="mailto:hola@olimpistas.com" style="color:${TEMAS.tinta.textSecondary};text-decoration:none">Ayuda</a>
            &nbsp;&nbsp;<a href="${APP_URL}/miembro" style="color:${TEMAS.tinta.textSecondary};text-decoration:none">Mi cuenta</a>
            ${unsubUrl ? `&nbsp;&nbsp;<a href="${unsubUrl}" style="color:${TEMAS.tinta.textSecondary};text-decoration:none">Preferencias</a>` : ""}
          </div>
          <div style="font-family:${FONT_TEXTO};font-size:11.5px;line-height:1.5;color:${TEMAS.tinta.textTertiary}">
            Club Olimpia · El Rey de Copas · El Decano
            ${unsubUrl ? `<br /><a href="${unsubUrl}" style="color:${TEMAS.tinta.textTertiary};font-size:11px;text-decoration:underline">Darme de baja de novedades</a>` : ""}
          </div>
        </td></tr>

      </table>
    </td></tr></table>
  </div>`;
}

// ── 1) Verificación + bienvenida (al registrarse) ──
async function enviarVerificacion(socio, link) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "Confirm your email to activate your card" : "Confirmá tu email para activar tu carnet",
    html: layout({
      titulo: en ? `Welcome to the Decano${n}!` : `¡Bienvenido al Decano${n}!`,
      intro: en
        ? "Confirm your email to activate your Olimpista card, appear on the world map and never miss giveaways, presales and exclusive content."
        : "Confirmá tu email para activar tu carnet de Olimpista, aparecer en el mapa mundial y no perderte sorteos, preventas y contenido exclusivo.",
      ctaText: en ? "Confirm my email" : "Confirmar mi email",
      ctaUrl: link,
      nota: en ? "If you didn't create this account, ignore this message." : "Si no creaste esta cuenta, ignorá este mensaje.",
    }),
  });
}

// ── 2) Validado como socio de Olimpia → carnet incluido (Plus/Junior según edad) ──
async function enviarReconocido(socio, tier) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "We verified your club membership! 🥇" : "¡Validamos tu membresía de socio del Decano! 🥇",
    html: layout({
      badge: "OLIMPISTA SOCIO",
      titulo: en ? `You're now an Olimpista Socio${n}` : `Ahora sos Olimpista Socio${n}`,
      intro: en
        ? `We verified your Club Olimpia membership. Your card is now <b style='color:#b08d2e'>Olimpista Socio</b>, the highest tier in the system.`
        : `Validamos tu membresía del Club Olimpia. Tu carnet ahora es <b style='color:#b08d2e'>Olimpista Socio</b>, el nivel más alto del sistema.`,
      lista: en
        ? [
            { t: "Everything in Plus", d: "Exclusive content, priority presales and store discounts." },
            { t: "Your member status", d: "Your card shows your club membership status." },
            { t: "Member benefits", d: "The ones tied to the club roll, plus everything on the platform." },
          ]
        : [
            { t: "Todo lo de Plus", d: "Contenido exclusivo, preventas prioritarias y descuentos en la tienda." },
            { t: "Tu estatus de socio", d: "El carnet muestra tu condición de socio del club." },
            { t: "Beneficios de socio", d: "Los que corresponden al padrón, además de los de la plataforma." },
          ],
      ctaText: en ? "See my Socio card" : "Ver mi carnet de Socio",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── 2b) Validación de socio en revisión (cédula sin match automático) ──
async function enviarEnRevision(socio) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "We're reviewing your membership validation" : "Estamos revisando tu validación de socio",
    html: layout({
      titulo: en ? `We received your validation${n}` : `Recibimos tu validación${n}`,
      intro: en
        ? "We're checking your ID number against the Club Olimpia member roll. We'll confirm it within 48 business hours. Your card is upgraded automatically and we'll let you know. In the meantime, you're already an Olimpista — enjoy the community."
        : "Estamos verificando tu número de cédula contra el padrón del Club Olimpia. Lo confirmamos en 48 horas hábiles. Tu carnet sube de nivel automáticamente y te avisamos. Mientras tanto, ya sos Olimpista y podés disfrutar la comunidad.",
      ctaText: en ? "Go to my account" : "Ir a mi cuenta",
      ctaUrl: APP_URL + "/miembro",
      nota: en ? "If you think this is a mistake, reply to this email." : "Si creés que es un error, escribinos respondiendo este correo.",
    }),
  });
}

// ── 3) Campaña de activación (magic-link, para el padrón de socios del club) ──
async function enviarActivacion(socio, magicLink) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "Activate your Olimpista Socio account" : "Activá tu cuenta de Olimpista Socio",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA SOCIO",
      titulo: en ? `Your spot is waiting${n}` : `Tu lugar te espera${n}`,
      intro: en
        ? "You're a Club Olimpia member, so you get the <b style='color:#b08d2e'>Olimpista Socio</b> card — the highest tier, above Plus, granted only to club members. Activate your account in one tap and add your flag to the Decano's world map."
        : "Sos socio del Club Olimpia, así que te corresponde el carnet <b style='color:#b08d2e'>Olimpista Socio</b> — el nivel más alto, por encima de Plus, otorgado solo a los socios del club. Activá tu cuenta en un toque y sumá tu bandera al mapa mundial del Decano.",
      ctaText: en ? "Activate my account" : "Activar mi cuenta",
      ctaUrl: magicLink,
      nota: en ? "This link is personal. If you're not a Club Olimpia member, ignore this message." : "Este enlace es personal. Si no sos socio del Club Olimpia, ignorá este mensaje.",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 4) Remarketing: empezó el pago de Plus/Junior y NO lo completó ──
async function enviarRemkPago(socio, { link, tier, total } = {}) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const esJunior = tier === "kids";
  const nivel = esJunior ? "Junior" : "Plus";
  const precio = esJunior ? (en ? "₲ 80,000/year" : "₲ 80.000/año") : (en ? "₲ 180,000/year" : "₲ 180.000/año");
  const cta = link || (APP_URL + "/#planes");
  // Prueba social CUALITATIVA (nunca el contador exacto: en un correo sería una afirmación de hecho).
  const social = en
    ? `Thousands of olimpistas across dozens of countries are already part of the Decano. Join the ${nivel} tier.`
    : `Miles de olimpistas en decenas de países ya son parte del Decano. Sumate al nivel ${nivel}.`;
  const lista = en
    ? [
        { t: `Digital ${nivel} card`, d: "Your Olimpista identity, always with you." },
        { t: "Priority presales", d: "Buy tickets before anyone else." },
        { t: "Exclusive giveaways", d: "Jerseys, experiences and members-only prizes." },
        { t: "Olimpia Media+", d: "Behind the scenes, interviews and exclusive content." },
      ]
    : [
        { t: `Carnet ${nivel} digital`, d: "Tu identidad de Olimpista, siempre con vos." },
        { t: "Preventas prioritarias", d: "Comprá entradas antes que nadie." },
        { t: "Sorteos exclusivos", d: "Camisetas, experiencias y premios para miembros." },
        { t: "Olimpia Media+", d: "Detrás de escena, entrevistas y contenido exclusivo." },
      ];
  return enviar({
    to: socio.email,
    subject: en ? `You're one step from your ${nivel} card` : `Te quedaste a un paso de tu carnet ${nivel}`,
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "ONE STEP AWAY" : "TE FALTÓ UN PASO",
      titulo: en ? `You're one step from your ${nivel} card` : `Estás a un paso de tu carnet ${nivel}`,
      intro: en
        ? `You started your ${nivel}${n}, but didn't finish. <b style="color:#b08d2e">Your spot at the Decano is still reserved</b> — finish in 1 minute and unlock everything:`
        : `Empezaste tu ${nivel}${n}, pero no llegaste a completarlo. <b style="color:#b08d2e">Tu lugar en el Decano sigue reservado</b> — terminá en 1 minuto y desbloqueá todo:`,
      lista,
      dato: { label: nivel, valor: precio, nota: en ? "Full access to the Decano. Renews once a year." : "Acceso completo al Decano. Se renueva una vez por año." },
      ctaText: en ? `Complete my ${nivel}` : `Completar mi ${nivel}`,
      ctaUrl: cta,
      ctaValor: true,
      nota: social,
      tema: "claro",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 6) Reclasificación Plus → Socio (migración: socios al día que tenían Plus) ──
async function enviarSocioReclasificado(socio) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "Your Plus card became Olimpista Socio" : "Tu carnet Plus pasó a Olimpista Socio",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA SOCIO",
      titulo: en ? `Your card upgraded to Socio${n}` : `Tu carnet subió a Socio${n}`,
      intro: en
        ? "Because you're a <b style='color:#b08d2e'>member in good standing of Club Olimpia</b>, your card is no longer Plus — it's now <b style='color:#b08d2e'>Olimpista Socio</b>, the highest tier, above Plus. It includes everything in Plus (exclusive content, priority presales, benefits) plus your status and the best member benefits. You don't have to do anything: it's already in your account."
        : "Por ser <b style='color:#b08d2e'>socio al día del Club Olimpia</b>, tu carnet dejó de ser Plus y ahora es <b style='color:#b08d2e'>Olimpista Socio</b> — el nivel más alto, por encima de Plus. Incluye todo lo de Plus (contenido exclusivo, preventas prioritarias, beneficios) más tu estatus y los mejores beneficios de socio. No tenés que hacer nada: ya está en tu cuenta.",
      ctaText: en ? "See my Socio card" : "Ver mi carnet de Socio",
      ctaUrl: APP_URL + "/miembro",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 7) Confirmación de compra de Plus/Junior (tras acreditarse el pago) ──
async function enviarBienvenidaCompra(socio, tierSlug, vencimiento) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const esJunior = tierSlug === "kids";
  const nivel = esJunior ? "Junior" : "Plus";
  const precio = esJunior ? "₲ 80.000" : "₲ 180.000";
  const beneficios = en
    ? (esJunior
        ? "welcome pack, giveaways for kids and a surprise birthday gift"
        : "exclusive content (Olimpia Media+), priority presales, store discounts and VIP giveaways")
    : (esJunior
        ? "pack de bienvenida, sorteos para los más chicos y regalo sorpresa en su cumpleaños"
        : "contenido exclusivo (Olimpia Media+), preventas prioritarias, descuentos en la tienda y sorteos VIP");
  return enviar({
    to: socio.email,
    subject: en ? `Welcome to Olimpista ${nivel}! Your payment is confirmed` : `¡Bienvenido a Olimpista ${nivel}! Tu pago está confirmado`,
    html: layout({
      badge: "OLIMPISTA " + nivel.toUpperCase(),
      titulo: en ? `You're now an Olimpista ${nivel}${n}!` : `¡Ya sos Olimpista ${nivel}${n}!`,
      intro: en
        ? `We confirmed your payment and your <b style='color:#b08d2e'>${nivel}</b> card is now active: ${beneficios}. Come in and enjoy everything the Decano has for you.`
        : `Confirmamos tu pago y tu carnet <b style='color:#b08d2e'>${nivel}</b> ya está activo: ${beneficios}. Entrá y disfrutá todo lo que tiene el Decano para vos.`,
      dato: {
        label: en ? "Payment confirmed" : "Pago confirmado",
        valor: precio,
        nota: vencimiento
          ? (en ? `Your ${nivel} card expires on ${formatearFecha(vencimiento, { en: true })}.` : `Tu carnet ${nivel} vence el ${formatearFecha(vencimiento)}.`)
          : undefined,
      },
      ctaText: en ? "See my card" : "Ver mi carnet",
      ctaUrl: APP_URL + "/miembro",
      ctaValor: false,
      tema: "claro",
    }),
  });
}

// ── 8) Entrada de preventa confirmada (pago acreditado) — TRANSACCIONAL ──
async function enviarEntradaConfirmada(socio, { evento, fecha, sede, cantidad } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const cuando = fecha ? formatearFecha(fecha, { en }) : "";
  return enviar({
    to: socio.email,
    subject: en ? `🎟️ Your ticket for ${evento || "the match"} is confirmed` : `🎟️ Tu entrada para ${evento || "el partido"} está confirmada`,
    html: layout({
      badge: en ? "TICKET CONFIRMED" : "ENTRADA CONFIRMADA",
      titulo: en ? `You're going to the stadium${n}! 🎟️` : `¡Vas a la cancha${n}! 🎟️`,
      intro: en
        ? `We confirmed your payment for <b style='color:#b08d2e'>${evento || "the event"}</b>. Keep this email; we'll let you know if it's pickup or access with your card. See you at the Decano! 🤍🖤🤍`
        : `Confirmamos tu pago para <b style='color:#b08d2e'>${evento || "el evento"}</b>. Guardá este correo; te avisamos si se retira o se accede con el carnet. ¡Nos vemos en el Decano! 🤍🖤🤍`,
      dato: {
        label: evento || (en ? "Event" : "Evento"),
        valor: cantidad ? `${cantidad} ${en ? (cantidad > 1 ? "tickets" : "ticket") : (cantidad > 1 ? "entradas" : "entrada")}` : (en ? "1 ticket" : "1 entrada"),
        nota: [cuando, sede].filter(Boolean).join(" · "),
      },
      ctaText: en ? "See my tickets" : "Ver mis entradas",
      ctaUrl: APP_URL + "/miembro",
      ctaValor: false,
      tema: "claro",
    }),
  });
}

// ── 9) Referido: se sumó tu invitado (MARKETING/engagement) ──
async function enviarReferidoSumado(socio, { invitado, total } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const quien = invitado ? `<b style='color:#b08d2e'>${invitado}</b>` : (en ? "someone new" : "alguien nuevo");
  const cuenta = total ? (en ? ` You've already brought <b style='color:#b08d2e'>${total}</b> to the Decano.` : ` Ya sumaste <b style='color:#b08d2e'>${total}</b> al Decano.`) : "";
  return enviar({
    to: socio.email,
    subject: en ? "Your invite joined Olimpistas! 🤍🖤" : "¡Se sumó tu invitado a Olimpistas! 🤍🖤",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "YOUR CREW" : "TU HINCHADA",
      titulo: en ? `You grew the tribe${n}! 🤍🖤` : `¡Sumaste a la tribu${n}! 🤍🖤`,
      intro: en
        ? `${quien} joined Olimpistas with your invite.${cuenta} Keep inviting your crew — the more of us, the bigger the Decano in the world.`
        : `${quien} se sumó a Olimpistas con tu invitación.${cuenta} Seguí invitando a tu banda — cuantos más seamos, más grande es el Decano en el mundo.`,
      ctaText: en ? "Invite more" : "Invitar más",
      ctaUrl: APP_URL + "/miembro",
      unsubUrl: unsubUrl(socio.id),
      tema: "claro",
    }),
  });
}

// ── 10) Sorteo: ¡ganaste! (TRANSACCIONAL) ──
async function enviarSorteoGanador(socio, { titulo } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the giveaway" : "el sorteo");
  return enviar({
    to: socio.email,
    subject: en ? `🎉 You won: ${t}` : `🎉 ¡Ganaste! ${t}`,
    html: layout({
      badge: en ? "WINNER" : "GANADOR",
      titulo: en ? `You won${n}! 🎉` : `¡Ganaste${n}! 🎉`,
      intro: en
        ? `Congratulations! You're the winner of <b style='color:#b08d2e'>${t}</b>. We'll message you on WhatsApp within 48 hours with the details to claim your prize. ¡Arriba el Decano!`
        : `¡Felicitaciones! Sos el ganador de <b style='color:#b08d2e'>${t}</b>. Te escribimos por WhatsApp dentro de 48 horas con los detalles para reclamar tu premio. ¡Arriba el Decano!`,
      ctaText: en ? "See the giveaway" : "Ver el sorteo",
      ctaUrl: APP_URL + "/miembro/descubrir/sorteos",
      tema: "claro",
    }),
  });
}

// ── Subastas: te superaron / ganaste ──
async function enviarSubastaSuperado(socio, { titulo, monto, minimo, cierre } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const cierreTxt = cierre ? `${formatearFecha(cierre, { en })} ${en ? "at" : "a las"} ${formatearHora(cierre)}` : (en ? "soon" : "pronto");
  return enviar({
    to: socio.email,
    subject: en ? `You've been outbid — ${t}` : `Te superaron en ${t}`,
    html: layout({
      badge: en ? "OUTBID" : "TE SUPERARON",
      titulo: en ? `Someone outbid you${n}` : `Te superaron${n}`,
      intro: en
        ? `The top bid on <b style='color:#b08d2e'>${t}</b> is now <b>${gs(monto)}</b>. Don't lose it — place a higher bid before it closes.`
        : `La puja más alta en <b style='color:#b08d2e'>${t}</b> ahora es <b>${gs(monto)}</b>. No la pierdas — pujá de nuevo antes de que cierre.`,
      dato: minimo != null ? {
        label: en ? "Current bid" : "Puja actual",
        valor: gs(monto),
        nota: en ? `Minimum to retake the lead: ${gs(minimo)} · closes ${cierreTxt}.` : `Mínimo para superarla: ${gs(minimo)} · cierra ${cierreTxt}.`,
      } : undefined,
      ctaText: en ? "Raise my bid" : "Subir mi puja",
      ctaUrl: APP_URL + "/miembro",
      ctaValor: true,
    }),
  });
}
async function enviarSubastaGanador(socio, { titulo, monto, urlSubasta, limitePago } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const url = urlSubasta || (APP_URL + "/miembro");
  const plazo = limitePago ? formatearFecha(limitePago, { en }) : (en ? "soon" : "pronto");
  return enviar({
    to: socio.email,
    subject: en ? `You won the auction — ${t}` : `¡Ganaste la subasta! ${t}`,
    html: layout({
      badge: en ? "AUCTION WON" : "SUBASTA GANADA",
      titulo: en ? `You won${n}! 🏆` : `¡Ganaste${n}! 🏆`,
      intro: en
        ? `Congratulations! You won <b style='color:#b08d2e'>${t}</b> with a bid of <b>${gs(monto)}</b>. ¡Arriba el Decano!`
        : `¡Felicitaciones! Ganaste <b style='color:#b08d2e'>${t}</b> con una puja de <b>${gs(monto)}</b>. ¡Arriba el Decano!`,
      dato: { label: en ? "Your winning bid" : "Tu puja ganadora", valor: gs(monto) },
      lista: en
        ? [
            { t: "Complete the payment", d: `Online and secure, via Pagopar. You have until ${plazo}.` },
            { t: "We'll message you on WhatsApp", d: "As soon as it's confirmed, to arrange pickup or delivery." },
            { t: "You'll get the certificate", d: "Official Certificate of Authenticity, along with the item." },
          ]
        : [
            { t: "Completá el pago", d: `Online y seguro, por Pagopar. Tenés hasta el ${plazo}.` },
            { t: "Te escribimos por WhatsApp", d: "Apenas se acredite, para coordinar retiro o envío." },
            { t: "Recibís el certificado", d: "Certificado de Autenticidad oficial, junto con la pieza." },
          ],
      ctaText: en ? "Pay now" : "Pagar ahora",
      ctaUrl: url,
      ctaValor: true,
      nota: en ? "If the payment isn't completed in time, the item goes to the second-highest bidder." : "Si el pago no se completa en plazo, la pieza pasa al segundo mejor postor.",
    }),
  });
}

// ── Pago de subasta acreditado: avisa al ganador que ya coordinamos la entrega ──
async function enviarSubastaPagoConfirmado(socio, { titulo, urlCertificado } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "your item" : "tu lote");
  return enviar({
    to: socio.email,
    subject: en ? "✅ Payment received — we'll message you on WhatsApp" : "✅ Pago recibido — te escribimos por WhatsApp",
    html: layout({
      badge: en ? "PAYMENT CONFIRMED" : "PAGO CONFIRMADO",
      titulo: en ? `Payment received${n} ✅` : `Pago recibido${n} ✅`,
      intro: en
        ? `We confirmed your payment for <b style='color:#b08d2e'>${t}</b>. We'll message you on WhatsApp within 48 hours to coordinate delivery. ¡Arriba el Decano!`
        : `Confirmamos tu pago de <b style='color:#b08d2e'>${t}</b>. Te escribimos por WhatsApp dentro de 48 horas para coordinar la entrega. ¡Arriba el Decano!`,
      ctaText: urlCertificado ? (en ? "View Certificate of Authenticity" : "Ver Certificado de Autenticidad") : undefined,
      ctaUrl: urlCertificado,
    }),
  });
}

// ── Campaña de una subasta (MARKETING, envío manual vía setup/enviar-campana-subasta.js) ──
// Dos variantes según el destinatario YA alcance el nivel mínimo de la subasta o no:
// invitación directa a pujar (ya elegible) vs. invitación a subir de nivel (Plus/Socio).
async function enviarSubastaInvitacion(socio, { titulo, urlSubasta, momento, pujaActual, cierre } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const url = urlSubasta || (APP_URL + "/miembro");
  const final = momento === "final";
  const cierreTxt = cierre
    ? (en ? `Closes ${formatearFecha(cierre, { en: true })} at ${formatearHora(cierre)} (Paraguay time).` : `Cierra el ${formatearFecha(cierre)} a las ${formatearHora(cierre)} de Paraguay.`)
    : "";
  const antisnipe = en
    ? "A bid in the final 3 minutes extends the clock: nothing is decided until the very end."
    : "Una puja en los últimos 3 minutos extiende el reloj: nada está dicho hasta el final.";
  return enviar({
    to: socio.email,
    subject: en
      ? (final ? `Final hours — bid on ${t}` : `Live now: bid on ${t}`)
      : (final ? `Últimas horas — pujá por ${t}` : `Ya está en vivo: pujá por ${t}`),
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "LIVE AUCTION" : "SUBASTA EN VIVO",
      titulo: en ? `${final ? "Last call" : "It's live"}${n}` : `${final ? "Última llamada" : "Ya podés pujar"}${n}`,
      intro: en
        ? (final
          ? `The auction for <b style='color:#b08d2e'>${t}</b> closes soon. Get your bid in before it's gone.`
          : `<b style='color:#b08d2e'>${t}</b> is now live. Place your bid and follow the action in real time.`)
        : (final
          ? `La subasta de <b style='color:#b08d2e'>${t}</b> cierra pronto. Pujá antes de que se termine.`
          : `<b style='color:#b08d2e'>${t}</b> ya está en subasta. Hacé tu puja y seguí el minuto a minuto.`),
      dato: pujaActual != null ? {
        label: en ? "Current bid" : "Puja actual",
        valor: gs(pujaActual),
        nota: cierreTxt + (final && cierreTxt ? " " + antisnipe : ""),
      } : undefined,
      ctaText: en ? "Bid now" : "Pujar ahora",
      ctaUrl: url,
      ctaValor: true,
    }),
  });
}
async function enviarSubastaUpsell(socio, { titulo, urlSubasta, momento } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "this auction" : "esta subasta");
  const url = urlSubasta || (APP_URL + "/miembro");
  const final = momento === "final";
  return enviar({
    to: socio.email,
    subject: en
      ? (final ? `⏳ Last chance to join the auction for ${t}` : `🔨 Want in? ${t} is up for auction`)
      : (final ? `⏳ Última chance para entrar a la subasta de ${t}` : `🔨 ¿Querés entrar? Se subasta ${t}`),
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "PLUS EXCLUSIVE" : "EXCLUSIVO PLUS",
      // El cuerpo también varía por momento (antes el subject prometía urgencia — "última
      // chance" — pero el texto de abajo quedaba idéntico al de "recién arrancó").
      titulo: en ? (final ? `Last chance${n}` : `Join the bid${n}`) : (final ? `Última oportunidad${n}` : `Sumate a la puja${n}`),
      intro: en
        ? (final
          ? `<b style='color:#b08d2e'>${t}</b> closes soon and is still exclusive to Olimpista Plus and Socio members. Upgrade now — you're still in time to bid before it's gone.`
          : `<b style='color:#b08d2e'>${t}</b> is being auctioned right now — exclusive to Olimpista Plus and Socio members. Upgrade today and you're in time to bid before it closes.`)
        : (final
          ? `<b style='color:#b08d2e'>${t}</b> cierra pronto y sigue siendo exclusiva para Olimpistas Plus y Socio. Sumate ahora — todavía llegás a tiempo para pujar antes de que se termine.`
          : `<b style='color:#b08d2e'>${t}</b> se está subastando ahora mismo — exclusivo para Olimpistas Plus y Socio. Sumate hoy y llegás a tiempo para pujar antes del cierre.`),
      dato: {
        label: "Olimpista Plus",
        valor: en ? "₲ 180,000/year" : "₲ 180.000/año",
        nota: en ? "Unlocks this auction and every other exclusive." : "Te habilita esta subasta y todas las exclusivas.",
      },
      ctaText: en ? "Go Plus" : "Hacerme Plus",
      ctaUrl: url,
      ctaValor: true,
    }),
  });
}

// ── 11) Cumpleaños (MARKETING) ──
async function enviarCumple(socio) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "Happy birthday from the Decano! 🎂🤍🖤" : "¡Feliz cumple de parte del Decano! 🎂🤍🖤",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "HAPPY BIRTHDAY" : "FELIZ CUMPLE",
      titulo: en ? `Happy birthday${n}! 🎂` : `¡Feliz cumpleaños${n}! 🎂`,
      intro: en
        ? "The whole Decano family wishes you an amazing day. Thanks for being part of Olimpistas — today we celebrate you. 🤍🖤🤍"
        : "Toda la familia del Decano te desea un día increíble. Gracias por ser parte de Olimpistas — hoy te celebramos a vos. 🤍🖤🤍",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 12) Renovación de membresía (MARKETING) ──
async function enviarRenovacion(socio, { tier, dias } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const nivel = tier === "kids" ? "Junior" : "Plus";
  const precio = tier === "kids" ? (en ? "₲ 80,000/year" : "₲ 80.000/año") : (en ? "₲ 180,000/year" : "₲ 180.000/año");
  const cuando = dias > 0 ? (en ? `in ${dias} day${dias > 1 ? "s" : ""}` : `en ${dias} día${dias > 1 ? "s" : ""}`) : (en ? "soon" : "pronto");
  const fechaVence = dias > 0 ? new Date(Date.now() + dias * 86400000) : null;
  return enviar({
    to: socio.email,
    subject: en ? `Your Olimpista ${nivel} renews ${cuando}` : `Tu Olimpista ${nivel} se renueva ${cuando}`,
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA " + nivel.toUpperCase(),
      titulo: en ? `Keep your ${nivel} card${n}` : `Mantené tu carnet ${nivel}${n}`,
      intro: en
        ? `Your Olimpista <b style='color:#b08d2e'>${nivel}</b> membership expires ${cuando}. Renew to keep your exclusive content, priority presales and member benefits without interruption.`
        : `Tu membresía Olimpista <b style='color:#b08d2e'>${nivel}</b> vence ${cuando}. Renovala para seguir con tu contenido exclusivo, preventas prioritarias y beneficios de miembro sin cortes.`,
      dato: {
        label: en ? "Expires" : "Vence",
        valor: fechaVence ? formatearFecha(fechaVence, { en }) : (en ? "very soon" : "muy pronto"),
        nota: `${nivel} · ${precio}`,
      },
      ctaText: en ? "Renew now" : "Renovar ahora",
      ctaUrl: APP_URL + "/miembro",
      ctaValor: true,
      tema: "claro",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 5) Recuperar contraseña ──
async function enviarReset(socio, link) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "Reset your password — Olimpistas.com" : "Restablecé tu contraseña — Olimpistas.com",
    html: layout({
      titulo: en ? `Recover your account${n}` : `Recuperá tu cuenta${n}`,
      intro: en
        ? "You asked to reset your password. Tap the button to create a new one. The link expires in 1 hour."
        : "Pediste restablecer tu contraseña. Tocá el botón para crear una nueva. El enlace vence en 1 hora.",
      ctaText: en ? "Create new password" : "Crear nueva contraseña",
      ctaUrl: link,
      nota: en ? "If you didn't request this, ignore the email: your password stays the same." : "Si no pediste esto, ignorá el correo: tu contraseña sigue igual.",
      tema: "claro",
    }),
  });
}

module.exports = { enviar, enviarVerificacion, enviarReconocido, enviarEnRevision, enviarActivacion, enviarRemkPago, enviarSocioReclasificado, enviarBienvenidaCompra, enviarEntradaConfirmada, enviarReferidoSumado, enviarSorteoGanador, enviarSubastaSuperado, enviarSubastaGanador, enviarSubastaPagoConfirmado, enviarSubastaInvitacion, enviarSubastaUpsell, enviarCumple, enviarRenovacion, enviarReset, unsubValido, unsubUrl, habilitado, layout, formatearFecha, formatearHora };
