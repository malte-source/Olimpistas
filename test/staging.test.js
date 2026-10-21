"use strict";
// ENTORNO=staging: el sitio de pruebas nunca se indexa y avisa que es de pruebas.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ENTORNO = "staging";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");

let srv, url;
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv && srv.close());

test("staging: robots.txt cierra todo el sitio", async () => {
  const r = await fetch(url + "/robots.txt");
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Disallow: \//);
});

test("staging: toda respuesta lleva X-Robots-Tag noindex (páginas, API y estáticos)", async () => {
  for (const ruta of ["/", "/miembro", "/api/config", "/health"]) {
    const r = await fetch(url + ruta);
    assert.match(r.headers.get("x-robots-tag") || "", /noindex/, ruta);
  }
});

test("staging: la home y la app muestran el cartel de pruebas", async () => {
  for (const ruta of ["/", "/en", "/miembro"]) {
    const html = await (await fetch(url + ruta)).text();
    assert.ok(html.includes('id="cartelPruebas"'), "falta el cartel en " + ruta);
    assert.ok(html.indexOf('id="cartelPruebas"') < html.lastIndexOf("</body>"), "el cartel va dentro del body");
  }
});
