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

// ── Layout branded reutilizable (negro/oro, sin imágenes externas = llega siempre) ──
function layout({ titulo, intro, ctaText, ctaUrl, nota, badge, unsubUrl }) {
  // ?v se sube cuando cambia el logo: fuerza a Gmail/clientes a re-descargar la imagen.
  const logo = `${APP_URL}/assets/logo-email.png?v=3`;
  // Rediseño (2026-08): fuera los gradientes dorados brillantes, las pills en mayúscula
  // y el centrado total — leían más a promoción barata que a comunicación de un club.
  // Ahora: dorado plano usado como acento puntual, texto alineado a la izquierda, pesos
  // de fuente más contenidos (700 como máximo, web-safe en clientes de correo).
  return `
  <div style="background:#0b0b0f;padding:40px 16px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#141419;border:1px solid #26262c;border-radius:12px;overflow:hidden">
      <div style="padding:30px 40px 24px;text-align:center;border-bottom:1px solid #26262c">
        <img src="${logo}" alt="Olimpistas" width="176" style="width:176px;max-width:58%;height:auto;display:inline-block" />
      </div>
      <div style="padding:40px">
        ${badge ? `<div style="margin:0 0 14px"><span style="font-weight:700;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#c9a227">${badge}</span></div>` : ""}
        <h1 style="margin:0 0 16px;color:#fff;font-size:22px;line-height:1.4;font-weight:700">${titulo}</h1>
        <p style="color:#b4b4bb;line-height:1.7;font-size:15px;margin:0 0 30px">${intro}</p>
        ${ctaText ? `<p style="margin:0 0 8px"><a href="${ctaUrl}" style="background:#c9a227;color:#0b0b0f;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:8px;display:inline-block;font-size:15px">${ctaText}</a></p>` : ""}
        ${nota ? `<p style="color:#6c6c74;font-size:12.5px;line-height:1.6;margin-top:28px">${nota}</p>` : ""}
      </div>
      <div style="padding:20px 40px;text-align:center;border-top:1px solid #26262c">
        <span style="color:#56565e;font-size:11.5px;letter-spacing:.2px">Club Olimpia · El Rey de Copas · El Decano</span>
        ${unsubUrl ? `<br><a href="${unsubUrl}" style="color:#56565e;font-size:11px;text-decoration:underline">Darme de baja de novedades</a>` : ""}
      </div>
    </div>
  </div>`;
}

// ── 1) Verificación + bienvenida (al registrarse) ──
async function enviarVerificacion(socio, link) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "You're an Olimpista! Confirm your email 🤍🖤🤍" : "¡Ya sos Olimpista! Confirmá tu email 🤍🖤🤍",
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
      titulo: en ? `You're a true Decano member${n}!` : `¡Sos Socio del Decano de verdad${n}!`,
      intro: en
        ? `We verified your Club Olimpia membership. Your card is now <b style='color:#c9a227'>Olimpista Socio</b> — the highest tier, above Plus and granted only to club members: it includes everything in Plus (exclusive content, priority presale, benefits) plus your member status and benefits. Come in and see your card.`
        : `Validamos tu membresía de socio del Club Olimpia. Tu carnet ahora es <b style='color:#c9a227'>Olimpista Socio</b> — el nivel más alto, por encima de Plus y otorgado solo a los socios del club: incluye todo lo de Plus (contenido exclusivo, preventa prioritaria, beneficios) más el estatus y los beneficios de socio. Entrá y mirá tu carnet.`,
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
        ? "We're checking your ID number against the Club Olimpia member roll. As soon as we confirm it, your card is upgraded automatically and we'll let you know. In the meantime, you're already an Olimpista — enjoy the community."
        : "Estamos verificando tu número de cédula contra el padrón del Club Olimpia. En cuanto lo confirmemos, tu carnet sube de nivel automáticamente y te avisamos. Mientras tanto, ya sos Olimpista y podés disfrutar la comunidad.",
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
    subject: en ? "Activate your spot as an Olimpista Socio 🥇" : "Activá tu lugar como Olimpista Socio 🥇",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA SOCIO",
      titulo: en ? `Your spot is waiting${n}` : `Tu lugar te espera${n}`,
      intro: en
        ? "You're a Club Olimpia member, so you get the <b style='color:#c9a227'>Olimpista Socio</b> card — the highest tier, above Plus, granted only to club members. Activate your account in one tap and add your flag to the Decano's world map."
        : "Sos socio del Club Olimpia, así que te corresponde el carnet <b style='color:#c9a227'>Olimpista Socio</b> — el nivel más alto, por encima de Plus, otorgado solo a los socios del club. Activá tu cuenta en un toque y sumá tu bandera al mapa mundial del Decano.",
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
  const logo = `${APP_URL}/assets/logo-email.png?v=3`;
  const unsub = unsubUrl(socio.id);
  const cta = link || (APP_URL + "/#planes");
  // Prueba social CUALITATIVA (nunca el contador exacto: en un correo sería una afirmación de hecho).
  const social = en
    ? `Thousands of olimpistas across dozens of countries are already part of the Decano. Join the ${nivel} tier.`
    : `Miles de olimpistas en decenas de países ya son parte del Decano. Sumate al nivel ${nivel}.`;
  const benef = (en
    ? [
        ["🪪", `Digital ${nivel} card`, "Your Olimpista identity, always with you."],
        ["🎟️", "Priority presales", "Buy tickets before anyone else."],
        ["🎁", "Exclusive giveaways", "Jerseys, experiences and members-only prizes."],
        ["▶️", "Olimpia Media+", "Behind the scenes, interviews and exclusive content."],
      ]
    : [
        ["🪪", `Carnet ${nivel} digital`, "Tu identidad de Olimpista, siempre con vos."],
        ["🎟️", "Preventas prioritarias", "Comprá entradas antes que nadie."],
        ["🎁", "Sorteos exclusivos", "Camisetas, experiencias y premios para miembros."],
        ["▶️", "Olimpia Media+", "Detrás de escena, entrevistas y contenido exclusivo."],
      ]
  ).map((b) => `
      <tr>
        <td style="padding:9px 0;vertical-align:top;width:38px;font-size:21px">${b[0]}</td>
        <td style="padding:9px 0;vertical-align:top">
          <div style="color:#fff;font-weight:700;font-size:15px">${b[1]}</div>
          <div style="color:#9a9aa4;font-size:13px;line-height:1.5">${b[2]}</div>
        </td>
      </tr>`).join("");
  const html = `
  <div style="background:#0b0b0f;padding:40px 16px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#141419;border:1px solid #26262c;border-radius:12px;overflow:hidden">
      <div style="padding:30px 40px 24px;text-align:center;border-bottom:1px solid #26262c">
        <img src="${logo}" alt="Olimpistas" width="176" style="width:176px;max-width:58%;height:auto;display:inline-block" />
      </div>
      <div style="padding:40px 40px 8px">
        <div style="margin:0 0 14px"><span style="font-weight:700;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#c9a227">${en ? "One step away" : "Te faltó un paso"}</span></div>
        <h1 style="margin:0 0 16px;color:#fff;font-size:22px;line-height:1.4;font-weight:700">${en ? `You're one step from your ${nivel} card` : `Estás a un paso de tu carnet ${nivel}`} 🤍🖤🤍</h1>
        <p style="color:#b4b4bb;line-height:1.7;font-size:15px;margin:0">${en ? `You started your ${nivel}${n}, but didn't finish. <b style="color:#fff">Your spot at the Decano is still reserved</b> — finish in 1 minute and unlock everything:` : `Empezaste tu ${nivel}${n}, pero no llegaste a completarlo. <b style="color:#fff">Tu lugar en el Decano sigue reservado</b> — terminá en 1 minuto y desbloqueá todo:`}</p>
      </div>
      <div style="padding:6px 40px 4px"><table style="width:100%;border-collapse:collapse">${benef}</table></div>
      <div style="padding:14px 40px 0">
        <p style="margin:18px 0 10px"><a href="${cta}" style="background:#c9a227;color:#0b0b0f;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:8px;display:inline-block;font-size:15px">${en ? `Complete my ${nivel} now →` : `Completar mi ${nivel} ahora →`}</a></p>
        <p style="color:#9a9aa4;font-size:13.5px;margin:6px 0 0">${nivel} · <b style="color:#c9a227">${precio}</b> · ${en ? "full access to the Decano" : "acceso completo al Decano"}</p>
        ${social ? `<p style="color:#6c6c74;font-size:12.5px;line-height:1.6;margin:18px 0 0">${social}</p>` : ""}
      </div>
      <div style="padding:20px 40px;text-align:center;border-top:1px solid #26262c;margin-top:22px">
        <span style="color:#56565e;font-size:11.5px;letter-spacing:.2px">Club Olimpia · El Rey de Copas · El Decano</span>
        ${unsub ? `<br><a href="${unsub}" style="color:#56565e;font-size:11px;text-decoration:underline">Darme de baja de novedades</a>` : ""}
      </div>
    </div>
  </div>`;
  return enviar({
    to: socio.email,
    subject: en
      ? `${socio.nombre || "Hey"}, you're one step from your ${nivel} card 🤍🖤🤍`
      : `${socio.nombre || "Che"}, te quedaste a un paso de tu carnet ${nivel} 🤍🖤🤍`,
    headers: headersMarketing(socio.id),
    html,
  });
}

// ── 6) Reclasificación Plus → Socio (migración: socios al día que tenían Plus) ──
async function enviarSocioReclasificado(socio) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  return enviar({
    to: socio.email,
    subject: en ? "You leveled up: you're now an Olimpista Socio 🖤🤍" : "Subiste de nivel: ahora sos Olimpista Socio 🖤🤍",
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA SOCIO",
      titulo: en ? `You leveled up${n} 🖤🤍` : `Subiste de nivel${n} 🖤🤍`,
      intro: en
        ? "Because you're a <b style='color:#c9a227'>member in good standing of Club Olimpia</b>, your card is no longer Plus — it's now <b style='color:#c9a227'>Olimpista Socio</b>, the highest tier, above Plus. It includes everything in Plus (exclusive content, priority presales, benefits) plus your status and the best member benefits. You don't have to do anything: it's already in your account."
        : "Por ser <b style='color:#c9a227'>socio al día del Club Olimpia</b>, tu carnet dejó de ser Plus y ahora es <b style='color:#c9a227'>Olimpista Socio</b> — el nivel más alto, por encima de Plus. Incluye todo lo de Plus (contenido exclusivo, preventas prioritarias, beneficios) más tu estatus y los mejores beneficios de socio. No tenés que hacer nada: ya está en tu cuenta.",
      ctaText: en ? "See my Socio card" : "Ver mi carnet de Socio",
      ctaUrl: APP_URL + "/miembro",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 7) Confirmación de compra de Plus/Junior (tras acreditarse el pago) ──
async function enviarBienvenidaCompra(socio, tierSlug) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const esJunior = tierSlug === "kids";
  const nivel = esJunior ? "Junior" : "Plus";
  const beneficios = en
    ? (esJunior
        ? "welcome pack, giveaways for kids and a surprise birthday gift"
        : "exclusive content (Olimpia Media+), priority presales, store discounts and VIP giveaways")
    : (esJunior
        ? "pack de bienvenida, sorteos para los más chicos y regalo sorpresa en su cumpleaños"
        : "contenido exclusivo (Olimpia Media+), preventas prioritarias, descuentos en la tienda y sorteos VIP");
  return enviar({
    to: socio.email,
    subject: en ? `Welcome to Olimpista ${nivel}! Your payment is confirmed 🎉` : `¡Bienvenido a Olimpista ${nivel}! Tu pago está confirmado 🎉`,
    html: layout({
      badge: "OLIMPISTA " + nivel.toUpperCase(),
      titulo: en ? `You're now an Olimpista ${nivel}${n}!` : `¡Ya sos Olimpista ${nivel}${n}!`,
      intro: en
        ? `We confirmed your payment and your <b style='color:#c9a227'>${nivel}</b> card is now active: ${beneficios}. Come in and enjoy everything the Decano has for you.`
        : `Confirmamos tu pago y tu carnet <b style='color:#c9a227'>${nivel}</b> ya está activo: ${beneficios}. Entrá y disfrutá todo lo que tiene el Decano para vos.`,
      ctaText: en ? "See my card" : "Ver mi carnet",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── 8) Entrada de preventa confirmada (pago acreditado) — TRANSACCIONAL ──
async function enviarEntradaConfirmada(socio, { evento, fecha, sede, cantidad } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const cuando = fecha ? String(fecha).slice(0, 10) : "";
  const detalle = [cantidad ? `${cantidad} ${en ? (cantidad > 1 ? "tickets" : "ticket") : (cantidad > 1 ? "entradas" : "entrada")}` : "", cuando, sede].filter(Boolean).join(" · ");
  return enviar({
    to: socio.email,
    subject: en ? `🎟️ Your ticket for ${evento || "the match"} is confirmed` : `🎟️ Tu entrada para ${evento || "el partido"} está confirmada`,
    html: layout({
      badge: en ? "TICKET CONFIRMED" : "ENTRADA CONFIRMADA",
      titulo: en ? `You're going to the stadium${n}! 🎟️` : `¡Vas a la cancha${n}! 🎟️`,
      intro: en
        ? `We confirmed your payment for <b style='color:#c9a227'>${evento || "the event"}</b>${detalle ? ` — ${detalle}` : ""}. Keep this email; we'll send you the pickup/access details. See you at the Decano! 🤍🖤🤍`
        : `Confirmamos tu pago para <b style='color:#c9a227'>${evento || "el evento"}</b>${detalle ? ` — ${detalle}` : ""}. Guardá este correo; te avisaremos los detalles de retiro/acceso. ¡Nos vemos en el Decano! 🤍🖤🤍`,
      ctaText: en ? "See my tickets" : "Ver mis entradas",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── 9) Referido: se sumó tu invitado (MARKETING/engagement) ──
async function enviarReferidoSumado(socio, { invitado, total } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const quien = invitado ? `<b style='color:#c9a227'>${invitado}</b>` : (en ? "someone new" : "alguien nuevo");
  const cuenta = total ? (en ? ` You've already brought <b style='color:#c9a227'>${total}</b> to the Decano.` : ` Ya sumaste <b style='color:#c9a227'>${total}</b> al Decano.`) : "";
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
        ? `Congratulations! You're the winner of <b style='color:#c9a227'>${t}</b>. We'll contact you shortly with the details to claim your prize. ¡Arriba el Decano!`
        : `¡Felicitaciones! Sos el ganador de <b style='color:#c9a227'>${t}</b>. En breve te contactamos con los detalles para reclamar tu premio. ¡Arriba el Decano!`,
      ctaText: en ? "Go to my account" : "Ir a mi cuenta",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── Subastas: te superaron / ganaste ──
async function enviarSubastaSuperado(socio, { titulo, monto } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const g = "₲ " + Number(monto || 0).toLocaleString("es-PY");
  return enviar({
    to: socio.email,
    subject: en ? `⚠️ You've been outbid — ${t}` : `⚠️ Te superaron en ${t}`,
    html: layout({
      badge: en ? "OUTBID" : "TE SUPERARON",
      titulo: en ? `Someone outbid you${n}` : `Te superaron${n}`,
      intro: en
        ? `The top bid on <b style='color:#c9a227'>${t}</b> is now <b>${g}</b>. Don't lose it — place a higher bid before it closes.`
        : `La puja más alta en <b style='color:#c9a227'>${t}</b> ahora es <b>${g}</b>. No la pierdas — pujá de nuevo antes de que cierre.`,
      ctaText: en ? "Bid again" : "Pujar de nuevo",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}
async function enviarSubastaGanador(socio, { titulo, monto } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const g = "₲ " + Number(monto || 0).toLocaleString("es-PY");
  return enviar({
    to: socio.email,
    subject: en ? `🏆 You won the auction — ${t}` : `🏆 ¡Ganaste la subasta! ${t}`,
    html: layout({
      badge: en ? "AUCTION WON" : "SUBASTA GANADA",
      titulo: en ? `You won${n}! 🏆` : `¡Ganaste${n}! 🏆`,
      intro: en
        ? `Congratulations! You won <b style='color:#c9a227'>${t}</b> with a bid of <b>${g}</b>. We'll reach out via WhatsApp to arrange payment and delivery, along with its official Certificate of Authenticity. ¡Arriba el Decano!`
        : `¡Felicitaciones! Ganaste <b style='color:#c9a227'>${t}</b> con una puja de <b>${g}</b>. Te vamos a escribir por WhatsApp para coordinar el pago y la entrega, junto con su Certificado de Autenticidad oficial. ¡Arriba el Decano!`,
      ctaText: en ? "Ir a mi cuenta" : "Ir a mi cuenta",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── Campaña de una subasta (MARKETING, envío manual vía setup/enviar-campana-subasta.js) ──
// Dos variantes según el destinatario YA alcance el nivel mínimo de la subasta o no:
// invitación directa a pujar (ya elegible) vs. invitación a subir de nivel (Plus/Socio).
async function enviarSubastaInvitacion(socio, { titulo, urlSubasta, momento } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const t = titulo || (en ? "the auction" : "la subasta");
  const url = urlSubasta || (APP_URL + "/miembro");
  const final = momento === "final";
  return enviar({
    to: socio.email,
    subject: en
      ? (final ? `⏳ Final hours — bid on ${t}` : `🔨 Live now: bid on ${t}`)
      : (final ? `⏳ Últimas horas — pujá por ${t}` : `🔨 Ya está en vivo: pujá por ${t}`),
    headers: headersMarketing(socio.id),
    html: layout({
      badge: en ? "LIVE AUCTION" : "SUBASTA EN VIVO",
      titulo: en ? `${final ? "Last call" : "It's live"}${n}` : `${final ? "Última llamada" : "Ya podés pujar"}${n}`,
      intro: en
        ? (final
          ? `The auction for <b style='color:#c9a227'>${t}</b> closes soon. Get your bid in before it's gone — a bid in the final 3 minutes extends the clock, so nothing is decided until the very end.`
          : `<b style='color:#c9a227'>${t}</b> is now live. Place your bid and follow the action in real time.`)
        : (final
          ? `La subasta de <b style='color:#c9a227'>${t}</b> cierra pronto. Pujá antes de que se termine — recordá que una puja en los últimos 3 minutos extiende el reloj, así que nada está dicho hasta el final.`
          : `<b style='color:#c9a227'>${t}</b> ya está en subasta. Hacé tu puja y seguí el minuto a minuto.`),
      ctaText: en ? "Bid now" : "Pujar ahora",
      ctaUrl: url,
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
          ? `<b style='color:#c9a227'>${t}</b> closes soon and is still exclusive to Olimpista Plus and Socio members. Upgrade now — you're still in time to bid before it's gone.`
          : `<b style='color:#c9a227'>${t}</b> is being auctioned right now — exclusive to Olimpista Plus and Socio members. Upgrade today and you're in time to bid before it closes.`)
        : (final
          ? `<b style='color:#c9a227'>${t}</b> cierra pronto y sigue siendo exclusiva para Olimpistas Plus y Socio. Sumate ahora — todavía llegás a tiempo para pujar antes de que se termine.`
          : `<b style='color:#c9a227'>${t}</b> se está subastando ahora mismo — exclusivo para Olimpistas Plus y Socio. Sumate hoy y llegás a tiempo para pujar antes del cierre.`),
      ctaText: en ? "Go Plus" : "Hacerme Plus",
      ctaUrl: url,
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
      ctaText: en ? "Go to my account" : "Ir a mi cuenta",
      ctaUrl: APP_URL + "/miembro",
      unsubUrl: unsubUrl(socio.id),
    }),
  });
}

// ── 12) Renovación de membresía (MARKETING) ──
async function enviarRenovacion(socio, { tier, dias } = {}) {
  const n = socio && socio.nombre ? ", " + socio.nombre : "";
  const en = langDe(socio) === "en";
  const nivel = tier === "kids" ? "Junior" : "Plus";
  const cuando = dias > 0 ? (en ? `in ${dias} day${dias > 1 ? "s" : ""}` : `en ${dias} día${dias > 1 ? "s" : ""}`) : (en ? "soon" : "pronto");
  return enviar({
    to: socio.email,
    subject: en ? `Your Olimpista ${nivel} renews ${cuando}` : `Tu Olimpista ${nivel} se renueva ${cuando}`,
    headers: headersMarketing(socio.id),
    html: layout({
      badge: "OLIMPISTA " + nivel.toUpperCase(),
      titulo: en ? `Keep your ${nivel} card${n}` : `Mantené tu carnet ${nivel}${n}`,
      intro: en
        ? `Your Olimpista <b style='color:#c9a227'>${nivel}</b> membership expires ${cuando}. Renew to keep your exclusive content, priority presales and member benefits without interruption.`
        : `Tu membresía Olimpista <b style='color:#c9a227'>${nivel}</b> vence ${cuando}. Renovala para seguir con tu contenido exclusivo, preventas prioritarias y beneficios de socio sin cortes.`,
      ctaText: en ? "Renew now" : "Renovar ahora",
      ctaUrl: APP_URL + "/miembro",
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
    }),
  });
}

module.exports = { enviar, enviarVerificacion, enviarReconocido, enviarEnRevision, enviarActivacion, enviarRemkPago, enviarSocioReclasificado, enviarBienvenidaCompra, enviarEntradaConfirmada, enviarReferidoSumado, enviarSorteoGanador, enviarSubastaSuperado, enviarSubastaGanador, enviarSubastaInvitacion, enviarSubastaUpsell, enviarCumple, enviarRenovacion, enviarReset, unsubValido, unsubUrl, habilitado, layout };
