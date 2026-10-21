"use strict";
// Arreglos de seguridad de la auditoría 2026-10-21 (Ola 1). Cada test reproduce el fallo
// original y comprueba que ya no ocurre.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-vieja-de-prueba";
process.env.UNSUB_SECRET = "secreto-de-bajas-nuevo-de-prueba";
process.env.APP_URL = "https://www.olimpistas.com";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

// ── Bajas de marketing ───────────────────────────────────────────────────────
const email = require("../lib/email");
const firmarCon = (clave, id) => `${id}.${crypto.createHmac("sha256", clave).update(id).digest("hex").slice(0, 24)}`;

test("baja: el token nuevo se firma con UNSUB_SECRET y valida", () => {
  const t = email.unsubUrl("soc_abc").split("u=")[1];
  const token = decodeURIComponent(t);
  assert.strictEqual(email.unsubValido(token), "soc_abc");
  assert.notStrictEqual(token, firmarCon(process.env.ADMIN_KEY, "soc_abc"), "ya NO se firma con ADMIN_KEY");
  assert.strictEqual(token, firmarCon(process.env.UNSUB_SECRET, "soc_abc"));
});

test("baja: los links ya enviados (firmados con ADMIN_KEY) siguen funcionando — transición", () => {
  assert.strictEqual(email.unsubValido(firmarCon(process.env.ADMIN_KEY, "soc_viejo")), "soc_viejo");
});

test("baja: forjar un token con el literal público o con una clave cualquiera NO sirve", () => {
  assert.strictEqual(email.unsubValido(firmarCon("olimpistas-unsub-v1", "soc_victima")), null);
  assert.strictEqual(email.unsubValido(firmarCon("otra-clave", "soc_victima")), null);
  assert.strictEqual(email.unsubValido("soc_victima.000000000000000000000000"), null);
});

test("baja: token alterado, vacío o sin firma → null (no lanza)", () => {
  const ok = firmarCon(process.env.UNSUB_SECRET, "soc_x");
  const alterado = ok.slice(0, -1) + (ok.endsWith("a") ? "b" : "a");
  assert.strictEqual(email.unsubValido(ok), "soc_x", "precondición: el original valida");
  assert.strictEqual(email.unsubValido(alterado), null, "un solo carácter distinto invalida");
  for (const malo of ["", null, undefined, "sinpunto", ".", "soc_x.", "soc_x.corto"]) assert.strictEqual(email.unsubValido(malo), null, String(malo));
});

// ── URL pública fija (no Host) ───────────────────────────────────────────────
const { baseUrl } = require("../lib/url");

test("url: baseUrl sale de APP_URL, sin barra final, con default de producción", () => {
  assert.strictEqual(baseUrl(), "https://www.olimpistas.com");
  const previa = process.env.APP_URL;
  process.env.APP_URL = "https://staging.example.test///";
  assert.strictEqual(baseUrl(), "https://staging.example.test");
  delete process.env.APP_URL;
  assert.strictEqual(baseUrl(), "https://www.olimpistas.com");
  process.env.APP_URL = previa;
});

// ── Servidor real: Host falso, cookie rota, tokens fuera de las respuestas ──
const app = require("../server");
const { getStore } = require("../data/store");

function servir() {
  return new Promise((res) => { const srv = app.listen(0, () => res(srv)); });
}
const post = (srv, ruta, body, headers = {}) =>
  fetch(`http://127.0.0.1:${srv.address().port}${ruta}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("cookie con % suelto ya NO tira 500 (antes rompía la home)", async () => {
  const srv = await servir();
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { headers: { Cookie: "a=%; b=%E0%A4%A" } });
    assert.ok(r.status < 500, "status " + r.status);
    const r2 = await fetch(`http://127.0.0.1:${srv.address().port}/api/config`, { headers: { Cookie: "olimpista_sess=%" } });
    assert.strictEqual(r2.status, 200);
  } finally { srv.close(); }
});

test("reset de contraseña: el link usa APP_URL aunque el atacante mande otro Host", async () => {
  const srv = await servir();
  const enviados = [];
  const original = email.enviar;
  // El router llama a mailer.enviarReset → enviar(); lo interceptamos en el módulo ya cargado.
  const mailer = require("../lib/email");
  const origReset = mailer.enviarReset;
  mailer.enviarReset = async (socio, link) => { enviados.push(link); return { ok: true }; };
  try {
    const store = getStore();
    const bcrypt = require("bcrypt");
    const socio = await store.createSocio({ email: "victima@ejemplo.com", passwordHash: await bcrypt.hash("clave-larga-123", 4), nombre: "Víctima" });
    const r = await post(srv, "/api/auth/recuperar", { email: "victima@ejemplo.com" }, { Host: "evil.example" });
    assert.ok(r.status < 500, "status " + r.status);
    await new Promise((x) => setTimeout(x, 200));
    assert.ok(enviados.length >= 1, "se pidió el correo de reset");
    assert.match(enviados[0], /^https:\/\/www\.olimpistas\.com\/reset\?token=/, enviados[0]);
    assert.ok(!enviados[0].includes("evil.example"), "el Host falso NO entra al link");
    assert.ok(socio.id);
  } finally { mailer.enviarReset = origReset; srv.close(); }
});

test("respuestas de API: /auth/yo y el registro no devuelven tokens ni hashes", async () => {
  const srv = await servir();
  try {
    const r = await post(srv, "/api/auth/registro", { email: "nuevo.hotfix@ejemplo.com", password: "clave-larga-123", nombre: "Ana" });
    assert.strictEqual(r.status, 201);
    const cuerpo = await r.json();
    for (const campo of ["password_hash", "password", "reset_token", "reset_token_exp", "verif_token", "carnet_secreto"])
      assert.ok(!(campo in cuerpo.socio), "el registro NO debe devolver " + campo);

    // Se pide un reset (deja reset_token guardado en la cuenta) y se vuelve a leer /auth/yo con la sesión.
    await post(srv, "/api/auth/recuperar", { email: "nuevo.hotfix@ejemplo.com" });
    await new Promise((x) => setTimeout(x, 200));
    const guardado = await getStore().getSocioByEmail("nuevo.hotfix@ejemplo.com");
    assert.ok(guardado.reset_token, "precondición: el reset_token existe en la base");
    const yo = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/yo`, { headers: { Authorization: "Bearer " + cuerpo.token, Cookie: "olimpista_sess=" + cuerpo.token } });
    const txt = await yo.text();
    assert.ok(!txt.includes(guardado.reset_token), "/auth/yo NO debe contener el reset_token");
    assert.ok(!/reset_token|verif_token|password_hash/.test(txt), "ningún campo privado en /auth/yo");
  } finally { srv.close(); }
});

test("foto de perfil: solo base64 puro; un data URL con comillas/atributos se rechaza", async () => {
  const srv = await servir();
  try {
    const reg = await (await post(srv, "/api/auth/registro", { email: "foto.hotfix@ejemplo.com", password: "clave-larga-123", nombre: "Foto" })).json();
    const h = { Authorization: "Bearer " + reg.token, Cookie: "olimpista_sess=" + reg.token };
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const ok = await post(srv, "/api/perfil/foto", { foto: "data:image/png;base64," + PNG }, h);
    assert.strictEqual(ok.status, 200, "una foto válida se acepta");
    for (const malo of [
      'data:image/png;base64,AAAA" onerror="alert(1)',
      "data:image/png;base64,AAAA'><script>alert(1)</script>",
      "data:image/png;base64,AAAA AAAA",
      "data:image/png;base64,",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    ]) {
      const r = await post(srv, "/api/perfil/foto", { foto: malo }, h);
      assert.strictEqual(r.status, 400, "debe rechazar: " + malo.slice(0, 50));
    }
  } finally { srv.close(); }
});

test("cron: token incorrecto, vacío, de otro largo o ausente → 401; el correcto pasa", async () => {
  const srv = await servir();
  try {
    const llamar = (tok) => post(srv, "/api/cron/diario", {}, tok === undefined ? {} : { "x-cron-token": tok });
    for (const malo of [undefined, "", "x", "secreto-de-cron-de-prueba-y-mas", "secreto-de-cron-de-pruebA"])
      assert.strictEqual((await llamar(malo)).status, 401, "token " + JSON.stringify(malo));
    assert.notStrictEqual((await llamar("secreto-de-cron-de-prueba")).status, 401, "el token correcto pasa la puerta");
  } finally { srv.close(); }
});

test("producción (sin ENTORNO=staging): ni cartel de pruebas ni noindex", async () => {
  const srv = await servir();
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    assert.ok(!(await r.text()).includes("cartelPruebas"));
    assert.ok(!(r.headers.get("x-robots-tag") || "").includes("noindex"));
  } finally { srv.close(); }
});

test("producción: el Tuti falso NO existe (solo se monta en staging)", async () => {
  const srv = await servir();
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/_mock/tuti/bff-service/OLIMPIA/subscription/members?documentNumber=4000001`, { headers: { "X-Api-Key": "mock", "X-Merchant-Key": "mock" } });
    assert.strictEqual(r.status, 404);
  } finally { srv.close(); }
});
