"use strict";
// U7 · Carnet listo para la puerta: mientras se ve el QR la pantalla no se apaga, se vuelve a pedir al volver y se avisa del brillo una sola vez.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "socio.js"), "utf8");
const i18n = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8");

// Corre el código REAL del bloque <U7> de socio.js con un navegador de mentira.
function entorno({ hidden = false, wakeLock, tactil = true, guardado = {}, hayQr = true } = {}) {
  const bloque = js.split("// <U7>")[1].split("// </U7>")[0].split("\n").slice(1).join("\n");   // sin lo que quedó de la línea del marcador
  const toasts = [], timers = [];
  const doc = { hidden, getElementById: (id) => (id === "qrBen" && hayQr ? {} : null) };
  const ls = { getItem: (k) => (k in guardado ? guardado[k] : null), setItem: (k, v) => { guardado[k] = v; } };
  const f = new Function("document", "navigator", "window", "matchMedia", "localStorage", "toast", "T", "setTimeout",
    bloque + "\nreturn { mantenerPantalla, soltarPantalla, avisoBrillo, estado: () => _wake };");
  const api = f(doc, { wakeLock }, { matchMedia: () => 0 }, () => ({ matches: tactil }), ls, (t) => toasts.push(t), (k) => k, (fn) => timers.push(fn));
  return { ...api, doc, toasts, timers, guardado };
}
const cerradura = () => {
  const lista = [];
  return { lista, request: async (tipo) => { const w = { tipo, liberada: false, oyentes: [], release() { this.liberada = true; this.oyentes.forEach((o) => o()); }, addEventListener(_e, fn) { this.oyentes.push(fn); } }; lista.push(w); return w; } };
};

test("pide la pantalla encendida una sola vez aunque se llame varias veces, y la suelta al salir del carnet", async () => {
  const wl = cerradura(), e = entorno({ wakeLock: wl });
  await e.mantenerPantalla(); await e.mantenerPantalla();
  assert.strictEqual(wl.lista.length, 1);
  assert.strictEqual(wl.lista[0].tipo, "screen");
  e.soltarPantalla();
  assert.strictEqual(wl.lista[0].liberada, true);
  assert.strictEqual(e.estado(), null);
});

test("si el sistema la suelta (segundo plano, batería baja) se puede volver a pedir", async () => {
  const wl = cerradura(), e = entorno({ wakeLock: wl });
  await e.mantenerPantalla();
  wl.lista[0].release();                       // el sistema la libera
  assert.strictEqual(e.estado(), null);
  await e.mantenerPantalla();
  assert.strictEqual(wl.lista.length, 2);
});

test("no pide nada con la página oculta, sin soporte, ni si el sistema la rechaza (nunca rompe el carnet)", async () => {
  const wl = cerradura();
  await entorno({ wakeLock: wl, hidden: true }).mantenerPantalla();
  assert.strictEqual(wl.lista.length, 0);
  await entorno({ wakeLock: undefined }).mantenerPantalla();
  const rechaza = entorno({ wakeLock: { request: async () => { throw new Error("NotAllowedError"); } } });
  await rechaza.mantenerPantalla();
  assert.strictEqual(rechaza.estado(), null);
  assert.doesNotThrow(() => entorno({ wakeLock: undefined }).soltarPantalla());
});

test("el aviso del brillo sale una sola vez por dispositivo, solo en el celular y solo si el QR sigue en pantalla", () => {
  const e = entorno({ wakeLock: cerradura() });
  e.avisoBrillo(); e.timers.forEach((t) => t());
  assert.deepStrictEqual(e.toasts, ["m_qr_brillo"]);
  assert.strictEqual(e.guardado.oli_brillo_aviso, "1");
  const otra = entorno({ wakeLock: cerradura(), guardado: e.guardado });
  otra.avisoBrillo(); otra.timers.forEach((t) => t());
  assert.deepStrictEqual(otra.toasts, [], "ya se avisó en este dispositivo");
  const escritorio = entorno({ wakeLock: cerradura(), tactil: false });
  escritorio.avisoBrillo(); assert.strictEqual(escritorio.timers.length, 0);
  const salio = entorno({ wakeLock: cerradura(), hayQr: false });
  salio.avisoBrillo(); salio.timers.forEach((t) => t());
  assert.deepStrictEqual(salio.toasts, [], "si ya salió del carnet no se avisa");
});

test("cableado: al mostrar el QR se pide, al detenerlo se suelta, al volver a la app se recupera; texto es y en", () => {
  assert.ok(/function detenerQrBeneficios\(\) \{[^}]*soltarPantalla\(\); \}/.test(js));
  assert.ok(/refrescarQr\(\);\r?\n\s*mantenerPantalla\(\); avisoBrillo\(\);/.test(js));
  assert.ok(/visibilitychange", \(\) => \{ if \(!document\.hidden && _qrTimer\) \{ refrescarQr\(\); mantenerPantalla\(\); \}/.test(js));
  assert.strictEqual((i18n.match(/\bm_qr_brillo:/g) || []).length, 2);
});
