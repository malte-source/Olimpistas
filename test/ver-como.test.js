"use strict";
// "Ver como": un owner del panel entra con SU usuario a los portales del comercio y de la peña, en modo lectura y con auditoría.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const app = require("../server");
const { getStore } = require("../data/store");
const adminAuth = require("../lib/admin-auth");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function usuarioPanel(rol) {
  const usuario = `vc-${rol}-${++n}@ejemplo.com`;
  await adminAuth.crearAdminUsuario({ usuario, nombre: usuario, password: "clave-de-prueba-1", rol });
  return usuario;
}

test("comercio: el login con un owner ofrece los comercios; entrar-como abre una sesión de SOLO LECTURA y queda auditado", async () => {
  const owner = await usuarioPanel("owner");
  const c = await store.crearComercio({ nombre: "Farmacia Ver Como " + (++n), ciudad: "Asunción", contacto: "x@ejemplo.com" });
  const login = await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: owner, password: "clave-de-prueba-1" } });
  assert.strictEqual(login.status, 200);
  const j = await login.json();
  assert.strictEqual(j.admin, true);
  assert.ok(j.opciones.some((o) => o.id === c.id));
  assert.ok(!("password_hash" in j.opciones[0]), "no se filtran datos del comercio");

  const entrar = await api("/comercio/entrar-como", { metodo: "POST", h: { "x-admin-token": j.token_admin }, cuerpo: { id: c.id } });
  assert.strictEqual(entrar.status, 200);
  const k = await entrar.json();
  assert.strictEqual(k.solo_lectura, true);
  assert.ok(k.token.startsWith("adm_"));

  const h = { "x-comercio-token": k.token };
  assert.strictEqual((await api("/comercio/beneficios", { h })).status, 200, "puede mirar");
  assert.strictEqual((await api("/comercio/estadisticas", { h })).status, 200);
  for (const [metodo, ruta] of [["POST", "/comercio/validar"], ["POST", "/comercio/beneficios"], ["PATCH", "/comercio/beneficios/x"]]) {
    const r = await api(ruta, { metodo, h, cuerpo: { codigo: "x", titulo: "x" } });
    assert.strictEqual(r.status, 403, metodo + " " + ruta + " debe estar bloqueado en modo lectura");
    assert.match((await r.json()).error, /Modo lectura/);
  }
  const acciones = await store.listAccionesAdmin({ limit: 50 });
  assert.ok(acciones.some((a) => a.accion === "ver_como:comercio" && a.target_id === c.id && a.por === owner));
});

test("peña: el owner elige una peña (incluso sin verificar), mira el panel y no puede pedir canjes", async () => {
  const owner = await usuarioPanel("owner");
  const p = await store.crearPena({ nombre: "Peña Ver Como " + (++n), ciudad: "Luque", pais_iso: "PY", presidente: "Presi", contacto: "p@ejemplo.com" });
  const j = await (await api("/pena/login", { metodo: "POST", cuerpo: { usuario: owner, password: "clave-de-prueba-1" } })).json();
  assert.strictEqual(j.admin, true);
  assert.ok(j.opciones.some((o) => o.id === p.id));
  const k = await (await api("/pena/entrar-como", { metodo: "POST", h: { "x-admin-token": j.token_admin }, cuerpo: { id: p.id } })).json();
  assert.ok(k.token.startsWith("adm_"));
  const h = { "x-pena-token": k.token };
  const panel = await api("/pena/panel", { h });
  assert.strictEqual(panel.status, 200);
  assert.strictEqual((await panel.json()).pena.nombre, p.nombre);
  assert.strictEqual((await api("/pena/fondo", { h })).status, 200);
  const canje = await api("/pena/fondo/canje", { metodo: "POST", h, cuerpo: { monto: 1000 } });
  assert.strictEqual(canje.status, 403);
  assert.match((await canje.json()).error, /Modo lectura/);
});

test("solo un owner: otro rol del panel no entra como comercio ni como peña,", async () => {
  const soporte = await usuarioPanel("soporte");
  const c = await store.crearComercio({ nombre: "Comercio Cerrado " + (++n), ciudad: "x", contacto: "c@ejemplo.com" });
  const rc = await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: soporte, password: "clave-de-prueba-1" } });
  assert.strictEqual(rc.status, 401);
  const rp = await api("/pena/login", { metodo: "POST", cuerpo: { usuario: soporte, password: "clave-de-prueba-1" } });
  assert.strictEqual(rp.status, 401);
  // y con la sesión de soporte (obtenida por el login normal del panel) tampoco se puede forzar la entrada
  const s = await (await api("/admin/login", { metodo: "POST", cuerpo: { usuario: soporte, password: "clave-de-prueba-1" } })).json();
  const forzar = await api("/comercio/entrar-como", { metodo: "POST", h: { "x-admin-token": s.token }, cuerpo: { id: c.id } });
  assert.strictEqual(forzar.status, 403);
  assert.strictEqual((await api("/pena/entrar-como", { metodo: "POST", h: { "x-admin-token": s.token }, cuerpo: { id: "x" } })).status, 403);
  // sin ninguna credencial
  assert.strictEqual((await api("/comercio/entrar-como", { metodo: "POST", cuerpo: { id: c.id } })).status, 401);
  // clave equivocada del owner
  const owner = await usuarioPanel("owner");
  assert.strictEqual((await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: owner, password: "otra-clave-mala" } })).status, 401);
});

test("el login normal del comercio sigue andando igual", async () => {
  const bcrypt = require("bcrypt");
  const c = await store.crearComercio({ nombre: "Comercio Normal " + (++n), ciudad: "x", contacto: "n@ejemplo.com" });
  const usuario = "norm" + n;
  await store.setComercioAcceso(c.id, usuario, await bcrypt.hash("clave-comercio-1", 4));
  const j = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario, password: "clave-comercio-1" } })).json();
  assert.ok(j.token && !j.token.startsWith("adm_") && !j.admin);
  assert.strictEqual((await api("/comercio/beneficios", { h: { "x-comercio-token": j.token } })).status, 200);
});
