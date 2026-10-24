"use strict";
// Notificaciones push: 4 tipos de aviso, preferencias por persona, suscripciones que se limpian solas y un solo aviso de beneficio por día.
const webpush = require("web-push");
const claves = webpush.generateVAPIDKeys();
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.VAPID_PUBLIC_KEY = claves.publicKey;
process.env.VAPID_PRIVATE_KEY = claves.privateKey;

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const push = require("../lib/push");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function persona(ciudad) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `pu${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio } = await r.json();
  if (ciudad) await store.updateSocio(socio.id, { ciudad });
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const SUB = (k) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/" + k, keys: { p256dh: "BNc" + "x".repeat(60), auth: "a".repeat(22) } });

test("preferencias: todo activo salvo lo que la persona apagó", () => {
  assert.deepStrictEqual(push.prefsDe({}), { subasta: true, pago: true, beneficio: true, partido: true });
  assert.deepStrictEqual(push.prefsDe({ push_prefs: { pago: false } }), { subasta: true, pago: false, beneficio: true, partido: true });
  assert.strictEqual(push.prefsDe({ push_prefs: JSON.stringify({ subasta: false }) }).subasta, false);
});

test("el aviso solo puede llevar a una página de Olimpistas y el texto se recorta", () => {
  const b = "https://www.olimpistas.com";
  assert.strictEqual(push.urlSegura("/miembro/beneficios", b), b + "/miembro/beneficios");
  assert.strictEqual(push.urlSegura("https://www.olimpistas.com/subasta/x", b), "https://www.olimpistas.com/subasta/x");
  for (const mala of ["https://malo.example/robo", "//malo.example", "javascript:alert(1)", "", null]) assert.strictEqual(push.urlSegura(mala, b), b + "/miembro", String(mala));
  const c = JSON.parse(push.armar({ titulo: "T".repeat(300), cuerpo: "c".repeat(500), url: "/x", tipo: "otro" }, b));
  assert.strictEqual(c.titulo.length, 80);
  assert.strictEqual(c.cuerpo.length, 160);
  assert.strictEqual(c.tipo, undefined, "un tipo desconocido no viaja");
});

test("avisar: llega a todos sus dispositivos, respeta lo que apagó y limpia las suscripciones que el navegador ya no reconoce", async () => {
  const A = await persona();
  await store.guardarPushSuscripcion({ socioId: A.id, endpoint: SUB("a1").endpoint, p256dh: "p", auth: "a", ua: "t" });
  await store.guardarPushSuscripcion({ socioId: A.id, endpoint: SUB("a2").endpoint, p256dh: "p", auth: "a", ua: "t" });
  const visto = [];
  const ok = (s, c) => { visto.push([s.endpoint, JSON.parse(c)]); return Promise.resolve(); };
  assert.strictEqual(await push.avisar(store, A.id, "subasta", { titulo: "Te superaron", cuerpo: "x", url: "/miembro" }, { base: "https://www.olimpistas.com", sender: ok }), 2);
  assert.strictEqual(visto[0][1].tipo, "subasta");
  await store.updateSocio(A.id, { push_prefs: { subasta: false } });
  assert.strictEqual(await push.avisar(store, A.id, "subasta", { titulo: "x" }, { sender: ok }), 0, "apagó este tipo");
  assert.strictEqual(await push.avisar(store, A.id, "pago", { titulo: "x" }, { sender: ok }), 2, "los otros tipos siguen");
  assert.strictEqual(await push.avisar(store, A.id, "inventado", { titulo: "x" }, { sender: ok }), 0, "tipo inexistente");
  const gone = (s) => (s.endpoint.endsWith("a1") ? Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 })) : Promise.resolve());
  assert.strictEqual(await push.avisar(store, A.id, "pago", { titulo: "x" }, { sender: gone }), 1);
  assert.deepStrictEqual((await store.listarPushDeSocio(A.id)).map((x) => x.endpoint), [SUB("a2").endpoint], "la suscripción vencida se borró sola");
});

test("difundir: solo la ciudad pedida, respeta preferencias y manda un solo beneficio por persona y día", async () => {
  const ciudad = "Ciudad" + Date.now();
  const P = await persona(ciudad), Q = await persona(ciudad), Lejos = await persona("Otra" + Date.now()), Callada = await persona(ciudad);
  for (const [x, k] of [[P, "p1"], [P, "p2"], [Q, "q1"], [Lejos, "l1"], [Callada, "c1"]]) await store.guardarPushSuscripcion({ socioId: x.id, endpoint: SUB(k + ciudad).endpoint, p256dh: "p", auth: "a", ua: "t" });
  await store.updateSocio(Callada.id, { push_prefs: { beneficio: false } });
  const enviados = [];
  const sender = (s) => { enviados.push(s.endpoint); return Promise.resolve(); };
  const r1 = await push.difundir(store, { tipo: "beneficio", ciudad, payload: { titulo: "Nuevo" }, sender, clave: "b1" });
  assert.deepStrictEqual(r1, { destinatarios: 2, enviados: 3 }, "P (2 dispositivos) y Q; no Lejos ni Callada");
  const r2 = await push.difundir(store, { tipo: "beneficio", ciudad, payload: { titulo: "Otro" }, sender, clave: "b1" });
  assert.deepStrictEqual(r2, { destinatarios: 0, enviados: 0 }, "el mismo día no se repite");
  const r3 = await push.difundir(store, { tipo: "partido", ciudad, payload: { titulo: "Hoy juega el Decano" }, sender, clave: "p1" });
  assert.strictEqual(r3.destinatarios, 3, "otro tipo tiene su propio cupo (Callada solo apagó beneficios)");
});

test("sin claves VAPID el módulo queda apagado y no falla", async () => {
  const antes = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY;
  try {
    assert.strictEqual(push.habilitado(), false);
    assert.strictEqual(await push.avisar(store, "no-existe", "subasta", { titulo: "x" }), 0);
    assert.deepStrictEqual(await push.difundir(store, { tipo: "beneficio", payload: { titulo: "x" } }), { destinatarios: 0, enviados: 0 });
  } finally { process.env.VAPID_PRIVATE_KEY = antes; }
});

test("rutas: la configuración da la clave pública; suscribir valida; las preferencias se guardan; solo se borra lo propio", async () => {
  const A = await persona(), B = await persona();
  assert.strictEqual((await api("/push/config")).status, 401, "hace falta sesión");
  const cfg = await (await api("/push/config", { h: A.h })).json();
  assert.strictEqual(cfg.habilitado, true);
  assert.strictEqual(cfg.clave, claves.publicKey);
  assert.deepStrictEqual(cfg.tipos, ["subasta", "pago", "beneficio", "partido"]);
  for (const mala of [{}, { endpoint: "http://inseguro.example/x", keys: { p256dh: "abc", auth: "abc" } }, { endpoint: "https://x.example/a", keys: { p256dh: "con espacios", auth: "abc" } }, { endpoint: "https://x.example/" + "a".repeat(800), keys: { p256dh: "abc", auth: "abc" } }]) {
    assert.strictEqual((await api("/push/suscribir", { metodo: "POST", h: A.h, cuerpo: { subscription: mala } })).status, 400);
  }
  const ok = await api("/push/suscribir", { metodo: "POST", h: A.h, cuerpo: { subscription: SUB("ruta1") } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await (await api("/push/config", { h: A.h })).json()).dispositivos, 1);
  const pr = await (await api("/push/preferencias", { metodo: "PATCH", h: A.h, cuerpo: { pago: false, subasta: "no-es-booleano" } })).json();
  assert.deepStrictEqual(pr.prefs, { subasta: true, pago: false, beneficio: true, partido: true });
  assert.strictEqual((await store.getSocioById(A.id)).push_prefs.pago, false);
  await api("/push/baja", { metodo: "POST", h: B.h, cuerpo: { endpoint: SUB("ruta1").endpoint } });
  assert.strictEqual((await store.listarPushDeSocio(A.id)).length, 1, "otra persona no puede borrar mi suscripción");
  await api("/push/baja", { metodo: "POST", h: A.h, cuerpo: { endpoint: SUB("ruta1").endpoint } });
  assert.strictEqual((await store.listarPushDeSocio(A.id)).length, 0);
});

test("admin: el aviso del club exige permiso, valida el texto y no manda nada si nadie está suscripto a esa ciudad", async () => {
  const sin = await api("/admin/push/enviar", { metodo: "POST", cuerpo: { titulo: "Hola" } });
  assert.ok([401, 403].includes(sin.status));
  const H = { "x-admin-key": "clave-admin-de-prueba" };
  assert.strictEqual((await api("/admin/push/enviar", { metodo: "POST", h: H, cuerpo: { titulo: "x" } })).status, 400);
  assert.strictEqual((await api("/admin/push/enviar", { metodo: "POST", h: H, cuerpo: { titulo: "Hoy juega el Decano", cuerpo: "c".repeat(200) } })).status, 400);
  const r = await (await api("/admin/push/enviar", { metodo: "POST", h: H, cuerpo: { titulo: "Hoy juega el Decano", cuerpo: "A las 20:00", ciudad: "Ciudad-Sin-Nadie" } })).json();
  assert.deepStrictEqual(r, { destinatarios: 0, enviados: 0 });
  const res = await (await api("/admin/push/resumen", { h: H })).json();
  assert.strictEqual(res.habilitado, true);
});

test("pantalla y service worker: ofrecer avisos tras la primera puja, ajustes con los 4 tipos y el aviso abre la página", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /setTimeout\(ofrecerAvisoSubasta, 1800\)/);
  assert.match(s, /Notification\.requestPermission\(\)/, "el permiso se pide con un toque, nunca al entrar");
  assert.match(s, /id="ajPushBox"/);
  assert.match(s, /pintarPushAjustes\(root\)/);
  const sw = leer("public", "sw.js");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /const VERSION = "oli-v17"/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["push_h", "push_no_soporta", "push_bloq", "push_t_subasta", "push_t_pago", "push_t_beneficio", "push_t_partido", "push_of_h", "push_ok"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});

test("los disparadores están conectados: te superaron, plazo de pago y beneficio destacado", () => {
  const r = leer("routes.js");
  assert.match(r, /pushLib\.avisar\(store, out\.prevGanador, "subasta"/);
  assert.match(r, /pushLib\.avisar\(store, s\.adjudicado_a, "pago"/);
  assert.match(r, /pushLib\.difundir\(store, \{ tipo: "beneficio", ciudad: c\.ciudad/);
});

test("migración 0017: suscripciones y preferencias, aditiva", () => {
  const m = leer("migraciones", "0017_push.sql");
  assert.match(m, /CREATE TABLE IF NOT EXISTS public\.push_suscripciones/);
  assert.match(m, /endpoint\s+text NOT NULL UNIQUE/);
  assert.match(m, /ADD COLUMN IF NOT EXISTS push_prefs jsonb/);
  assert.ok(!/DROP|TRUNCATE|DELETE FROM/i.test(m));
});
