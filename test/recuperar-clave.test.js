"use strict";
// Recuperar la contraseña del panel de peña y de comercio: correo con link de un solo uso (1 hora), respuesta idéntica exista o no la cuenta,
// respiro de 5 minutos por cuenta, sesiones anteriores cerradas, y el token nunca queda guardado en claro (comercio).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
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
beforeEach(() => {
  correos = [];
  mailer.enviarRecuperarClave = async (d, x) => { correos.push({ a: d.email, ...x }); return { ok: true, modo: "resend" }; };
  mailer.enviarPenaVerificada = async () => ({ ok: true, modo: "resend" });
});
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
const espera = () => new Promise((x) => setTimeout(x, 30));
const tokenDe = (u) => new URL(u).searchParams.get("token") || new URL(u).searchParams.get("clave");
let n = 0;

async function pena() {
  n++;
  const contacto = `rp${n}-${Date.now()}@ejemplo.com`;
  const id = (await (await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Clave " + n, ciudad: "Asunción", pais_iso: "PY", presidente: "Presi Dente", contacto } })).json()).id;
  await api("/admin/penas/" + id + "/verificar", { metodo: "POST", h: ADM });
  const u = await store.getPenaUsuarioDePena(id);
  await store.updatePenaUsuario(u.id, { password_hash: await bcrypt.hash("clave-vieja-1", 4), setup_token: null, setup_exp: null });
  const login = await (await api("/pena/login", { metodo: "POST", cuerpo: { usuario: u.usuario, password: "clave-vieja-1" } })).json();
  return { id, contacto, usuario: u.usuario, sesion: login.token };
}
async function comercio() {
  n++;
  const c = await store.crearComercio({ nombre: "Comercio Clave " + n, ciudad: "Asunción", contacto: `rc${n}-${Date.now()}@ejemplo.com` });
  const usuario = "cc" + n + "-" + crypto.randomBytes(2).toString("hex");
  await store.setComercioAcceso(c.id, usuario, await bcrypt.hash("clave-vieja-1", 4));
  const login = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario, password: "clave-vieja-1" } })).json();
  return { id: c.id, contacto: c.contacto, usuario, sesion: login.token };
}
const loginPena = (usuario, password) => api("/pena/login", { metodo: "POST", cuerpo: { usuario, password } });
const loginCom = (usuario, password) => api("/comercio/login", { metodo: "POST", cuerpo: { usuario, password } });

test("peña: pedir el cambio manda el link al correo de contacto, elegir la contraseña nueva entra y cierra las sesiones anteriores", async () => {
  const p = await pena();
  assert.strictEqual((await api("/pena/panel", { h: { "x-pena-token": p.sesion } })).status, 200, "la sesión vieja funciona");
  const r = await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: p.usuario } });
  assert.strictEqual(r.status, 200);
  await espera();
  assert.strictEqual(correos.length, 1);
  assert.deepStrictEqual({ a: correos[0].a, tipo: correos[0].tipo, usuario: correos[0].usuario }, { a: p.contacto, tipo: "peña", usuario: p.usuario });
  const token = tokenDe(correos[0].url);
  assert.ok(token && token.length >= 30);
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "corta" } })).status, 400, "mínimo 8 caracteres");
  const ok = await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "clave-nueva-123" } });
  assert.strictEqual(ok.status, 200);
  const nuevaSesion = (await ok.json()).token;
  assert.strictEqual((await api("/pena/panel", { h: { "x-pena-token": nuevaSesion } })).status, 200);
  assert.strictEqual((await api("/pena/panel", { h: { "x-pena-token": p.sesion } })).status, 401, "la sesión abierta con la contraseña anterior se cerró");
  assert.strictEqual((await loginPena(p.usuario, "clave-vieja-1")).status, 401);
  assert.strictEqual((await loginPena(p.usuario, "clave-nueva-123")).status, 200);
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token, password: "otra-clave-456" } })).status, 400, "el link sirve una sola vez");
});

test("peña: también se puede pedir con el correo de contacto; si no existe o no hay correo, la respuesta es idéntica y no sale nada", async () => {
  const p = await pena();
  const a = await (await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: p.contacto.toUpperCase() } })).json();
  const b = await (await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: "no-existe-" + n } })).json();
  const c = await (await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: "otro@nadie.com" } })).json();
  const d = await (await api("/pena/olvide", { metodo: "POST", cuerpo: {} })).json();
  await espera();
  assert.deepStrictEqual([b, c, d], [a, a, a], "no se puede averiguar qué usuarios existen");
  assert.deepStrictEqual(correos.map((x) => x.a), [p.contacto], "solo salió el de la peña real");
});

test("peña: respiro de 5 minutos por cuenta y un link vencido no sirve", async () => {
  const p = await pena();
  await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: p.usuario } });
  await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: p.usuario } });
  await espera();
  assert.strictEqual(correos.length, 1, "el segundo pedido seguido no manda otro correo");
  const u = await store.getPenaUsuarioDePena(p.id);
  assert.ok(new Date(u.setup_exp).getTime() - Date.now() <= 3600000 + 5000, "vence en 1 hora (no en 7 días)");
  await store.updatePenaUsuario(u.id, { setup_exp: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual((await api("/pena/clave", { metodo: "POST", cuerpo: { token: tokenDe(correos[0].url), password: "clave-nueva-123" } })).status, 400);
});

test("peña en pausa: no se manda el correo", async () => {
  const p = await pena();
  await api("/admin/penas/" + p.id + "/estado", { metodo: "POST", h: ADM, cuerpo: { estado: "pausada" } });
  await api("/pena/olvide", { metodo: "POST", cuerpo: { usuario: p.usuario } });
  await espera();
  assert.strictEqual(correos.length, 0);
});

test("comercio: pedir el cambio, elegir la contraseña nueva, entrar, y las sesiones y la contraseña anteriores dejan de servir", async () => {
  const c = await comercio();
  assert.strictEqual((await api("/comercio/beneficios", { h: { "x-comercio-token": c.sesion } })).status, 200, "la sesión vieja funciona");
  assert.strictEqual((await api("/comercio/olvide", { metodo: "POST", cuerpo: { usuario: c.usuario } })).status, 200);
  await espera();
  assert.strictEqual(correos.length, 1);
  assert.deepStrictEqual({ a: correos[0].a, tipo: correos[0].tipo, usuario: correos[0].usuario }, { a: c.contacto, tipo: "comercio", usuario: c.usuario });
  assert.match(correos[0].url, /\/comercio\?clave=/);
  const token = tokenDe(correos[0].url);
  const guardado = (await store.listComercios()).find((x) => x.id === c.id);
  assert.ok(guardado.clave_token && guardado.clave_token !== token && /^[0-9a-f]{64}$/.test(guardado.clave_token), "se guarda la huella, nunca el token");
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token, password: "corta" } })).status, 400);
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token: "inventado", password: "clave-nueva-123" } })).status, 400);
  const ok = await api("/comercio/clave", { metodo: "POST", cuerpo: { token, password: "clave-nueva-123" } });
  assert.strictEqual(ok.status, 200);
  const j = await ok.json();
  assert.strictEqual(j.comercio.id, c.id);
  assert.strictEqual((await api("/comercio/beneficios", { h: { "x-comercio-token": j.token } })).status, 200);
  assert.strictEqual((await api("/comercio/beneficios", { h: { "x-comercio-token": c.sesion } })).status, 401, "la sesión anterior se cerró");
  assert.strictEqual((await loginCom(c.usuario, "clave-vieja-1")).status, 401);
  assert.strictEqual((await loginCom(c.usuario, "clave-nueva-123")).status, 200);
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token, password: "otra-clave-456" } })).status, 400, "el link sirve una sola vez");
  assert.ok(!(await store.listComercios()).find((x) => x.id === c.id).clave_token, "el token se borra al usarlo");
});

test("comercio: respuesta idéntica exista o no, con correo de contacto; sin usuario, inactivo, sin correo o vencido no sirve", async () => {
  const c = await comercio();
  const a = await (await api("/comercio/olvide", { metodo: "POST", cuerpo: { usuario: c.contacto } })).json();
  const b = await (await api("/comercio/olvide", { metodo: "POST", cuerpo: { usuario: "nadie-" + n } })).json();
  await espera();
  assert.deepStrictEqual(b, a);
  assert.strictEqual(correos.length, 1, "con el correo de contacto también");
  await api("/comercio/olvide", { metodo: "POST", cuerpo: { usuario: c.usuario } }); await espera();
  assert.strictEqual(correos.length, 1, "respiro de 5 minutos por cuenta");
  await store.updateComercio(c.id, { clave_exp: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual((await api("/comercio/clave", { metodo: "POST", cuerpo: { token: tokenDe(correos[0].url), password: "clave-nueva-123" } })).status, 400, "vencido");
  const inactivo = await comercio(); await store.updateComercio(inactivo.id, { estado: "pausado" });
  const sinCorreo = await comercio(); await store.updateComercio(sinCorreo.id, { contacto: "" });
  correos.length = 0;
  for (const x of [inactivo, sinCorreo]) await api("/comercio/olvide", { metodo: "POST", cuerpo: { usuario: x.usuario } });
  await espera();
  assert.strictEqual(correos.length, 0);
});

test("los portales ofrecen '¿Olvidaste tu contraseña?', el de comercio elige la nueva con el link y los intentos tienen límite", () => {
  const p = leer("public", "pena.html"), c = leer("public", "comercio.html"), s = leer("server.js"), e = leer("lib", "email.js");
  assert.ok(/id="olvide"/.test(p) && /\/pena\/olvide/.test(p));
  assert.ok(/id="olvide"/.test(c) && /id="claveCard"/.test(c) && /\/comercio\/olvide/.test(c) && /\/comercio\/clave/.test(c) && /get\("clave"\)/.test(c));
  for (const ruta of ["/api/pena/olvide", "/api/comercio/olvide", "/api/comercio/clave"]) assert.ok(s.includes(`app.use("${ruta}", limitePenaAcceso)`), ruta + " con límite de intentos");
  assert.ok(/async function enviarRecuperarClave/.test(e) && /enviarRecuperarClave,/.test(e));
});
