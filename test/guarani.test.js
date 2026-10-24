"use strict";
// Guaraní (beta): solo traduce lo seguro; lo que falta se ve en español. Selector de idioma en Ajustes con tres opciones.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

function cargar(lang) {
  const ctx = {
    window: {}, document: { documentElement: {}, querySelectorAll: () => [] }, location: { pathname: "/miembro" },
    localStorage: { getItem: (k) => (k === "oli_lang" ? lang : null), setItem() {} }, navigator: { language: "es-PY" },
  };
  vm.createContext(ctx);
  vm.runInContext(leer("public", "js", "i18n.js").replace(/^\s*(?:window\.OLI_I18N\s*=|const OLI_I18N\s*=)/m, "var OLI_I18N ="), ctx);
  return { I: vm.runInContext("OLI_I18N", ctx), doc: ctx.document };
}

test("en guaraní se ven los textos traducidos y el resto cae al español, nunca a la clave", () => {
  const { I, doc } = cargar("gn");
  assert.strictEqual(I.lang(), "gn");
  assert.strictEqual(doc.documentElement.lang, "gn", "el idioma de la página se declara para los lectores de pantalla");
  assert.strictEqual(I.t("tab_inicio"), "Ñepyrũ");
  assert.strictEqual(I.t("cn_foto_falta"), "Emoĩ che ta'anga");
  assert.strictEqual(I.t("pal_ph"), I.DICT.es.pal_ph, "sin traducir: español");
  assert.strictEqual(I.t("clave_que_no_existe"), "clave_que_no_existe");
});

test("cada clave en guaraní existe también en español y conserva sus marcadores {n}, {p}", () => {
  const { I } = cargar("es");
  const es = I.DICT.es, gn = I.DICT.gn;
  assert.ok(Object.keys(gn).length >= 40, "cubre Inicio, Carnet y Beneficios");
  for (const [k, v] of Object.entries(gn)) {
    assert.ok(k in es, "clave huérfana: " + k);
    const marcas = (t) => (String(t).match(/\{[a-z]+\}/g) || []).sort().join();
    assert.strictEqual(marcas(v), marcas(es[k]), "marcadores de " + k);
  }
});

test("el idioma se elige entre español, inglés y guaraní (beta) y se recuerda; español sigue siendo el predeterminado", () => {
  assert.strictEqual(cargar("es").I.lang(), "es");
  assert.strictEqual(cargar("en").I.lang(), "en");
  assert.strictEqual(cargar("xx").I.lang(), "es");
  const s = leer("public", "js", "socio.js");
  assert.match(s, /\[\["es", "Español"\], \["en", "English"\], \["gn", "Avañe'ẽ \(beta\)"\]\]/);
  assert.match(s, /OLI_I18N\.setLang\(b\.dataset\.lang\)/);
});
