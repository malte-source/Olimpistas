"use strict";
// Aviso masivo "Subiste a Socio" a los socios del club reclasificados (Plus/Junior → Socio).
// Idempotente: marca cada aviso en `actualizaciones` (tipo 'reclasif_socio_avisado') y NO reenvía.
// Respeta la baja de marketing. En el idioma de cada socio. dry-run por defecto.
// Uso: OLIMPISTAS_DATABASE_URL=... [RESEND_API_KEY=...] node setup/enviar-reclasificacion.js [--apply]
const postgres = require("postgres");
const mailer = require("../lib/email");
const apply = process.argv.includes("--apply");
const SEED = "%@demo.olimpistas.test";
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  // Socios del club que ya están en 'socio' (marcador pago_ref 'socio:%'), aún sin avisar,
  // que no se dieron de baja y con email real.
  const rows = await sql`
    SELECT s.id, s.nombre, s.email, s.idioma, s.pais_iso
    FROM socios s
    JOIN membresias m ON m.socio_id = s.id AND m.estado = 'activa' AND m.tier_slug = 'socio' AND m.pago_ref LIKE 'socio:%'
    WHERE s.email <> '' AND s.email NOT LIKE ${SEED}
      AND coalesce(s.marketing_baja, false) = false
      AND NOT EXISTS (SELECT 1 FROM actualizaciones a WHERE a.socio_id = s.id AND a.tipo = 'reclasif_socio_avisado')`;
  console.log("A notificar (reclasificados, sin baja, sin aviso previo):", rows.length);
  if (!apply) { console.log("(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); process.exit(0); }

  let ok = 0, fail = 0;
  for (const s of rows) {
    try {
      const r = await mailer.enviarSocioReclasificado(s);
      if (r && r.ok) {
        ok++;
        // Marca idempotente (best-effort).
        await sql`INSERT INTO actualizaciones (id, socio_id, tipo, email, estado, notas)
                  VALUES (${"upd_" + s.id + "_rec"}, ${s.id}, 'reclasif_socio_avisado', ${s.email}, 'validado_auto', 'Aviso Plus→Socio enviado')`.catch(() => {});
      } else fail++;
    } catch (e) { fail++; }
    await new Promise((res) => setTimeout(res, 350)); // ~3/s, bajo el límite de Resend
  }
  console.log(`\nENVIADO: ${ok} ok, ${fail} fallidos, de ${rows.length}.`);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
