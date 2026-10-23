"use strict";
// El escudo del club se muestra con el PNG oficial (escudo.png) tal cual, sin círculo ni fondo detrás y nunca en negativo; y la frase del Inicio.
// El PNG trae su propio contorno blanco, que lo separa del fondo negro de los encabezados.
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

test("los escudos en <img> usan el PNG oficial tal cual (.escudo-ok), sin círculo ni fondo detrás", () => {
  let n = 0;
  for (const f of [...lista("."), ...lista("js")]) {
    for (const m of leer(f).matchAll(/<img\b[^>]*\/assets\/escudo\.png[^>]*>/g)) {
      if (f === "ayuda.html") continue; // ahí va sobre fondo claro
      if (/c-escudo/.test(m[0])) continue; // el cartel de la peña se imprime sobre papel blanco
      n++; assert.match(m[0], /escudo-ok/, f);
    }
  }
  assert.ok(n >= 8, "se revisaron los escudos de las pantallas (" + n + ")");
  const regla = /\.escudo-ok \{([^}]*)\}/.exec(leer("css/styles.css"));
  assert.ok(regla, ".escudo-ok existe");
  assert.ok(!/background|border-radius|padding|filter/.test(regla[1]), "ni círculo, ni fondo, ni relleno, ni filtros: el escudo va tal cual");
});

test("las imágenes dibujadas (story y pin de peña) usan el escudo oficial tal cual, sin círculo blanco", () => {
  const common = leer("js/common.js"), globe = leer("js/globe.js");
  assert.ok(!/escudo-olimpia-blanco/.test(common) && !/escudo-olimpia-blanco/.test(globe));
  assert.match(common, /"\/assets\/escudo\.png"/);
  assert.ok(!/fillStyle = "#ffffff"; x\.beginPath\(\); x\.arc\(cx, 130/.test(common), "la story ya no dibuja un círculo blanco detrás del escudo");
  assert.ok(!/x\.arc\(c\.width \/ 2/.test(globe), "el pin del mapa ya no dibuja un círculo blanco");
});

test("la frase del Inicio: 'Esto es lo tuyo, Olimpista.'", () => {
  const i = leer("js/i18n.js");
  assert.match(i, /m_ini_p: "Esto es lo tuyo, Olimpista\."/);
  assert.ok(!/Esto es lo tuyo, hincha del Decano/.test(i));
});
