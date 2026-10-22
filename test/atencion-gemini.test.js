"use strict";
// Atención con IA: Gemini como motor principal y Anthropic como respaldo. Todo se simula interceptando fetch:
// ningún test sale a internet ni gasta crédito.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const atencion = require("../lib/atencion");

const URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/";
const URL_ANTHROPIC = "https://api.anthropic.com/v1/messages";
const respuesta = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
const gTexto = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }] });
const gUsa = (name, args = {}, extra = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args }, ...extra }] } }] });
const aTexto = (t) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

let llamadas, guionGemini, guionAnthropic;
function fetchSimulado(u, opts) {
  const cuerpo = JSON.parse(opts.body);
  if (String(u).startsWith(URL_GEMINI)) { llamadas.push({ proveedor: "gemini", url: String(u), headers: opts.headers, cuerpo }); return Promise.resolve(guionGemini(cuerpo)); }
  if (String(u) === URL_ANTHROPIC) { llamadas.push({ proveedor: "anthropic", url: String(u), headers: opts.headers, cuerpo }); return Promise.resolve(guionAnthropic(cuerpo)); }
  throw new Error("salida a internet no esperada: " + u);
}
const ENV = { GEMINI_API_KEY: "AIza-de-prueba", ANTHROPIC_API_KEY: "sk-ant-de-prueba" };
beforeEach(() => { llamadas = []; guionGemini = async () => respuesta(gTexto("Hola desde Gemini.")); guionAnthropic = async () => respuesta(aTexto("Hola desde Anthropic.")); });

const H = (texto) => ({ de: "hincha", texto });
const ejecutores = (extra = {}) => ({
  consultar_cuenta: async () => ({ resultado: { puntos: 120, escalon: "Plata" } }),
  derivar_a_humano: async () => ({ resultado: { ok: true } }),
  ...extra,
});

test("proveedores: Gemini va primero; sin su clave queda Anthropic; sin ninguna, nada (responde por palabras clave)", () => {
  assert.deepStrictEqual(atencion.proveedores(ENV).map((p) => p.nombre), ["gemini", "anthropic"]);
  assert.deepStrictEqual(atencion.proveedores({ ...ENV, ATENCION_PROVEEDOR: "anthropic" }).map((p) => p.nombre), ["anthropic", "gemini"]);
  assert.deepStrictEqual(atencion.proveedores({ ANTHROPIC_API_KEY: "x" }).map((p) => p.nombre), ["anthropic"]);
  assert.deepStrictEqual(atencion.proveedores({ GOOGLE_API_KEY: "x" }).map((p) => p.nombre), ["gemini"]);
  assert.deepStrictEqual(atencion.proveedores({}), []);
  assert.strictEqual(atencion.crearLlamador({}), null);
  assert.strictEqual(atencion.proveedores({ GEMINI_API_KEY: "x", ATENCION_MODELO_GEMINI: "gemini-x" })[0].modelo, "gemini-x");
  assert.strictEqual(atencion.proveedores({ GEMINI_API_KEY: "x" })[0].modelo, "gemini-flash-latest");
});

test("Gemini: la clave va en la cabecera (no en la URL), con la instrucción del sistema, el voseo y las herramientas traducidas", async () => {
  const llamar = atencion.crearLlamador({ GEMINI_API_KEY: "AIza-de-prueba" }, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("hola")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(out.texto, "Hola desde Gemini.");
  assert.strictEqual(out.via, "ia");
  assert.strictEqual(out.proveedor, "gemini");
  const c = llamadas[0];
  assert.strictEqual(c.url, URL_GEMINI + "gemini-flash-latest:generateContent");
  assert.ok(!c.url.includes("AIza"), "la clave no viaja en la URL");
  assert.strictEqual(c.headers["x-goog-api-key"], "AIza-de-prueba");
  assert.ok(c.cuerpo.systemInstruction.parts[0].text.includes("Sos el asistente de Olimpistas.com"));
  assert.deepStrictEqual(c.cuerpo.contents, [{ role: "user", parts: [{ text: "hola" }] }]);
  assert.ok(c.cuerpo.generationConfig.maxOutputTokens >= 1024, "margen para el razonamiento del modelo");
  const decl = c.cuerpo.tools[0].functionDeclarations;
  assert.ok(!("parameters" in decl.find((d) => d.name === "consultar_cuenta")), "sin parámetros: Gemini rechaza un objeto vacío");
  const derivar = decl.find((d) => d.name === "derivar_a_humano");
  assert.strictEqual(derivar.parameters.type, "OBJECT");
  assert.strictEqual(derivar.parameters.properties.motivo.type, "STRING");
  assert.deepStrictEqual(derivar.parameters.required, ["motivo"]);
  assert.ok(!decl.some((d) => d.name === "liberar_lugar"), "una herramienta no disponible no se ofrece");
});

test("Gemini: llama a una herramienta, recibe el resultado y contesta; devuelve su parte original con la firma de pensamiento", async () => {
  let paso = 0;
  guionGemini = async () => (++paso === 1 ? respuesta(gUsa("consultar_cuenta", {}, { thoughtSignature: "FIRMA-123" })) : respuesta(gTexto("Tenés 120 puntos.")));
  const llamar = atencion.crearLlamador({ GEMINI_API_KEY: "k" }, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("¿cuántos puntos tengo?")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(out.texto, "Tenés 120 puntos.");
  assert.strictEqual(llamadas.length, 2);
  const turno2 = llamadas[1].cuerpo.contents;
  assert.deepStrictEqual(turno2[1], { role: "model", parts: [{ functionCall: { name: "consultar_cuenta", args: {} }, thoughtSignature: "FIRMA-123" }] });
  assert.deepStrictEqual(turno2[2], { role: "user", parts: [{ functionResponse: { name: "consultar_cuenta", response: { puntos: 120, escalon: "Plata" } } }] });
});

test("Gemini: derivar a una persona funciona y los argumentos llegan a la herramienta", async () => {
  let paso = 0, recibido = null;
  guionGemini = async () => (++paso === 1 ? respuesta(gUsa("derivar_a_humano", { motivo: "Reclamo por una subasta" })) : respuesta(gTexto("Listo, te paso con una persona.")));
  const llamar = atencion.crearLlamador({ GEMINI_API_KEY: "k" }, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("quiero reclamar")], ejecutores: ejecutores({ derivar_a_humano: async (i) => { recibido = i; return { resultado: { ok: true } }; } }), llamar });
  assert.strictEqual(out.derivado, true);
  assert.deepStrictEqual(recibido, { motivo: "Reclamo por una subasta" });
});

test("Gemini: el razonamiento interno del modelo no se muestra al hincha", async () => {
  guionGemini = async () => respuesta({ candidates: [{ content: { parts: [{ text: "Pensando en voz alta…", thought: true }, { text: "Hola, ¿en qué te ayudo?" }] } }] });
  const llamar = atencion.crearLlamador({ GEMINI_API_KEY: "k" }, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("hola")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(out.texto, "Hola, ¿en qué te ayudo?");
});

test("si Gemini falla, contesta Anthropic (y se sabe cuál); si fallan los dos, respuesta por palabras clave", async () => {
  guionGemini = async () => respuesta({ error: "overloaded" }, 503);
  const llamar = atencion.crearLlamador(ENV, async (u, o) => fetchSimulado(u, o));
  const a = await atencion.responder({ historial: [H("hola")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(a.texto, "Hola desde Anthropic.");
  assert.strictEqual(a.proveedor, "anthropic");
  assert.deepStrictEqual(llamadas.map((l) => l.proveedor), ["gemini", "anthropic"]);

  guionAnthropic = async () => respuesta({ error: "x" }, 500);
  const b = await atencion.responder({ historial: [H("¿cómo pago mi cuota?")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(b.via, "respaldo");
  assert.match(b.texto, /ITTI/);
});

test("Gemini sin candidatos (bloqueo de seguridad) cae al respaldo en vez de dejar al hincha sin respuesta", async () => {
  guionGemini = async () => respuesta({ promptFeedback: { blockReason: "SAFETY" } });
  const llamar = atencion.crearLlamador({ GEMINI_API_KEY: "k" }, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("¿cuántos puntos tengo?")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(out.via, "respaldo");
  assert.ok(out.texto.length > 10);
});

test("cambio de motor a mitad de una consulta: a Anthropic no le llega el campo interno de Gemini", async () => {
  let paso = 0;
  guionGemini = async () => (++paso === 1 ? respuesta(gUsa("consultar_cuenta", {}, { thoughtSignature: "F" })) : respuesta({ error: "caído" }, 500));
  const llamar = atencion.crearLlamador(ENV, async (u, o) => fetchSimulado(u, o));
  const out = await atencion.responder({ historial: [H("¿cuántos puntos tengo?")], ejecutores: ejecutores(), llamar });
  assert.strictEqual(out.proveedor, "anthropic");
  const aAnthropic = llamadas.find((l) => l.proveedor === "anthropic").cuerpo;
  const bloque = aAnthropic.messages[1].content[0];
  assert.strictEqual(bloque.type, "tool_use");
  assert.ok(!Object.keys(bloque).some((k) => k.startsWith("_")), "sin campos internos: Anthropic los rechazaría");
});

// ── API: el chat del hincha usa Gemini y la bandeja muestra qué motor contestó ───────────────────────────────
const app = require("../server");
let srv, url;
const fetchReal = global.fetch;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => { srv && srv.close(); global.fetch = fetchReal; delete process.env.GEMINI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.ATENCION_PROVEEDOR; });

test("API: con GEMINI_API_KEY el chat contesta con Gemini y el panel lo informa", async () => {
  process.env.GEMINI_API_KEY = "AIza-de-prueba"; delete process.env.ANTHROPIC_API_KEY;
  global.fetch = (u, o) => (String(u).startsWith(URL_GEMINI) || String(u) === URL_ANTHROPIC ? fetchSimulado(u, o) : fetchReal(u, o));
  const reg = await (await fetch(url + "/api/auth/registro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "gem" + Date.now() + "@ejemplo.com", password: "clave-larga-123", nombre: "Gema", apellido: "Prueba" }) })).json();
  const h = { "Content-Type": "application/json", Authorization: "Bearer " + reg.token, Cookie: "olimpista_sess=" + reg.token };
  const j = await (await fetch(url + "/api/atencion/chat", { method: "POST", headers: h, body: JSON.stringify({ texto: "hola" }) })).json();
  const ia = j.mensajes.find((m) => m.de === "ia");
  assert.strictEqual(ia.texto, "Hola desde Gemini.");
  assert.strictEqual(ia.meta.via, "ia");
  assert.strictEqual(ia.meta.proveedor, "gemini");
  assert.strictEqual(llamadas.filter((l) => l.proveedor === "anthropic").length, 0);
  const cfg = await (await fetch(url + "/api/admin/atencion/config", { headers: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  assert.strictEqual(cfg.ia_conectada, true);
  assert.strictEqual(cfg.proveedor, "gemini");
  assert.strictEqual(cfg.modelo, "gemini-flash-latest");
  const integ = await (await fetch(url + "/api/admin/integraciones", { headers: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  assert.strictEqual(integ.items.find((i) => i.id === "ia").estado, "conectado");
});
