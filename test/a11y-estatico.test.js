"use strict";
// Lo que el revisor de accesibilidad (scripts/a11y-axe.js) encontró y se corrigió, fijado para que no vuelva; el revisor mismo corre en CI.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("legal: el texto usa los colores del tema (no un gris fijo que se pierde en el tema claro) y los enlaces se distinguen sin depender del color", () => {
  const l = leer("public", "legal.html");
  assert.ok(!/#c9c9d2/i.test(l));
  assert.ok(/\.legal p, \.legal li \{ color: var\(--text-secondary\)/.test(l));
  assert.ok(/\.legal a \{[^}]*text-decoration: underline/.test(l));
});

test("landing: la lista del mapa no se muestra vacía (un resumen sin texto no tiene nombre para un lector de pantalla)", () => {
  assert.ok(/id="mapaListaWrap" hidden>/.test(leer("public", "index.html")));
  assert.ok(/wrap\.hidden = false;/.test(leer("public", "js", "landing.js")));
  assert.ok(/\.mapa-lista-wrap\[hidden\] \{ display: none; \}/.test(leer("public", "css", "styles.css")));
});

test("el revisor de accesibilidad cubre público y miembro, celular, escritorio y tema oscuro, y falla en serias o críticas", () => {
  const s = leer("scripts", "a11y-axe.js"), w = leer(".github", "workflows", "calidad-a11y.yml");
  assert.ok(/colorScheme: "dark"/.test(s) && /\/miembro\/carnet/.test(s) && /A11Y_FALLA_EN \|\| "serious"/.test(s));
  assert.ok(/node scripts\/a11y-axe\.js/.test(w) && /pull_request:/.test(w) && /playwright install/.test(w));
});
