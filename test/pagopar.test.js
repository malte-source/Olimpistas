"use strict";
// Validación del webhook de Pagopar: DEBE fallar-cerrado y validar la firma sha1(private + hash).
// El token de prueba se setea ANTES de requerir config/pagopar (se lee en el load).
process.env.PAGOPAR_PUBLIC_TOKEN = "pub_test";
process.env.PAGOPAR_PRIVATE_TOKEN = "priv_test_key";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const pagopar = require("../lib/pagopar");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

test("acepta el token correcto = sha1(private + hash_pedido)", () => {
  const hash = "abc123hashpedido";
  const tokenOk = sha1("priv_test_key" + hash);
  assert.equal(pagopar.validarWebhook(hash, tokenOk), true);
});

test("rechaza token inválido", () => {
  assert.equal(pagopar.validarWebhook("abc123hashpedido", "token-cualquiera"), false);
});

test("rechaza sin token o sin hash (fail-closed)", () => {
  assert.equal(pagopar.validarWebhook("hash", ""), false);
  assert.equal(pagopar.validarWebhook("", "token"), false);
  assert.equal(pagopar.validarWebhook(null, null), false);
});

test("no es vulnerable a token de otro hash (no reusa firma)", () => {
  const tokenDeOtro = sha1("priv_test_key" + "otro-hash");
  assert.equal(pagopar.validarWebhook("hash-victima", tokenDeOtro), false);
});
