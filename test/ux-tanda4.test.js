"use strict";
// Pulido del admin y del panel del comercio: modales accesibles, reintento por área y monto pedido después de escanear.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("admin: los modales son diálogos accesibles (rol, foco adentro, Tab atrapado, foco de vuelta, cerrar con nombre)", () => {
  const a = leer("admin.html");
  assert.match(a, /box\.setAttribute\("role", "dialog"\); box\.setAttribute\("aria-modal", "true"\)/);
  assert.match(a, /enganchar\("uiModalBg", "uiModalBox"\); enganchar\("fichaBg", "fichaBox"\)/);
  assert.match(a, /aria-labelledby/);
  assert.match(a, /e\.key !== "Tab"/);
  assert.match(a, /setAttribute\("aria-label", "Cerrar"\)/);
});

test("admin: un panel que falla al cargar ofrece Reintentar y vuelve a correr los cargadores del área", () => {
  const a = leer("admin.html");
  assert.match(a, /data-reintentar/);
  assert.match(a, /\(AREA_LOADERS\[area\] \|\| \[\]\)\.forEach/);
});

test("comercio: después de escanear sin monto se pide el monto (con opción de registrar sin monto)", () => {
  const c = leer("comercio.html");
  assert.match(c, /id="pasoMonto"/);
  assert.match(c, /function pedirMonto\(qr\)/);
  assert.match(c, /Number\(\$\("monto"\)\.value\) > 0\) validar\(hit\.rawValue\); else pedirMonto\(hit\.rawValue\)/);
  for (const id of ["pasoOk", "pasoSin", "pasoNo", "montoPaso"]) assert.match(c, new RegExp('id="' + id + '"'));
});
