"use strict";
// Mapa en el panel del club (solo totales) y "Compartir mi bandera" (cifras reales de tu ciudad y tu país).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ciudades = require("../lib/ciudades");
const adminAuth = require("../lib/admin-auth");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
const C1 = 880001, C2 = 880002, C3 = 880003;
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  const c = (id, nombre, lat, lng) => ({ id, nombre, nombre_norm: ciudades.norm(nombre), pais_iso: "PY", lat, lng, poblacion: 1000 });
  await store.importarCiudades([c(C1, "Ciudad Mapa Uno", -25.3, -57.6), c(C2, "Ciudad Mapa Dos", -27.3, -55.8), c(C3, "Ciudad Mapa Tres", -22.5, -55.7)]);
});
after(() => srv && srv.close());

const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function hincha(extra = {}) {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `mp${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Mapa", apellido: "Panel" } });
  const j = await r.json();
  if (Object.keys(extra).length) await store.updateSocio(j.socio.id, extra);
  return { id: j.socio.id, h: { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token } };
}

test("admin/mapa: hinchas y conversión por ciudad, solo totales (ni emails ni nombres ni casas)", async () => {
  const a = await hincha({ ciudad_id: C1, pais_iso: "PY", pais: "Paraguay", ciudad: "Ciudad Mapa Uno" });
  await hincha({ ciudad_id: C1, pais_iso: "PY" }); await hincha({ ciudad_id: C1, pais_iso: "PY" });
  await store.setMembresia(a.id, { tierSlug: "premium", ciclo: "anio" });
  await hincha({ ciudad_id: C2, pais_iso: "PY" });
  await hincha({}); // sin ciudad oficial: no se dibuja
  const demo = await store.createSocio({ email: `d${Date.now()}@demo.olimpistas.test`, passwordHash: "x", nombre: "Demo" });
  await store.updateSocio(demo.id, { ciudad_id: C1 });
  const j = await (await api("/admin/mapa?capa=ciudades", { h: OWNER })).json();
  const uno = j.items.find((x) => x.id === C1), dos = j.items.find((x) => x.id === C2);
  assert.strictEqual(uno.total, 3, "la fila de demo no cuenta");
  assert.strictEqual(uno.plus, 1);
  assert.strictEqual(dos.total, 1);
  assert.deepStrictEqual(Object.keys(uno).sort(), ["id", "lat", "lng", "nombre", "pais_iso", "plus", "socios", "total"]);
  assert.ok(!/@ejemplo|Mapa Panel|Mapa/.test(JSON.stringify(j.items.filter((x) => x.id === C1).map(({ nombre, ...r }) => r))), "nada personal");
  const p = await (await api("/admin/mapa?capa=plus", { h: OWNER })).json();
  assert.strictEqual(p.capa, "plus");
  assert.strictEqual(p.items.find((x) => x.id === C1).total, 3);
});

test("admin/mapa: peñas y comercios ubicados, con sus números; capa inválida da 400; sin sesión no entra", async () => {
  const pena = await store.crearPena({ nombre: "Peña Mapa Panel", ciudad: "X", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" });
  await store.updatePena(pena.id, { estado: "verificada", lat: -25.3, lng: -57.6 });
  const sinUbic = await store.crearPena({ nombre: "Peña Sin Ubicación Panel", ciudad: "X", pais_iso: "PY", presidente: "P", contacto: "q@ejemplo.com" });
  await store.updatePena(sinUbic.id, { estado: "verificada" });
  const pj = await (await api("/admin/mapa?capa=penas", { h: OWNER })).json();
  assert.ok(pj.items.some((x) => x.nombre === "Peña Mapa Panel" && x.lat === -25.3));
  assert.ok(!pj.items.some((x) => x.nombre === "Peña Sin Ubicación Panel"), "la que no tiene ubicación no se dibuja");
  assert.ok(!JSON.stringify(pj).includes("p@ejemplo.com"), "ni el contacto ni el presidente");
  const com = await store.crearComercio({ nombre: "Comercio Mapa Panel", ciudad: "X", estado: "activo", lat: -25.31, lng: -57.61 });
  const alumno = await hincha({});
  await store.registrarCanje({ beneficioId: "ben_x", socioId: alumno.id, comercioId: com.id, monto: 100000, ahorro: 10000 });
  await store.registrarCanje({ beneficioId: "ben_x", socioId: alumno.id, comercioId: com.id, monto: 50000, ahorro: 5000 });
  const cj = await (await api("/admin/mapa?capa=comercios", { h: OWNER })).json();
  const fila = cj.items.find((x) => x.nombre === "Comercio Mapa Panel");
  assert.strictEqual(fila.canjes, 2);
  assert.strictEqual(fila.ahorro, 15000);
  assert.deepStrictEqual(Object.keys(fila).sort(), ["ahorro", "canjes", "ciudad", "estado", "id", "lat", "lng", "nombre", "rubro"]);
  assert.strictEqual((await api("/admin/mapa?capa=raro", { h: OWNER })).status, 400);
  assert.strictEqual((await api("/admin/mapa")).status, 401);
});

test("admin/mapa: lo ven los roles que ven el tablero (incluida la CD, que no ve datos personales)", async () => {
  for (const rol of ["cd", "marketing", "lectura"]) {
    const u = `mapa-${rol}-${++n}@ejemplo.com`;
    await adminAuth.crearAdminUsuario({ usuario: u, nombre: u, password: "clave-de-prueba-1", rol });
    const s = await (await api("/admin/login", { metodo: "POST", cuerpo: { usuario: u, password: "clave-de-prueba-1" } })).json();
    const r = await api("/admin/mapa?capa=ciudades", { h: { "x-admin-token": s.token } });
    assert.strictEqual(r.status, 200, rol);
  }
});

test("Compartir mi bandera: /perfil/mapa cuenta olimpistas REALES de tu ciudad y de tu país (sin demo) y exige sesión", async () => {
  const yo = await hincha({ ciudad_id: C3, ciudad: "Ciudad Mapa Tres", pais_iso: "PY", pais: "Paraguay", nombre: "Marta" });
  await hincha({ ciudad_id: C3, pais_iso: "PY" });
  const demo = await store.createSocio({ email: `d2${Date.now()}@demo.olimpistas.test`, passwordHash: "x", nombre: "Demo" });
  await store.updateSocio(demo.id, { ciudad_id: C3, pais_iso: "PY" });
  const j = await (await api("/perfil/mapa", { h: yo.h })).json();
  assert.strictEqual(j.ciudad, "Ciudad Mapa Tres");
  assert.strictEqual(j.ciudad_n, 2, "yo y uno más; el demo no cuenta");
  assert.strictEqual(j.iso, "PY");
  assert.ok(j.pais_n >= 2);
  assert.deepStrictEqual(Object.keys(j).sort(), ["ciudad", "ciudad_n", "iso", "nombre", "pais", "pais_n"]);
  assert.strictEqual((await api("/perfil/mapa")).status, 401);
  const sin = await hincha({});
  const k = await (await api("/perfil/mapa", { h: sin.h })).json();
  assert.strictEqual(k.ciudad_n, 0, "sin ciudad oficial no hay cifra");
});

test("front: la gráfica 'Mi bandera' (sin oro ni emojis), el botón del perfil y el mapa del tablero", () => {
  const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");
  const c = leer("js/common.js");
  assert.match(c, /async function storyMapaImagen\(o\)/);
  assert.match(c, /tipo === "mapa"/);
  const antes = c.indexOf("async function storyImagen"), despues = c.indexOf("async function compartirStory");
  const cuerpo = c.slice(antes, despues);
  assert.deepStrictEqual((cuerpo.match(/b08d2e|d9b65a/gi) || []), [], "las gráficas de story ya no usan oro");
  assert.ok(!/\p{Extended_Pictographic}/u.test(cuerpo), "ni emojis dibujados");
  assert.match(leer("js/socio.js"), /btnStoryMapa/);
  assert.match(leer("js/socio.js"), /api\("\/perfil\/mapa"\)/);
  const i = leer("js/i18n.js");
  for (const k of ["m_story_mapa", "m_story_mapa_cap", "m_story_mapa_cap0"]) assert.strictEqual((i.match(new RegExp(k + ":", "g")) || []).length, 2, k);
  const a = leer("admin.html");
  assert.match(a, /id="admMapa"/);
  assert.match(a, /async function cargarMapaAdmin\(\)/);
  assert.match(a, /dashboard: \[cargarTablero, cargarSalud, cargarReportes, cargarRevCount, cargarMapaAdmin\]/);
});
