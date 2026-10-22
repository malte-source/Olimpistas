"use strict";
// En CI (EXIGIR_TEST_DB=1) los tests con base de datos NO pueden saltearse en silencio:
// si el servicio Postgres no está, el job tiene que fallar en rojo y no quedar verde engañoso.
const { test } = require("node:test");
const assert = require("node:assert");

test("CI: hay un Postgres de prueba disponible", { skip: process.env.EXIGIR_TEST_DB === "1" ? false : "solo se exige en CI" }, async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "falta TEST_DATABASE_URL");
  const sql = require("postgres")(url, { prepare: false, max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const [r] = await sql`SELECT 1 AS ok`;
    assert.strictEqual(r.ok, 1);
  } finally { await sql.end({ timeout: 5 }); }
});
