"use strict";
// Ciudades normalizadas (GeoNames) y "la peña más cercana": autocompletado, ciudad oficial del hincha y peñas por distancia.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const ciudades = require("../lib/ciudades");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  const c = (id, nombre, pais_iso, lat, lng, poblacion) => ({ id, nombre, nombre_norm: ciudades.norm(nombre), pais_iso, lat, lng, poblacion });
  await store.importarCiudades([
    c(3437863, "Lambaré", "PY", -25.34682, -57.60647, 126377), c(3437665, "Nemby", "PY", -25.3949, -57.53574, 94641),
    c(3439389, "Asunción", "PY", -25.28646, -57.64700, 521559), c(3437056, "San Lorenzo", "PY", -25.33968, -57.50879, 227876),
    c(3438735, "Encarnación", "PY", -27.33176, -55.86662, 74983), c(3435910, "Buenos Aires", "AR", -34.61315, -58.37723, 2891082),
    c(9000001, "Asunción", "GT", 14.5, -90.5, 20000), // homónima en otro país
  ]);
});
after(() => srv && srv.close());

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function hincha(extra = {}) {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `ciu${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Ciudad", apellido: "Prueba" } });
  const j = await r.json();
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  if (extra.pais) await api("/perfil", { metodo: "PATCH", h, cuerpo: { pais: extra.pais } });
  return { id: j.socio.id, h };
}
const perfil = (s, cuerpo) => api("/perfil", { metodo: "PATCH", h: s.h, cuerpo }).then((r) => r.json());
const ciudadId = async (s) => (await store.getSocioById(s.id)).ciudad_id;

test("lib: normaliza (sin acentos ni mayúsculas), lee una línea de GeoNames y mide distancias", () => {
  assert.strictEqual(ciudades.norm("  Ñemby "), "nemby");
  assert.strictEqual(ciudades.norm("Asunción"), ciudades.norm("ASUNCION"));
  const linea = ["3437863", "Lambaré", "Lambare", "x", "-25.34682", "-57.60647", "P", "PPLA", "PY", "", "", "", "", "", "126377", "", "", "America/Asuncion", "2020-01-01"].join("\t");
  assert.deepStrictEqual(ciudades.filaDeGeonames(linea), { id: 3437863, nombre: "Lambaré", nombre_norm: "lambare", pais_iso: "PY", lat: -25.34682, lng: -57.60647, poblacion: 126377 });
  assert.strictEqual(ciudades.filaDeGeonames("basura"), null);
  assert.strictEqual(ciudades.parsearGeonames(linea + "\n\n" + "x\ty").length, 1);
  const km = ciudades.distanciaKm(-25.2865, -57.647, -34.6131, -58.3772);
  assert.ok(km > 1000 && km < 1100, "Asunción–Buenos Aires ≈ 1.040 km: " + km);
  assert.strictEqual(ciudades.distanciaKm(1, 1, 1, 1), 0);
});

test("/api/ciudades: por prefijo, sin acentos, más poblada primero, filtra por país y no devuelve datos de más", async () => {
  const a = await (await api("/ciudades?q=nem&pais=PY")).json();
  assert.deepStrictEqual(a.items.map((x) => x.nombre), ["Nemby"]);
  assert.deepStrictEqual(Object.keys(a.items[0]).sort(), ["id", "nombre", "pais_iso"]);
  assert.deepStrictEqual((await (await api("/ciudades?q=%C3%91emby&pais=PY")).json()).items.map((x) => x.nombre), ["Nemby"], "la Ñ encuentra a Nemby");
  const as = await (await api("/ciudades?q=asun")).json();
  assert.deepStrictEqual(as.items.map((x) => x.pais_iso), ["PY", "GT"], "sin país: la más poblada primero");
  assert.deepStrictEqual((await (await api("/ciudades?q=asun&pais=GT")).json()).items.map((x) => x.pais_iso), ["GT"]);
  assert.deepStrictEqual((await (await api("/ciudades?q=a")).json()).items, [], "una letra no alcanza");
  assert.deepStrictEqual((await (await api("/ciudades?q=%25%25")).json()).items, [], "los comodines no se interpretan");
});

test("perfil: la ciudad escrita se reconoce (sin acentos, por país); si no coincide queda sin ciudad oficial", async () => {
  const s = await hincha({ pais: "PY" });
  await perfil(s, { ciudad: "lambare" });
  assert.strictEqual(await ciudadId(s), 3437863);
  await perfil(s, { ciudad: "Pueblito Inventado" });
  assert.strictEqual(await ciudadId(s), null, "no coincide: sin ciudad oficial (el texto se conserva)");
  assert.strictEqual((await store.getSocioById(s.id)).ciudad, "Pueblito Inventado");
  await perfil(s, { ciudad: "Asunción" });
  assert.strictEqual(await ciudadId(s), 3439389, "la homónima de Guatemala no gana: el país es PY");
  await perfil(s, { ciudad: "" });
  assert.strictEqual(await ciudadId(s), null);
});

test("perfil: elegir del autocompletado fija la ciudad oficial y su nombre", async () => {
  const s = await hincha({ pais: "PY" });
  const j = await perfil(s, { ciudad: "nembi", ciudad_id: 3437665 });
  assert.strictEqual(j.socio.ciudad, "Nemby");
  assert.strictEqual(await ciudadId(s), 3437665);
});

test("perfil: al elegir su casa sin ciudad, se asigna la más cercana del mismo país (hasta 60 km)", async () => {
  const cerca = await hincha({ pais: "PY" });
  await perfil(cerca, { lat: -25.29, lng: -57.6 });
  assert.strictEqual(await ciudadId(cerca), 3439389, "Asunción");
  assert.strictEqual((await store.getSocioById(cerca.id)).ciudad, "Asunción", "y completa el texto si estaba vacío");
  const lejos = await hincha({ pais: "PY" });
  await perfil(lejos, { lat: -23.0, lng: -58.9 }); // monte chaqueño, a más de 60 km de todo
  assert.ok((await ciudadId(lejos)) == null, "sin ciudad cercana: sin ciudad oficial");
  const yaTenia = await hincha({ pais: "PY" });
  await perfil(yaTenia, { ciudad: "Encarnación" });
  await perfil(yaTenia, { lat: -25.29, lng: -57.6 });
  assert.strictEqual(await ciudadId(yaTenia), 3438735, "no pisa la ciudad que ya había elegido");
});

test("peñas: la solicitud se ubica por su ciudad; /penas?cerca ordena por distancia, con km, y solo trae peñas ubicadas", async () => {
  const mk = async (nombre, ciudad) => {
    const r = await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre, ciudad, pais_iso: "PY", presidente: "Presi", contacto: `p${++n}-${Date.now()}@ejemplo.com` } });
    const { id } = await r.json();
    return store.getPena(id);
  };
  const lamb = await mk("Peña Lambaré Test", "Lambaré"), enc = await mk("Peña Encarnación Test", "Encarnación"), rara = await mk("Peña Sin Ciudad Test", "Lugar Inventado");
  assert.ok(Math.abs(lamb.lat - -25.34682) < 1e-6, "ubicada por su ciudad");
  assert.ok(rara.lat == null, "ciudad desconocida: sin ubicación");
  for (const p of [lamb, enc, rara]) await store.updatePena(p.id, { estado: "verificada" });
  const j = await (await api("/penas?cerca=-25.29,-57.6")).json();
  assert.deepStrictEqual(j.items.map((p) => p.nombre), ["Peña Lambaré Test", "Peña Encarnación Test"], "la sin ubicación no entra");
  assert.ok(j.items[0].distancia_km < 15 && j.items[1].distancia_km > 200);
  assert.ok(j.items[0].distancia_km <= j.items[1].distancia_km);
  const todas = await (await api("/penas")).json();
  assert.ok(todas.items.every((p) => "lat" in p && "lng" in p && !("distancia_km" in p)));
  assert.strictEqual((await api("/penas?cerca=hola")).status, 200, "una ubicación inválida se ignora");
  assert.ok(!/@ejemplo|Presi/.test(JSON.stringify(j)), "nada del presidente ni del contacto");
});

test("front: el perfil autocompleta ciudades y el globo muestra las peñas con 'Encontrá tu peña' y 'Sumarme'", () => {
  const fs = require("fs"), path = require("path");
  const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");
  const s = leer("js/socio.js");
  assert.match(s, /list="pfCiudades"/);
  assert.match(s, /\/ciudades\?q=/);
  assert.match(s, /body\.ciudad_id = ciudadIds/);
  const g = leer("js/globe.js");
  assert.match(g, /penas-escudo/);
  assert.match(g, /setPenas\(lista\)/);
  assert.match(g, /abrirPena\(p\)/);
  assert.match(g, /\/\?pena=/);
  assert.deepStrictEqual((g.match(/b08d2e|c9a227/gi) || []), [], "sin oro");
  assert.match(leer("index.html"), /id="penaCerca"/);
  const l = leer("js/landing.js");
  assert.match(l, /function iniciarPenas\(gl\)/);
  assert.match(l, /\/penas\?cerca=/);
  const i18n = leer("js/i18n.js");
  for (const k of ["mapa_pena", "mapa_pena_buscando", "mapa_pena_ninguna", "mapa_pena_km"]) assert.strictEqual((i18n.match(new RegExp(k + ":", "g")) || []).length, 2, k);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "assets", "escudo-olimpia-blanco.png")));
});

test("ciudades extra: las ciudades grandes que GeoNames trae sin población (Luque, Hernandarias…) se cargan igual", () => {
  const fs = require("fs"), path = require("path");
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "ciudades-extra.json"), "utf8"));
  assert.ok(extra.length >= 4);
  for (const e of extra) {
    assert.ok(Number.isInteger(e.id) && e.nombre && /^[A-Z]{2}$/.test(e.pais_iso) && Number.isFinite(e.lat) && Number.isFinite(e.lng), JSON.stringify(e));
  }
  assert.ok(extra.some((e) => e.nombre === "Luque" && e.pais_iso === "PY"));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "setup", "importar-ciudades.js"), "utf8"), /ciudades-extra\.json/);
});
