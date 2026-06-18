"use strict";
/**
 * import-padron.js — Importa el padrón oficial de socios de Olimpia a la tabla
 * `padron_olimpia`. Al registrarse en la app, si el email o la cédula coinciden,
 * el socio se reconoce y se sube a Premium automáticamente.
 *
 * Detecta las columnas solo (email/correo, cedula/ci/documento, nombre, telefono,
 * nro_socio) — no importa el orden ni los nombres exactos del archivo.
 *
 * Uso:
 *   node setup/import-padron.js [archivo.csv]                 → DRY-RUN (muestra qué leería)
 *   OLIMPISTAS_DATABASE_URL=... node setup/import-padron.js archivo.csv --apply
 *   node setup/import-padron.js archivo.csv --apply --reset   → vacía el padrón antes
 */
const fs = require("fs");
const crypto = require("crypto");

const MAP = {
  email: ["email", "correo", "e-mail", "mail", "e mail"],
  cedula: ["cedula", "cédula", "ci", "documento", "doc", "dni", "nro documento"],
  apellido: ["apellido", "apellidos", "last name", "surname"],
  nombre: ["nombre completo", "nombre y apellido", "apellido y nombre", "nombres", "nombre", "first name", "name", "socio"],
  telefono: ["telefono", "teléfono", "celular", "whatsapp", "phone", "tel", "movil", "móvil"],
  nro_socio: ["nro_socio", "nro socio", "numero de socio", "n° socio", "nº socio", "carnet", "matricula", "matrícula", "socio nro"],
};

function parseCSV(text) {
  const sep = (text.split("\n")[0].split(";").length > text.split("\n")[0].split(",").length) ? ";" : ",";
  const lines = text.replace(/\r\n/g, "\n").replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const parseLine = (line) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === sep) { out.push(cur); cur = ""; } else if (c === '"') q = true; else cur += c; }
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  return { headers: parseLine(lines[0]), rows: lines.slice(1).map(parseLine) };
}

function detectar(headers) {
  const norm = headers.map((h) => h.toLowerCase().trim());
  const find = (alts) => {
    for (const a of alts) { const i = norm.indexOf(a); if (i >= 0) return i; }
    for (let i = 0; i < norm.length; i++) if (alts.some((a) => norm[i].includes(a))) return i;
    return -1;
  };
  return { email: find(MAP.email), cedula: find(MAP.cedula), apellido: find(MAP.apellido), nombre: find(MAP.nombre), telefono: find(MAP.telefono), nro_socio: find(MAP.nro_socio) };
}

const limpiarCed = (s) => (s || "").replace(/\D/g, "");

function leer(file) {
  const text = fs.readFileSync(file, "utf8");
  const { headers, rows } = parseCSV(text);
  const idx = detectar(headers);
  const get = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
  const vistos = new Set();
  const filas = [];
  for (const r of rows) {
    const email = get(r, idx.email).toLowerCase(), cedula = limpiarCed(get(r, idx.cedula));
    if (!email && !cedula) continue;
    const clave = email || ("ced:" + cedula);
    if (vistos.has(clave)) continue; vistos.add(clave);
    let nombre = get(r, idx.nombre), apellido = get(r, idx.apellido);
    // Si no hay columna de apellido pero el nombre viene completo, parto por el último espacio.
    if (!apellido && idx.apellido < 0 && /\s/.test(nombre)) {
      const parts = nombre.split(/\s+/);
      apellido = parts.pop();
      nombre = parts.join(" ");
    }
    filas.push({
      id: "pad_" + crypto.randomBytes(7).toString("hex"),
      cedula, email, nombre, apellido, telefono: get(r, idx.telefono), nro_socio: get(r, idx.nro_socio),
    });
  }
  return { headers, idx, filas };
}

async function conectar() {
  const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) { console.error("\n✖ Falta OLIMPISTAS_DATABASE_URL."); process.exit(1); }
  return require("postgres")(url, { max: 5, idle_timeout: 20, prepare: false, ssl: "require" });
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => /\.csv$/i.test(a)) || "setup/padron-ejemplo.csv";
  if (!fs.existsSync(file)) { console.error("✖ No encuentro el archivo:", file); process.exit(1); }
  const { headers, idx, filas } = leer(file);

  console.log(`\n=== PADRÓN: ${file} ===`);
  console.log("Columnas detectadas:");
  console.log(`  email    → ${idx.email >= 0 ? headers[idx.email] : "(no encontrada)"}`);
  console.log(`  cédula   → ${idx.cedula >= 0 ? headers[idx.cedula] : "(no encontrada)"}`);
  console.log(`  nombre   → ${idx.nombre >= 0 ? headers[idx.nombre] : "(no encontrada)"}`);
  console.log(`  apellido → ${idx.apellido >= 0 ? headers[idx.apellido] : "(se parte del nombre completo)"}`);
  console.log(`  teléfono → ${idx.telefono >= 0 ? headers[idx.telefono] : "(no encontrada)"}`);
  console.log(`  nro socio→ ${idx.nro_socio >= 0 ? headers[idx.nro_socio] : "(no encontrada)"}`);
  const conEmail = filas.filter((f) => f.email).length, conCed = filas.filter((f) => f.cedula).length;
  console.log(`\nFilas válidas: ${filas.length.toLocaleString("es-PY")}  (con email: ${conEmail}, con cédula: ${conCed})`);
  console.log("Ejemplo:", filas.slice(0, 2).map((f) => `${f.nombre || "?"} <${f.email || "sin email"}> ced:${f.cedula || "-"}`).join(" | "));

  if (!args.includes("--apply")) {
    console.log("\n(DRY-RUN) Revisá las columnas detectadas. Agregá --apply para importar.");
    if (idx.email < 0 && idx.cedula < 0) console.log("⚠ Sin email ni cédula no se puede reconocer a nadie. Revisá el archivo.");
    return;
  }

  const sql = await conectar();
  try {
    await sql`CREATE TABLE IF NOT EXISTS padron_olimpia (
      id TEXT PRIMARY KEY, cedula TEXT DEFAULT '', email TEXT DEFAULT '', nombre TEXT DEFAULT '',
      apellido TEXT DEFAULT '', telefono TEXT DEFAULT '', nro_socio TEXT DEFAULT '', reclamado BOOLEAN NOT NULL DEFAULT false,
      socio_id TEXT, creado TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`ALTER TABLE padron_olimpia ADD COLUMN IF NOT EXISTS apellido TEXT DEFAULT ''`;
    await sql`CREATE INDEX IF NOT EXISTS idx_padron_email ON padron_olimpia(lower(email)) WHERE email <> ''`;
    await sql`CREATE INDEX IF NOT EXISTS idx_padron_cedula ON padron_olimpia(cedula) WHERE cedula <> ''`;
    if (args.includes("--reset")) { await sql`TRUNCATE padron_olimpia`; console.log("Padrón vaciado (--reset)."); }
    const COLS = ["id", "cedula", "email", "nombre", "apellido", "telefono", "nro_socio"];
    for (let i = 0; i < filas.length; i += 1000) {
      await sql`INSERT INTO padron_olimpia ${sql(filas.slice(i, i + 1000), ...COLS)}`;
      console.log(`  importadas ${Math.min(i + 1000, filas.length)} / ${filas.length}`);
    }
    const [{ n }] = await sql`SELECT COUNT(*)::int n FROM padron_olimpia`;
    console.log(`\n✔ Padrón en la base: ${n.toLocaleString("es-PY")} socios.`);
  } finally { await sql.end({ timeout: 5 }); }
}

main().catch((e) => { console.error("✖ Error:", e.message); process.exit(1); });
