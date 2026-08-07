"use strict";
// Saludo de cumpleaños a los socios que cumplen HOY (mismo día y mes). Respeta la baja de
// marketing. Pensado para correr 1×/día (Cloud Scheduler → este script). dry-run por defecto.
// Uso: OLIMPISTAS_DATABASE_URL=... [RESEND_API_KEY=...] node setup/enviar-cumpleanos.js [--apply]
const postgres = require("postgres");
const mailer = require("../lib/email");
const apply = process.argv.includes("--apply");
const SEED = "%@demo.olimpistas.test";
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  const rows = await sql`
    SELECT id, nombre, email, idioma, pais_iso FROM socios
    WHERE fecha_nacimiento IS NOT NULL
      AND to_char(fecha_nacimiento, 'MM-DD') = to_char(now(), 'MM-DD')
      AND email <> '' AND email NOT LIKE ${SEED}
      AND coalesce(marketing_baja, false) = false`;
  console.log("Cumplen hoy:", rows.length);
  if (!apply) { console.log("(dry-run) — agregá --apply (con RESEND_API_KEY) para enviar."); await sql.end(); process.exit(0); }
  let ok = 0, fail = 0;
  for (const s of rows) {
    const r = await mailer.enviarCumple(s);
    if (r && r.ok) ok++; else fail++;
    await new Promise((res) => setTimeout(res, 350)); // ~3/s
  }
  console.log(`\nENVIADO: ${ok} ok, ${fail} fallidos, de ${rows.length}.`);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
