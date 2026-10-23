"use strict";
// Mi carnet en escritorio: dos columnas (carnet + todo lo demás a la derecha) y el ícono de ubicación en línea con el texto
// (antes era un bloque suelto a la izquierda).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("el carnet agrupa estado, acciones, hinchada y nivel en la columna derecha (el orden en celular no cambia)", () => {
  const s = leer("js/socio.js");
  const v = s.slice(s.indexOf("async function vCarnet()"), s.indexOf("async function vCarnet()") + 9000);
  const lado = v.indexOf('class="cn2-lado"'), hinchada = v.indexOf('class="card cn2-hinchada"'), resumen = v.indexOf('class="cn2-resumen"'), nota = v.indexOf('class="cn2-nota"');
  assert.ok(lado > 0 && nota > lado && hinchada > nota && resumen > hinchada, "orden: lado → nota → hinchada → resumen");
  assert.ok(!/max-width:520px;margin:18px auto 0/.test(v), "sin los estilos en línea que lo centraban en una columna angosta");
});

test("CSS: grilla de dos columnas desde 900 px, carnet fijo, y el ícono de ubicación centrado en línea", () => {
  const c = leer("css/styles.css");
  assert.match(c, /@media \(min-width: 900px\) \{\s*\.cn2-grid \{ display: grid; grid-template-columns: 340px minmax\(0, 1fr\)/);
  assert.match(c, /\.cn2-grid \.cn2 \{ position: sticky/);
  assert.match(c, /\.ubic-line \{ display: flex; align-items: center; justify-content: center/);
});
