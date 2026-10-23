"use strict";
// Panel del comercio "pro": lo de hoy en caja, resultado a pantalla completa, pestañas en el celular, ayuda y guía imprimible.
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
const carnetLib = require("../lib/carnet");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("/comercio/hoy: totales del día y últimos canjes con el nombre y la inicial del apellido (nada más del hincha)", async () => {
  const com = await store.crearComercio({ nombre: "Caja Hoy", estado: "activo" });
  await api(`/admin/comercios/${com.id}/acceso`, { metodo: "POST", cuerpo: { usuario: "cajahoy", password: "clave-comercio-1" }, h: OWNER });
  const login = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: "cajahoy", password: "clave-comercio-1" } })).json();
  const h = { "x-comercio-token": login.token };
  const vacio = await (await api("/comercio/hoy", { h })).json();
  assert.strictEqual(vacio.canjes, 0);
  assert.deepStrictEqual(vacio.ultimos, []);
  const ben = await store.crearBeneficio({ comercio_id: com.id, titulo: "Todos los días", valor: "10%", niveles: "todos", pct: 10 });
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `ch-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Marta Lucía", apellido: "González Pérez" } })).json();
  await store.registrarCanje({ beneficioId: ben.id, socioId: j.socio.id, comercioId: com.id, monto: 200000, ahorro: 20000 });
  await store.registrarCanje({ beneficioId: ben.id, socioId: j.socio.id, comercioId: com.id, monto: 100000, ahorro: 10000 });
  const hoy = await (await api("/comercio/hoy", { h })).json();
  assert.strictEqual(hoy.canjes, 2);
  assert.strictEqual(hoy.ahorro, 30000);
  assert.strictEqual(hoy.ventas, 300000);
  assert.strictEqual(hoy.ultimos.length, 2);
  assert.strictEqual(hoy.ultimos[0].socio, "Marta G.");
  assert.match(hoy.ultimos[0].hora, /^\d{2}:\d{2}$/);
  assert.deepStrictEqual(Object.keys(hoy.ultimos[0]).sort(), ["ahorro", "beneficio", "hora", "monto", "socio"]);
  assert.ok(!JSON.stringify(hoy).includes("ejemplo.com") && !JSON.stringify(hoy).includes("Pérez"), "ni correo ni apellido completo");
  assert.strictEqual((await api("/comercio/hoy")).status, 401);
  // lo de otro comercio no se mezcla
  const otro = await store.crearComercio({ nombre: "Otra Caja", estado: "activo" });
  await api(`/admin/comercios/${otro.id}/acceso`, { metodo: "POST", cuerpo: { usuario: "otracaja", password: "clave-comercio-2" }, h: OWNER });
  const l2 = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: "otracaja", password: "clave-comercio-2" } })).json();
  assert.strictEqual((await (await api("/comercio/hoy", { h: { "x-comercio-token": l2.token } })).json()).canjes, 0);
});

test("la página del comercio: caja grande, pestañas, resultado a pantalla completa, Hoy y ayuda; el paso del monto sigue", () => {
  const c = leer("comercio.html");
  for (const id of ['id="vValidar"', 'id="vMi"', 'id="vAyuda"', 'id="tabs"', 'id="resOv"', 'id="hoyKpis"', 'id="ultimos"', 'id="pasoMonto"', 'class="com-mas"', "com-escanear"]) assert.ok(c.includes(id), id);
  assert.match(c, /function mostrarResultado\(ok, d\)/);
  assert.match(c, /function cargarHoy\(\)|async function cargarHoy\(\)/);
  assert.match(c, /\/comercio\/hoy/);
  assert.match(c, /grid-template-columns: minmax\(380px, 460px\) minmax\(0, 1fr\)/);
  assert.match(c, /\.com-tabs \{ display: none !important; \}/);
  assert.ok(!/class="com-res (ok|no)"/.test(c), "el resultado ya no es una tarjeta chica dentro del formulario");
});

test("guía de una página para el cajero: se sirve en /guia-comercio y se imprime sin CSP en línea", async () => {
  const r = await fetch(url + "/guia-comercio");
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.match(html, /Cómo canjear un beneficio en caja/);
  assert.match(html, /@page \{ size: A4/);
  assert.ok(!/\sonclick=/.test(html), "la CSP del sitio bloquea los manejadores en línea");
  assert.match(leer("comercio.html"), /href="\/guia-comercio"/);
});
