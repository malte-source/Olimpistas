"use strict";
// Promociones del comercio: formulario rápido con vista previa, días en texto natural, y el flujo de aprobación de siempre.
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

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const html = fs.readFileSync(path.join(__dirname, "..", "public", "comercio.html"), "utf8");

test("días en texto natural: el formulario genera 'Lunes a viernes', 'Jueves a sábados', 'Todos los domingos'… y los vuelve a leer al editar", () => {
  const src = html.slice(html.indexOf('var DIAS = ["Lunes"'), html.indexOf("function valorActual()"));
  const { diasTexto, parseDias } = new Function(src + "; return { diasTexto: diasTexto, parseDias: parseDias };")();
  assert.strictEqual(diasTexto([0, 1, 2, 3, 4, 5, 6]), "Todos los días");
  assert.strictEqual(diasTexto([0, 1, 2, 3, 4]), "Lunes a viernes");
  assert.strictEqual(diasTexto([3, 4, 5]), "Jueves a sábados");
  assert.strictEqual(diasTexto([0, 1]), "Lunes y martes");
  assert.strictEqual(diasTexto([6]), "Todos los domingos");
  assert.strictEqual(diasTexto([3]), "Todos los jueves");
  assert.strictEqual(diasTexto([5, 6]), "Sábado y domingo");
  assert.strictEqual(diasTexto([3, 5, 6]), "Jueves, sábado y domingo");
  assert.strictEqual(diasTexto([0, 2]), "Lunes y miércoles");
  assert.strictEqual(diasTexto([]), "");
  for (const sel of [[0, 1, 2, 3, 4], [3, 4, 5], [6], [3, 5, 6], [0, 2], [0, 1, 2, 3, 4, 5, 6]]) assert.deepStrictEqual(parseDias(diasTexto(sel)), sel.slice().sort((a, b) => a - b));
  assert.strictEqual(parseDias("Todos los días del año"), null, "un título libre no se interpreta");
});

test("la página: pestaña de Promos, hoja con vista previa en vivo, tipos, porcentajes, días, para quién, duplicar y pausar", () => {
  for (const id of ['id="vPromo"', 'id="promoNueva"', 'id="promoSheet"', 'id="psPrev"', 'id="psTipo"', 'id="psPcts"', 'id="psDias"', 'id="psPara"', 'id="psEnviar"', 'id="psOk"', 'data-vista="promo"']) assert.ok(html.includes(id), id);
  for (const fn of ["function abrirPromo(", "function cardOferta(", "function diasTexto(", "async function cargarPromos()"]) assert.ok(html.includes(fn), fn);
  assert.match(html, /data-dup=/);
  assert.match(html, /data-pausa=/);
  assert.match(html, /grid-template-areas: "caja promo" "caja mi" "caja ayuda"/);
  assert.ok(!html.includes('id="ofEnviar"'), "el formulario viejo ya no está");
});

test("flujo: el comercio carga una promoción con detalle completo → queda en revisión con su estructura; el club la publica; editar la devuelve a revisión", async () => {
  const com = await store.crearComercio({ nombre: "Promos " + Date.now().toString(36), rubro: "Moda", ciudad: "Asunción", direccion: "Av. Test 123", estado: "activo", logo: "/assets/comercios/dhl.webp" });
  await api(`/admin/comercios/${com.id}/acceso`, { metodo: "POST", cuerpo: { usuario: "promos" + com.id.slice(-5), password: "clave-comercio-1" }, h: OWNER });
  const login = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario: "promos" + com.id.slice(-5), password: "clave-comercio-1" } })).json();
  const h = { "x-comercio-token": login.token };
  const info = await (await api("/comercio/beneficios", { h })).json();
  assert.deepStrictEqual(Object.keys(info.comercio).sort(), ["ciudad", "direccion", "id", "logo", "nombre", "rubro"], "datos públicos para la vista previa, nada de credenciales");
  assert.strictEqual(info.comercio.logo, "/assets/comercios/dhl.webp");

  const descripcion = ["Dónde: Av. Test 123", "Incluye: " + "Todos los productos de la tienda. ".repeat(4).trim(), "Cómo acceder: Mostrá tu carnet de Olimpistas (el QR cambia cada minuto): el comercio lo escanea y te aplica el descuento", "Importante: No acumulable con otras promociones"].join("\n");
  assert.ok(descripcion.length > 300 && descripcion.length < 1000);
  const c = await api("/comercio/beneficios", { metodo: "POST", cuerpo: { titulo: "Jueves a sábados", valor: "25%", para: "socio", descripcion, stock: 50, vigencia_hasta: "2027-01-31" }, h });
  assert.strictEqual(c.status, 201);
  const oferta = (await c.json()).oferta;
  assert.strictEqual(oferta.estado, "borrador");
  assert.strictEqual(oferta.pct, 25);
  assert.strictEqual(oferta.descripcion, descripcion, "la descripción larga y con renglones se guarda completa");
  assert.strictEqual(oferta.niveles, "socio");

  assert.strictEqual((await api(`/admin/beneficios/${oferta.id}`, { metodo: "PATCH", cuerpo: { estado: "aprobado" }, h: OWNER })).status, 200);
  const pausa = await (await api(`/comercio/beneficios/${oferta.id}`, { metodo: "PATCH", cuerpo: { activo: false }, h })).json();
  assert.strictEqual(pausa.oferta.activo, false);
  assert.strictEqual(pausa.vuelve_a_aprobacion, false, "pausar no vuelve a revisión");
  const ed = await (await api(`/comercio/beneficios/${oferta.id}`, { metodo: "PATCH", cuerpo: { valor: "30%", para: "plus" }, h })).json();
  assert.strictEqual(ed.vuelve_a_aprobacion, true);
  assert.strictEqual(ed.oferta.estado, "borrador");
  assert.strictEqual(ed.oferta.niveles, "premium,socio");
  // validaciones amigables
  assert.strictEqual((await api("/comercio/beneficios", { metodo: "POST", cuerpo: { titulo: "ab", valor: "10%" }, h })).status, 400);
  assert.strictEqual((await api("/comercio/beneficios", { metodo: "POST", cuerpo: { titulo: "Todos los días", valor: "" }, h })).status, 400);
});
