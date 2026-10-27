"use strict";
// Resend permite 10 pedidos por segundo: un 429 se reintenta en vez de perder el correo; otros rechazos no se reintentan.
process.env.RESEND_API_KEY = "re_clave_de_prueba";
process.env.EMAIL_REINTENTO_MS = "1";
process.env.NODE_ENV = "test";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fetchOriginal = global.fetch;
const email = require("../lib/email");

let llamadas, respuestas;
beforeEach(() => {
  llamadas = 0; respuestas = [];
  global.fetch = async (url) => {
    if (!String(url).includes("api.resend.com")) return fetchOriginal(url);
    llamadas++;
    const status = respuestas.shift() || 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify({ name: status === 429 ? "rate_limit_exceeded" : "x" }) };
  };
});
after(() => { global.fetch = fetchOriginal; });
const mandar = () => email.enviar({ to: "a@ejemplo.com", subject: "Hola", html: "<p>Hola</p>" });

test("un 429 se reintenta y el correo sale (con la cuenta de reintentos)", async () => {
  respuestas = [429, 429];
  const r = await mandar();
  assert.deepStrictEqual([r.ok, r.modo, r.reintentos, llamadas], [true, "resend", 2, 3]);
});

test("si el límite sigue, después de 3 intentos se rinde y lo informa (no se queda trabado)", async () => {
  respuestas = [429, 429, 429, 429];
  const r = await mandar();
  assert.deepStrictEqual([r.ok, llamadas], [false, 3]);
});

test("un rechazo que no es de límite (por ejemplo una dirección inválida) no se reintenta; el éxito a la primera tampoco", async () => {
  respuestas = [422];
  assert.deepStrictEqual([(await mandar()).ok, llamadas], [false, 1]);
  llamadas = 0; respuestas = [];
  const r = await mandar();
  assert.deepStrictEqual([r.ok, r.reintentos, llamadas], [true, undefined, 1]);
});
