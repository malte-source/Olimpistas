"use strict";
/**
 * Importa el padrón oficial de Olimpia en el formato ANCHO real que exporta su
 * sistema: una fila por PLAN (titular) + hasta 5 adherentes familiares, cada uno
 * con su propia cédula ("LicTradNum") y nombre, más el flag Al_Dia_Hoy (S/N) que
 * indica si el plan está al día HOY. Un plan familiar al día sube al titular Y a
 * cada adherente — todos son socios reales, cualquiera puede registrarse solo.
 *
 * Reemplaza TODO padron_olimpia (TRUNCATE + recarga), igual que import-padron-xlsx.js
 * (ese script sirve para el formato angosto viejo: cedula/nombre_apellido en columnas
 * ya nombradas así; este es para el export ancho con Adh1.._Adh5.. + Al_Dia_Hoy).
 *
 * Uso:  OLIMPISTAS_DATABASE_URL=... node setup/import-padron-aldia.js "<ruta.xlsx>" [--apply]
 *   sin --apply = dry-run (muestra conteo y muestra, no toca la base).
 */
const XLSX = require("xlsx");
const crypto = require("crypto");
const postgres = require("postgres");

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const dig = (s) => String(s == null ? "" : s).replace(/\D/g, "");

if (!file) { console.error('Uso: node setup/import-padron-aldia.js "<ruta.xlsx>" [--apply]'); process.exit(1); }

const wb = XLSX.readFile(file);
const regs = [];
let filasLeidas = 0, filasAlDia = 0;
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  for (const r of rows) {
    filasLeidas++;
    const alDia = String(r.Al_Dia_Hoy || "").trim().toUpperCase() === "S";
    if (!alDia) continue;
    filasAlDia++;
    const cedTitular = dig(r["Número de identificación fiscal"]);
    if (cedTitular) {
      regs.push({ id: "pad_" + crypto.randomBytes(8).toString("hex"), cedula: cedTitular, nombre: String(r["Nombre SN"] || "").trim().slice(0, 160), email: "", telefono: "", nro_socio: "" });
    }
    for (let i = 1; i <= 5; i++) {
      const ced = dig(r["Adh" + i + "_LicTradNum"]);
      const nom = String(r["Adh" + i + "_Nombre"] || "").trim();
      if (!ced || !nom) continue;
      regs.push({ id: "pad_" + crypto.randomBytes(8).toString("hex"), cedula: ced, nombre: nom.slice(0, 160), email: "", telefono: "", nro_socio: "" });
    }
  }
}
// De-dup por cédula: un adherente puede figurar en más de un plan/fila.
const porCedula = new Map();
for (const r of regs) if (!porCedula.has(r.cedula)) porCedula.set(r.cedula, r);
const unicos = [...porCedula.values()];

console.log(`Filas leídas: ${filasLeidas} | planes al día: ${filasAlDia} | registros (titulares+adherentes): ${regs.length} | únicos por cédula: ${unicos.length}`);
console.log("Muestra:", unicos.slice(0, 5).map((r) => ({ ced: r.cedula, nom: r.nombre })));

(async () => {
  if (!apply) { console.log("\n(dry-run) — no se tocó la base. Agregá --apply para importar."); process.exit(0); }
  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 3, prepare: false, ssl: "require" });
  await sql`TRUNCATE padron_olimpia`;
  let n = 0;
  for (let i = 0; i < unicos.length; i += 800) {
    const chunk = unicos.slice(i, i + 800).map((r) => ({ id: r.id, cedula: r.cedula, email: r.email, nombre: r.nombre, apellido: "", telefono: r.telefono, nro_socio: r.nro_socio }));
    await sql`INSERT INTO padron_olimpia ${sql(chunk, "id", "cedula", "email", "nombre", "apellido", "telefono", "nro_socio")}`;
    n += chunk.length; process.stdout.write("\r  insertados: " + n);
  }
  const [c] = await sql`SELECT COUNT(*)::int total FROM padron_olimpia`;
  console.log("\nListo. padron_olimpia total:", c.total);
  await sql.end(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
