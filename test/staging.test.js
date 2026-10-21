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

// ── Tuti falso: cada último dígito de la cédula es un caso distinto ──────────
process.env.TUTI_API_KEY = "mock";
process.env.TUTI_MERCHANT_KEY = "mock";
const tuti = require("../lib/tuti");

// El cliente real apunta a bff.tuti.com.py; acá se redirige a este mismo servidor.
const alMock = (u, o) => fetch(u.replace("https://bff.tuti.com.py", url + "/_mock/tuti"), o);
const consultar = (cedula) => tuti.consultarSocio(cedula, { fetchImpl: alMock });

test("tuti mock: 1/2/3 son socios al día (ACTIVE, LIFETIME, DEBT = pago pendiente)", async () => {
  for (const [ced, status] of [["4000001", "ACTIVE"], ["4000002", "LIFETIME"], ["4000003", "DEBT"]]) {
    const r = await consultar(ced);
    assert.strictEqual(r.encontrado, true, ced);
    assert.strictEqual(r.socio.status, status);
    assert.strictEqual(r.socio.alDia, true, status + " sigue siendo socio");
  }
  assert.strictEqual((await consultar("4000003")).socio.deuda, 180000);
});

test("tuti mock: 4 y 5 son bajas (INACTIVE, UNSUBSCRIBED) y 0/9 no figuran", async () => {
  for (const ced of ["4000004", "4000005"]) assert.strictEqual((await consultar(ced)).socio.alDia, false, ced);
  for (const ced of ["4000000", "4000009"]) {
    const r = await consultar(ced);
    assert.deepStrictEqual({ ok: r.ok, encontrado: r.encontrado }, { ok: true, encontrado: false });
  }
});

test("tuti mock: 7 → error del proveedor, no concluyente", async () => {
  const r = await consultar("4000007");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, "http_500");
});

test("tuti mock: 6 → límite de velocidad (429) con Retry-After y el cliente se frena", async () => {
  const r = await consultar("4000006");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, "limite");
  assert.strictEqual(r.reintentarEnMs, 20000);
  const sigue = await consultar("4000001"); // mientras dura el bloqueo ni siquiera consulta
  assert.strictEqual(sigue.motivo, "limite");
  tuti.__resetBloqueo();
});

test("tuti mock: sin las keys → 401 igual que la API real", async () => {
  const r = await fetch(url + "/_mock/tuti/bff-service/OLIMPIA/subscription/members?documentNumber=4000001");
  assert.strictEqual(r.status, 401);
});
