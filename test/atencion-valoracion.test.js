"use strict";
// "Me sirvió / No me sirvió" sobre las respuestas del asistente: solo en la propia conversación, se puede cambiar y quitar, y el panel lo cuenta.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function cuenta() {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `va${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio } = await r.json();
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
async function conversacionConRespuesta(c) {
  const conv = await store.abrirConversacionAtencion({ socioId: c.id, canal: "app" });
  await store.addMensajeAtencion({ conversacionId: conv.id, de: "hincha", texto: "Hola" });
  const ia = await store.addMensajeAtencion({ conversacionId: conv.id, de: "ia", texto: "Hola, ¿en qué te ayudo?", meta: { via: "respaldo" } });
  const hu = await store.addMensajeAtencion({ conversacionId: conv.id, de: "humano", texto: "Te respondo yo" });
  return { conv, ia, hu };
}
const valorar = (c, id, valor) => api("/atencion/mensajes/" + id + "/valorar", { metodo: "POST", h: c.h, cuerpo: { valor } });
const meta = async (convId, mid) => { const m = (await store.listMensajesAtencion(convId)).find((x) => x.id === mid); return JSON.parse(m.meta || "{}"); };

test("valorar: queda guardado, se puede cambiar y quitar, y conserva el resto del meta", async () => {
  const A = await cuenta(), { conv, ia } = await conversacionConRespuesta(A);
  assert.strictEqual((await valorar(A, ia.id, 1)).status, 200);
  assert.deepStrictEqual(await meta(conv.id, ia.id), { via: "respaldo", valoracion: 1 });
  await valorar(A, ia.id, -1);
  assert.strictEqual((await meta(conv.id, ia.id)).valoracion, -1);
  await valorar(A, ia.id, 0);
  assert.deepStrictEqual(await meta(conv.id, ia.id), { via: "respaldo" });
  const chat = await (await api("/atencion/chat", { h: A.h })).json();
  assert.ok(chat.mensajes.some((m) => m.id === ia.id), "el chat vuelve a traer el mensaje (con su valoración si la tiene)");
});

test("valorar: solo respuestas del asistente y solo de la propia conversación; valores inválidos se rechazan", async () => {
  const A = await cuenta(), B = await cuenta(), { conv, ia, hu } = await conversacionConRespuesta(A);
  assert.strictEqual((await valorar(B, ia.id, 1)).status, 404, "otra persona no puede valorar");
  assert.strictEqual((await valorar(A, hu.id, 1)).status, 404, "una respuesta humana no se valora");
  assert.strictEqual((await valorar(A, "atm_noexiste", 1)).status, 404);
  for (const malo of [2, -2, "bien", null]) assert.strictEqual((await valorar(A, ia.id, malo)).status, 400, String(malo));
  assert.strictEqual((await api("/atencion/mensajes/" + ia.id + "/valorar", { metodo: "POST", cuerpo: { valor: 1 } })).status, 401);
  assert.strictEqual((await meta(conv.id, ia.id)).valoracion, undefined);
});

test("el panel de atención cuenta las valoraciones de la semana y las muestra en la conversación", async () => {
  const A = await cuenta(), { conv, ia } = await conversacionConRespuesta(A);
  const antes = (await (await api("/admin/atencion", { h: { "x-admin-key": "clave-admin-de-prueba" } })).json()).indicadores;
  await valorar(A, ia.id, -1);
  const desp = (await (await api("/admin/atencion", { h: { "x-admin-key": "clave-admin-de-prueba" } })).json()).indicadores;
  assert.strictEqual(desp.no_utiles, antes.no_utiles + 1);
  assert.strictEqual(desp.utiles, antes.utiles);
  const d = await (await api("/admin/atencion/" + conv.id, { h: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  assert.strictEqual(d.mensajes.find((m) => m.id === ia.id).meta.valoracion, -1);
});

test("el chat muestra los pulgares solo en respuestas del asistente, con nombre accesible y estado, en español e inglés", () => {
  const j = leer("public", "js", "atencion.js"), a = leer("public", "admin.html"), c = leer("public", "css", "styles.css");
  assert.ok(/data-mid="\$\{esc\(m\.id\)\}"/.test(j) && /data-val="\$\{val\}"/.test(j) && /aria-pressed/.test(j) && /aria-label="\$\{esc\(txt\)\}"/.test(j));
  for (const k of ["util:", "noUtil:", "gracias:"]) assert.strictEqual((j.match(new RegExp("\\b" + k, "g")) || []).length, 2, k + " en es y en");
  assert.ok(/\/valorar/.test(j) && /\^\(tmp\|esp\)-/.test(j), "no se valoran mensajes que todavía no existen en el servidor");
  assert.ok(/me sirvió \/ no me sirvió/.test(a) && /NO le sirvió/.test(a));
  assert.ok(/\.atc-pulgar:focus-visible/.test(c) && /\.atc-pulgar \{[^}]*width: 32px; height: 32px/.test(c), "foco visible y blanco táctil de 32 px");
});
