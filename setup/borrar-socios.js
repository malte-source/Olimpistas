"use strict";
/**
 * Borra socios cuyo nombre+apellido matchea uno o más patrones + sus datos dependientes.
 * Uso: OLIMPISTAS_DATABASE_URL=... node setup/borrar-socios.js "nombre apellido" ["otro"] [--apply]
 *   Cada patrón matchea si TODAS sus palabras están en "nombre apellido".
 *   sin --apply = dry-run (solo lista).
 */
const postgres = require("postgres");
const apply = process.argv.includes("--apply");
const terms = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!terms.length) { console.error("Pasá al menos un nombre. Ej: node setup/borrar-socios.js \"Juan Perez\""); process.exit(1); }
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  const socios = await sql`SELECT id, email, nombre, apellido FROM socios WHERE email NOT LIKE '%@demo.olimpistas.test'`;
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const objetivo = socios.filter((s) => {
    const full = norm((s.nombre || "") + " " + (s.apellido || ""));
    return terms.some((t) => norm(t).split(/\s+/).every((w) => full.includes(w)));
  });
  console.log("Patrones:", terms.join(" | "));
  console.log("Cuentas que matchean (" + objetivo.length + "):");
  objetivo.forEach((s) => console.log("  -", (s.nombre || "") + " " + (s.apellido || ""), "|", s.email));
  if (!objetivo.length) { console.log("Nada para borrar."); await sql.end(); process.exit(0); }
  if (!apply) { console.log("\n(dry-run) — no se borró nada. Agregá --apply."); await sql.end(); process.exit(0); }

  const ids = objetivo.map((s) => s.id);
  for (const t of ["sesiones", "membresias", "participaciones", "reservas", "pedidos_pago", "actualizaciones"]) {
    try { const r = await sql`DELETE FROM ${sql(t)} WHERE socio_id IN ${sql(ids)}`; console.log("  " + t + ": " + r.count); }
    catch (e) { console.log("  " + t + ": (omitido: " + e.message + ")"); }
  }
  const r = await sql`DELETE FROM socios WHERE id IN ${sql(ids)}`;
  console.log("socios borrados:", r.count);
  await sql.end(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
