"use strict";
/**
 * Remarketing: email a quienes INICIARON el pago (pedido pendiente) y NO lo completaron
 * (siguen en Olimpista, no Plus/Junior). Links de pago y total salen de la API pública.
 *
 *   dry-run (solo lista):  OLIMPISTAS_DATABASE_URL=... node setup/enviar-remkt-pago.js
 *   preview (1 a tu mail): RESEND_API_KEY=... node setup/enviar-remkt-pago.js --preview malte@thecrewagencia.com
 *   ENVIAR a todos:        OLIMPISTAS_DATABASE_URL=... RESEND_API_KEY=... node setup/enviar-remkt-pago.js --apply
 */
const postgres = require("postgres");
const mailer = require("../lib/email");
const BASE = process.env.APP_URL || "https://www.olimpistas.com";
const apply = process.argv.includes("--apply");
const pIdx = process.argv.indexOf("--preview");
const previewTo = pIdx > -1 ? process.argv[pIdx + 1] : null;
const SEED = "%@demo.olimpistas.test";

async function getJSON(path) { const r = await fetch(BASE + path); return r.json(); }

(async () => {
  const cfg = await getJSON("/api/config");
  const tiers = {}; (cfg.tiers || []).forEach((t) => { tiers[t.slug] = t; });
  let total = 0; try { total = (await getJSON("/api/contador")).total || 0; } catch (e) {}
  const linkFor = (tierSlug, iso) => {
    const t = tiers[tierSlug] || tiers.premium || {};
    return (iso === "PY" ? t.linkPagoGs : t.linkPagoUsd) || t.linkPagoGs || (BASE + "/#planes");
  };

  // Preview: manda 1 muestra (no toca la DB).
  if (previewTo) {
    const res = await mailer.enviarRemkPago({ nombre: "Malte", email: previewTo }, { link: linkFor("premium", "PY"), tier: "premium", total });
    console.log(res.ok ? "✅ Preview enviado a " + previewTo + " (modo " + res.modo + ")" : "❌ Falló el preview");
    process.exit(0);
  }

  const cIdx = process.argv.indexOf("--campana");
  const campanaId = cIdx > -1 ? process.argv[cIdx + 1] : null;
  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

  // Modo CAMPAÑA: envía al cohort congelado de una campaña y marca enviado_ok (para medir conversión).
  if (campanaId) {
    const envs = await sql`SELECT e.id AS envio_id, e.email, e.tier_pretendido, s.nombre, s.pais_iso
      FROM campana_envios e LEFT JOIN socios s ON s.id = e.socio_id
      WHERE e.campana_id = ${campanaId} AND e.enviado_ok = false
        AND coalesce(s.marketing_baja, false) = false`;
    console.log("Campaña " + campanaId + " — pendientes de envío:", envs.length);
    if (!apply) { console.log("(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); process.exit(0); }
    let cok = 0, cfail = 0;
    for (const e of envs) {
      const tier = e.tier_pretendido || "premium";
      const res = await mailer.enviarRemkPago({ nombre: e.nombre, email: e.email }, { link: linkFor(tier, e.pais_iso), tier, total });
      if (res && res.ok) { await sql`UPDATE campana_envios SET enviado_ok = true WHERE id = ${e.envio_id}`; cok++; } else cfail++;
      await new Promise((s) => setTimeout(s, 350)); // ~3/s
    }
    console.log(`\nCAMPAÑA enviada: ${cok} ok, ${cfail} fallidos, de ${envs.length}.`);
    await sql.end(); process.exit(0);
  }

  const rows = await sql`
    SELECT DISTINCT ON (s.id) s.id, s.nombre, s.apellido, s.email, s.pais_iso, p.tier_slug
    FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id
    WHERE p.estado = 'pendiente'
      AND s.email NOT LIKE ${SEED}
      AND coalesce(s.marketing_baja, false) = false
      AND NOT EXISTS (SELECT 1 FROM membresias m WHERE m.socio_id = s.id AND m.estado = 'activa' AND m.tier_slug IN ('premium','kids'))
    ORDER BY s.id, p.creado DESC`;
  console.log("Audiencia (iniciaron pago y NO completaron):", rows.length);
  rows.slice(0, 40).forEach((r) => console.log("  -", ((r.nombre || "") + " " + (r.apellido || "")).trim(), "<" + r.email + ">", "|", r.tier_slug, "|", r.pais_iso || "—"));
  if (rows.length > 40) console.log("  … y " + (rows.length - 40) + " más");

  if (!apply) { console.log("\n(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); process.exit(0); }

  let ok = 0, fail = 0;
  for (const r of rows) {
    const res = await mailer.enviarRemkPago(r, { link: linkFor(r.tier_slug, r.pais_iso), tier: r.tier_slug, total });
    if (res && res.ok) ok++; else fail++;
    await new Promise((s) => setTimeout(s, 350)); // ~3/s, bajo el límite Resend (5/s)
  }
  console.log(`\nENVIADO: ${ok} ok, ${fail} fallidos, de ${rows.length}.`);
  await sql.end(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
