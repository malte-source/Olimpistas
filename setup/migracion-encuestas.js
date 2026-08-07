"use strict";
// Encuestas (Fan Survey) + respuestas. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-encuestas.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`CREATE TABLE IF NOT EXISTS encuestas (
    id         TEXT PRIMARY KEY,
    titulo     TEXT NOT NULL DEFAULT '',
    pregunta   TEXT NOT NULL DEFAULT '',
    opciones   TEXT NOT NULL DEFAULT '[]',       -- JSON array de strings (para tipo 'opcion')
    tipo       TEXT NOT NULL DEFAULT 'opcion',   -- opcion | texto
    nivel_min  TEXT NOT NULL DEFAULT 'olimpista',-- quién puede responder (olimpista = todos)
    estado     TEXT NOT NULL DEFAULT 'borrador', -- borrador | activa | cerrada
    creado     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_encuestas_estado ON encuestas(estado)`;

  await sql`CREATE TABLE IF NOT EXISTS respuestas_encuesta (
    id          TEXT PRIMARY KEY,
    encuesta_id TEXT NOT NULL REFERENCES encuestas(id) ON DELETE CASCADE,
    socio_id    TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
    opcion      INTEGER,                          -- índice de la opción elegida (tipo 'opcion')
    texto       TEXT,                             -- respuesta abierta (tipo 'texto')
    creado      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Una respuesta por socio por encuesta (habilita el upsert ON CONFLICT).
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_respuesta_socio ON respuestas_encuesta(encuesta_id, socio_id)`;

  console.log("OK: encuestas + respuestas_encuesta");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
