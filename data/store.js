"use strict";

/**
 * store.js — Selector de backend de datos.
 *
 * - Con OLIMPISTAS_DATABASE_URL  → Postgres (pg-store).
 * - Sin ella                     → memoria con datos semilla (memory-store),
 *   persistido opcionalmente a data/.olimpistas-state.json para no perder datos.
 *
 * Importante: usa SU PROPIA variable (OLIMPISTAS_DATABASE_URL), no DATABASE_URL,
 * para no mezclarse nunca con la base de The Crew OS. Esta app es standalone.
 */

const path = require("path");
const { createMemoryStore } = require("./memory-store");
const { createPgStore }     = require("./pg-store");

let _store = null;

function memoria() {
  const filePath = process.env.OLIMPISTAS_PERSIST === "0"
    ? null
    : path.join(__dirname, ".olimpistas-state.json");
  console.log("[olimpistas] store: memoria" + (filePath ? " (persistida a JSON)" : ""));
  return createMemoryStore({ filePath });
}

function getStore() {
  if (_store) return _store;
  const dbUrl = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (/^postgres(ql)?:\/\//.test(dbUrl)) {
    try {
      _store = createPgStore({ databaseUrl: dbUrl });
      console.log("[olimpistas] store: Postgres");
      return _store;
    } catch (e) {
      // URL mal formada u otro fallo al construir → NO tiramos abajo el sitio.
      console.error("[olimpistas] OLIMPISTAS_DATABASE_URL inválida (" + e.message + "). Uso store en memoria.");
    }
  } else if (dbUrl) {
    console.error("[olimpistas] OLIMPISTAS_DATABASE_URL no parece una URL postgres. Uso store en memoria.");
  }
  _store = memoria();
  return _store;
}

module.exports = { getStore };
