"use strict";
// Portal de la comisión de la peña: resumen con el avance del padrón (solo cantidades), invitar, y datos que la comisión mantiene sola.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { armarPlan, aplicarPlan } = require("../lib/penas-padron");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const html = fs.readFileSync(path.join(__dirname, "..", "public", "pena.html"), "utf8");
const sufijo = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function crearPenaConComision(nombre, miembros = 6) {
  const filas = Array.from({ length: miembros }, (_, k) => [nombre, "Persona Ficticia " + k, String(100 + k), String(4000000 + Math.floor(Math.random() * 900000) + k), k % 2 ? "EN MORA" : "AL DÍA"]);
  await aplicarPlan(store, armarPlan(filas), { fuente: "test" });
  const pena = (await store.listPenas()).find((p) => p.nombre === nombre);
  const usuario = "com" + sufijo();
  await store.crearPenaUsuario({ penaId: pena.id, usuario, passwordHash: await bcrypt.hash("clave-comision-1", 10) });
  const login = await (await api("/pena/login", { metodo: "POST", cuerpo: { usuario, password: "clave-comision-1" } })).json();
  return { pena, h: { "x-pena-token": login.token }, usuario };
}

test("panel: avance del listado del club (cuántos ya están en la app), ranking y datos; nunca quién debe ni cédulas", async () => {
  const { pena, h } = await crearPenaConComision("Comisión " + sufijo(), 6);
  const sinCuenta = await (await api("/pena/panel", { h })).json();
  assert.deepStrictEqual(sinCuenta.padron, { miembros: 6, con_cuenta: 0, pendientes: 6 });
  assert.strictEqual(sinCuenta.kpis.hinchada, 6);
  // una persona del listado se registra y carga su cédula → se vincula y se suma sola
  const miembro = (await store.listarMiembrosPena(pena.id))[0];
  const cuenta = await store.createSocio({ email: `cm-${sufijo()}@ejemplo.com`, passwordHash: "x", nombre: "Persona" });
  await store.updateSocio(cuenta.id, { cedula: miembro.cedula });
  await store.sincronizarMiembrosPena({ socioId: cuenta.id });
  const pendiente = await (await api("/pena/panel", { h })).json();
  assert.strictEqual(pendiente.solicitudes.invitaciones, 1, "la comisión ve que hay una invitación esperando a la persona");
  assert.strictEqual(pendiente.padron.con_cuenta, 0, "todavía no confirmó");
  await store.resolverSolicitudPena({ id: (await store.solicitudPenaPendiente(cuenta.id)).id, por: "socio", aceptar: true });
  const p = await (await api("/pena/panel", { h })).json();
  assert.deepStrictEqual(p.padron, { miembros: 6, con_cuenta: 1, pendientes: 5 });
  assert.strictEqual(p.kpis.hinchada, 6, "la persona vinculada no se cuenta dos veces");
  assert.ok(Array.isArray(p.top) && p.top.length >= 1 && p.top.length <= 5);
  assert.ok(p.top.every((t) => Object.keys(t).sort().join() === "ciudad,es_tuya,hinchada,nombre"));
  assert.deepStrictEqual(Object.keys(p.datos).sort(), ["ciudad", "contacto", "nombre", "pais_iso", "presidente"]);
  const txt = JSON.stringify(p);
  assert.ok(!/en_mora|al_dia|estado_cuota|cedula|Persona Ficticia/.test(txt), "nada del padrón individual sale al panel de la comisión");
});

test("la comisión mantiene los datos de su peña: valida el país y el correo, y una sesión de solo lectura no puede cambiar nada", async () => {
  const { pena, h } = await crearPenaConComision("Datos " + sufijo(), 2);
  const ok = await (await api("/pena/perfil", { metodo: "PATCH", cuerpo: { ciudad: "  Luque ", pais_iso: "py", presidente: "Ana Presidenta", contacto: "COMISION@Ejemplo.com" }, h })).json();
  assert.deepStrictEqual(ok.datos, { nombre: pena.nombre, ciudad: "Luque", pais_iso: "PY", presidente: "Ana Presidenta", contacto: "comision@ejemplo.com" });
  assert.strictEqual((await store.getPena(pena.id)).ciudad, "Luque");
  assert.strictEqual((await api("/pena/perfil", { metodo: "PATCH", cuerpo: { pais_iso: "Paraguay" }, h })).status, 400);
  assert.strictEqual((await api("/pena/perfil", { metodo: "PATCH", cuerpo: { contacto: "no-es-un-correo" }, h })).status, 400);
  assert.strictEqual((await api("/pena/perfil", { metodo: "PATCH", cuerpo: {}, h })).status, 400);
  assert.strictEqual((await api("/pena/perfil", { metodo: "PATCH", cuerpo: { ciudad: "X" } })).status, 401);
  // "ver como": el owner entra en solo lectura
  const entrar = await (await api("/pena/entrar-como", { metodo: "POST", cuerpo: { id: pena.id }, h: OWNER })).json();
  assert.ok(entrar.token);
  assert.strictEqual((await api("/pena/perfil", { metodo: "PATCH", cuerpo: { ciudad: "Otra" }, h: { "x-pena-token": entrar.token } })).status, 403);
  assert.strictEqual((await store.getPena(pena.id)).ciudad, "Luque");
  // lo que cambia la comisión se ve en el listado público
  const pub = await (await api("/penas")).json();
  assert.strictEqual(pub.items.find((x) => x.id === pena.id).ciudad, "Luque");
});

test("la página de la comisión: pestañas, avance del padrón, WhatsApp, QR descargable, cartel, mensajes y datos de la peña", () => {
  for (const id of ['id="vResumen"', 'id="vInvitar"', 'id="vHinchada"', 'id="vPerfil"', 'id="tabs"', 'id="waBtn"', 'id="qrBajar"', 'id="cartelBtn"', 'id="plantillas"', 'id="pfGuardar"', 'id="progRelleno"', 'id="cartel"']) assert.ok(html.includes(id), id);
  assert.match(html, /wa\.me\/\?text=/);
  assert.match(html, /@media print/);
  assert.match(html, /grid-template-areas: "resumen invitar" "hinchada perfil"/);
  assert.ok(!/onclick=/.test(html), "la CSP del sitio bloquea los manejadores en línea");
});
