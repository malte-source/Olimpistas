"use strict";
// Barrios en hexágonos H3 con k-anonimato: /api/mapa/celdas nunca entrega una casa ni a quien está solo en su zona.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const h3 = require("h3-js");
const h3lib = require("../lib/h3");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

let n = 0;
async function hincha(lat, lng, extra = {}) {
  const s = await store.createSocio({ email: `h3-${++n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Hincha" + n });
  await store.updateSocio(s.id, { lat, lng, mostrar_exacto: true, ...extra });
  return s;
}
const celdas = async (bbox) => (await fetch(`${url}/api/mapa/celdas?bbox=${bbox}`)).json();
const caja = (lat, lng, d = 0.05) => [lng - d, lat - d, lng + d, lat + d].join(",");

test("lib/h3: una celda con 3 o más hinchas se muestra; con menos, se sube un nivel; si sigue chica, se omite", () => {
  const base = h3.latLngToCell(-25.3, -57.6, 9);
  const [lat, lng] = h3.cellToLatLng(base);
  const p = (c) => { const [a, b] = h3.cellToLatLng(c); return { lat: a, lng: b }; };
  // 3 en la misma celda → res 9
  assert.deepStrictEqual(h3lib.celdasAnonimas([p(base), p(base), p(base)]), [{ c: base, n: 3, r: 9 }]);
  // 2 + 1 en celdas vecinas del mismo padre → se agrupan en res 8
  const padre = h3.cellToParent(base, 8);
  const hermana = h3.cellToChildren(padre, 9).find((c) => c !== base);
  const r = h3lib.celdasAnonimas([p(base), p(base), p(hermana)]);
  assert.deepStrictEqual(r, [{ c: padre, n: 3, r: 8 }]);
  // 1 solo → nada
  assert.deepStrictEqual(h3lib.celdasAnonimas([{ lat, lng }]), []);
  // dos solos → nada
  assert.deepStrictEqual(h3lib.celdasAnonimas([{ lat, lng }, { lat, lng }]), []);
  // basura se ignora
  assert.deepStrictEqual(h3lib.celdasAnonimas([{ lat: "x", lng: 1 }, { lat: 200, lng: 0 }, { lat: null, lng: null }]), []);
});

test("API: celdas con n ≥ 3, sin ids ni nombres, solo de quienes eligieron mostrarse", async () => {
  const [lat, lng] = [-25.52, -56.9]; // zona propia para este test
  for (let i = 0; i < 3; i++) await hincha(lat, lng);
  await hincha(lat, lng, { mostrar_exacto: false }); // no eligió mostrarse: no cuenta
  const j = await celdas(caja(lat, lng));
  assert.strictEqual(j.k, 3);
  assert.strictEqual(j.celdas.length, 1);
  assert.deepStrictEqual(Object.keys(j.celdas[0]).sort(), ["c", "n", "r"]);
  assert.strictEqual(j.celdas[0].n, 3, "el que no eligió mostrarse no suma");
  assert.strictEqual(j.celdas[0].r, 9);
  assert.ok(h3.isValidCell(j.celdas[0].c));
  const texto = JSON.stringify(j);
  assert.ok(!/Hincha|ejemplo\.com|soc_/.test(texto), "nada identificable en la respuesta");
});

test("API: quien está solo en su zona no aparece, ni como celda", async () => {
  const [lat, lng] = [-22.1, -55.9];
  await hincha(lat, lng);
  await hincha(lat + 0.5, lng + 0.5); // otro lejos
  const j = await celdas(caja(lat, lng, 1));
  assert.deepStrictEqual(j.celdas, []);
});

test("API: dos más uno en celdas vecinas se agrupan en un barrio más grande (res 8) con el total", async () => {
  const [lat0, lng0] = [-24.6, -57.1];
  const base = h3.latLngToCell(lat0, lng0, 9);
  const hermana = h3.cellToChildren(h3.cellToParent(base, 8), 9).find((c) => c !== base);
  const [la, lo] = h3.cellToLatLng(base), [lb, lob] = h3.cellToLatLng(hermana);
  await hincha(la, lo); await hincha(la, lo); await hincha(lb, lob);
  const j = await celdas(caja(la, lo, 0.05));
  assert.strictEqual(j.celdas.length, 1);
  assert.strictEqual(j.celdas[0].r, 8);
  assert.strictEqual(j.celdas[0].n, 3);
});

test("API: el recuadro tiene tope (no se puede barrer el mundo) y valida el formato", async () => {
  assert.strictEqual((await fetch(`${url}/api/mapa/celdas?bbox=-180,-90,180,90`)).status, 400);
  assert.strictEqual((await fetch(`${url}/api/mapa/celdas?bbox=-58,-26,-50,-20`)).status, 400, "más de 2 grados");
  assert.strictEqual((await fetch(`${url}/api/mapa/celdas?bbox=a,b,c`)).status, 400);
  assert.strictEqual((await fetch(`${url}/api/mapa/celdas`)).status, 400);
  assert.strictEqual((await fetch(`${url}/api/mapa/celdas?bbox=-57,-25,-57.5,-25.5`)).status, 400, "min > max");
});

test("el globo dibuja barrios (polígonos H3), con h3-js propio y sin oro", () => {
  const fs = require("fs"), path = require("path");
  const g = fs.readFileSync(path.join(__dirname, "..", "public", "js", "globe.js"), "utf8");
  assert.match(g, /barrios-fill/);
  assert.match(g, /cellToBoundary/);
  assert.match(g, /assets\/vendor\/h3-js\.umd\.js/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "assets", "vendor", "h3-js.umd.js")));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "public", "js", "landing.js"), "utf8"), /celdasUrl: "\/api\/mapa\/celdas"/);
});
