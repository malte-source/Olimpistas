"use strict";
// Con la sesión liviana, /auth/yo y /perfil siguen devolviendo la foto, el progreso del perfil cuenta la foto y el carnet la lleva.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });

test("foto: se sube, /auth/yo y /perfil la devuelven, el progreso la cuenta y el carnet la incluye", async () => {
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `ft-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Foto", apellido: "Prueba" } })).json();
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  const antes = await (await api("/auth/yo", { h })).json();
  assert.strictEqual(antes.socio.foto, "");
  assert.ok(!antes.progreso.faltantes.every((f) => f.key !== "foto") === true, "la foto figura como faltante");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.strictEqual((await api("/perfil/foto", { metodo: "POST", cuerpo: { foto: png }, h })).status, 200);
  const yo = await (await api("/auth/yo", { h })).json();
  assert.strictEqual(yo.socio.foto, png);
  assert.ok(!yo.progreso.faltantes.some((f) => f.key === "foto"), "ya no falta la foto");
  const per = await (await api("/perfil", { h })).json();
  assert.strictEqual(per.socio.foto, png);
  assert.ok(!per.progreso.faltantes.some((f) => f.key === "foto"));
  const car = await (await api("/carnet", { h })).json();
  assert.strictEqual(car.carnet.foto, png);
});
