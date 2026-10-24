"use strict";
// Sprint 4 — carnet con QR rotativo y comercio autogestionado.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const carnet = require("../lib/carnet");
const { periodo } = require("../lib/periodo");

// ── QR rotativo: lógica pura ─────────────────────────────────────────────────
const SECRETO = "s".repeat(64);
const T0 = Date.UTC(2026, 9, 21, 15, 0, 30);
const secretoDe = (m) => async (id) => m[id] || null;

test("el token tiene el formato OLI1.<id>.<ventana>.<firma> y rota cada 60 s", () => {
  const a = carnet.generarToken("soc_abc123", SECRETO, T0), b = carnet.generarToken("soc_abc123", SECRETO, T0 + 1000), c = carnet.generarToken("soc_abc123", SECRETO, T0 + 61000);
  assert.match(a.token, /^OLI1\.soc_abc123\.[0-9a-z]+\.[0-9a-f]{20}$/);
  assert.strictEqual(a.token, b.token, "misma ventana → mismo token");
  assert.notStrictEqual(a.token, c.token, "la ventana siguiente cambia");
  assert.ok(a.vence_en >= 1 && a.vence_en <= 60);
  assert.strictEqual(a.vence_en, 30, "a los :30 faltan 30 s para rotar");
  assert.match(a.codigo, /^\d{6}$/);
  assert.notStrictEqual(carnet.generarToken("soc_abc123", "otro-secreto", T0).token, a.token, "otro secreto, otra firma");
  assert.notStrictEqual(carnet.generarToken("soc_otro999", SECRETO, T0).token.split(".")[3], a.token.split(".")[3], "otro hincha, otra firma");
});

test("verifica la ventana actual y una a cada lado; más lejos está vencido", async () => {
  const ob = secretoDe({ soc_abc123: SECRETO });
  const tok = (ms) => carnet.generarToken("soc_abc123", SECRETO, ms).token;
  assert.deepStrictEqual((await carnet.verificarToken(tok(T0), ob, T0)).ok, true);
  assert.strictEqual((await carnet.verificarToken(tok(T0 - 60000), ob, T0)).ok, true, "una ventana atrás");
  assert.strictEqual((await carnet.verificarToken(tok(T0 + 60000), ob, T0)).ok, true, "una ventana adelante (reloj adelantado)");
  assert.deepStrictEqual(await carnet.verificarToken(tok(T0 - 120000), ob, T0), { ok: false, motivo: "vencido" });
  assert.deepStrictEqual(await carnet.verificarToken(tok(T0 + 120000), ob, T0), { ok: false, motivo: "vencido" });
  const r = await carnet.verificarToken(tok(T0), ob, T0);
  assert.deepStrictEqual({ socioId: r.socioId, ventana: r.ventana }, { socioId: "soc_abc123", ventana: carnet.ventanaDe(T0) });
});

test("rechaza firmas ajenas, alteradas, hinchas desconocidos y basura (sin lanzar)", async () => {
  const ob = secretoDe({ soc_abc123: SECRETO });
  const bueno = carnet.generarToken("soc_abc123", SECRETO, T0).token;
  const partes = bueno.split(".");
  const flip = partes.slice(); flip[3] = (flip[3][0] === "a" ? "b" : "a") + flip[3].slice(1);
  assert.strictEqual((await carnet.verificarToken(flip.join("."), ob, T0)).motivo, "invalido", "un carácter de la firma alterado");
  assert.strictEqual((await carnet.verificarToken(carnet.generarToken("soc_abc123", "secreto-robado", T0).token, ob, T0)).motivo, "invalido", "firmado con otro secreto");
  assert.strictEqual((await carnet.verificarToken(carnet.generarToken("soc_fantasma", SECRETO, T0).token, ob, T0)).motivo, "invalido", "hincha desconocido");
  const otraVentana = partes.slice(); otraVentana[2] = (carnet.ventanaDe(T0) + 1).toString(36);
  assert.strictEqual((await carnet.verificarToken(otraVentana.join("."), ob, T0)).motivo, "invalido", "la ventana va firmada: no se puede correr");
  for (const basura of ["", null, undefined, "hola", "OLI1.a.b.c", "OLI2.soc_abc123.1.aaaaaaaaaaaaaaaaaaaa", bueno + "x", "OLI1." + "x".repeat(200)])
    assert.strictEqual((await carnet.verificarToken(basura, ob, T0)).motivo, "formato", String(basura).slice(0, 30));
});

// ── Período de los reportes ──────────────────────────────────────────────────
test("período: días calendario de Paraguay, por defecto el mes en curso, con validación", () => {
  const ahora = Date.UTC(2026, 9, 21, 15, 0, 0);
  const d = periodo({}, ahora);
  assert.strictEqual(d.desde, "2026-10-01T03:00:00.000Z", "medianoche de Paraguay = 03:00 UTC");
  assert.strictEqual(d.hasta, "2026-10-22T03:00:00.000Z", "incluye todo el día de hoy");
  const p = periodo({ desde: "2026-09-01", hasta: "2026-09-30" }, ahora);
  assert.deepStrictEqual([p.desde, p.hasta, p.etiqueta], ["2026-09-01T03:00:00.000Z", "2026-10-01T03:00:00.000Z", "2026-09-01 a 2026-09-30"]);
  for (const mal of [{ desde: "2026-13-01" }, { desde: "2026-02-31" }, { desde: "ayer" }, { desde: "2026-10-05", hasta: "2026-10-01" }, { desde: "2024-01-01", hasta: "2026-10-01" }])
    assert.throws(() => periodo(mal, ahora), (e) => e.status === 400, JSON.stringify(mal));
  assert.strictEqual(periodo({}, Date.UTC(2026, 10, 1, 2, 59, 0)).desde, "2026-10-01T03:00:00.000Z", "31-oct 23:59 en Paraguay todavía es octubre");
});

// ── Servidor ─────────────────────────────────────────────────────────────────
const app = require("../server");
const { getStore } = require("../data/store");
const mailer = require("../lib/email");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

let correos, rechazos, canjesAviso;
const origOferta = mailer.enviarOfertaAprobada;
after(() => { mailer.enviarOfertaAprobada = origOferta; });
beforeEach(() => {
  correos = []; rechazos = []; canjesAviso = [];
  mailer.enviarOfertaAprobada = async (d, x) => { correos.push({ a: d.email, ...x }); return { ok: true }; };
  mailer.enviarOfertaRechazada = async (d, x) => { rechazos.push({ a: d.email, ...x }); return { ok: true }; };
  mailer.enviarCanjeExitoso = async (s, x) => { canjesAviso.push({ a: s.email, ...x }); return { ok: true }; };
});

const ADMIN = { "x-admin-key": "clave-admin-de-prueba" };
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const admin = (ruta, o = {}) => api("/admin" + ruta, { ...o, h: { ...ADMIN, ...(o.h || {}) } });

let n = 0;
async function socio(nombre, tier = null) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `${nombre}${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre, apellido: "Prueba" } });
  const j = await r.json();
  if (tier) await store.setMembresia(j.socio.id, { tierSlug: tier, ciclo: "anio" });
  return { id: j.socio.id, h: { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token } };
}
async function comercio(nombre = "Farmacia") {
  n++;
  const c = await store.crearComercio({ nombre: nombre + " " + n, ciudad: "Asunción", contacto: `contacto${n}@ejemplo.com` });
  const usuario = "com" + n + "-" + crypto.randomBytes(2).toString("hex");
  await store.setComercioAcceso(c.id, usuario, await bcrypt.hash("clave-comercio-1", 4));
  const l = await (await api("/comercio/login", { metodo: "POST", cuerpo: { usuario, password: "clave-comercio-1" } })).json();
  return { id: c.id, nombre: c.nombre, h: { "x-comercio-token": l.token } };
}
const beneficio = (c, extra = {}) => store.crearBeneficio({ comercio_id: c.id, titulo: "10% en todo " + (++n), valor: "10%", pct: 10, niveles: "todos", ...extra });
const qr = async (s, ms = Date.now()) => carnet.generarToken(s.id, await store.asegurarCarnetSecreto(s.id), ms);
const validar = (c, cuerpo) => api("/comercio/validar", { metodo: "POST", h: c.h, cuerpo }).then((r) => r.json());

// ── GET /carnet/token ────────────────────────────────────────────────────────
test("carnet/token: exige sesión, entrega el QR que rota y nunca el secreto", async () => {
  assert.strictEqual((await api("/carnet/token")).status, 401);
  const A = await socio("Qr"), B = await socio("Qr2");
  const r = await api("/carnet/token", { h: A.h });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("cache-control"), "no-store");
  const d = await r.json();
  assert.match(d.token, /^OLI1\.soc_/);
  assert.ok(d.vence_en >= 1 && d.vence_en <= 60 && d.ventana_s === 60);
  assert.match(d.codigo, /^\d{6}$/);
  const secretoA = await store.getCarnetSecreto(A.id);
  assert.ok(secretoA && secretoA.length === 64);
  assert.ok(!JSON.stringify(d).includes(secretoA), "el secreto no sale de la base");
  await api("/carnet/token", { h: A.h });
  assert.strictEqual(await store.getCarnetSecreto(A.id), secretoA, "el secreto se crea una vez y no cambia");
  await api("/carnet/token", { h: B.h });
  assert.notStrictEqual(await store.getCarnetSecreto(B.id), secretoA, "cada hincha tiene el suyo");
});

test("el secreto del carnet nunca aparece en las respuestas de la API de la cuenta", async () => {
  const A = await socio("Priv");
  await api("/carnet/token", { h: A.h });
  const secreto = await store.getCarnetSecreto(A.id);
  for (const ruta of ["/auth/yo", "/carnet", "/perfil"]) {
    const t = await (await api(ruta, { h: A.h })).text();
    assert.ok(!t.includes(secreto), ruta + " no debe contener el secreto");
  }
});

// ── Validar en caja con el QR ────────────────────────────────────────────────
test("validar con QR: aprueba, registra el canje con el nivel del hincha y avisa cómo entró", async () => {
  const c = await comercio(), A = await socio("Caja", "premium"), b = await beneficio(c);
  const t = await qr(A);
  const r = await validar(c, { token: t.token, beneficioId: b.id, monto: 50000 });
  assert.deepStrictEqual({ ok: r.ok, via: r.via, ahorro: r.ahorro, tier: r.socio.tier }, { ok: true, via: "qr", ahorro: 5000, tier: "premium" });
  const canjes = await store.canjesDeComercio({ comercioId: c.id, desde: new Date(Date.now() - 3600000).toISOString(), hasta: new Date(Date.now() + 3600000).toISOString() });
  assert.deepStrictEqual({ n: canjes.length, nivel: canjes[0].nivel, monto: canjes[0].monto }, { n: 1, nivel: "premium", monto: 50000 });
  await new Promise((x) => setTimeout(x, 30));
  assert.ok((await store.eventosDeSocio(A.id)).some((e) => e.tipo === "primer_canje"), "queda el hito del primer canje con su fecha");
  assert.strictEqual(canjesAviso.length, 1, "el socio recibe el aviso de lo que ahorró");
  assert.deepStrictEqual({ comercio: canjesAviso[0].comercio, ahorro: canjesAviso[0].ahorro, a: /^caja\d+-\d+@ejemplo\.com$/.test(canjesAviso[0].a) }, { comercio: c.nombre, ahorro: 5000, a: true });
  const rechazado = await validar(c, { token: "OLI1.basura", beneficioId: b.id, monto: 1000 });
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(rechazado.ok, false);
  assert.strictEqual(canjesAviso.length, 1, "un canje que no se hizo no avisa");
});

test("un QR sirve UNA vez: reusarlo (aun con otra oferta) o 5 cajas a la vez → un solo canje", async () => {
  const c = await comercio(), A = await socio("Una"), b1 = await beneficio(c), b2 = await beneficio(c);
  const t = await qr(A);
  assert.strictEqual((await validar(c, { token: t.token, beneficioId: b1.id })).ok, true);
  assert.strictEqual((await validar(c, { token: t.token, beneficioId: b2.id })).motivo, "qr_usado");
  const B = await socio("Carrera"), tb = await qr(B);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => validar(c, { token: tb.token, beneficioId: b1.id })));
  assert.strictEqual(rs.filter((x) => x.ok).length, 1);
  assert.strictEqual(rs.filter((x) => x.motivo === "qr_usado").length, 4);
});

test("el QR de la ventana siguiente sí sirve; uno de hace 3 ventanas está vencido; uno alterado es inválido", async () => {
  const c = await comercio(), A = await socio("Ventanas"), b = await beneficio(c, { limite_dias: null });
  assert.strictEqual((await validar(c, { token: (await qr(A, Date.now() + 60000)).token, beneficioId: b.id })).ok, true, "ventana siguiente");
  assert.strictEqual((await validar(c, { token: (await qr(A, Date.now() - 180000)).token, beneficioId: b.id })).motivo, "qr_vencido");
  const alterado = (await qr(A)).token.replace(/.$/, (x) => (x === "a" ? "b" : "a"));
  assert.strictEqual((await validar(c, { token: alterado, beneficioId: b.id })).motivo, "qr_invalido");
  assert.strictEqual((await validar(c, { token: "OLI1.soc_fantasma.zz.aaaaaaaaaaaaaaaaaaaa", beneficioId: b.id })).motivo, "qr_invalido");
  assert.strictEqual((await validar(c, { token: "basura", beneficioId: b.id })).motivo, "qr_invalido");
});

test("un rechazo por nivel o por límite NO gasta el QR: se puede reintentar con otra oferta", async () => {
  const c = await comercio(), A = await socio("Reintenta"), soloSocios = await beneficio(c, { niveles: "socio", titulo: "Solo socios " + (++n) }), libre = await beneficio(c, { limite_dias: 30 });
  const t = await qr(A);
  assert.strictEqual((await validar(c, { token: t.token, beneficioId: soloSocios.id })).motivo, "nivel_no_aplica");
  assert.strictEqual((await validar(c, { token: t.token, beneficioId: libre.id })).ok, true, "el mismo QR, otra oferta: sirve");
  const t2 = await qr(A, Date.now() + 60000);
  assert.strictEqual((await validar(c, { token: t2.token, beneficioId: libre.id })).motivo, "limite", "límite de 30 días");
  assert.strictEqual((await validar(c, { token: t2.token, beneficioId: (await beneficio(c)).id })).ok, true, "y el QR rechazado por límite tampoco se gastó");
});

test("un QR no sirve para la oferta de OTRO comercio ni para una pausada", async () => {
  const c1 = await comercio("Uno"), c2 = await comercio("Dos"), A = await socio("Cruzado");
  const ajena = await beneficio(c2), pausada = await beneficio(c1, { activo: false });
  const t = await qr(A);
  assert.strictEqual((await validar(c1, { token: t.token, beneficioId: ajena.id })).motivo, "beneficio_invalido");
  assert.strictEqual((await validar(c1, { token: t.token, beneficioId: pausada.id })).motivo, "beneficio_invalido");
});

test("sin cámara: código de socio + los 6 dígitos que rotan funciona (y registra su nivel); el código de socio solo ya no alcanza", async () => {
  const c = await comercio(), A = await socio("Fijo"), b = await beneficio(c);
  const ref = (await store.getSocioById(A.id)).ref_codigo, t = await qr(A);
  const r = await validar(c, { codigo: `${ref.toUpperCase()} ${t.codigo.slice(0, 3)} ${t.codigo.slice(3)}`, beneficioId: b.id, monto: 20000 });
  assert.deepStrictEqual({ ok: r.ok, via: r.via, ahorro: r.ahorro }, { ok: true, via: "codigo", ahorro: 2000 });
  const solo = await validar(c, { codigo: ref, beneficioId: b.id, monto: 20000 });
  assert.deepStrictEqual({ ok: solo.ok, motivo: solo.motivo }, { ok: false, motivo: "codigo_incompleto" });
});

test("el código de caja rota: uno ajeno, equivocado, vencido o ya usado se rechaza, sin revelar si el socio existe", async () => {
  const c = await comercio(), A = await socio("Rota"), B = await socio("Rota2"), b = await beneficio(c);
  const refA = (await store.getSocioById(A.id)).ref_codigo, tA = await qr(A), tB = await qr(B);
  const motivo = async (codigo) => (await validar(c, { codigo, beneficioId: b.id, monto: 1000 })).motivo;
  assert.strictEqual(await motivo(`${refA} ${tB.codigo}`), "codigo_invalido", "los 6 dígitos de otro socio no valen");
  assert.strictEqual(await motivo(`${refA} 000000`), "codigo_invalido", "dígitos al azar");
  assert.strictEqual(await motivo(`noexiste ${tA.codigo}`), "codigo_invalido", "socio inexistente: mismo motivo que un código malo");
  const viejo = carnet.generarToken(A.id, await store.getCarnetSecreto(A.id), Date.now() - 5 * 60000);
  assert.strictEqual(await motivo(`${refA} ${viejo.codigo}`), "codigo_invalido", "el de hace 5 minutos ya no sirve");
  const ok = await validar(c, { codigo: `${refA} ${tA.codigo}`, beneficioId: b.id, monto: 1000 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(await motivo(`${refA} ${tA.codigo}`), "qr_usado", "el mismo código no se usa dos veces en la misma ventana");
  assert.strictEqual(await motivo(`${refA}${tA.codigo}`), "codigo_incompleto", "sin separador no es un formato válido");
  assert.deepStrictEqual(carnet.verificarCodigo(A.id, null, tA.codigo), { ok: false }, "sin secreto no hay código válido");
});

test("validar exige sesión de comercio", async () => {
  assert.strictEqual((await api("/comercio/validar", { metodo: "POST", cuerpo: { token: "x" } })).status, 401);
});

// ── Cupo (stock) ─────────────────────────────────────────────────────────────
test("cupo: baja con cada canje, se agota y la app lo marca agotado", async () => {
  const c = await comercio(), b = await beneficio(c, { limite_dias: null }); await store.updateBeneficio(b.id, { stock: 2 });
  const hs = [await socio("S1"), await socio("S2"), await socio("S3")];
  const r = [];
  for (const h of hs) r.push(await validar(c, { token: (await qr(h)).token, beneficioId: b.id }));
  assert.deepStrictEqual(r.map((x) => x.ok), [true, true, false]);
  assert.strictEqual(r[2].motivo, "agotado");
  assert.strictEqual(r[1].stock, 0);
  const lista = await (await api("/beneficios", { h: hs[0].h })).json();
  assert.strictEqual(lista.items.find((x) => x.id === b.id).agotado, true);
});

test("cupo: con 1 lugar y 6 cajas simultáneas se entrega exactamente 1", async () => {
  const c = await comercio(), b = await beneficio(c); await store.updateBeneficio(b.id, { stock: 1 });
  const hs = []; for (let i = 0; i < 6; i++) hs.push(await socio("Cupo" + i));
  const qrs = await Promise.all(hs.map((h) => qr(h)));
  const rs = await Promise.all(hs.map((h, i) => validar(c, { token: qrs[i].token, beneficioId: b.id })));
  assert.strictEqual(rs.filter((x) => x.ok).length, 1);
  assert.strictEqual((await store.getBeneficio(b.id)).stock, 0);
});

// ── Ofertas que carga el comercio ────────────────────────────────────────────
const ofertar = (c, cuerpo) => api("/comercio/beneficios", { metodo: "POST", h: c.h, cuerpo });

test("oferta nueva: valida, nace en BORRADOR (origen comercio) y el hincha todavía no la ve", async () => {
  const c = await comercio(), A = await socio("Ve");
  for (const mal of [{ titulo: "ab", valor: "10%" }, { titulo: "Buena oferta", valor: "" }, { titulo: "Buena oferta", valor: "10%", para: "vip" }, { titulo: "Buena oferta", valor: "10%", stock: -1 },
    { titulo: "Buena oferta", valor: "10%", ahorro_estimado: -5 }, { titulo: "Buena oferta", valor: "10%", vigencia_hasta: "mañana" }])
    assert.strictEqual((await ofertar(c, mal)).status, 400, JSON.stringify(mal));
  const r = await ofertar(c, { titulo: "10% en <b>protectores</b> solares", valor: "10%", descripcion: "Todos los días", para: "plus", stock: 50 });
  assert.strictEqual(r.status, 201);
  const o = (await r.json()).oferta;
  assert.deepStrictEqual({ estado: o.estado, origen: o.origen, pct: o.pct, niveles: o.niveles, stock: o.stock }, { estado: "borrador", origen: "comercio", pct: 10, niveles: "premium,socio", stock: 50 });
  assert.ok(!/[<>]/.test(o.titulo));
  const lista = await (await api("/beneficios", { h: A.h })).json();
  assert.ok(!lista.items.some((x) => x.id === o.id), "una oferta sin aprobar no se ve");
  const caja = await validar(c, { token: (await qr(A)).token, beneficioId: o.id });
  assert.strictEqual(caja.motivo, "beneficio_invalido", "ni se puede validar en caja");
  const mias = await (await api("/comercio/beneficios", { h: c.h })).json();
  assert.ok(mias.ofertas.some((x) => x.id === o.id && x.estado === "borrador"));
  assert.ok(!mias.items.some((x) => x.id === o.id), "items = solo lo publicado");
});

test("oferta: '2x1' no es un porcentaje; el % se lee de 'valor'; máximo 10 esperando aprobación", async () => {
  const c = await comercio();
  const dos = (await (await ofertar(c, { titulo: "Dos por uno", valor: "2x1", ahorro_estimado: 20000 })).json()).oferta;
  assert.deepStrictEqual({ pct: dos.pct, ahorro: dos.ahorro_estimado }, { pct: null, ahorro: 20000 });
  assert.strictEqual((await (await ofertar(c, { titulo: "Quince por ciento", valor: "15 %" })).json()).oferta.pct, 15);
  for (let i = 0; i < 8; i++) assert.strictEqual((await ofertar(c, { titulo: "Oferta " + i + " larga", valor: "5%" })).status, 201);
  const tope = await ofertar(c, { titulo: "Una de más", valor: "5%" });
  assert.strictEqual(tope.status, 409);
});

test("el club aprueba: se publica, el hincha la ve, se valida en caja y el comercio recibe el correo", async () => {
  const c = await comercio(), A = await socio("Aprob"), o = (await (await ofertar(c, { titulo: "Descuento aprobable", valor: "20%" })).json()).oferta;
  assert.strictEqual((await admin(`/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "pendiente" } })).status, 400);
  assert.strictEqual((await api(`/admin/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "aprobado" } })).status >= 400, true, "sin credenciales no");
  const r = await admin(`/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "aprobado" } });
  assert.strictEqual(r.status, 200);
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(correos.length, 1);
  assert.match(correos[0].a, /^contacto\d+@ejemplo\.com$/);
  assert.ok((await (await api("/beneficios", { h: A.h })).json()).items.some((x) => x.id === o.id), "ahora sí la ve");
  assert.deepStrictEqual((await validar(c, { token: (await qr(A)).token, beneficioId: o.id, monto: 10000 })).ahorro, 2000);
});

test("el club rechaza: exige un motivo y el comercio lo ve en su panel", async () => {
  const c = await comercio(), o = (await (await ofertar(c, { titulo: "Oferta dudosa", valor: "90%" })).json()).oferta;
  assert.strictEqual((await admin(`/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "rechazado" } })).status, 400, "sin motivo no");
  assert.strictEqual((await admin(`/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "rechazado", motivo: "El 90% no es sostenible" } })).status, 200);
  const mias = await (await api("/comercio/beneficios", { h: c.h })).json();
  const v = mias.ofertas.find((x) => x.id === o.id);
  assert.deepStrictEqual({ estado: v.estado, motivo: v.motivo_rechazo }, { estado: "rechazado", motivo: "El 90% no es sostenible" });
  assert.strictEqual(correos.length, 0, "el rechazo no manda el correo de 'publicada'");
  assert.strictEqual(rechazos.length, 1, "pero sí avisa al comercio con el motivo");
  assert.deepStrictEqual({ motivo: rechazos[0].motivo, titulo: rechazos[0].titulo, a: /^contacto\d+@ejemplo\.com$/.test(rechazos[0].a) }, { motivo: "El 90% no es sostenible", titulo: "Oferta dudosa", a: true });
  assert.strictEqual((await admin("/beneficios/ben_inventada", { metodo: "PATCH", cuerpo: { estado: "aprobado" } })).status, 404);
});

test("editar lo que ve el hincha de una oferta aprobada la devuelve a aprobación; pausarla o ajustar el cupo no", async () => {
  const c = await comercio(), A = await socio("Edita"), o = (await (await ofertar(c, { titulo: "Oferta estable", valor: "10%", stock: 5 })).json()).oferta;
  await admin(`/beneficios/${o.id}`, { metodo: "PATCH", cuerpo: { estado: "aprobado" } });
  const pausa = await (await api(`/comercio/beneficios/${o.id}`, { metodo: "PATCH", h: c.h, cuerpo: { activo: false } })).json();
  assert.deepStrictEqual({ estado: pausa.oferta.estado, activo: pausa.oferta.activo, vuelve: pausa.vuelve_a_aprobacion }, { estado: "aprobado", activo: false, vuelve: false });
  await api(`/comercio/beneficios/${o.id}`, { metodo: "PATCH", h: c.h, cuerpo: { activo: true, stock: 99 } });
  assert.strictEqual((await store.getBeneficio(o.id)).estado, "aprobado");
  assert.ok((await (await api("/beneficios", { h: A.h })).json()).items.some((x) => x.id === o.id));
  const cambio = await (await api(`/comercio/beneficios/${o.id}`, { metodo: "PATCH", h: c.h, cuerpo: { valor: "80%", titulo: "Ahora 80% de descuento" } })).json();
  assert.deepStrictEqual({ estado: cambio.oferta.estado, vuelve: cambio.vuelve_a_aprobacion, pct: cambio.oferta.pct }, { estado: "borrador", vuelve: true, pct: 80 });
  assert.ok(!(await (await api("/beneficios", { h: A.h })).json()).items.some((x) => x.id === o.id), "mientras se re-aprueba, no se ve");
  assert.strictEqual((await validar(c, { token: (await qr(A)).token, beneficioId: o.id })).motivo, "beneficio_invalido");
});

test("un comercio no puede tocar ni ver las ofertas de otro", async () => {
  const c1 = await comercio("Uno"), c2 = await comercio("Dos"), o = (await (await ofertar(c1, { titulo: "Oferta de uno", valor: "10%" })).json()).oferta;
  assert.strictEqual((await api(`/comercio/beneficios/${o.id}`, { metodo: "PATCH", h: c2.h, cuerpo: { activo: false } })).status, 404);
  assert.ok(!(await (await api("/comercio/beneficios", { h: c2.h })).json()).ofertas.some((x) => x.id === o.id));
  assert.strictEqual((await api("/comercio/beneficios", { metodo: "POST", cuerpo: { titulo: "Anónima", valor: "5%" } })).status, 401);
});

test("el PATCH del admin sin 'estado' sigue siendo el CRUD de siempre (no se rompió)", async () => {
  const c = await comercio(), b = await beneficio(c);
  const r = await admin(`/beneficios/${b.id}`, { metodo: "PATCH", cuerpo: { titulo: "Título editado por el club" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await store.getBeneficio(b.id)).titulo, "Título editado por el club");
});

// ── Estadísticas ─────────────────────────────────────────────────────────────
async function conCanjes() {
  const c = await comercio("Estadisticas"), b = await beneficio(c, { limite_dias: null, pct: 10 });
  const hs = [await socio("E1", "premium"), await socio("E2", "premium"), await socio("E3")];
  await validar(c, { token: (await qr(hs[0])).token, beneficioId: b.id, monto: 100000 });
  await validar(c, { token: (await qr(hs[1])).token, beneficioId: b.id, monto: 50000 });
  await validar(c, { token: (await qr(hs[2])).token, beneficioId: b.id });                       // sin monto
  return { c, b };
}

test("estadísticas del comercio: canjes, ahorro entregado, ventas, ticket promedio y mix por nivel", async () => {
  const { c } = await conCanjes();
  assert.strictEqual((await api("/comercio/estadisticas")).status, 401);
  const d = await (await api("/comercio/estadisticas", { h: c.h })).json();
  assert.deepStrictEqual({ canjes: d.canjes, ahorro: d.ahorro, ventas: d.ventas, ticket: d.ticket_promedio }, { canjes: 3, ahorro: 15000, ventas: 150000, ticket: 75000 });
  assert.deepStrictEqual(Object.fromEntries(d.mix.map((m) => [m.nivel, m.canjes])), { premium: 2, olimpista: 1 });
  const futuro = await (await api("/comercio/estadisticas?desde=2099-01-01&hasta=2099-01-31", { h: c.h })).json();
  assert.strictEqual(futuro.canjes, 0);
  assert.strictEqual((await api("/comercio/estadisticas?desde=basura", { h: c.h })).status, 400);
});

test("estadísticas: un comercio solo ve lo suyo", async () => {
  const { c } = await conCanjes(), otro = await comercio("Otro");
  assert.strictEqual((await (await api("/comercio/estadisticas", { h: otro.h })).json()).canjes, 0);
  assert.strictEqual((await (await api("/comercio/estadisticas", { h: c.h })).json()).canjes, 3);
});

test("CSV del comercio: con encabezado, sin datos personales del hincha y a prueba de fórmulas de Excel", async () => {
  const { c, b } = await conCanjes();
  await store.updateBeneficio(b.id, { titulo: "=HYPERLINK(\"http://malo\")" });
  const r = await api("/comercio/estadisticas?format=csv", { h: c.h });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="canjes-.*\.csv"/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM para que Excel lea las tildes");
  const txt = buf.toString("utf8").replace(/^﻿/, "");
  assert.ok(txt.startsWith("\"fecha\",\"beneficio\",\"nivel\",\"monto\",\"ahorro\""));
  assert.strictEqual(txt.trim().split("\n").length, 4, "encabezado + 3 canjes");
  assert.ok(!/@ejemplo\.com|soc_|Prueba/.test(txt), "ningún dato personal del hincha");
  assert.ok(txt.includes("\"'=HYPERLINK"), "la celda que empieza con = se neutraliza");
});

test("reporte para sponsors (admin): por comercio, ciudad y nivel; exige permiso de exportar", async () => {
  const { c } = await conCanjes();
  assert.ok((await api("/admin/comercios/estadisticas.csv")).status >= 400);
  const r = await admin("/comercios/estadisticas.csv");
  assert.strictEqual(r.status, 200);
  const txt = await r.text();
  assert.ok(txt.includes("\"comercio\",\"ciudad\",\"nivel\",\"canjes\",\"ahorro\",\"ventas\""));
  const filas = txt.trim().split("\n").filter((l) => l.includes(c.nombre));
  assert.strictEqual(filas.length, 2, "una fila por nivel (premium y olimpista)");
  const premium = filas.find((l) => l.includes("premium"));
  assert.ok(premium.includes("\"2\",\"15000\",\"150000\""), premium);
  assert.strictEqual((await admin("/comercios/estadisticas.csv?desde=2026-02-31")).status, 400);
});

test("el carnet muestra en vivo 'código de socio + 6 dígitos' para dictar en caja, y sin conexión avisa que hace falta conectarse", async () => {
  const A = await socio("Pie");
  const d = await (await api("/carnet/token", { h: A.h })).json();
  assert.strictEqual(d.ref, (await store.getSocioById(A.id)).ref_codigo, "el carnet recibe el código de socio junto con el token");
  const fs = require("fs"), path = require("path");
  const j = fs.readFileSync(path.join(__dirname, "..", "public", "js", "socio.js"), "utf8"), i = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8");
  assert.ok(/qrBenCod"\)\.textContent = \(d\.ref/.test(j));
  assert.ok(!/dictá este código\./.test(i) && /necesitás conexión/.test(i), "el aviso sin conexión ya no promete que alcanza con dictar el código fijo");
});
