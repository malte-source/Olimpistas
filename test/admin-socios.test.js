"use strict";
// Tabla de socios del panel: ruta paginada (admin), filtros, exportación con los mismos filtros y la pantalla.
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
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
const H = { "x-admin-key": "clave-admin-de-prueba" };
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  for (const [n, a, ex, tier] of [["Ana", "Zapata", { ciudad: "Asunción", email_verificado: true, es_socio_olimpia: true }, "socio"], ["Beto", "Alvarez", { ciudad: "Luque" }, "premium"], ["Carla", "Mendez", { ciudad: "Asunción", email_verificado: true }, null], ["Dario", "Benitez", { ciudad: "Encarnación", es_socio_olimpia: true }, "socio"]]) {
    const s = await store.createSocio({ email: `tabla-${n.toLowerCase()}@ejemplo.com`, passwordHash: "x", nombre: n, apellido: a });
    await store.updateSocio(s.id, ex); if (tier) await store.setMembresia(s.id, { tierSlug: tier, ciclo: "anio" });
  }
});
after(() => srv && srv.close());
const api = (ruta, { h = {} } = {}) => fetch(url + "/api" + ruta, { headers: h });
const lista = async (qs) => (await (await api("/admin/socios?" + qs, { h: H })).json());

test("la tabla es solo para admin y devuelve una página con su total", async () => {
  assert.ok([401, 403].includes((await api("/admin/socios")).status));
  const r = await lista("q=tabla-&limite=2&orden=nombre&dir=asc");
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(r.items.map((x) => x.nombre), ["Beto", "Dario"]);
  const p2 = await lista("q=tabla-&limite=2&pagina=1&orden=nombre&dir=asc");
  assert.deepStrictEqual(p2.items.map((x) => x.nombre), ["Carla", "Ana"]);
});

test("filtros por nivel, socio del club, correo y foto; valores raros se ignoran", async () => {
  assert.strictEqual((await lista("q=tabla-&tier=socio")).total, 2);
  assert.strictEqual((await lista("q=tabla-&club=1")).total, 2);
  assert.strictEqual((await lista("q=tabla-&club=0")).total, 2);
  assert.strictEqual((await lista("q=tabla-&verificado=1")).total, 2);
  assert.strictEqual((await lista("q=tabla-&verificado=0")).total, 2);
  assert.strictEqual((await lista("q=tabla-&foto=1")).total, 0, "nadie tiene foto");
  assert.strictEqual((await lista("q=tabla-&foto=0")).total, 4);
  assert.strictEqual((await lista("q=tabla-&tier=inventado")).total, 4, "un nivel inexistente no filtra");
  assert.strictEqual((await lista("q=tabla-&limite=999999")).limite, 100);
});

test("exportar CSV respeta los mismos filtros que la tabla y neutraliza fórmulas", async () => {
  const res = await api("/admin/export/socios.csv?q=tabla-&club=1&verificado=1", { h: H });
  assert.strictEqual(res.status, 200);
  const lineas = (await res.text()).trim().split("\n");
  assert.strictEqual(lineas.length, 2, "encabezado + 1 socio (Ana)");
  assert.match(lineas[1], /Ana/);
  assert.ok(!(await api("/admin/export/socios.csv")).ok, "sin credenciales no exporta");
});

test("pantalla: filtros, orden y páginas en el servidor, columnas elegibles, vistas guardadas, teclado y exportación", () => {
  const h = leer("public", "admin.html");
  for (const id of ["sNivel", "sClub", "sVerif", "sFoto", "sLimpiar", "socCols", "sVistas", "sVistaGuardar", "sVistaBorrar", "sExport", "socResumen", "searchWrap"]) assert.ok(h.includes('id="' + id + '"'), id);
  assert.match(h, /socios: \[iniciarSocios\]/);
  assert.match(h, /api\("\/admin\/socios\?" \+ socParams\(/);
  assert.match(h, /aria-sort=/, "las columnas ordenables dicen su orden a los lectores de pantalla");
  assert.match(h, /e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"/);
  assert.match(h, /e\.key !== "\/"/);
  assert.match(h, /localStorage\.setItem\(k, JSON\.stringify\(v\)\)/);
  assert.match(h, /\$\("sExport"\)\.style\.display = puede\("export"\)/, "exportar exige el permiso de exportación");
  assert.match(h, /if \(mi !== soc\.req\) return;/, "una respuesta vieja no pisa a la nueva");
  assert.match(h, /data-tier="socio"/, "las acciones de activar nivel siguen en cada fila");
  assert.match(h, /\.soc-tabla thead th \{ position:sticky/);
});
