"use strict";
/**
 * Aplica un archivo .sql de migración a la base, statement por statement (resiliente).
 * Uso: OLIMPISTAS_DATABASE_URL=... node setup/aplicar-migracion.js setup/archivo.sql
 */
const fs = require("fs");
const postgres = require("postgres");

const file = process.argv[2];
const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
if (!file || !url) { console.error("Falta archivo SQL o OLIMPISTAS_DATABASE_URL"); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });
// Separa por ';' a nivel de línea (ignora líneas de comentario completas).
const raw = fs.readFileSync(file, "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const stmts = raw.split(";").map((s) => s.trim()).filter(Boolean);

(async () => {
  for (const s of stmts) {
    const label = s.replace(/\s+/g, " ").slice(0, 70);
    try { await sql.unsafe(s); console.log("OK  ", label); }
    catch (e) { console.error("FALLO", label, "→", e.message); }
  }
  await sql.end();
  console.log("Migración terminada.");
})().catch((e) => { console.error(e.message); process.exit(1); });
