"use strict";
// El carnet de la app tiene formato de carnet: foto de frente, nombre, número y desde cuándo, y debajo el pase de caja (QR).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("el frente del carnet lleva escudo, nivel, foto, nombre, número, fecha y bandera; sin foto invita a subirla", () => {
  const s = leer("public", "js", "socio.js");
  const f = s.slice(s.indexOf("function antiguedadCarnet"), s.indexOf("async function vCarnet"));
  for (const k of ["escudo.png", "cn2-niv", "cn2-foto", "cn2-nom", "cn2-nro", "m_cn_desde", "cn2-flag", "cn2-socio"]) assert.ok(f.includes(k), k);
  assert.match(f, /data-cn-foto/, "sin foto: botón para agregarla");
  assert.match(f, /esc\(c\.nombre\)/, "el nombre sale escapado");
});

test("la vista usa el frente en línea y sin conexión, con corte punteado y pase de caja; el QR rotativo conserva sus ids", () => {
  const s = leer("public", "js", "socio.js");
  assert.strictEqual((s.match(/carnetFrente\(/g) || []).length, 3, "definición + en línea + sin conexión");
  for (const id of ["qrBen", "qrBenImg", "qrBenVel", "qrBenBarra", "qrBenSeg", "qrBenCod"]) assert.ok(s.includes('id="' + id + '"'), id);
  assert.match(s, /cn2-corte/);
  assert.match(s, /\[data-cn-foto\]/);
});

test("textos del carnet en español e inglés y estilos con tokens", () => {
  const i = leer("public", "js", "i18n.js"), c = leer("public", "css", "styles.css");
  for (const k of ["cn_titulo", "cn_nombre", "cn_numero", "cn_socio", "cn_foto_falta", "cn_foto_alt", "cn_pase"]) assert.strictEqual((i.split(" " + k + ":").length - 1), 2, k);
  assert.match(c, /\.cn2-frente \{/);
  assert.match(c, /\.cn2-corte \{ border-top: 2px dashed/);
});
