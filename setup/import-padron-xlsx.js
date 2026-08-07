"use strict";
/**
 * Importa el padrón oficial (xlsx, 2 hojas: "socios al dia" + "vitalicios") a
 * padron_olimpia. TODO el archivo = AL DÍA. Matchea por cédula.
 * Uso:  OLIMPISTAS_DATABASE_URL=... node setup/import-padron-xlsx.js "<ruta.xlsx>" [--apply]
 *   sin --apply = dry-run (muestra conteo y muestra, no toca la base).
 */
const XLSX = require("xlsx");
const crypto = require("crypto");
const postgres = require("postgres");

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const dig = (s) => String(s == null ? "" : s).replace(/\D/g, "");
const pick = (row, names) => {
  for (const n of names) for (const k of Object.keys(row)) if (k.toLowerCase().trim() === n) return row[k];
  return "";
};

const wb = XLSX.readFile(file);
const regs = [];
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  for (const r of rows) {
    const cedula = dig(pick(r, ["cedula", "documento"]));
    if (!cedula) continue;
    regs.push({
      id: "pad_" + crypto.randomBytes(8).toString("hex"),
      cedula,
      nombre: String(pick(r, ["nombre_apellido", "nombre apellido", "nombre"]) || "").trim().slice(0, 160),
      email: String(pick(r, ["email"]) || "").toLowerCase().trim().slice(0, 160),
      telefono: String(pick(r, ["telefono"]) || "").trim().slice(0, 40),
      nro_socio: String(pick(r, ["nro_socio"]) || "").trim().slice(0, 40),
      hoja: name,
    });
  }
}
const porHoja = regs.reduce((a, r) => ((a[r.hoja] = (a[r.hoja] || 0) + 1), a), {});
console.log("Total con cédula:", regs.length, "| por hoja:", porHoja);
console.log("Muestra:", regs.slice(0, 2).map((r) => ({ ced: r.cedula, nom: r.nombre, mail: r.email, nro: r.nro_socio })));

(async () => {
  if (!apply) { console.log("\n(dry-run) — no se tocó la base. Agregá --apply para importar."); process.exit(0); }
  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 3, prepare: false, ssl: "require" });
  await sql`TRUNCATE padron_olimpia`;
  let n = 0;
  for (let i = 0; i < regs.length; i += 800) {
    const chunk = regs.slice(i, i + 800).map((r) => ({ id: r.id, cedula: r.cedula, email: r.email, nombre: r.nombre, apellido: "", telefono: r.telefono, nro_socio: r.nro_socio }));
    await sql`INSERT INTO padron_olimpia ${sql(chunk, "id", "cedula", "email", "nombre", "apellido", "telefono", "nro_socio")}`;
    n += chunk.length; process.stdout.write("\r  insertados: " + n);
  }
  const [c] = await sql`SELECT COUNT(*)::int total FROM padron_olimpia`;
  console.log("\nListo. padron_olimpia total:", c.total);
  await sql.end(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
