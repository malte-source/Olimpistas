"use strict";
/**
 * Carga la base de socios del club (xlsx del sistema administrativo) en `socios_club`.
 *
 *   OLIMPISTAS_DATABASE_URL=... node setup/importar-socios-club.js "<archivo.xlsx>" [--apply]
 *
 * Sin --apply es un ensayo: limpia el archivo y muestra el resumen (solo cifras, sin datos personales) sin tocar la base.
 * Con --apply hace un "upsert" por cédula: vuelve a correr sin duplicar y NO pisa el estado ya consultado a la API de socios.
 * Reglas de limpieza: ver lib/club-import.js y docs/analisis-base-socios.md. Es una tabla de REFERENCIA: no otorga el nivel Socio.
 */
const XLSX = require("xlsx");
const postgres = require("postgres");
const { procesarFilas } = require("../lib/club-import");

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error('Uso: node setup/importar-socios-club.js "<archivo.xlsx>" [--apply]'); process.exit(1); }

const wb = XLSX.readFile(file, { cellDates: true });
const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
const { registros, resumen } = procesarFilas(filas);
console.log("Resumen de la limpieza (sin datos personales):");
console.log(JSON.stringify(resumen, null, 2));

(async () => {
  if (!apply) { console.log("\n(ensayo) No se tocó la base. Agregá --apply para cargar."); process.exit(0); }
  const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) { console.error("Falta OLIMPISTAS_DATABASE_URL."); process.exit(1); }
  const sql = postgres(url, { max: 2, prepare: false, ssl: process.env.DB_SSL === "disable" ? false : "require", onnotice: () => {} });
  const store = require("../data/pg-store").createPgStore({ databaseUrl: url });
  try {
    const n = await store.upsertSociosClub(registros);
    const [t] = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE socio_desde IS NOT NULL)::int AS con_socio_desde FROM socios_club`;
    console.log(`\nCargados ${n} registros. En la tabla: ${t.total} (con "Socio desde" creíble: ${t.con_socio_desde}).`);
  } finally { await sql.end({ timeout: 5 }); try { await store._sql.end({ timeout: 5 }); } catch (e) {} }
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
