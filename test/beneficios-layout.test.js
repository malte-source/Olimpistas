"use strict";
// Beneficios en el celular: lista más arriba, controles en menos filas y tarjetas sin repetir lo obvio.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const sj = leer("public", "js", "socio.js"), css = leer("public", "css", "styles.css");
const vista = sj.slice(sj.indexOf("async function vBeneficios"), sj.indexOf("function iniciarBeneficiosMapa"));

test("buscador y Lista/Mapa comparten fila; cantidad y orden van en una sola línea", () => {
  assert.match(vista, /<div class="bx-r1">.*id="bxQ".*<span id="bxVista"><\/span><\/div>/s);
  assert.ok(vista.indexOf('id="bxN"') < vista.indexOf('id="bxOrden"'), "cantidad a la izquierda, orden a la derecha");
  assert.ok(!/<span id="bxVista"><\/span>' \+\s*'<\/div>' \+\s*'<p class="bx-n"/.test(vista), "ya no hay una fila aparte para Lista/Mapa");
});

test("Todos / Para vos solo aparece si hay beneficios bloqueados, y los títulos de grupo solo si hay dos grupos", () => {
  assert.match(vista, /\(bloqueados\.length \? '<div class="ctl-seg" id="bxDisp"/);
  assert.match(vista, /libres\.length && cerrados\.length/);
});

test("la tarjeta no repite 'Disponible para vos' ni 'tu ciudad' junto al nombre; solo lo bloqueado dice su estado", () => {
  const fila = vista.slice(vista.indexOf("const fila = "), vista.indexOf("const st = { q:"));
  assert.ok(!fila.includes("ben-loc"), "sin chip 'tu ciudad' al lado del nombre");
  assert.match(fila, /x\.desbloqueado \? "" : '<span class="bx-estado">'/);
  assert.match(fila, /hayMezcla && esLocal\(x\)/, "la ciudad propia se resalta solo si hay comercios de otras ciudades");
  assert.match(css, /\.bx-card-top \.grupo-tx b \{ display: block; overflow: hidden; text-overflow: ellipsis/);
});

test("la billetera sin canjes es una línea, el subtítulo escribe bien la ciudad y el chat se corre al scrollear", () => {
  assert.match(vista, /sinAhorro \? '<div class="ben-ahorro cero">/);
  assert.match(vista, /ciudadTxt/);
  assert.match(leer("public", "js", "atencion.js"), /classList\.add\("atc-baja"\)/);
  assert.match(css, /\.atc-fab\.atc-baja \{ opacity: 0; pointer-events: none/);
  const i = leer("public", "js", "i18n.js");
  assert.strictEqual(i.split(" bx_ahorro_cero: ").length - 1, 2);
});
