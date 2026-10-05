"use strict";
// Cliente de la API de socios (ITI/Tuti): mapeo de respuestas y reglas de la guía del
// proveedor (404 = no concluyente, 401 = no reintentar en loop, timeout corto).
// fetch simulado — estos tests NO tocan la API real.
process.env.TUTI_API_KEY = "test-api-key";
process.env.TUTI_MERCHANT_KEY = "test-merchant-key";
process.env.TUTI_TIMEOUT_MS = "200";

const { test } = require("node:test");
const assert = require("node:assert");
const tuti = require("../lib/tuti");

const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const socio200 = (extra = {}) => resp(200, {
  documentNumber: "1234567", documentType: "CI", firstName: "Juan", lastName: "Pérez",
  subscriptionNumber: 62868, phoneNumber: "+595981111111", email: "JUAN@Ejemplo.com",
  plan: "PLAN_PERSONAL", paymentModality: "MONTHLY_SUBSCRIPTION", autoDebitEnabled: true,
  status: "ACTIVE", debtor: false, totalDebt: 0, ...extra,
});

test("esAlDia: ACTIVE y LIFETIME sí; mora y bajas no", () => {
  for (const s of ["ACTIVE", "LIFETIME", "active"]) assert.strictEqual(tuti.esAlDia(s), true, s);
  for (const s of ["DEBT", "INACTIVE", "UNSUBSCRIBED", "", undefined, null]) assert.strictEqual(tuti.esAlDia(s), false, String(s));
});

test("200: normaliza el socio y manda las dos credenciales", async () => {
  let visto;
  const r = await tuti.consultarSocio("1.234.567", { fetchImpl: async (url, opts) => { visto = { url, opts }; return socio200(); } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.encontrado, true);
  assert.strictEqual(r.socio.alDia, true);
  assert.strictEqual(r.socio.numeroSocio, "62868");
  assert.strictEqual(r.socio.email, "juan@ejemplo.com");
  assert.match(visto.url, /documentNumber=1234567$/, "la cédula va sólo con dígitos");
  assert.strictEqual(visto.opts.headers["X-Api-Key"], "test-api-key");
  assert.strictEqual(visto.opts.headers["X-Merchant-Key"], "test-merchant-key");
});

test("200 con DEBT: encontrado pero NO al día", async () => {
  const r = await tuti.consultarSocio("1234567", { fetchImpl: async () => socio200({ status: "DEBT", debtor: true, totalDebt: 90000 }) });
  assert.strictEqual(r.encontrado, true);
  assert.strictEqual(r.socio.alDia, false);
  assert.strictEqual(r.socio.deudor, true);
  assert.strictEqual(r.socio.deuda, 90000);
});

test("404: no concluyente (puede ser adherente) — no es un error", async () => {
  const r = await tuti.consultarSocio("4037682", { fetchImpl: async () => resp(404, { errors: [{ code: "SUB-027" }] }) });
  assert.deepStrictEqual(r, { ok: true, encontrado: false });
});

test("cédula inválida: ni siquiera consulta", async () => {
  let llamadas = 0;
  const r = await tuti.consultarSocio("12", { fetchImpl: async () => { llamadas++; return socio200(); } });
  assert.strictEqual(llamadas, 0);
  assert.strictEqual(r.encontrado, false);
});

test("timeout: falla suave (ok:false) para que quien llama use el padrón", async () => {
  const lento = (_url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => { const e = new Error("abortado"); e.name = "AbortError"; rej(e); }));
  const t0 = Date.now();
  const r = await tuti.consultarSocio("1234567", { fetchImpl: lento });
  assert.deepStrictEqual(r, { ok: false, motivo: "timeout" });
  assert.ok(Date.now() - t0 < 1500, "corta cerca del plazo, no se cuelga");
});

test("error de red: falla suave, no lanza", async () => {
  const r = await tuti.consultarSocio("1234567", { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.deepStrictEqual(r, { ok: false, motivo: "red" });
});

test("500 del proveedor: falla suave", async () => {
  const r = await tuti.consultarSocio("1234567", { fetchImpl: async () => resp(500, {}) });
  assert.deepStrictEqual(r, { ok: false, motivo: "http_500" });
});

test("429: respeta Retry-After y no vuelve a golpear la API mientras dura", async () => {
  tuti.__resetBloqueo();
  let llamadas = 0;
  const f = async () => { llamadas++; return { status: 429, ok: false, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "20" : null) }, json: async () => ({}) }; };
  const a = await tuti.consultarSocio("1234567", { fetchImpl: f });
  const b = await tuti.consultarSocio("7654321", { fetchImpl: f });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.motivo, "limite");
  assert.strictEqual(a.reintentarEnMs, 20000, "usa el Retry-After del proveedor");
  assert.strictEqual(b.motivo, "limite");
  assert.ok(b.reintentarEnMs > 0 && b.reintentarEnMs <= 20000);
  assert.strictEqual(llamadas, 1, "la 2ª consulta ni salió a la red");
  tuti.__resetBloqueo();
});

// Va al final: el 401 bloquea las consultas 5 min dentro del proceso (a propósito).
test("401: no se reintenta en loop — la 2ª consulta ni sale a la red", async () => {
  tuti.__resetBloqueo();
  let llamadas = 0;
  const f = async () => { llamadas++; return resp(401, {}); };
  const a = await tuti.consultarSocio("1234567", { fetchImpl: f });
  const b = await tuti.consultarSocio("7654321", { fetchImpl: f });
  assert.deepStrictEqual(a, { ok: false, motivo: "credenciales" });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.motivo, "credenciales");
  assert.ok(b.reintentarEnMs > 0, "informa cuánto falta para volver a intentar");
  assert.strictEqual(llamadas, 1, "sólo el primer intento llegó al proveedor");
  tuti.__resetBloqueo();
});
