"use strict";
// Mapa (handoff v3, M2.6 + M3): banderas propias de 250 países, caminos al Defensores y "Mirá cómo crece".
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const mapa = require("../lib/mapa");
const geo = require("../public/js/geo-arcos.js");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

const PUBLIC = path.join(__dirname, "..", "public");
const leer = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

test("historia: acumula por mes y país, sin huecos hasta el mes actual, e ignora filas inválidas", () => {
  const h = mapa.acumularHistoria([
    { mes: "2026-08", iso: "py", n: 2 }, { mes: "2026-10", iso: "AR", n: 1 }, { mes: "2026-10", iso: "PY", n: 3 },
    { mes: "basura", iso: "PY", n: 9 }, { mes: "2026-09", iso: "PRY", n: 9 }, { mes: "2026-09", iso: "UY", n: 0 },
  ], new Date("2026-10-22T12:00:00Z"));
  assert.deepStrictEqual(h.map((x) => x.mes), ["2026-08", "2026-09", "2026-10"], "septiembre aparece aunque no hubo altas");
  assert.deepStrictEqual(h.map((x) => x.total), [2, 2, 6]);
  assert.deepStrictEqual(h[2].porPais, { PY: 5, AR: 1 });
  assert.deepStrictEqual(h[1].porPais, { PY: 2 });
  assert.deepStrictEqual(mapa.acumularHistoria([]), []);
  // cruza el año
  const a = mapa.acumularHistoria([{ mes: "2025-11", iso: "PY", n: 1 }], new Date("2026-02-10T12:00:00Z"));
  assert.deepStrictEqual(a.map((x) => x.mes), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("API /mapa/historia: solo hinchas reales (sin demo), con país, y solo totales por país", async () => {
  const r = await fetch(url + "/api/auth/registro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `hist${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Hist", apellido: "Prueba" }) });
  const { socio } = await r.json();
  await store.updateSocio(socio.id, { pais_iso: "UY" });
  const demo = await store.createSocio({ email: `demo${Date.now()}@demo.olimpistas.test`, passwordHash: "x", nombre: "Demo" });
  await store.updateSocio(demo.id, { pais_iso: "ZZ" });
  const j = await (await fetch(url + "/api/mapa/historia")).json();
  const ult = j.meses[j.meses.length - 1];
  assert.ok(ult.porPais.UY >= 1, "el hincha real cuenta");
  assert.ok(!("ZZ" in ult.porPais), "las filas de demo no cuentan");
  assert.deepStrictEqual(Object.keys(j), ["meses"]);
  assert.ok(!/ejemplo\.com|Hist/.test(JSON.stringify(j)), "nada de una persona");
});

test("caminos: el arco empieza y termina donde debe, es el camino corto y se corta al cruzar el antimeridiano", () => {
  const [par] = geo.arco([2.35, 48.85], geo.DEFENSORES);
  assert.deepStrictEqual(par[0], [2.35, 48.85]);
  assert.ok(Math.abs(par[par.length - 1][0] - geo.DEFENSORES[0]) < 1e-6 && Math.abs(par[par.length - 1][1] - geo.DEFENSORES[1]) < 1e-6);
  // París → Asunción pasa por el Atlántico, no por Asia: la longitud nunca sube de la de París
  assert.ok(par.every(([lng]) => lng <= 2.36 && lng >= -57.7));
  // Tokio → Asunción: por el Pacífico, cruza ±180 → 2 tramos, y dentro de cada tramo no hay saltos de más de 180°
  const tokio = geo.arco([139.7, 35.7], geo.DEFENSORES);
  assert.strictEqual(tokio.length, 2);
  for (const t of tokio) for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i][0] - t[i - 1][0]) < 180);
  // mismo punto: no hay línea
  assert.strictEqual(geo.arco(geo.DEFENSORES, geo.DEFENSORES)[0].length, 1);
});

test("caminosFC: una línea por país con coordenadas, Paraguay no dibuja, y lleva la cantidad", () => {
  const fc = geo.caminosFC([{ iso: "AR", lat: -34, lng: -64, count: 300 }, { iso: "PY", lat: -23, lng: -58, count: 9000 }, { iso: "ES", lat: 40, lng: -3.7, count: 120 }, { iso: "XX", count: 5 }, { iso: "JP", lat: 36, lng: 138, count: 7 }]);
  assert.deepStrictEqual(fc.features.map((f) => f.properties.iso).sort(), ["AR", "ES", "JP"]);
  assert.strictEqual(fc.features.find((f) => f.properties.iso === "AR").properties.count, 300);
  assert.strictEqual(fc.features.find((f) => f.properties.iso === "JP").geometry.type, "MultiLineString");
  assert.deepStrictEqual(geo.caminosFC(null).features, []);
});

test("banderas propias: 250 países en /assets/flags, con licencia, y ya nadie pide banderas a flagcdn", async () => {
  const dir = path.join(PUBLIC, "assets", "flags", "4x3");
  const archivos = fs.readdirSync(dir).filter((f) => /^[a-z]{2}\.svg$/.test(f));
  assert.ok(archivos.length >= 240, "faltan banderas: " + archivos.length);
  for (const iso of ["py", "ar", "br", "uy", "bo", "cl", "pe", "co", "ve", "ec", "mx", "us", "es", "fr", "de", "it", "pt", "jp", "cn", "gb"]) assert.ok(archivos.includes(iso + ".svg"), iso);
  assert.ok(fs.existsSync(path.join(PUBLIC, "assets", "flags", "LICENSE")), "falta la licencia MIT de flag-icons");
  const r = await fetch(url + "/assets/flags/4x3/py.svg");
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /<svg/);
  for (const f of ["js/common.js", "js/socio.js", "js/globe.js", "js/landing.js"]) assert.ok(!/https:\/\/flagcdn/.test(leer(f)), f + " pide banderas a flagcdn");
  const csp = (await fetch(url + "/")).headers.get("content-security-policy") || "";
  assert.ok(!/flagcdn/.test(csp), "la CSP ya no abre flagcdn");
  const g = leer("js/globe.js");
  assert.ok(!/\bFLAG\s*=\s*\{/.test(g), "sin la tabla de banderas dibujadas a mano");
  assert.match(g, /\/assets\/flags\/4x3\//);
});

test("el globo dibuja los caminos y la landing trae el deslizador del tiempo", () => {
  const g = leer("js/globe.js");
  assert.match(g, /caminos-linea/);
  assert.match(g, /OLI_GEO\.caminosFC/);
  assert.match(leer("js/common.js"), /geo-arcos\.js/);
  const h = leer("index.html");
  assert.match(h, /id="globoTiempo"/);
  assert.match(h, /id="tiempoRango"/);
  assert.match(leer("js/landing.js"), /function iniciarTiempo\(gl\)/);
  assert.deepStrictEqual((g.match(/b08d2e|c9a227/gi) || []), [], "sin oro");
});

test("los scripts del mapa se piden con la versión del deploy (la de common.js), no con un número fijo que se queda viejo en caché", () => {
  const c = leer("js/common.js");
  assert.match(c, /document\.currentScript/);
  assert.match(c, /globe\.js\?v=" \+ VER/);
  assert.match(c, /geo-arcos\.js\?v=" \+ VER/);
  assert.ok(!/(globe|geo-arcos)\.js\?v=\d+/.test(c), "sin versión fija");
  assert.match(c, /replace\(\/\[\^\w\.-\]\/g/, "la versión se limpia sin tocar las letras");
});
