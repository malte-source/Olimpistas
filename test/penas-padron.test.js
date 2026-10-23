"use strict";
// Padrón de las peñas: del informe del club a peñas verificadas con su listado, sin crear cuentas de personas que no se registraron.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { armarPlan, aplicarPlan } = require("../lib/penas-padron");
const adminAuth = require("../lib/admin-auth");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
const sufijo = () => `${Date.now().toString(36)}${++n}`;
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("armarPlan: peñas en orden de aparición, estados, cédulas, repetidos y datos deducidos del nombre", () => {
  const filas = [
    ["Los Alfa", "Ana Pérez", "10", "1.234.567", "AL DÍA"],
    ["Los Alfa", "ANA PÉREZ", "10", "1234567", "AL DÍA"],                 // la misma fila repetida
    ["Los Alfa", "Beto Gómez", "", "1234567", "EN MORA"],                 // otra persona con una cédula ya usada en su peña
    ["Los Alfa", "Carla Díaz", "", "", "SIN DATO"],
    ["Los Beta", "Ana Pérez", "10", "1234567", "EN MORA"],                // la misma persona en una segunda peña
    ["Hernandarias (POH)", "Dora Ruiz", "5", "7654321", "al día"],
    ["", "Sin peña", "1", "111111", "AL DÍA"],
  ];
  const p = armarPlan(filas);
  assert.deepStrictEqual(p.penas.map((x) => x.nombre), ["Los Alfa", "Los Beta", "Hernandarias (POH)"]);
  const alfa = p.penas[0].miembros;
  assert.strictEqual(alfa.length, 3, "se descartó la fila repetida y se conservó a Beto");
  assert.strictEqual(alfa[0].cedula, "1234567");
  assert.strictEqual(alfa[0].estado_cuota, "al_dia");
  assert.strictEqual(alfa[1].cedula, "", "Beto queda sin cédula: no se lo vincula con la cuenta de otra persona");
  assert.strictEqual(alfa[1].estado_cuota, "en_mora");
  assert.strictEqual(alfa[2].estado_cuota, "sin_dato");
  assert.strictEqual(p.cedulaCompartida, 1);
  assert.strictEqual(p.repetidasEnOtraPena, 1);
  assert.strictEqual(p.descartadas, 2, "la fila repetida y la que no tiene peña");
  assert.strictEqual(p.penas[2].ciudad, "Hernandarias");
  assert.ok(alfa[0].orden < p.penas[1].miembros[0].orden, "la primera peña tiene el orden menor");
});

test("aplicarPlan: peñas VERIFICADAS, padrón cargado, cuentas vinculadas y la primera peña asignada; correrlo de nuevo no duplica nada", async () => {
  const s = sufijo();
  const A = "Alfa " + s, B = "Beta " + s;
  const ced = "9" + Date.now().toString().slice(-7), ced2 = "8" + Date.now().toString().slice(-7);
  const filas = [[A, "Ana Pérez", "10", ced, "AL DÍA"], [A, "Beto", "11", ced2, "EN MORA"], [B, "Ana Pérez", "10", ced, "EN MORA"], [B, "Carla", "12", "", "SIN DATO"]];
  const antes = (await store.listPenas()).length;
  const registrada = await store.createSocio({ email: `pp-${s}@ejemplo.com`, passwordHash: "x", nombre: "Ana" });
  await store.updateSocio(registrada.id, { cedula: ced });
  const plan = armarPlan(filas);
  const r1 = await aplicarPlan(store, plan, { fuente: "test" });
  assert.strictEqual(r1.penas_creadas, 2);
  assert.strictEqual(r1.miembros_nuevos, 4);
  assert.ok(r1.vinculados >= 2, "Ana figura en las dos peñas y se vincula en ambas");
  assert.ok(r1.asignados >= 1);
  assert.strictEqual((await store.listPenas()).length, antes + 2);
  const penas = (await store.listPenas()).filter((p) => [A, B].includes(p.nombre));
  assert.ok(penas.every((p) => p.estado === "verificada"));
  const pa = penas.find((p) => p.nombre === A), pb = penas.find((p) => p.nombre === B);
  assert.strictEqual((await store.getSocioById(registrada.id)).pena_id, pa.id, "la primera peña del informe");
  const pa2 = (await store.listPenas()).find((p) => p.id === pa.id);
  assert.strictEqual(pa2.miembros, 2);
  assert.strictEqual(pa2.hinchada, 2, "la cuenta de Ana ya figura en el padrón: no se cuenta dos veces");
  assert.strictEqual(pb.hinchada, 2);
  assert.strictEqual((await store.getSocioByCedula(ced2)) || null, null, "no se crean cuentas de quien no se registró");
  const r2 = await aplicarPlan(store, plan, { fuente: "test" });
  assert.strictEqual(r2.penas_creadas, 0);
  assert.strictEqual(r2.miembros_nuevos, 0);
  assert.strictEqual(r2.miembros_actualizados, 4);
  assert.strictEqual((await store.listPenas()).length, antes + 2);
});

test("al cargar la cédula después, la cuenta se vincula y se suma sola a su peña (y no pisa una peña ya elegida)", async () => {
  const s = sufijo(), P = "Gamma " + s, ced = "7" + Date.now().toString().slice(-7);
  await aplicarPlan(store, armarPlan([[P, "Luis", "20", ced, "AL DÍA"]]), { fuente: "test" });
  const luis = await store.createSocio({ email: `lu-${s}@ejemplo.com`, passwordHash: "x", nombre: "Luis" });
  assert.ok(!(await store.getSocioById(luis.id)).pena_id);
  await store.updateSocio(luis.id, { cedula: ced });
  const r = await store.sincronizarMiembrosPena({ socioId: luis.id });
  assert.strictEqual(r.asignados, 1);
  const pena = (await store.listPenas()).find((p) => p.nombre === P);
  assert.strictEqual((await store.getSocioById(luis.id)).pena_id, pena.id);
  const otra = await store.crearPena({ nombre: "Otra " + s, ciudad: "X", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" });
  await store.updatePena(otra.id, { estado: "verificada" });
  const ced2 = "6" + Date.now().toString().slice(-7);
  await aplicarPlan(store, armarPlan([[P, "Marta", "21", ced2, "EN MORA"]]), { fuente: "test" });
  const marta = await store.createSocio({ email: `ma-${s}@ejemplo.com`, passwordHash: "x", nombre: "Marta" });
  await store.updateSocio(marta.id, { cedula: ced2, pena_id: otra.id });
  await store.sincronizarMiembrosPena({ socioId: marta.id });
  assert.strictEqual((await store.getSocioById(marta.id)).pena_id, otra.id, "quien ya eligió otra peña la conserva");
});

test("el estado de la cuota lo ve solo el owner: la lista de miembros y el CSV están cerrados para los demás roles", async () => {
  const s = sufijo(), P = "Delta " + s;
  await aplicarPlan(store, armarPlan([[P, "Nora Paz", "30", "5" + Date.now().toString().slice(-7), "EN MORA"], [P, "Omar Paz", "31", "", "AL DÍA"]]), { fuente: "test" });
  const pena = (await store.listPenas()).find((p) => p.nombre === P);
  assert.strictEqual((await api(`/admin/penas/${pena.id}/miembros`)).status, 401);
  const u = `marketing-${s}@ejemplo.com`;
  await adminAuth.crearAdminUsuario({ usuario: u, nombre: u, password: "clave-de-prueba-1", rol: "marketing" });
  const ses = await (await api("/admin/login", { metodo: "POST", cuerpo: { usuario: u, password: "clave-de-prueba-1" } })).json();
  assert.strictEqual((await api(`/admin/penas/${pena.id}/miembros`, { h: { "x-admin-token": ses.token } })).status, 403);
  const ok = await (await api(`/admin/penas/${pena.id}/miembros`, { h: OWNER })).json();
  assert.strictEqual(ok.items.length, 2);
  assert.deepStrictEqual(ok.items.map((m) => m.estado_cuota).sort(), ["al_dia", "en_mora"]);
  assert.match(await (await api(`/admin/penas/${pena.id}/miembros?format=csv`, { h: OWNER })).text(), /En mora/);
  const lista = await (await api("/admin/penas", { h: { "x-admin-token": ses.token } })).json();
  const fila = lista.items.find((p) => p.id === pena.id);
  assert.strictEqual(fila.padron.miembros, 2);
  assert.ok(!("en_mora" in fila.padron), "los demás roles ven cuántos miembros hay, no quién debe");
  const lo = (await (await api("/admin/penas", { h: OWNER })).json()).items.find((p) => p.id === pena.id);
  assert.strictEqual(lo.padron.en_mora, 1);
  const pub = await (await api("/penas")).json();
  assert.strictEqual(pub.items.find((p) => p.id === pena.id).miembros, 2);
  assert.ok(!JSON.stringify(pub).includes("Nora Paz"), "ningún nombre del padrón sale en la API pública");
});

test("el admin puede completar los datos de una peña (ciudad, país, contacto)", async () => {
  const p = await store.crearPena({ nombre: "Editable " + sufijo(), ciudad: "", pais_iso: "PY", presidente: "", contacto: "" });
  const r = await (await api(`/admin/penas/${p.id}`, { metodo: "PATCH", cuerpo: { ciudad: "Luque", presidente: "Juan", pais_iso: "py" }, h: OWNER })).json();
  assert.strictEqual(r.pena.ciudad, "Luque");
  assert.strictEqual(r.pena.pais_iso, "PY");
  assert.strictEqual((await api(`/admin/penas/${p.id}`, { metodo: "PATCH", cuerpo: {}, h: OWNER })).status, 400);
  assert.strictEqual((await api("/admin/penas/no-existe", { metodo: "PATCH", cuerpo: { ciudad: "X" }, h: OWNER })).status, 404);
});

test("el 10 % al fondo de la peña está apagado (y se puede volver a encender con PENA_FONDO_ACTIVO=1)", () => {
  assert.match(leer("routes.js"), /if \(process\.env\.PENA_FONDO_ACTIVO !== "1"\) return;/);
  assert.match(leer("routes.js"), /fondo_activo: process\.env\.PENA_FONDO_ACTIVO === "1"/);
  assert.ok(!/El " \+ d\.pct \+ "% de lo que esos hinchas pagan/.test(leer("public", "pena.html")), "el panel de la comisión ya no promete el 10 %");
  assert.ok(!/propuesta es 10%/.test(leer("data", "ayuda.json")), "la ayuda ya no promete el 10 %");
});

test("pantalla: Peñas con buscador, tarjetas, ficha para sumarse con confirmación, ranking y pedido de una nueva", () => {
  const s = leer("public", "js", "socio.js");
  const v = s.slice(s.indexOf("async function vPenas()"), s.indexOf("async function vSorteos()"));
  for (const id of ['id="pnQ"', 'id="pnOrden"', 'id="pnLista"', 'class="pn-top"', 'id="penaCerca"', 'id="penaSolForm"', 'class="pn-hero"', 'id="pnSumar"', "pn_confirmar"]) assert.ok(v.includes(id), id);
  assert.match(leer("public", "css", "styles.css"), /\.pn \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 320px/);
});
