"use strict";
// Compositor de campañas: validación, render seguro, audiencia, envío por tandas, bajas, cancelación y permisos.
// Nada sale a internet: el correo y el WhatsApp se reemplazan por espías.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.CAMPANAS_PAUSA_MS = "0";
process.env.CAMPANAS_ACTIVAS = "1";
delete process.env.GHL_WHATSAPP_URL;

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const campanas = require("../lib/campanas");
const app = require("../server");
const { getStore } = require("../data/store");
const adminAuth = require("../lib/admin-auth");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function socios(marca, lista) {
  const out = [];
  for (const extra of lista) {
    const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `${marca}-${++n}@ejemplo.com`, password: "clave-larga-123", nombre: extra.nombre || "Hincha", apellido: "Prueba" } });
    const j = await r.json();
    if (extra.baja) await store.updateSocio(j.socio.id, { marketing_baja: true });
    if (extra.telefono) await store.updateSocio(j.socio.id, { telefono: extra.telefono });
    out.push({ id: j.socio.id, email: `${marca}-${n}@ejemplo.com` });
  }
  return out;
}
const marcaUnica = () => "camp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const textoOk = { asunto: "Hola {{nombre}}, una novedad", titulo: "Novedad del club", cuerpo: "Hola {{nombre}},\n\nTenemos algo para contarte sobre tu nivel {{nivel}}.", cta_texto: "Ver novedades", cta_url: "/miembro" };
const enviar = (marca, extra = {}) => api("/admin/campanas/enviar", { metodo: "POST", h: OWNER, cuerpo: { nombre: "Prueba " + marca, canal: "email", plantilla: "novedad", ...textoOk, filtros: { q: marca }, ...extra } });

test("validarCampos: pide asunto y mensaje, y el link del botón solo puede ser una ruta del sitio o https", () => {
  assert.strictEqual(campanas.validarCampos({ ...textoOk, asunto: "ab" }).ok, false);
  assert.strictEqual(campanas.validarCampos({ ...textoOk, cuerpo: "corto" }).ok, false);
  for (const mala of ["javascript:alert(1)", "http://insegura.com", "//otro-sitio.com/x", "data:text/html,x", "mailto:a@b.com"]) {
    assert.strictEqual(campanas.validarCampos({ ...textoOk, cta_url: mala }).ok, false, mala);
  }
  for (const buena of ["/miembro/beneficios", "https://www.olimpistas.com/x"]) assert.strictEqual(campanas.validarCampos({ ...textoOk, cta_url: buena }).ok, true, buena);
  assert.strictEqual(campanas.validarCampos({ ...textoOk, cta_texto: "Ir", cta_url: "" }).ok, false, "un botón sin link no vale");
});

test("el correo reemplaza {{nombre}} y {{nivel}}, lleva el link de baja y escapa el HTML que escriba el club", () => {
  const c = campanas.validarCampos({ ...textoOk, cuerpo: "Hola {{nombre}} <script>alert(1)</script>\n\nTu nivel: {{nivel}}" }).campos;
  const r = campanas.renderEmail(c, { id: "soc_1", nombre: "marcos", tier_slug: "premium" });
  assert.strictEqual(r.subject, "Hola Marcos, una novedad");
  assert.ok(r.html.includes("Hola Marcos"));
  assert.ok(r.html.includes("Olimpista Plus"));
  assert.ok(!r.html.includes("<script>alert(1)"), "el HTML del club se escapa");
  assert.ok(r.html.includes("&lt;script&gt;"));
  assert.match(r.html, /api\/baja\?u=/, "link de baja a la vista");
  assert.ok(r.headers && r.headers["List-Unsubscribe"], "headers de baja con un clic");
  const wa = campanas.renderWhatsApp(c, { id: "soc_1", nombre: "marcos", tier_slug: "premium" });
  assert.match(wa, /Ver novedades: https?:\/\/.*\/miembro/);
  assert.match(wa, /api\/baja\?u=/);
});

test("audiencia: cuenta quién recibe y por qué se excluye a los demás (bajas, sin teléfono)", async () => {
  const marca = marcaUnica();
  await socios(marca, [{ telefono: "0981123456" }, { baja: true, telefono: "0981999999" }, {}]);
  const mail = await (await api("/admin/campanas/audiencia", { metodo: "POST", h: OWNER, cuerpo: { canal: "email", filtros: { q: marca } } })).json();
  assert.strictEqual(mail.total, 3);
  assert.strictEqual(mail.reciben, 2);
  assert.strictEqual(mail.excluidos.baja, 1);
  const wa = await (await api("/admin/campanas/audiencia", { metodo: "POST", h: OWNER, cuerpo: { canal: "whatsapp", filtros: { q: marca } } })).json();
  assert.strictEqual(wa.reciben, 1, "solo uno tiene teléfono y no está de baja");
  assert.strictEqual(wa.excluidos.sin_telefono, 1);
  assert.strictEqual((await api("/admin/campanas/audiencia", { metodo: "POST", h: OWNER, cuerpo: { canal: "email" } })).status, 400, "sin a quién no se calcula nada");
});

test("enviar: exige que el total coincida con lo que se mostró, congela la lista y el cron la manda por tandas sin tocar a quien se dio de baja", async () => {
  const marca = marcaUnica();
  const [a, b, baja] = await socios(marca, [{ nombre: "ana" }, { nombre: "beto" }, { baja: true }]);
  assert.strictEqual((await enviar(marca, { total_esperado: 5 })).status, 409, "total distinto al que vio el club");
  const ok = await enviar(marca, { total_esperado: 2 });
  assert.strictEqual(ok.status, 201);
  const j = await ok.json();
  assert.strictEqual(j.total, 2);
  assert.strictEqual(j.excluidos.baja, 1);
  assert.strictEqual((await enviar(marca, { total_esperado: 2 })).status, 409, "el doble clic no duplica la campaña");

  const enviados = [];
  const r1 = await campanas.procesarLote({ store, enviarEmail: async (m) => { enviados.push(m); return { ok: true }; } });
  assert.strictEqual(r1.enviados, 2);
  assert.deepStrictEqual(enviados.map((m) => m.to).sort(), [a.email, b.email].sort());
  assert.ok(!enviados.some((m) => m.to === baja.email), "el que se dio de baja nunca recibe");
  assert.ok(enviados.every((m) => m.headers && m.headers["List-Unsubscribe"]));
  assert.ok(enviados.some((m) => m.subject === "Hola Ana, una novedad"));
  // segunda corrida: no manda nada más (cada envío se reclama una sola vez)
  const r2 = await campanas.procesarLote({ store, enviarEmail: async () => { throw new Error("no debería enviar"); } });
  assert.strictEqual(r2.enviados, 0);
  const d = await (await api("/admin/campanas/" + j.id, { h: OWNER })).json();
  assert.strictEqual(d.campana.estado, "enviada");
  assert.strictEqual(d.conteo.enviado, 2);
});

test("si alguien se da de baja DESPUÉS de armar la campaña, no recibe nada (se omite)", async () => {
  const marca = marcaUnica();
  const [x, y] = await socios(marca, [{}, {}]);
  const j = await (await enviar(marca, { total_esperado: 2 })).json();
  await store.updateSocio(y.id, { marketing_baja: true });
  const enviados = [];
  const r = await campanas.procesarLote({ store, enviarEmail: async (m) => { enviados.push(m.to); return { ok: true }; } });
  assert.deepStrictEqual(enviados, [x.email]);
  assert.strictEqual(r.omitidos, 1);
  const d = await (await api("/admin/campanas/" + j.id, { h: OWNER })).json();
  assert.strictEqual(d.conteo.omitido, 1);
});

test("los envíos que fallan quedan marcados con su motivo y la campaña igual termina", async () => {
  const marca = marcaUnica();
  await socios(marca, [{}, {}]);
  const j = await (await enviar(marca, { total_esperado: 2 })).json();
  let i = 0;
  const r = await campanas.procesarLote({ store, enviarEmail: async () => (++i === 1 ? { ok: false } : { ok: true }) });
  assert.strictEqual(r.enviados, 1);
  assert.strictEqual(r.fallidos, 1);
  const d = await (await api("/admin/campanas/" + j.id, { h: OWNER })).json();
  assert.strictEqual(d.campana.estado, "enviada");
  assert.strictEqual(d.conteo.fallido, 1);
  assert.strictEqual(d.fallos.length, 1);
});

test("cancelar: lo que no salió se omite y no se manda", async () => {
  const marca = marcaUnica();
  await socios(marca, [{}, {}, {}]);
  const j = await (await enviar(marca, { total_esperado: 3 })).json();
  assert.strictEqual((await api("/admin/campanas/" + j.id + "/cancelar", { metodo: "POST", h: OWNER })).status, 200);
  const r = await campanas.procesarLote({ store, enviarEmail: async () => { throw new Error("no debería enviar"); } });
  assert.strictEqual(r.enviados, 0);
  const d = await (await api("/admin/campanas/" + j.id, { h: OWNER })).json();
  assert.strictEqual(d.campana.estado, "cancelada");
  assert.strictEqual(d.conteo.omitido, 3);
  assert.strictEqual((await api("/admin/campanas/" + j.id + "/cancelar", { metodo: "POST", h: OWNER })).status, 409, "no se cancela dos veces");
});

test("WhatsApp: sin conexión no se puede lanzar; conectado, sale al teléfono limpio con el link de baja", async () => {
  const marca = marcaUnica();
  await socios(marca, [{ telefono: "+595 981 123-456" }, {}]);
  assert.strictEqual((await enviar(marca, { canal: "whatsapp", total_esperado: 1 })).status, 400, "falta GHL_WHATSAPP_URL");
  process.env.GHL_WHATSAPP_URL = "https://hooks.ghl.example/wa";
  try {
    const j = await (await enviar(marca, { canal: "whatsapp", total_esperado: 1 })).json();
    assert.strictEqual(j.total, 1);
    const mandados = [];
    await campanas.procesarLote({ store, enviarWhatsApp: async (m) => { mandados.push(m); return { ok: true }; }, enviarEmail: async () => { throw new Error("un WhatsApp no manda correo"); } });
    assert.strictEqual(mandados.length, 1);
    assert.strictEqual(mandados[0].telefono, "595981123456");
    assert.match(mandados[0].texto, /api\/baja\?u=/);
  } finally { delete process.env.GHL_WHATSAPP_URL; }
});

test("vista previa y prueba: la vista previa no manda nada; la prueba va solo al correo indicado y lleva [PRUEBA]", async () => {
  const mailer = require("../lib/email");
  const real = mailer.enviar;
  const salida = [];
  mailer.enviar = async (m) => { salida.push(m); return { ok: true, modo: "simulado" }; };
  try {
    const vp = await (await api("/admin/campanas/vista-previa", { metodo: "POST", h: OWNER, cuerpo: textoOk })).json();
    assert.ok(vp.html.includes("Hola Marcos") && vp.whatsapp.includes("Marcos"));
    assert.strictEqual(salida.length, 0);
    assert.strictEqual((await api("/admin/campanas/prueba", { metodo: "POST", h: OWNER, cuerpo: { ...textoOk, a: "no-es-un-correo" } })).status, 400);
    const p = await api("/admin/campanas/prueba", { metodo: "POST", h: OWNER, cuerpo: { ...textoOk, a: "yo@ejemplo.com" } });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(salida.length, 1);
    assert.strictEqual(salida[0].to, "yo@ejemplo.com");
    assert.match(salida[0].subject, /^\[PRUEBA\]/);
  } finally { mailer.enviar = real; }
});

test("permisos: marketing puede lanzar; lectura solo mira; sin sesión no entra; el cron exige su token", async () => {
  const marca = marcaUnica();
  await socios(marca, [{}]);
  const mk = `mk-${++n}@ejemplo.com`, le = `le-${++n}@ejemplo.com`;
  await adminAuth.crearAdminUsuario({ usuario: mk, nombre: mk, password: "clave-de-prueba-1", rol: "marketing" });
  await adminAuth.crearAdminUsuario({ usuario: le, nombre: le, password: "clave-de-prueba-1", rol: "lectura" });
  const tok = async (u) => ({ "x-admin-token": (await (await api("/admin/login", { metodo: "POST", cuerpo: { usuario: u, password: "clave-de-prueba-1" } })).json()).token });
  const hLectura = await tok(le), hMarketing = await tok(mk);
  const cuerpo = { nombre: "x", canal: "email", ...textoOk, filtros: { q: marca }, total_esperado: 1 };
  assert.strictEqual((await api("/admin/campanas/enviar", { metodo: "POST", h: hLectura, cuerpo })).status, 403);
  assert.strictEqual((await api("/admin/campanas/audiencia", { metodo: "POST", h: hLectura, cuerpo })).status, 200, "mirar la audiencia sí");
  assert.strictEqual((await api("/admin/campanas/enviar", { metodo: "POST", cuerpo })).status, 401);
  assert.strictEqual((await api("/admin/campanas/enviar", { metodo: "POST", h: hMarketing, cuerpo })).status, 201);
  assert.strictEqual((await api("/cron/campanas", { metodo: "POST" })).status, 401);
  assert.strictEqual((await api("/cron/campanas", { metodo: "POST", h: { "x-cron-token": "secreto-de-cron-de-prueba" } })).status, 200);
});

test("interruptor general: sin CAMPANAS_ACTIVAS no se prueba ni se envía nada y el cron no manda, pero se puede armar y ver la vista previa", async () => {
  const marca = marcaUnica();
  await socios(marca, [{}, {}]);
  const j = await (await enviar(marca, { total_esperado: 2 })).json(); // armada con las campañas activas
  delete process.env.CAMPANAS_ACTIVAS;
  try {
    assert.strictEqual((await api("/admin/campanas/plantillas", { h: OWNER }).then((r) => r.json())).activas, false);
    assert.strictEqual((await api("/admin/campanas/vista-previa", { metodo: "POST", h: OWNER, cuerpo: textoOk })).status, 200, "la vista previa sigue");
    assert.strictEqual((await api("/admin/campanas/audiencia", { metodo: "POST", h: OWNER, cuerpo: { canal: "email", filtros: { q: marca } } })).status, 200);
    for (const [ruta, cuerpo] of [["/admin/campanas/enviar", { nombre: "x", canal: "email", ...textoOk, filtros: { q: marca }, total_esperado: 2 }], ["/admin/campanas/prueba", { ...textoOk, a: "yo@ejemplo.com" }]]) {
      const r = await api(ruta, { metodo: "POST", h: OWNER, cuerpo });
      assert.strictEqual(r.status, 403, ruta);
      assert.match((await r.json()).error, /todavía no están activas/);
    }
    const r = await campanas.procesarLote({ store, enviarEmail: async () => { throw new Error("apagado: no debería enviar"); } });
    assert.strictEqual(r.pausado, true);
    assert.strictEqual(r.enviados, 0);
    const d = await (await api("/admin/campanas/" + j.id, { h: OWNER })).json();
    assert.strictEqual(d.conteo.pendiente, 2, "lo armado queda esperando");
  } finally { process.env.CAMPANAS_ACTIVAS = "1"; }
  const r2 = await campanas.procesarLote({ store, enviarEmail: async () => ({ ok: true }) });
  assert.ok(r2.enviados >= 2, "al encender el interruptor, sale");
});
