"use strict";
// El escudo del club se muestra en su versión correcta (sobre círculo blanco en fondos oscuros), no el negativo; y la frase del Inicio.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const PUB = path.join(__dirname, "..", "public");
const leer = (rel) => fs.readFileSync(path.join(PUB, rel), "utf8");
const lista = (dir) => fs.readdirSync(path.join(PUB, dir)).filter((f) => /\.(html|js)$/.test(f)).map((f) => path.join(dir, f));

test("ninguna página ni plantilla usa el escudo en negativo en una etiqueta <img>", () => {
  for (const f of [...lista("."), ...lista("js")]) {
    const src = leer(f);
    assert.ok(!/<img\b[^>]*escudo-olimpia-blanco/.test(src), f + " todavía usa el escudo en negativo");
  }
});

test("los escudos en <img> usan la versión correcta con el círculo blanco (.escudo-ok)", () => {
  let n = 0;
  for (const f of [...lista("."), ...lista("js")]) {
    for (const m of leer(f).matchAll(/<img\b[^>]*\/assets\/escudo\.png[^>]*>/g)) {
      if (f === "ayuda.html") continue; // ahí va sobre fondo claro
      n++; assert.match(m[0], /escudo-ok/, f);
    }
  }
  assert.ok(n >= 8, "se revisaron los escudos de las pantallas (" + n + ")");
  assert.match(leer("css/styles.css"), /\.escudo-ok \{[^}]*border-radius: 50%[^}]*background: #fff/);
});

test("las imágenes dibujadas (story y pin de peña) usan el escudo correcto sobre círculo blanco", () => {
  assert.ok(!/escudo-olimpia-blanco/.test(leer("js/common.js")) && !/escudo-olimpia-blanco/.test(leer("js/globe.js")));
  assert.match(leer("js/common.js"), /"\/assets\/escudo\.png"/);
});

test("la frase del Inicio: 'Esto es lo tuyo, Olimpista.'", () => {
  const i = leer("js/i18n.js");
  assert.match(i, /m_ini_p: "Esto es lo tuyo, Olimpista\."/);
  assert.ok(!/Esto es lo tuyo, hincha del Decano/.test(i));
});
