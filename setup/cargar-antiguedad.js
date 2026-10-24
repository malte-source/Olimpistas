"use strict";
/**
 * Carga la ANTIGÜEDAD REAL de los socios del club (fecha de alta) desde un listado (xlsx o csv) con una columna de cédula
 * y otra de fecha de alta. La fecha se guarda en el padrón y en las cuentas de Olimpistas que ya validaron su cédula;
 * el carnet de un Socio muestra "Socio desde <mes año>". Sin esta fecha el carnet muestra el número de socio, no una fecha inventada.
 * También completa el número de socio (nro_socio) de las cuentas ya validadas con el del padrón.
 *
 * Uso:  OLIMPISTAS_DATABASE_URL=... node setup/cargar-antiguedad.js "<archivo.xlsx|csv>" [--apply]
 *   sin --apply = ensayo: cuenta qué cambiaría y no toca la base.
 * Columnas reconocidas (sin importar mayúsculas): cédula = cedula|documento|ci ; fecha = fecha_alta|alta|antiguedad|socio_desde|fecha_ingreso|ingreso|fecha.
 */
const XLSX = require("xlsx");
const postgres = require("postgres");

const dig = (s) => String(s == null ? "" : s).replace(/\D/g, "");
const pick = (row, names) => { for (const n of names) for (const k of Object.keys(row)) if (k.toLowerCase().trim() === n) return row[k]; return ""; };

/** Fecha de Excel (número de serie), dd/mm/aaaa, dd-mm-aaaa o aaaa-mm-dd → "aaaa-mm-dd". Lo que no sea una fecha razonable da "". */
function aFecha(v) {
  let y, m, d;
  if (v instanceof Date && !isNaN(v)) { y = v.getUTCFullYear(); m = v.getUTCMonth() + 1; d = v.getUTCDate(); }
  else if (typeof v === "number" && v > 1 && v < 80000) { const t = new Date(Math.round((v - 25569) * 86400000)); y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate(); }
  else {
    const s = String(v || "").trim();
    let x = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
    if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; }
    else return "";
  }
  if (!(y >= 1901 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  if (Date.UTC(y, m - 1, d) > Date.now()) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

module.exports = { aFecha };
if (require.main !== module) return;

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error('Uso: node setup/cargar-antiguedad.js "<archivo.xlsx|csv>" [--apply]'); process.exit(1); }

const wb = XLSX.readFile(file, { cellDates: true });
const regs = new Map();
let sinFecha = 0;
for (const name of wb.SheetNames) {
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" })) {
    const cedula = dig(pick(r, ["cedula", "cédula", "documento", "ci"]));
    if (!cedula) continue;
    const fecha = aFecha(pick(r, ["fecha_alta", "fecha alta", "alta", "antiguedad", "antigüedad", "socio_desde", "fecha_ingreso", "fecha ingreso", "ingreso", "fecha"]));
    if (!fecha) { sinFecha++; continue; }
    if (!regs.has(cedula) || fecha < regs.get(cedula)) regs.set(cedula, fecha);   // si figura dos veces, vale la más antigua
  }
}
console.log(`Cédulas con fecha de alta válida: ${regs.size} | filas sin fecha o con fecha inválida: ${sinFecha}`);
console.log("Muestra:", [...regs].slice(0, 3));

(async () => {
  if (!process.env.OLIMPISTAS_DATABASE_URL) { console.log("\nSin OLIMPISTAS_DATABASE_URL: solo se leyó el archivo."); process.exit(0); }
  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
  const cedulas = [...regs.keys()], fechas = cedulas.map((c) => regs.get(c));
  const [{ n: enCuentas }] = await sql`
    SELECT COUNT(*)::int n FROM socios s JOIN unnest(${cedulas}::text[]) c(ced) ON regexp_replace(s.cedula, '[^0-9]', '', 'g') = c.ced WHERE s.es_socio_olimpia`;
  const [{ n: enPadron }] = await sql`
    SELECT COUNT(*)::int n FROM padron_olimpia p JOIN unnest(${cedulas}::text[]) c(ced) ON regexp_replace(p.cedula, '[^0-9]', '', 'g') = c.ced`;
  console.log(`Cuentas de socios que recibirían la fecha: ${enCuentas} | filas del padrón: ${enPadron}`);
  if (!apply) { console.log("\n(ensayo) — no se tocó la base. Agregá --apply para cargar."); await sql.end(); process.exit(0); }
  await sql.begin(async (t) => {
    await t`
      UPDATE padron_olimpia p SET socio_desde = c.f::date
      FROM unnest(${cedulas}::text[], ${fechas}::text[]) c(ced, f) WHERE regexp_replace(p.cedula, '[^0-9]', '', 'g') = c.ced`;
    await t`
      UPDATE socios s SET socio_desde = c.f::date
      FROM unnest(${cedulas}::text[], ${fechas}::text[]) c(ced, f) WHERE s.es_socio_olimpia AND regexp_replace(s.cedula, '[^0-9]', '', 'g') = c.ced`;
    // Cuentas ya validadas que todavía no tienen su número de socio: se completa con el del padrón.
    await t`
      UPDATE socios s SET nro_socio = p.nro_socio
      FROM padron_olimpia p WHERE s.es_socio_olimpia AND s.nro_socio = '' AND coalesce(p.nro_socio, '') <> ''
        AND regexp_replace(p.cedula, '[^0-9]', '', 'g') = regexp_replace(s.cedula, '[^0-9]', '', 'g') AND s.cedula <> ''`;
  });
  const [r] = await sql`SELECT COUNT(*) FILTER (WHERE socio_desde IS NOT NULL)::int con_fecha, COUNT(*)::int total FROM socios WHERE es_socio_olimpia`;
  console.log(`Listo. Socios con antigüedad cargada: ${r.con_fecha} de ${r.total}.`);
  await sql.end(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
