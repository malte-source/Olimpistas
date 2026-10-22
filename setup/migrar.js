"use strict";
/**
 * Aplica las migraciones pendientes a la base de OLIMPISTAS_DATABASE_URL.
 *
 *   node setup/migrar.js          aplica lo pendiente
 *   node setup/migrar.js --ver    muestra qué haría, sin tocar nada
 *
 * Orden de un deploy a producción: 1) migrar  2) deploy del código.
 * (Las migraciones son aditivas: el código anterior sigue andando con el esquema nuevo.)
 */
const postgres = require("postgres");
const { migrar } = require("../lib/migrar");

(async () => {
  const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) { console.error("Falta OLIMPISTAS_DATABASE_URL."); process.exit(1); }
  const host = (() => { try { return new URL(url).hostname; } catch (e) { return "?"; } })();
  const sql = postgres(url, { prepare: false, max: 1, ssl: process.env.DB_SSL === "disable" ? false : "require", onnotice: () => {} });
  const ver = process.argv.includes("--ver");
  try {
    const r = await migrar(sql, { soloVer: ver, log: { info: (o, m) => console.log(" ·", m, o && o.migracion ? "— " + o.migracion : "") } });
    console.log(`\nBase: ${host}`);
    if (ver) console.log(r.baseline ? "Esta base tiene el esquema pero no historial: se registraría 0001 como base." : "", "\nPendientes:", r.pendientes.length ? r.pendientes.join(", ") : "ninguna");
    else console.log(r.aplicadas.length ? "Aplicadas: " + r.aplicadas.join(", ") : "Nada para aplicar: la base está al día.");
  } catch (e) {
    console.error("\nERROR:", e.message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
