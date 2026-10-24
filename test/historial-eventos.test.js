"use strict";
// Ola B: la memoria del sistema. Historial del estado del club (cuándo entró en mora, cuánto duró, cuándo pagó) y hitos del socio con fecha.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { claseClub } = require("../lib/club-estado");
const eventos = require("../lib/eventos");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined, redirect: "manual" });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
const espera = () => new Promise((x) => setTimeout(x, 40));
let n = 0;
async function cuenta(extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `he${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Hito", ...extra } });
  const { token, socio } = await r.json();
  await espera();
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const tipos = async (id) => (await store.eventosDeSocio(id)).map((e) => e.tipo);

test("claseClub: lo objetivo que dice el club, sin depender de SOCIO_MORA", () => {
  assert.strictEqual(claseClub({ estado: "LIFETIME" }), "al_dia");
  assert.strictEqual(claseClub({ estado: "ACTIVE", deuda: 0 }), "al_dia");
  assert.strictEqual(claseClub({ estado: "ACTIVE", deuda: 1000 }), "mora");
  assert.strictEqual(claseClub({ estado: "DEBT" }), "mora");
  assert.strictEqual(claseClub({ estado: "INACTIVE" }), "baja");
  assert.strictEqual(claseClub({ estado: "UNSUBSCRIBED" }), "baja");
  assert.strictEqual(claseClub({ estado: "RARO", alDia: true }), "al_dia");
  assert.strictEqual(claseClub({ estado: "RARO", alDia: false }), "baja");
});

test("historial del club: abre un tramo por cada cambio de clase, no repite si no cambió, y mide entradas, vueltas y duración de la mora", async () => {
  const ced = "9100001", e = (estado, deuda = 0, alDia = estado === "ACTIVE" || estado === "LIFETIME") => ({ estado, deuda, alDia, plan: "Socio", numero: "1" });
  await store.guardarEstadoTuti(ced, e("ACTIVE"));
  await store.guardarEstadoTuti(ced, e("ACTIVE"));                 // sin cambio: no abre otro tramo
  await store.guardarEstadoTuti(ced, e("DEBT", 150000, false));    // entra en mora
  await store.guardarEstadoTuti(ced, e("DEBT", 120000, false));    // sigue en mora: solo refresca la deuda
  await store.guardarEstadoTuti(ced, e("ACTIVE"));                 // pagó: vuelve al día
  const h = await store.historialClubDeCedula(ced);
  assert.deepStrictEqual(h.map((x) => x.clase), ["al_dia", "mora", "al_dia"], "más nuevo primero: al día, mora, al día");
  const mora = h.find((x) => x.clase === "mora");
  assert.strictEqual(mora.deuda, 120000, "la deuda se actualiza dentro del mismo tramo");
  assert.ok(mora.hasta, "el tramo de mora se cerró al pagar");
  assert.strictEqual(h.filter((x) => !x.hasta).length, 1, "un solo tramo abierto por cédula");
  const r = await store.resumenHistorialClub({ desde: new Date(Date.now() - 3600000).toISOString() });
  assert.ok(r.entraron_mora >= 1 && r.volvieron_al_dia >= 1, JSON.stringify(r));
  assert.ok(r.dias_medios_en_mora !== null && r.dias_medios_en_mora >= 0);
  await store.guardarEstadoTuti("9100002", e("ACTIVE"));
  await store.guardarEstadoTuti("9100002", e("UNSUBSCRIBED", 0, false));
  assert.deepStrictEqual((await store.historialClubDeCedula("9100002")).map((x) => x.clase), ["baja", "al_dia"]);
  await store.guardarEstadoTuti("9100003", { estado: "", deuda: 0 });
  assert.deepStrictEqual(await store.historialClubDeCedula("9100003"), [], "sin estado no se inventa un tramo");
});

test("hitos: registro, correo confirmado y foto quedan con fecha; los únicos no se repiten", async () => {
  const A = await cuenta();
  assert.ok((await tipos(A.id)).includes("registro"));
  const s = await store.getSocioById(A.id);
  assert.ok(s.verif_token || s.email_verificado !== undefined);
  if (s.verif_token) { const r = await api("/auth/verificar?token=" + encodeURIComponent(s.verif_token)); assert.ok([302, 301].includes(r.status)); await espera(); }
  assert.ok((await tipos(A.id)).includes("correo_verificado"), "al confirmar el correo");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  assert.strictEqual((await api("/perfil/foto", { metodo: "POST", h: A.h, cuerpo: { foto: png } })).status, 200);
  await api("/perfil/foto", { metodo: "POST", h: A.h, cuerpo: { foto: png } }); await espera();
  assert.deepStrictEqual((await tipos(A.id)).filter((t) => t === "foto"), ["foto"], "la foto es un hito único");
  await store.registrarEvento(A.id, "registro"); await store.registrarEvento(A.id, "registro");
  assert.strictEqual((await tipos(A.id)).filter((t) => t === "registro").length, 1);
  await store.registrarEvento(A.id, "nivel_socio_pausado", { motivo: "mora" }); await store.registrarEvento(A.id, "nivel_socio_pausado", { motivo: "baja" });
  assert.strictEqual((await tipos(A.id)).filter((t) => t === "nivel_socio_pausado").length, 2, "pausar y recuperar el nivel se repite");
  await assert.rejects(() => store.registrarEvento("soc_inexistente", "foto"), "un hito de un socio inexistente falla (las rutas lo ignoran)");
});

test("referido: quien invita recibe el hito cuando el invitado se registra", async () => {
  const A = await cuenta(), ref = (await store.getSocioById(A.id)).ref_codigo;
  await cuenta({ ref });
  assert.ok((await tipos(A.id)).includes("referido"));
});

test("cohortes de alta: cuántos llegaron a cada hito por semana y la mediana de días hasta el primer canje", async () => {
  const A = await cuenta(), B = await cuenta(), C = await cuenta();
  await store.registrarEvento(A.id, "primer_canje"); await store.registrarEvento(A.id, "nivel_socio_activado"); await store.registrarEvento(B.id, "primer_pago");
  const r = await (await api("/admin/cohortes?semanas=2", { h: ADM })).json();
  assert.ok(Array.isArray(r.cohortes) && r.cohortes.length >= 1 && r.cohortes.length <= 3);
  const esta = r.cohortes[0];
  for (const k of ["semana", "registrados", "verificaron", "socios", "canjearon", "pagaron", "mediana_dias_primer_canje"]) assert.ok(k in esta, k);
  assert.ok(esta.registrados >= 3 && esta.canjearon >= 1 && esta.socios >= 1 && esta.pagaron >= 1);
  assert.ok(esta.mediana_dias_primer_canje !== null && esta.mediana_dias_primer_canje < 1, "canjeó el mismo día que se registró");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(esta.semana));
  assert.ok(r.club && "dias7" in r.club && "dias30" in r.club);
  assert.ok(C.id);
});

test("ficha 360: la línea de tiempo suma los hitos y los tramos del club (sin la foto del primer día)", async () => {
  const A = await cuenta();
  await store.updateSocio(A.id, { cedula: "9200001" });
  await store.registrarEvento(A.id, "nivel_socio_activado", { fuente: "api" });
  await store.guardarEstadoTuti("9200001", { estado: "ACTIVE", deuda: 0, alDia: true });
  await store.guardarEstadoTuti("9200001", { estado: "DEBT", deuda: 90000, alDia: false });
  const d = await (await api("/admin/socios/" + A.id + "/360", { h: ADM })).json();
  const t = d.eventos.map((x) => x.titulo);
  assert.ok(t.includes("Se activó su nivel Socio"), t.join(" | "));
  assert.ok(t.includes("En mora con el club") && t.includes("Al día con el club"), t.join(" | "));
});

test("las rutas registran los hitos sin bloquear nada, y el panel los muestra", () => {
  const r = leer("routes.js"), a = leer("lib", "admin-auth.js"), m = leer("migraciones", "0022_historial_y_eventos.sql");
  for (const [tipo, donde] of [["registro", /evento\(socio\.id, "registro"/], ["correo_verificado", /evento\(socio\.id, "correo_verificado"\)/], ["foto", /evento\(req\.socio\.id, "foto"\)/], ["nivel_socio_activado", /evento\(socioId, "nivel_socio_activado"/],
    ["nivel_socio_pausado", /evento\(f\.id, "nivel_socio_pausado"/], ["primer_canje", /evento\(socio\.id, "primer_canje"/], ["primer_pago", /evento\(pedido\.socio_id, "primer_pago"/], ["primera_puja", /evento\(req\.socio\.id, "primera_puja"\)/], ["referido", /evento\(socio\.referido_por, "referido"/]])
    assert.ok(donde.test(r), tipo + " se registra");
  assert.ok(/store\.registrarEvento\(socioId, tipo, meta\)\.catch\(\(\) => \{\}\)/.test(r), "un hito que falla no rompe el flujo");
  for (const t of eventos.TIPOS) assert.ok(r.includes(`"${t}"`) || t === "primera_puja", t + " usado");
  assert.ok(/cohortes: "tablero"/.test(a));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS club_hist_abierta/.test(m) && /CREATE UNIQUE INDEX IF NOT EXISTS socio_eventos_unico/.test(m));
});

test("el Dashboard muestra las cohortes de alta y los movimientos del club", () => {
  const a = leer("public", "admin.html");
  assert.ok(/id="cohortesBox"/.test(a) && /async function cargarCohortes\(\)/.test(a) && /\/admin\/cohortes\?semanas=8/.test(a));
  assert.ok(/Días hasta el 1\.er canje/.test(a) && /entraron en mora/.test(a) && /volvieron al día/.test(a));
  assert.ok(/cargarCohortes\(\);\s*\n\s*\} catch \(e\) \{ \$\("repCards"\)/.test(a), "se carga junto con los reportes");
});
