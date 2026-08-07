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
const log = require("../lib/log");
const { createMemoryStore } = require("./memory-store");
const { createPgStore }     = require("./pg-store");

let _store = null;

function memoria() {
  const filePath = process.env.OLIMPISTAS_PERSIST === "0"
    ? null
    : path.join(__dirname, ".olimpistas-state.json");
  log.info("store: memoria" + (filePath ? " (persistida a JSON)" : ""));
  return createMemoryStore({ filePath });
}

function getStore() {
  if (_store) return _store;
  const dbUrl = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (/^postgres(ql)?:\/\//.test(dbUrl)) {
    try {
      _store = createPgStore({ databaseUrl: dbUrl });
      log.info("store: Postgres");
      return _store;
    } catch (e) {
      log.error({ err: e.message }, "OLIMPISTAS_DATABASE_URL inválida");
      if (process.env.NODE_ENV === "production") {
        log.fatal("en producción se REQUIERE Postgres. Abortando para no servir datos en memoria.");
        process.exit(1);
      }
      log.warn("uso store en memoria (solo dev)");
    }
  } else if (dbUrl) {
    log.error("OLIMPISTAS_DATABASE_URL no parece una URL postgres");
  }
  // En producción nunca caemos a memoria (single-instance, se pierde al reiniciar).
  if (process.env.NODE_ENV === "production" && (!_store)) {
    log.fatal("falta OLIMPISTAS_DATABASE_URL válida en producción. Abortando.");
    process.exit(1);
  }
  _store = memoria();
  return _store;
}

module.exports = { getStore };
