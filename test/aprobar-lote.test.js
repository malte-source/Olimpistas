"use strict";
// Aprobar varias ofertas de comercios de una vez desde el panel: se marcan, se confirma una sola vez y cada comercio recibe su correo; rechazar sigue siendo de a una.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const mailer = require("../lib/email");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const ADM = { "x-admin-key": "clave-admin-de-prueba", "Content-Type": "application/json" };

test("aprobar varias ofertas seguidas las publica todas y avisa a cada comercio una vez (lo que hace el botón del panel)", async () => {
  const avisos = [];
  mailer.enviarOfertaAprobada = async (d, x) => { avisos.push([d.email, x.titulo]); return { ok: true }; };
  const a = await store.crearComercio({ nombre: "Lote A", ciudad: "Asunción", contacto: "lote-a@ejemplo.com" }), b = await store.crearComercio({ nombre: "Lote B", ciudad: "Luque", contacto: "lote-b@ejemplo.com" });
  const ofertas = [await store.crearBeneficioComercio({ comercioId: a.id, titulo: "Lote uno", valor: "10%", pct: 10, niveles: "todos" }), await store.crearBeneficioComercio({ comercioId: a.id, titulo: "Lote dos", valor: "15%", pct: 15, niveles: "premium" }), await store.crearBeneficioComercio({ comercioId: b.id, titulo: "Lote tres", valor: "2x1", niveles: "socio" })];
  assert.ok(ofertas.every((o) => o.estado === "borrador"));
  for (const o of ofertas) assert.strictEqual((await fetch(`${url}/api/admin/beneficios/${o.id}`, { method: "PATCH", headers: ADM, body: JSON.stringify({ estado: "aprobado" }) })).status, 200);
  await new Promise((x) => setTimeout(x, 40));
  const d = await (await fetch(url + "/api/admin/beneficios", { headers: ADM })).json();
  for (const o of ofertas) assert.strictEqual(d.items.find((x) => x.id === o.id).estado, "aprobado");
  assert.deepStrictEqual(avisos.map((v) => v[1]).sort(), ["Lote dos", "Lote tres", "Lote uno"], "cada oferta avisó a su comercio");
  assert.strictEqual(avisos.filter((v) => v[0] === "lote-a@ejemplo.com").length, 2);
});

test("el panel permite marcar ofertas, seleccionar todas y aprobar las marcadas con una sola confirmación (hasta 50); rechazar sigue de a una", () => {
  const a = leer("public", "admin.html");
  assert.ok(/class="of-sel" data-ofsel=/.test(a) && /id="ofTodas"/.test(a) && /id="ofAprobarSel"/.test(a) && /id="ofLoteMsg"/.test(a));
  assert.ok(/pend\.length > 1 && w \?/.test(a), "la barra solo aparece con permiso de escritura y si hay más de una");
  assert.ok(/ofSeleccionadas\(\)\.slice\(0, 50\)/.test(a), "tope de 50 por vez");
  assert.ok(/await confirmar\("Se publican " \+ ids\.length \+ " ofertas/.test(a) && /Aprobar " \+ ids\.length \+ " ofertas/.test(a), "una sola confirmación");
  assert.ok(/ofTodas"\)\.indeterminate|todas\.indeterminate = n > 0 && n < total/.test(a), "estado intermedio de 'seleccionar todas'");
  assert.ok(/data-ofrec="' \+ esc\(b\.id\) \+ '">Rechazar/.test(a), "rechazar sigue por oferta: pide un motivo");
  assert.ok(/aria-label="Seleccionar ' \+ esc\(b\.titulo\)/.test(a), "cada casilla tiene nombre accesible");
});
