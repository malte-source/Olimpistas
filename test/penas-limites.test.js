"use strict";
// Los límites de intentos del panel de peñas y de la solicitud pública (apagados en el resto de la suite).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.TEST_LIMITES = "1";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const post = (ruta, cuerpo) => fetch(url + ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });

test("login y elección de contraseña de la peña: frena la fuerza bruta (12 intentos por 15 min)", async () => {
  const estados = [];
  for (let i = 0; i < 14; i++) estados.push((await post("/api/pena/login", { usuario: "no-existe", password: "x" + i })).status);
  assert.deepStrictEqual(estados.slice(0, 12).filter((s) => s !== 401), [], "los primeros 12 responden normal");
  assert.strictEqual(estados[12], 429);
  assert.strictEqual((await post("/api/pena/clave", { token: "x", password: "clave-larga-123" })).status, 429, "comparten el cupo");
});

test("solicitud pública de peña: 10 por hora y red", async () => {
  const estados = [];
  for (let i = 0; i < 12; i++) estados.push((await post("/api/penas/solicitud", { nombre: "ab" })).status);
  assert.strictEqual(estados.filter((s) => s === 400).length, 10);
  assert.strictEqual(estados.filter((s) => s === 429).length, 2);
});
