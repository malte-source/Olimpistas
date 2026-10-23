"use strict";
// Beneficios de muestra del club: todos exclusivos para socios, sin datos de las empresas, idempotentes, y un hincha que no es socio
// los ve bloqueados mientras un socio los puede usar.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const { BENEFICIOS_MUESTRA } = require("../data/beneficios-muestra");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function hincha(tier) {
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `bm${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Ben", apellido: "Muestra" } })).json();
  if (tier) await store.setMembresia(j.socio.id, { tierSlug: tier, ciclo: "anio", pagoRef: "socio:test" });
  return { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
}

test("los datos: 28 comercios, todos 'socio', con descuento y cómo acceder, y sin datos de las empresas", () => {
  assert.strictEqual(BENEFICIOS_MUESTRA.length, 28);
  const nombres = new Set(BENEFICIOS_MUESTRA.map((x) => x.comercio.nombre));
  assert.strictEqual(nombres.size, 28, "sin marcas repetidas");
  for (const { comercio, beneficio } of BENEFICIOS_MUESTRA) {
    assert.strictEqual(beneficio.niveles, "socio", comercio.nombre);
    assert.ok(beneficio.valor && beneficio.titulo && /Cómo acceder:/.test(beneficio.descripcion), comercio.nombre);
    assert.ok(Number.isInteger(beneficio.pct) && beneficio.pct > 0 && beneficio.pct <= 50, comercio.nombre);
  }
  const todo = JSON.stringify(BENEFICIOS_MUESTRA);
  assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(todo), "ni un correo");
  assert.ok(!/\bRUC\b|\bC\.?I\.?\b\s*[:Nº]/i.test(todo), "ni RUC ni cédulas de representantes");
});

test("admin: cargar la muestra crea comercios y beneficios aprobados; correrla de nuevo no duplica nada", async () => {
  assert.strictEqual((await api("/admin/beneficios/muestra", { metodo: "POST" })).status, 401);
  const a = await (await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER })).json();
  assert.strictEqual(a.beneficios_creados, 28);
  assert.strictEqual(a.comercios_creados, 28);
  const b = await (await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER })).json();
  assert.strictEqual(b.beneficios_creados, 0);
  assert.strictEqual(b.beneficios_existentes, 28);
  const lista = (await store.listBeneficios()).filter((x) => x.niveles === "socio");
  assert.strictEqual(lista.length, 28);
  assert.ok(lista.every((x) => x.estado === "aprobado" && x.activo));
});

test("un hincha común y Plus los ven bloqueados; un Socio los puede usar", async () => {
  await api("/admin/beneficios/muestra", { metodo: "POST", h: OWNER });
  const comun = await (await api("/beneficios", { h: await hincha() })).json();
  const plus = await (await api("/beneficios", { h: await hincha("premium") })).json();
  const socio = await (await api("/beneficios", { h: await hincha("socio") })).json();
  const ver = (j) => j.items.filter((x) => x.niveles === "socio");
  assert.strictEqual(ver(comun).length, 28);
  assert.ok(ver(comun).every((x) => x.desbloqueado === false));
  assert.ok(ver(plus).every((x) => x.desbloqueado === false), "Plus tampoco: es solo para socios");
  assert.ok(ver(socio).every((x) => x.desbloqueado === true));
  const sup = ver(socio).find((x) => x.comercio_nombre === "Superseis");
  assert.strictEqual(sup.valor, "10%");
  assert.match(sup.descripcion, /Tope mensual/);
  assert.strictEqual(sup.nivel_min, "socio");
});
