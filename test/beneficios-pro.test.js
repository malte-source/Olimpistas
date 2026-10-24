"use strict";
// Red de Beneficios "pro": destacados que elige el admin, texto del beneficio ordenado en líneas, canje siempre con el carnet de
// Olimpistas, actualización de la muestra, y que la pantalla tenga buscador, rubros, orden, disponibilidad y dos columnas en escritorio.
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
const { BENEFICIOS_MUESTRA } = require("../data/beneficios-muestra");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("la muestra: una línea por dato y el canje es con el carnet de Olimpistas (salvo Petrosur y G5 PRO, que tienen canal propio)", () => {
  for (const { comercio, beneficio } of BENEFICIOS_MUESTRA) {
    const l = beneficio.descripcion.split("\n");
    assert.strictEqual(l.length, 4, comercio.nombre);
    assert.deepStrictEqual(l.map((x) => x.split(": ")[0]), ["Dónde", "Incluye", "Cómo acceder", "Importante"], comercio.nombre);
    const acceso = l[2];
    if (["Petrosur", "G5 PRO"].includes(comercio.nombre)) assert.match(acceso, /cédula/, comercio.nombre);
    else {
      assert.match(acceso, /carnet de Olimpistas/, comercio.nombre);
      assert.ok(!/cédula|Portal de Socios/.test(acceso), comercio.nombre + ": ya no se canjea con cédula ni con el portal");
    }
  }
});

test("admin: destacar y quitar de destacados; el socio recibe la marca; sin permiso no se puede", async () => {
  await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER });
  const lista = await store.listBeneficios();
  const elegido = lista.find((b) => b.titulo === "Jueves a sábados");
  assert.strictEqual((await api(`/admin/beneficios/${elegido.id}/destacar`, { metodo: "POST", cuerpo: { destacado: true } })).status, 401);
  const r = await (await api(`/admin/beneficios/${elegido.id}/destacar`, { metodo: "POST", cuerpo: { destacado: true }, h: OWNER })).json();
  assert.strictEqual(r.item.destacado, true);
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `bp-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Pro", apellido: "Ben" } })).json();
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  const ben = await (await api("/beneficios", { h })).json();
  assert.strictEqual(ben.items.filter((x) => x.destacado).length, 1);
  assert.strictEqual((await api(`/admin/beneficios/${elegido.id}/destacar`, { metodo: "POST", cuerpo: { destacado: false }, h: OWNER })).status, 200);
  assert.strictEqual((await (await api("/beneficios", { h })).json()).items.filter((x) => x.destacado).length, 0);
  assert.strictEqual((await api("/admin/beneficios/no-existe/destacar", { metodo: "POST", cuerpo: { destacado: true }, h: OWNER })).status, 404);
});

test("cargar la muestra con ?actualizar=1 corrige el texto de los que ya existen sin duplicar", async () => {
  await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER });
  const b = (await store.listBeneficios()).find((x) => x.titulo === "Todos los días del año");
  await store.updateBeneficio(b.id, { descripcion: "texto viejo", valor: "99%" });
  const sin = await (await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER })).json();
  assert.strictEqual(sin.beneficios_actualizados, 0);
  assert.strictEqual((await store.listBeneficios()).find((x) => x.id === b.id).descripcion, "texto viejo", "por defecto no pisa");
  const con = await (await api("/admin/beneficios/muestra?actualizar=1", { metodo: "POST", h: OWNER })).json();
  assert.strictEqual(con.beneficios_actualizados, 28);
  assert.strictEqual(con.beneficios_creados, 0);
  const luego = (await store.listBeneficios()).find((x) => x.id === b.id);
  assert.match(luego.descripcion, /^Dónde: /);
  assert.strictEqual(luego.valor, "10%");
});

test("pantalla: destacados, buscador, rubros, orden, disponibilidad, hoja estructurada y dos columnas en escritorio", () => {
  const s = leer("js/socio.js");
  const v = s.slice(s.indexOf("async function vBeneficios()"), s.indexOf("function abrirBeneficio("));
  for (const id of ['class="bx-hero"', 'id="bxQ"', 'id="bxChips"', 'id="bxOrden"', 'id="bxDisp"', 'id="bxVista"', 'class="bx-side"', 'class="bx-up"', 'class="bx-guia"']) assert.ok(v.includes(id), id);
  assert.match(v, /x\.destacado/);
  assert.match(v, /querySelector\("\.bx"\)\.addEventListener/, "el clic se engancha al contenedor de esta pantalla (no se acumula en #view)");
  const h = s.slice(s.indexOf("function abrirBeneficio("), s.indexOf("function abrirBeneficio(") + 4200);
  assert.match(h, /bx-dl/);
  assert.match(h, /m_ben_mostrar_qr/, "el desbloqueado siempre muestra el QR");
  const c = leer("css/styles.css");
  assert.match(c, /@media \(min-width: 1200px\) \{\s*\.bx \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 320px/);
  assert.match(c, /\.bx-main, \.bx-side \{ display: contents; \}/);
  const i = leer("js/i18n.js");
  for (const k of ["bx_destacados", "bx_buscar", "bx_o_desc", "bx_g2", "bx_up_h", "bx_l_acceso", "bx_vacio", "bx_limpiar"]) assert.ok(i.split(" " + k + ": ").length - 1 >= 2, k);
});
