"use strict";
// Puntos de corte unificados: toda la interfaz usa la misma escala de anchos.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

// Escala: 359 y 430 (teléfonos), 600 (teléfono grande/tableta chica), 900 (tableta y escritorio chico), 1200 (escritorio) y 1600 (pantalla ancha).
// "min-width" usa estos números; "max-width" usa el número menos uno (599, 899) o el propio tope de teléfono (359, 430).
const MIN = new Set([600, 900, 1200, 1600]);
const MAX = new Set([359, 430, 599, 899]);
const ARCHIVOS = ["css/styles.css", "admin.html", "ayuda.html", "comercio.html", "guia-comercio.html", "pena.html", "index.html", "socio.html"];

test("las hojas de estilo solo usan los puntos de corte de la escala", () => {
  for (const f of ARCHIVOS) {
    const t = leer("public", ...f.split("/"));
    for (const m of t.matchAll(/@media[^{]*\{/g)) {
      for (const q of m[0].matchAll(/\((min|max)-width:\s*(\d+)px\)/g)) {
        const n = Number(q[2]);
        assert.ok((q[1] === "min" ? MIN : MAX).has(n), `${f}: ${q[0]} no está en la escala`);
      }
    }
  }
});

test("matchMedia en el JS usa la misma escala y coincide con el CSS del escritorio", () => {
  const s = leer("public", "js", "socio.js");
  for (const m of s.matchAll(/matchMedia\("\((min|max)-width:\s*(\d+)px\)"\)/g)) assert.ok((m[1] === "min" ? MIN : MAX).has(Number(m[2])), m[0]);
  assert.match(s, /escritorio = window\.matchMedia\("\(min-width: 900px\)"\)/, "la barra lateral aparece a partir de 900");
  assert.match(s, /matchMedia\("\(min-width: 1200px\)"\)\.matches \? view\(\)\.querySelector\("#bxDetalle"\)/, "el detalle lateral de Beneficios coincide con su CSS");
});

test("los pares de corte no dejan hueco ni se pisan: cada max-width es el min-width de arriba menos uno", () => {
  const c = leer("public", "css", "styles.css");
  assert.ok(!/\(max-width: (900|901|920|860|1024)px\)/.test(c), "sin cortes viejos");
  assert.match(c, /@media \(max-width: 899px\)/);
  assert.match(c, /@media \(min-width: 900px\)/);
});
