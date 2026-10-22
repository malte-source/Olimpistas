"use strict";
// Comercios en el admin (alta, ubicación por link de Google Maps, acceso al portal) y "beneficios cerca tuyo" en el mapa.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const mapaUrl = require("../lib/mapaurl");
const ciudades = require("../lib/ciudades");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  await store.importarCiudades([{ id: 3439389, nombre: "Asunción", nombre_norm: ciudades.norm("Asunción"), pais_iso: "PY", lat: -25.28646, lng: -57.647, poblacion: 521559 }]);
});
after(() => srv && srv.close());

const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const LARGO = "https://www.google.com/maps/place/Estadio+ueno+Osvaldo+Dom%C3%ADnguez+Dibb/@-25.2908711,-57.6116634,16z/data=!4m6!3m5!1s0x945da7d7eaf51ba9:0x8521f3de87e1ad0c!8m2!3d-25.2916778!4d-57.6085796!16zL20vMGJfcXhu?entry=tts";

test("mapaurl: lee el punto del lugar (!3d!4d) antes que el centro del mapa, y también @lat,lng, q=, ll= y coordenadas sueltas", () => {
  assert.deepStrictEqual(mapaUrl.coordsDeTexto(LARGO), { lat: -25.2916778, lng: -57.6085796 });
  assert.deepStrictEqual(mapaUrl.coordsDeTexto("https://www.google.com/maps/@-25.3,-57.6,15z"), { lat: -25.3, lng: -57.6 });
  assert.deepStrictEqual(mapaUrl.coordsDeTexto("https://maps.google.com/?q=-25.31,-57.62"), { lat: -25.31, lng: -57.62 });
  assert.deepStrictEqual(mapaUrl.coordsDeTexto("https://maps.google.com/?ll=-25.31,-57.62&z=10"), { lat: -25.31, lng: -57.62 });
  assert.deepStrictEqual(mapaUrl.coordsDeTexto(" -25.29, -57.6 "), { lat: -25.29, lng: -57.6 });
  for (const mala of ["", "hola", "https://google.com/maps", "999.5,10.5", "0,0", "@95.5,10.5"]) assert.strictEqual(mapaUrl.coordsDeTexto(mala), null, mala);
});

test("mapaurl.resolver: sigue el link corto de Google (solo hosts de Google, pocos saltos) y no sale a ningún otro lado", async () => {
  const pedidos = [];
  const falso = async (u) => { pedidos.push(u); return { headers: { get: (h) => (h.toLowerCase() === "location" ? LARGO : null) } }; };
  assert.deepStrictEqual(await mapaUrl.resolver("https://maps.app.goo.gl/BmeQhyr1KQbBHKg37", falso), { lat: -25.2916778, lng: -57.6085796 });
  assert.deepStrictEqual(pedidos, ["https://maps.app.goo.gl/BmeQhyr1KQbBHKg37"]);
  // un host que no es de Google no se pide nunca (nada de usar el servidor para llegar a cualquier dirección)
  pedidos.length = 0;
  for (const mala of ["https://evil.example.com/x", "http://maps.app.goo.gl/x", "https://google.com.evil.example/x", "https://169.254.169.254/latest/meta-data", "ftp://goo.gl/x"]) assert.strictEqual(await mapaUrl.resolver(mala, falso), null, mala);
  assert.deepStrictEqual(pedidos, [], "no se hizo ningún pedido");
  // una redirección a otro host se corta
  const aOtro = async () => ({ headers: { get: () => "https://evil.example.com/" } });
  assert.strictEqual(await mapaUrl.resolver("https://goo.gl/maps/abc", aOtro), null);
  // sin fin: se rinde a los 4 saltos
  let n = 0; const infinito = async () => { n++; return { headers: { get: () => "https://goo.gl/maps/otra" + n } }; };
  assert.strictEqual(await mapaUrl.resolver("https://goo.gl/maps/inicio", infinito), null);
  assert.ok(n <= 4);
});

test("admin: un comercio se da de alta con su ubicación (link de Maps, o la de su ciudad) y la respuesta nunca trae el hash de la contraseña", async () => {
  const a = await (await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Café del Estadio", rubro: "Café", ciudad: "Asunción", estado: "activo", mapa_url: LARGO } })).json();
  assert.strictEqual(a.item.lat, -25.2916778);
  assert.strictEqual(a.item.lng, -57.6085796);
  const b = await (await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Librería Centro", ciudad: "asuncion", estado: "activo" } })).json();
  assert.ok(Math.abs(b.item.lat - -25.28646) < 1e-6, "sin link: la ubicación de su ciudad");
  const c = await (await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Sin Ubicación", ciudad: "Pueblo Inventado" } })).json();
  assert.ok(c.item.lat == null, "ciudad desconocida: queda sin ubicar");
  // acceso al portal y listado
  assert.strictEqual((await api(`/admin/comercios/${a.item.id}/acceso`, { metodo: "POST", h: OWNER, cuerpo: { usuario: "cafe.estadio", password: "clave-comercio-1" } })).status, 200);
  const lista = await (await api("/admin/comercios", { h: OWNER })).json();
  const fila = lista.items.find((x) => x.id === a.item.id);
  assert.strictEqual(fila.usuario, "cafe.estadio");
  assert.ok(lista.items.every((x) => !("password_hash" in x)), "el listado no trae hashes");
  const ed = await (await api(`/admin/comercios/${a.item.id}`, { metodo: "PATCH", h: OWNER, cuerpo: { rubro: "Cafetería" } })).json();
  assert.ok(!("password_hash" in ed.item), "ni al editar");
  assert.strictEqual(ed.item.lat, -25.2916778, "editar el rubro no pierde la ubicación");
});

test("admin: un link que no se puede leer da un error claro, y las coordenadas se validan", async () => {
  const r = await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "X Comercio", mapa_url: "https://evil.example.com/algo" } });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /ubicación de ese link/);
  const m = await (await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Manual", lat: "-25.5", lng: "-57.5" } })).json();
  assert.strictEqual(m.item.lat, -25.5);
  assert.strictEqual((await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Mala", lat: 123, lng: 5 } })).status, 400);
  assert.strictEqual((await api("/admin/comercios", { metodo: "POST" })).status, 401);
});

test("hincha: /beneficios trae la ubicación de cada comercio (para dibujarlo en el mapa)", async () => {
  const com = await (await api("/admin/comercios", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Heladería Mapa", ciudad: "Asunción", estado: "activo", mapa_url: LARGO } })).json();
  await store.crearBeneficio({ comercio_id: com.item.id, titulo: "15% en helados", valor: "15%", pct: 15, niveles: "todos", activo: true, estado: "aprobado" });
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `bm${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Mapa", apellido: "Prueba" } });
  const j = await r.json();
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  const b = await (await api("/beneficios", { h })).json();
  const mio = b.items.find((x) => x.comercio_nombre === "Heladería Mapa");
  assert.ok(mio, "el beneficio aparece");
  assert.strictEqual(mio.comercio_lat, -25.2916778);
  assert.strictEqual(mio.comercio_lng, -57.6085796);
  assert.ok(!("password_hash" in mio) && !JSON.stringify(mio).includes("cafe.estadio"), "nada del acceso del comercio");
});

test("front: el admin gestiona comercios (acceso y ubicación) y la app muestra el mapa de beneficios con Lista / Mapa", () => {
  const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");
  const a = leer("admin.html");
  assert.match(a, /<option value="comercios">Comercios<\/option>/);
  assert.match(a, /comercios: \{ t: "Comercios", comercio: true/);
  assert.match(a, /function accesoComercio\(id\)/);
  assert.match(a, /\/acceso", \{ method: "POST"/);
  assert.match(a, /mapa_url/);
  const s = leer("js/socio.js");
  assert.match(s, /function iniciarBeneficiosMapa\(items, TL\)/);
  assert.match(s, /class="ctl-seg-b" aria-checked="true" data-v="lista"/);
  assert.match(s, /ben-pin/);
  const i = leer("js/i18n.js");
  for (const k of ["m_ben_lista", "m_ben_mapa", "m_ben_cerca"]) assert.strictEqual((i.match(new RegExp(k + ":", "g")) || []).length, 2, k);
  assert.deepStrictEqual((leer("css/styles.css").match(/\.ben-pin[^{]*\{[^}]*(b08d2e|c9a227|oro)/gi) || []), [], "sin oro en las píldoras");
});
