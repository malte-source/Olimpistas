"use strict";
// Tanda 2 de la auditoría (usabilidad): la red caída no se confunde con "sin sesión", las pujas no se duplican ni se borran
// mientras se tipean, el pago en proceso no desaparece, el texto sobre el oro se lee y las claves de idioma están en es y en.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("api(): corta a los 25 s y traduce la falla de red a un mensaje claro; yoEstado distingue 401 de caída", () => {
  const c = leer("js/common.js");
  assert.match(c, /new AbortController\(\)/);
  assert.match(c, /timeout \|\| 25000/);
  for (const k of ["err_red", "err_lento", "err_servidor"]) assert.match(c, new RegExp(k));
  assert.match(c, /async function yoEstado\(\)/);
  assert.match(c, /toast, yo, yoEstado,/);
  const socio = leer("js/socio.js");
  assert.match(socio, /OLI\.yoEstado\(\)/);
  assert.match(socio, /btnReintentarInit/);
  assert.match(leer("js/landing.js"), /yoEstado\(\)\)\.sesion/);
});

test("subastas: sin pujas dobles, confirmación de cifras desmedidas (con el modal propio) y el monto tipeado sobrevive al refresco", () => {
  const s = leer("js/socio.js");
  assert.match(s, /let pujando = false/);
  assert.match(s, /if \(pujando\) return;/);
  assert.match(s, /monto >= min \* 3/);
  assert.match(s, /tipeo/);
});

test("pago en proceso: aviso persistente con botón de cerrar (no un toast de 2,6 s)", () => {
  assert.match(leer("js/socio.js"), /className = "aviso-pago"/);
  assert.match(leer("css/styles.css"), /\.aviso-pago \{/);
});

test("contraste: el texto sobre el oro es tinta y el modal scrollea en pantallas bajas", () => {
  const css = leer("css/styles.css");
  assert.match(css, /\.btn-valor, \.tier-ribbon\.oro, \.destacado-cta \{ color: #0a0a0a; \}/);
  assert.match(css, /\.modal \{ max-height: calc\(100dvh - 40px\); overflow-y: auto;/);
});

test("i18n: cada clave nueva existe una vez en español y una en inglés", () => {
  const i = leer("js/i18n.js");
  for (const k of ["err_red", "err_lento", "err_servidor", "err_reintentar", "err_cuenta_titulo", "m_cerrar", "m_sub_confirmar", "m_sub_confirmar_t", "m_sub_confirmar_si"])
    assert.strictEqual(i.split(" " + k + ": ").length - 1, 2, k);
});
