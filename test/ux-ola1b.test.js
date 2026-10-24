"use strict";
// Ola 1b: detalle de subasta en dos columnas para escritorio, monto libre realmente oculto y caché inmutable para assets versionados.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("detalle de subasta: la puja va en una columna derecha fija en escritorio y el orden del celular no cambia", () => {
  const s = leer("public", "js", "socio.js");
  const r = s.slice(s.indexOf("function renderDetalle"), s.indexOf("function bindPujas"));
  assert.match(r, /<div class="sub-cols"><div class="sub-izq">/);
  assert.ok(r.indexOf('class="sub-hero"') < r.indexOf('class="sub-der"'), "la pieza queda a la izquierda");
  assert.ok(r.indexOf('class="sub-der"') < r.indexOf('class="sub-box"') && r.indexOf('class="sub-box"') < r.indexOf('id="subAcciones"'), "puja y acciones a la derecha");
  for (const id of ["subAmt", "subAmtUsd", "subState", "subClock", "subCd", "subPuj", "subMia", "subAcciones", "subFeed"]) assert.ok(r.includes('id="' + id + '"'), id);
  const c = leer("public", "css", "styles.css");
  assert.match(c, /\.sub-izq, \.sub-der \{ display: contents; \}/, "en el celular los envoltorios no cambian el orden");
  assert.match(c, /\.sub-cols \.sub-box \{ order: 4; \}[\s\S]*#subAcciones \{ order: 7; \}[\s\S]*\.sub-feed \{ order: 9; \}/);
  assert.match(c, /@media \(min-width: 1000px\) \{\s*\.sub-detalle-wrap \{ max-width: 1080px; \}[\s\S]*\.sub-der \{ display: flex; flex-direction: column; position: sticky; top: 24px; \}/);
});

test("el monto libre de la puja arranca oculto de verdad", () => {
  assert.match(leer("public", "css", "styles.css"), /\.sub-custom-form\[hidden\], \.sub-custom-toggle\[hidden\] \{ display: none; \}/);
});

test("assets con ?v=<revisión actual> se guardan un año como inmutables; cualquier otro ?v= conserva el caché corto", () => {
  const s = leer("server.js");
  assert.match(s, /res\.req\.query\.v === BUILD_ID && !!process\.env\.K_REVISION/);
  assert.match(s, /"public, max-age=31536000, immutable"/);
  assert.match(s, /PROD \? "public, max-age=86400" : "no-cache"/, "lo demás sigue como estaba");
});

test("caja del comercio: escanea con BarcodeDetector y, donde no existe (iPhone, Firefox), con jsQR que se baja solo al tocar Escanear", () => {
  const h = leer("public", "comercio.html");
  assert.match(h, /if\("BarcodeDetector" in window\) det = new BarcodeDetector/);
  assert.match(h, /else \{ await cargarJsQR\(\); det = detectorJsQR\(\); \}/);
  assert.match(h, /s\.src = "\/assets\/vendor\/jsQR\.js"/);
  assert.ok(!/<script[^>]+jsQR/.test(h), "no se carga al abrir el panel, solo bajo demanda");
  assert.match(h, /\/\^OLI1\\./, "solo acepta QR del carnet de Olimpistas");
  const v = leer("public", "assets", "vendor", "jsQR.js");
  assert.match(v, /jsQR/);
  assert.match(leer("public", "assets", "vendor", "jsQR.LICENSE.txt"), /Apache License 2\.0/);
});
