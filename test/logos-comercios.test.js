"use strict";
// Logos de los comercios de la Red de Beneficios: archivos livianos en public/assets/comercios, asignados a su comercio (sin pisar uno
// ya cargado) y mostrados sobre un recuadro negro (los logos vienen en blanco).
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
const { BENEFICIOS_MUESTRA } = require("../data/beneficios-muestra");
const { cargarMuestra } = require("../lib/beneficios-muestra");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const DIR = path.join(__dirname, "..", "public", "assets", "comercios");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("los logos recibidos están como WebP livianos y la muestra los toma por el nombre del comercio", () => {
  const archivos = fs.readdirSync(DIR).filter((f) => f.endsWith(".webp"));
  assert.ok(archivos.length >= 14, "hay al menos los 14 logos recibidos (" + archivos.length + ")");
  for (const f of archivos) {
    const b = fs.readFileSync(path.join(DIR, f));
    assert.strictEqual(b.slice(0, 4).toString(), "RIFF", f + " es WebP");
    assert.ok(b.length < 40 * 1024, f + " pesa " + Math.round(b.length / 1024) + " KB: demasiado para un logo");
  }
  const con = BENEFICIOS_MUESTRA.filter((x) => x.comercio.logo);
  assert.strictEqual(con.length, archivos.length, "cada archivo corresponde a un comercio de la muestra");
  assert.ok(con.every((x) => fs.existsSync(path.join(DIR, path.basename(x.comercio.logo)))));
  const sup = BENEFICIOS_MUESTRA.find((x) => x.comercio.nombre === "Superseis");
  assert.strictEqual(sup.comercio.logo, "/assets/comercios/superseis.webp");
  assert.strictEqual(BENEFICIOS_MUESTRA.find((x) => x.comercio.nombre === "Santorini Café Bar").comercio.logo, "/assets/comercios/santorini-cafe-bar.webp");
  assert.strictEqual(BENEFICIOS_MUESTRA.find((x) => x.comercio.nombre === "Liberato").comercio.logo, "", "sin archivo, sin logo");
});

test("cargar la muestra asigna el logo; en los que ya existían sin logo lo completa y nunca pisa uno cargado a mano", async () => {
  const propio = await store.crearComercio({ nombre: "Superseis", estado: "activo", logo: "/assets/otro-logo-del-admin.png" });
  const sinLogo = await store.crearComercio({ nombre: "DHL", estado: "activo" });
  const r = await cargarMuestra(store);
  assert.strictEqual(r.comercios_existentes, 2);
  assert.strictEqual(r.logos_asignados, 1, "solo DHL: Superseis ya tenía uno del admin, y los comercios nuevos nacen con su logo");
  assert.strictEqual((await store.listComercios()).filter((c) => String(c.logo || "").startsWith("/assets/comercios/")).length, 13, "13 de la muestra (14 menos el de Superseis, que conserva el suyo)");
  assert.strictEqual((await store.listComercios()).find((c) => c.id === propio.id).logo, "/assets/otro-logo-del-admin.png");
  assert.strictEqual((await store.listComercios()).find((c) => c.id === sinLogo.id).logo, "/assets/comercios/dhl.webp");
  assert.strictEqual((await cargarMuestra(store)).logos_asignados, 0, "idempotente");
});

test("el servidor entrega los logos como imagen y la pantalla los muestra sobre recuadro negro", async () => {
  const r = await fetch(url + "/assets/comercios/muar.webp");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/webp/);
  const s = leer("public", "js", "socio.js");
  assert.match(s, /comercio_logo/);
  assert.match(s, /bx-ban-logo/);
  const c = leer("public", "css", "styles.css");
  assert.match(c, /\.bx-logo \{[^}]*background: #0a0a0a/);
  assert.match(c, /\.bx-ban-logo \{/);
});
