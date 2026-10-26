"use strict";
// Contenido por secciones: una pestaña por tema, con globitos de lo que espera, y enlaces directos desde "Para hacer ahora".
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const a = leer("public", "admin.html");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

test("cada bloque de Contenido pertenece a una sección y hay una pestaña por sección, accesible", () => {
  const bloques = [...a.matchAll(/<div data-sec="([^"]+)" data-sub="([a-z]+)">\s*<h2>([^<]+)<\/h2>/g)].map((m) => [m[2], m[3]]);
  assert.deepStrictEqual(bloques.map((b) => b[0]), ["catalogo", "penas", "comercios", "comercios", "puntos", "cola"]);
  assert.ok(bloques.some((b) => b[1] === "Comercios de la red") && bloques.some((b) => b[1] === "Ofertas de comercios"), "comercios y ofertas van juntos");
  assert.ok(/<nav class="cont-tabs" id="contTabs" role="tablist" aria-label="Secciones de Contenido">/.test(a));
  assert.ok(/role="tab" class="cont-tab"[^>]*aria-selected="' \+ \(s\[0\] === sub\)/.test(a), "pestañas con rol y estado");
  assert.ok(/\.cont-tab:focus-visible/.test(a) && /\.cont-oculto \{ display:none !important; \}/.test(a));
});

test("solo se ofrecen las pestañas que el rol puede ver, y los bloques ocultos por rol no se muestran al cambiar", () => {
  assert.ok(/function contDisponible\(sub\) \{ return contBloques\(sub\)\.some\(function \(b\) \{ return veSeccion\.apply\(null, b\.dataset\.sec\.split\(","\)\); \}\); \}/.test(a));
  assert.ok(/CONT_SUBS\.filter\(function \(s\) \{ return contDisponible\(s\[0\]\); \}\)/.test(a));
  assert.ok(/if \(!disp\.some\(function \(s\) \{ return s\[0\] === sub; \}\)\) sub = disp\[0\]\[0\];/.test(a), "si la sección pedida no está disponible para el rol, abre la primera que sí");
  assert.ok(/classList\.toggle\("cont-oculto"/.test(a) && !/\.style\.display = s\[0\]/.test(a), "ocultar secciones no pisa el ocultamiento por rol (style.display)");
});

test("los enlaces de 'Para hacer ahora' llevan a la pestaña correcta y el globito usa las mismas colas que el servidor", async () => {
  const d = await (await fetch(url + "/api/admin/pendientes", { headers: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  const area = Object.fromEntries(d.colas.map((c) => [c.clave, c.area]));
  assert.deepStrictEqual(area, { pagos: "pagos", subastas: "contenido/catalogo", atencion: "atencion", validaciones: "contenido/cola", ofertas: "contenido/comercios", penas: "contenido/penas", canjes_pena: "contenido/penas", canjes_puntos: "contenido/puntos" });
  const alias = JSON.parse(a.match(/var CONT_ALIAS = (\{[^}]+\});/)[1].replace(/(\w+):/g, '"$1":'));
  for (const c of d.colas.filter((x) => x.area.startsWith("contenido/"))) assert.ok(alias[c.area.split("/")[1]], "el enlace " + c.area + " tiene alias");
  const cola = JSON.parse(a.match(/var CONT_COLA = (\{.+\});/)[1].replace(/(\w+):/g, '"$1":'));
  const usadas = new Set(Object.values(cola).flat());
  for (const c of d.colas.filter((x) => x.area.startsWith("contenido/"))) assert.ok(usadas.has(c.clave), "la cola " + c.clave + " tiene globito en alguna pestaña");
  assert.ok(a.includes("function onHash() { var a = (location.hash || \"\").replace(") && a.includes("split(\"/\")[0] || \"dashboard\"; navTo(a); }"), "el área se saca de la primera parte del enlace");
});
