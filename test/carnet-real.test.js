"use strict";
// El carnet de la app tiene formato de carnet: foto de frente, nombre, número y desde cuándo, y debajo el pase de caja (QR).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("el frente del carnet lleva escudo, nivel, foto, nombre, número, fecha y bandera; sin foto invita a subirla", () => {
  const s = leer("public", "js", "socio.js");
  const f = s.slice(s.indexOf("function antiguedadesCarnet"), s.indexOf("async function vCarnet"));
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
  for (const k of ["cn_titulo", "cn_nombre", "cn_numero", "cn_socio", "cn_foto_falta", "cn_foto_alt", "cn_pase"]) assert.ok((i.split(" " + k + ":").length - 1) >= 2, k);
  assert.match(c, /\.cn2-frente \{/);
  assert.match(c, /\.cn2-corte \{ border-top: 2px dashed/);
});

test("el carnet distingue 'Miembro desde' (registro en Olimpistas) de 'Socio desde' (antigüedad real en el club)", () => {
  const s = leer("public", "js", "socio.js");
  const src = s.slice(s.indexOf("const fechaMes"), s.indexOf("function carnetFrente"));
  const LOC = "es-PY", T = (k) => ({ cn_anios: "{n} años", cn_anio_uno: "1 año" }[k] || k);
  const { antiguedadesCarnet } = new Function("LOC", "T", src + "; return { antiguedadesCarnet };")(LOC, T);
  const desde = "23 de octubre de 2026";
  // no es socio: solo cuándo se registró
  assert.deepStrictEqual(antiguedadesCarnet({ esSocio: false }, desde), [{ et: "m_cn_desde", val: desde }]);
  // socio con fecha de alta en el club: las dos, por separado
  const dos = antiguedadesCarnet({ esSocio: true, socioDesde: "2009-03-14", nroSocio: "4321" }, desde);
  assert.deepStrictEqual(dos.map((x) => x.et), ["m_cn_desde", "cn_socio_desde"]);
  assert.strictEqual(dos[0].val, desde);
  assert.match(dos[1].val, /2009 · \d+ años/, "con la antigüedad en años");
  const hoy = new Date().toISOString().slice(0, 10);
  assert.ok(!/ · /.test(antiguedadesCarnet({ esSocio: true, socioDesde: hoy }, desde)[1].val), "menos de un año: solo la fecha");
  // socio sin fecha confiable: su número y la invitación a contarla, nunca una fecha inventada
  const sin = antiguedadesCarnet({ esSocio: true, socioDesde: "", nroSocio: "4321" }, desde);
  assert.deepStrictEqual(sin.map((x) => x.et), ["m_cn_desde", "cn_nro_socio", "cn_socio_desde"]);
  assert.deepStrictEqual([sin[2].val, sin[2].accion], ["", "carnet"], "la fila de 'Socio desde' es una acción, sin valor");
  assert.deepStrictEqual(antiguedadesCarnet({ esSocio: true, socioDesde: "", nroSocio: "" }, desde).map((x) => x.et), ["m_cn_desde", "cn_socio_desde"], "sin número igual se ofrece contarla");
  // solo se sabe el año (1 de enero): se muestra el año, no un mes
  assert.match(antiguedadesCarnet({ esSocio: true, socioDesde: "2008-01-01" }, desde)[1].val, /^2008 · \d+ años$/);
  const i = leer("public", "js", "i18n.js");
  assert.ok(!/Hincha desde|Fan since/.test(i), "ya no dice 'Hincha desde'");
  assert.match(i, /m_cn_desde: "Miembro desde"/);
  assert.match(i, /m_cn_desde: "Member since"/);
});
