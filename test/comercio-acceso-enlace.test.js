"use strict";
// Alta guiada de comercios: el admin manda un enlace de UN SOLO USO (7 días) y el comercio elige su propia contraseña. Nadie escribe ni pasa una.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const mailer = require("../lib/email");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url, correos;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
beforeEach(() => { correos = []; mailer.enviarComercioAcceso = async (d, x) => { correos.push({ a: d.email, ...x }); return { ok: true, modo: "resend" }; }; });
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
const tokenDe = (u) => new URL(u).searchParams.get("clave");
let n = 0;
const comercio = (extra = {}) => store.crearComercio({ nombre: "Café del Estadio " + (++n), ciudad: "Asunción", contacto: `cafe${n}-${Date.now()}@ejemplo.com`, ...extra });

test("el admin manda el enlace por correo: crea el usuario, no hay contraseña conocida y el comercio elige la suya una sola vez", async () => {
  const c = await comercio();
  const r = await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.correo_enviado, true);
  assert.strictEqual(j.url, undefined, "si salió por correo no se muestra el enlace");
  assert.match(j.usuario, /^cafe-del-estadio-\d+$/);
  assert.strictEqual(correos.length, 1);
  assert.strictEqual(correos[0].a, c.contacto);
  assert.match(correos[0].url, /\/comercio\?clave=[\w-]+&alta=1$/);
  // todavía no puede entrar con ninguna contraseña
  assert.strictEqual((await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: j.usuario, password: "cualquiera123" } })).status, 401);
  // el token no queda guardado en claro
  const tok = tokenDe(correos[0].url);
  assert.ok(!JSON.stringify(await store.listComercios()).includes(tok));
  // elige su contraseña: entra directo; el mismo enlace no sirve dos veces
  const e1 = await api("/comercio/clave", { metodo: "POST", cuerpo: { token: tok, password: "mi-clave-propia-1" } });
  assert.strictEqual(e1.status, 200);
  assert.ok((await e1.json()).token);
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token: tok, password: "otra-clave-larga-2" } })).status, 400);
  assert.strictEqual((await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: j.usuario, password: "mi-clave-propia-1" } })).status, 200);
});

test("sin correo válido (o si el correo falla) se devuelve el enlace para copiarlo, y vence a los 7 días", async () => {
  const c = await comercio({ contacto: "" });
  const j = await (await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  assert.strictEqual(j.correo_enviado, false);
  assert.strictEqual(correos.length, 0);
  assert.match(j.url, /\/comercio\?clave=/);
  const venc = new Date((await store.listComercios()).find((x) => x.id === c.id).clave_exp).getTime() - Date.now();
  assert.ok(venc > 6.9 * 86400000 && venc <= 7 * 86400000, "7 días");
  mailer.enviarComercioAcceso = async () => ({ ok: false });
  const c2 = await comercio();
  const j2 = await (await api("/admin/comercios/" + c2.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  assert.strictEqual(j2.correo_enviado, false);
  assert.ok(j2.url, "falló el correo: se muestra el enlace");
  // vencido
  await store.updateComercio(c.id, { clave_exp: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token: tokenDe(j.url), password: "mi-clave-propia-1" } })).status, 400);
});

test("un comercio con acceso recibe un enlace nuevo sin perder su usuario ni su contraseña actual; el usuario no se repite entre comercios", async () => {
  const c = await comercio();
  const j1 = await (await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  await api("/comercio/clave", { metodo: "POST", cuerpo: { token: tokenDe(correos[0].url), password: "clave-vieja-123" } });
  const j2 = await (await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  assert.strictEqual(j2.usuario, j1.usuario);
  assert.strictEqual((await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: j1.usuario, password: "clave-vieja-123" } })).status, 200, "la actual vale hasta que elija otra");
  // mismo nombre → otro usuario
  const gemelo = await store.crearComercio({ nombre: c.nombre, ciudad: "Luque", contacto: "g@ejemplo.com" });
  const j3 = await (await api("/admin/comercios/" + gemelo.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  assert.notStrictEqual(j3.usuario, j1.usuario);
});

test("protegido: sin clave de admin 401, comercio inexistente 404, comercio pausado 409", async () => {
  const c = await comercio();
  assert.strictEqual((await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", cuerpo: {} })).status, 401);
  assert.strictEqual((await api("/admin/comercios/com_inventado/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).status, 404);
  await store.updateComercio(c.id, { estado: "pausado" });
  assert.strictEqual((await api("/admin/comercios/" + c.id + "/acceso-enlace", { metodo: "POST", h: ADM, cuerpo: {} })).status, 409);
});

test("el correo y las pantallas existen: bienvenida en comercio.html y el botón en el panel, con la contraseña a mano escondida", () => {
  const e = leer("lib", "email.js"), cm = leer("public", "comercio.html"), ad = leer("public", "admin.html");
  assert.ok(/async function enviarComercioAcceso/.test(e) && /enviarComercioAcceso,/.test(e));
  assert.ok(/get\("alta"\)/.test(cm) && /id="claveTit"/.test(cm));
  assert.ok(/acceso-enlace/.test(ad) && /Enviar enlace por correo/.test(ad) && /Poner usuario y contraseña a mano/.test(ad));
});
