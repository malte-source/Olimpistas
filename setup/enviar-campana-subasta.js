"use strict";
/**
 * Campaña de comunicación de una subasta (plan de marketing "Fase 2/Fase 4"):
 * manda UN correo a toda la base viva, segmentado en dos variantes según si el
 * destinatario YA alcanza el nivel mínimo de la subasta o no:
 *   - Ya elegible (Plus/Socio/etc.)  → enviarSubastaInvitacion (CTA: pujar ahora)
 *   - No elegible (típicamente Olimpista gratis) → enviarSubastaUpsell (CTA: Hacerme Plus)
 * El nivel mínimo se lee de la propia subasta (nivel_min), así que sirve para
 * cualquier subasta futura sin tocar el script.
 *
 *   dry-run (solo lista):  OLIMPISTAS_DATABASE_URL=... node setup/enviar-campana-subasta.js --subasta <id> --momento inicio
 *   preview (1 a tu mail): RESEND_API_KEY=... OLIMPISTAS_DATABASE_URL=... node setup/enviar-campana-subasta.js --subasta <id> --momento inicio --preview vos@mail.com
 *   ENVIAR a todos:        OLIMPISTAS_DATABASE_URL=... RESEND_API_KEY=... node setup/enviar-campana-subasta.js --subasta <id> --momento inicio --apply
 *
 * --momento: "inicio" (Fase 2, recién arrancó) o "final" (Fase 4, últimas horas). Cambia
 * solo el copy (urgencia); la segmentación de audiencia es la misma en ambos momentos.
 * --imagen <url>: banner promocional opcional (URL pública, ej. subido a public/assets/campanas/)
 * que se muestra arriba del cuerpo del correo, en las dos variantes.
 */
const postgres = require("postgres");
const mailer = require("../lib/email");
const BASE = process.env.APP_URL || "https://www.olimpistas.com";
const SEED = "%@demo.olimpistas.test";

const apply = process.argv.includes("--apply");
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const subastaId = arg("--subasta");
const momento = arg("--momento") === "final" ? "final" : "inicio";
const previewTo = arg("--preview");
const imagen = arg("--imagen");

async function getJSON(path) { const r = await fetch(BASE + path); if (!r.ok) throw new Error(path + " → " + r.status); return r.json(); }

// Reintento con backoff (envío real, 2026-08-09 con Tim Payne): en un envío largo
// (miles de correos, más de una hora corrida) Resend/la red tienen cortes transitorios
// — "fetch failed", algún 500/502 — que sin reintento se pierden para siempre. 3 intentos
// con pausa creciente resuelve la enorme mayoría sin intervención manual después.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function conReintento(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fn(); if (r && r.ok) return r; } catch (e) { /* cae al reintento */ }
    if (i < tries - 1) await sleep(1500 * (i + 1));
  }
  return { ok: false };
}

(async () => {
  if (!subastaId) { console.error("Falta --subasta <id>. Ej: node setup/enviar-campana-subasta.js --subasta sub_xxx --momento inicio"); process.exitCode = 1; return; }

  // La subasta y el catálogo de tiers salen de la API pública (misma fuente de verdad
  // que ve el usuario, sin tocar la DB para esto).
  const { subasta } = await getJSON("/api/subastas/" + encodeURIComponent(subastaId));
  const cfg = await getJSON("/api/config");
  const nivelPorSlug = {}; (cfg.tiers || []).forEach((t) => { nivelPorSlug[t.slug] = t.nivel; });
  const nivelRequerido = nivelPorSlug[subasta.nivel_min] ?? 0;
  const urlSubasta = BASE + "/subasta/" + encodeURIComponent(subasta.slug || subastaId); // link legible si tiene slug
  console.log(`Subasta: "${subasta.titulo}" · nivel mínimo: ${subasta.nivel_min} (nivel ${nivelRequerido}) · momento: ${momento}`);

  if (previewTo) {
    const socio = { nombre: "Vos", email: previewTo };
    await mailer.enviarSubastaInvitacion(socio, { titulo: subasta.titulo, urlSubasta, momento, pujaActual: subasta.puja_actual, cierre: subasta.termina, descripcion: subasta.descripcion, imagen });
    await mailer.enviarSubastaUpsell(socio, { titulo: subasta.titulo, urlSubasta, momento, imagen });
    console.log("✅ Preview enviado a " + previewTo + " (las dos variantes: invitación + upsell).");
    return; // sin process.exit(): evita el crash de libuv por sockets de fetch aún abiertos
  }

  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
  // Nivel actual de cada socio vivo (su membresía activa, u "olimpista" si no tiene).
  const rows = await sql`
    SELECT s.id, s.nombre, s.apellido, s.email, s.pais_iso, s.idioma,
           COALESCE(m.tier_slug, 'olimpista') AS tier_slug
    FROM socios s
    LEFT JOIN membresias m ON m.socio_id = s.id AND m.estado = 'activa'
    WHERE s.email NOT LIKE ${SEED}
      AND coalesce(s.marketing_baja, false) = false`;

  const elegibles = rows.filter((r) => (nivelPorSlug[r.tier_slug] ?? 0) >= nivelRequerido);
  const noElegibles = rows.filter((r) => (nivelPorSlug[r.tier_slug] ?? 0) < nivelRequerido);
  console.log(`Audiencia: ${elegibles.length} ya elegibles (invitación a pujar) · ${noElegibles.length} no elegibles (invitación a subir de nivel)`);

  if (!apply) { console.log("\n(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); return; }

  let ok = 0, fail = 0;
  const fallidos = [];
  for (const r of elegibles) {
    const res = await conReintento(() => mailer.enviarSubastaInvitacion(r, { titulo: subasta.titulo, urlSubasta, momento, pujaActual: subasta.puja_actual, cierre: subasta.termina, descripcion: subasta.descripcion, imagen }));
    if (res.ok) ok++; else { fail++; fallidos.push({ email: r.email, tipo: "invitacion" }); }
    if ((ok + fail) % 200 === 0) console.log(`  elegibles: ${ok + fail}/${elegibles.length} (ok:${ok} fail:${fail})`);
    await sleep(350); // ~3/s, bajo el límite Resend (5/s)
  }
  for (const r of noElegibles) {
    const res = await conReintento(() => mailer.enviarSubastaUpsell(r, { titulo: subasta.titulo, urlSubasta, momento, imagen }));
    if (res.ok) ok++; else { fail++; fallidos.push({ email: r.email, tipo: "upsell" }); }
    if ((ok + fail) % 200 === 0) console.log(`  no elegibles: ${ok + fail - elegibles.length}/${noElegibles.length} (ok:${ok} fail:${fail})`);
    await sleep(350);
  }
  console.log(`\nENVIADO: ${ok} ok, ${fail} fallidos, de ${rows.length}.`);
  if (fallidos.length) console.log("Fallidos (sin resolver tras 3 intentos):", JSON.stringify(fallidos));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
