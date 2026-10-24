"use strict";
// Avisos al celular desde el panel: el club arma un aviso de partido o de beneficio, ve a cuántas personas llega y lo confirma antes de enviarlo.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const a = leer("public", "admin.html");

test("Campañas tiene el formulario de avisos al celular con los límites del servidor y solo para quien puede escribir campañas", () => {
  for (const id of ["pushTipo", "pushCiudad", "pushTitulo", "pushCuerpo", "pushUrl", "pushEnviar", "pushMsg", "pushResumen", "pushBox"]) assert.ok(a.includes(`id="${id}"`), id);
  assert.ok(/id="pushTitulo" maxlength="80"/.test(a) && /id="pushCuerpo" maxlength="160"/.test(a), "los mismos límites que valida el servidor (80 y 160)");
  assert.ok(/box\.hidden = !puede\("campanas\.write"\)/.test(a), "solo con permiso de campañas");
  assert.ok(/campanas: \[cargarPush, /.test(a), "se carga al abrir Campañas");
  assert.ok(/<option value="partido">/.test(a) && /<option value="beneficio">/.test(a) && !/<option value="subasta">|<option value="pago">/.test(a), "solo los avisos que manda el club (los de subasta y pago son por persona)");
});

test("antes de enviar muestra a cuántas personas llega y pide confirmación; sin conexión del servicio no se envía; sin diálogos del sistema", () => {
  assert.ok(/await confirmar\("Se manda a /.test(a) && /No se puede deshacer\./.test(a) && /ok: "Enviar ahora"/.test(a));
  assert.ok(/\/admin\/push\/resumen/.test(a) && /\/admin\/push\/enviar/.test(a));
  assert.ok(/\$\("pushEnviar"\)\.disabled = true/.test(a) && /faltan las claves del servicio/.test(a), "sin las claves, el botón queda apagado");
  assert.ok(!/\b(window\.)?(alert|prompt)\(/.test(a.slice(a.indexOf("async function cargarPush"), a.indexOf("async function cargarPendientes"))), "sin diálogos del sistema");
  for (const u of ["/miembro", "/miembro/beneficios", "/miembro/carnet"]) assert.ok(a.includes(`<option value="${u}">`), "destino " + u);
});

test("el plan refleja que la landing no vende socios", () => {
  const p = leer("docs", "plan-maestro.md");
  assert.ok(/no un lugar para vender socios/.test(p) && /Descartado/.test(p));
  assert.ok(!/seis comercios reales con logo y descuento en la landing/.test(p) || /~~Visitante/.test(p));
});

test("Sistema permite guardar los perfiles de la campaña de validación (solo con permiso de campañas) y avisa que las campañas siguen apagadas", () => {
  assert.ok(/id="clubPerfiles"/.test(a) && /puede\("campanas\.write"\) \? '<div class="row-actions"/.test(a));
  assert.ok(/\/admin\/club\/perfiles/.test(a) && /Las campañas siguen apagadas hasta que se decida encenderlas/.test(a));
});
