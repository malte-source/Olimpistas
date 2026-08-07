"use strict";
// Recordatorio de renovación: membresías PAGAS (premium/kids) que vencen pronto.
// Vencimiento = inicio + 1 año (ciclo anual; no se guarda 'fin'). Excluye socios del club
// (pago_ref 'socio:%', su nivel no vence). Respeta la baja. dry-run por defecto.
// Uso: OLIMPISTAS_DATABASE_URL=... [RESEND_API_KEY=...] node setup/enviar-renovaciones.js [dias] [--apply]
const postgres = require("postgres");
const mailer = require("../lib/email");
const apply = process.argv.includes("--apply");
const dias = Math.max(1, parseInt((process.argv.slice(2).find((a) => /^\d+$/.test(a))) || "7", 10));
const SEED = "%@demo.olimpistas.test";
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  const rows = await sql`
    SELECT s.id, s.nombre, s.email, s.idioma, s.pais_iso, m.tier_slug,
           ((m.inicio + interval '1 year')::date - now()::date) AS dias_rest
    FROM membresias m JOIN socios s ON s.id = m.socio_id
    WHERE m.estado = 'activa' AND m.tier_slug IN ('premium','kids')
      AND m.pago_ref IS NOT NULL AND m.pago_ref <> '' AND m.pago_ref NOT LIKE 'socio:%'
      AND s.email <> '' AND s.email NOT LIKE ${SEED}
      AND coalesce(s.marketing_baja, false) = false
      AND (m.inicio + interval '1 year')::date BETWEEN now()::date AND (now()::date + ${dias})`;
  console.log(`Membresías que vencen en <= ${dias} días:`, rows.length);
  if (!apply) { console.log("(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); process.exit(0); }
  let ok = 0, fail = 0;
  for (const s of rows) {
    const r = await mailer.enviarRenovacion(s, { tier: s.tier_slug, dias: Number(s.dias_rest) });
    if (r && r.ok) ok++; else fail++;
    await new Promise((res) => setTimeout(res, 350)); // ~3/s
  }
  console.log(`\nENVIADO: ${ok} ok, ${fail} fallidos, de ${rows.length}.`);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
