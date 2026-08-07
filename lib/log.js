"use strict";
/**
 * lib/log.js — Logger estructurado (pino). Reemplaza console.* en el runtime.
 *
 * Emite JSON a stdout. Cloud Run / Cloud Logging lee `severity` y `message` y los
 * indexa (queryable por nivel, filtrable, con campos). `redact` es defensa en
 * profundidad: aunque NO logueamos PII a propósito, censura si algo se cuela.
 *
 * Nivel por env: LOG_LEVEL (default info). Para leerlo lindo en dev: `npm start | npx pino-pretty`.
 */
const pino = require("pino");

// pino label → severity de Google Cloud Logging.
const GCP = { trace: "DEBUG", debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" };

module.exports = pino({
  level: process.env.LOG_LEVEL || "info",
  messageKey: "message",
  base: { service: "olimpistas" },
  formatters: { level(label) { return { severity: GCP[label] || "DEFAULT" }; } },
  redact: {
    paths: ["password", "password_hash", "token", "cedula", "foto",
      "*.password", "*.password_hash", "*.cedula", "*.foto",
      "req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]",
  },
});
