"use strict";

/**
 * routes.js — API de Olimpistas. Se monta bajo /api.
 *
 * Público:   /config, /auth/registro, /auth/login
 * Socio:     /auth/yo, /auth/logout, /perfil*, /membresia, /pagos/*, /contenido,
 *            /sorteos, /preventas, /carnet
 *
 * El gateo por nivel se hace en el servidor (no confiar en el front).
 */

const express = require("express");
const crypto = require("crypto");
const { getStore } = require("./data/store");
const auth = require("./lib/auth");
const adminAuth = require("./lib/admin-auth");
const mailer = require("./lib/email");
const access = require("./lib/access");
const log = require("./lib/log");
const pagopar = require("./lib/pagopar");
const resend = require("./lib/resend");
const { alertar } = require("./lib/alert");
const bcrypt = require("bcrypt");
const geo = require("./lib/geo");
const { listaPaises, paisNombre, paisCentroide, PAISES } = require("./data/paises");
const { BRAND, TIERS, PERFIL_CAMPOS, tierBySlug } = require("./config");
const { edadDesde } = require("./lib/edad");

// Errores de infraestructura (DB no responde / pooler / red). Cuando pasan, NO
// filtramos el detalle crudo al usuario (ej. "ENOTFOUND tenant… not found"): damos
// un mensaje amable y logueamos/alertamos del lado del server.
const INFRA_CODES = new Set([
  "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "EPIPE",
  "08006", "08001", "08004", "08P01", "57P01", "57P03", "53300", "XX000",
]);
function esDbCaida(e) {
  if (e && INFRA_CODES.has(e.code)) return true;
  const m = String((e && e.message) || "");
  return /\btenant\b|getaddrinfo|Connection terminated|terminating connection|server closed the connection|too many connections|the database system is|connect ETIMEDOUT/i.test(m);
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status < 500) return res.status(status).json({ error: e.message || "Error interno" });
    log.error({ err: (e && e.stack) || String(e) }, "error no manejado");
    const db = esDbCaida(e);
    alertar(
      db ? "db-caida" : "error-500",
      db ? "La base de datos no responde" : "Error 500",
      `${req.method} ${req.originalUrl || req.url}\n${e.code || ""} ${e.message || e}`
    );
    res.status(db ? 503 : 500).json({
      error: db
        ? "Estamos con una intermitencia técnica. Probá de nuevo en unos minutos."
        : "Ocurrió un error inesperado. Probá de nuevo.",
    });
  });

function setSessionCookie(res, token) {
  res.cookie(auth.COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/** Progreso de completitud del perfil (alimenta la barra). */
function perfilProgreso(socio) {
  const total = PERFIL_CAMPOS.reduce((a, c) => a + c.peso, 0);
  let hechos = 0;
  const faltantes = [];
  for (const c of PERFIL_CAMPOS) {
    const lleno = socio && String(socio[c.key] || "").trim() !== "";
    if (lleno) hechos += c.peso;
    else faltantes.push({ key: c.key, label: c.label });
  }
  return { pct: Math.round((hechos / total) * 100), completos: hechos, total, faltantes };
}

const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };

function buildRouter() {
  const r = express.Router();
  const store = getStore();

  // ─── Config pública (branding + tiers + países) ─────────────────────────────
  r.get("/config", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60"); // corto: precios/tiers se propagan rápido al cambiarlos
    res.json({ brand: BRAND, tiers: TIERS, paises: listaPaises() });
  });

  // Health público (sin auth, sin PII): ping barato a la DB → 200 ok / 503 caída.
  // Pensado para un monitor de uptime externo (UptimeRobot / Cloud Monitoring / cron):
  // si da 503, alerta (throttled) para enterarnos antes que los usuarios.
  r.get("/salud", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const t0 = Date.now();
    try {
      await store.contarTotal();
      res.json({ ok: true, ms: Date.now() - t0, rev: process.env.K_REVISION || null });
    } catch (e) {
      log.error({ err: e.code || e.message }, "salud DB");
      alertar("db-caida", "La base de datos no responde", `/salud\n${e.code || ""} ${e.message || e}`);
      res.status(503).json({ ok: false });
    }
  });

  // País del visitante (prefill por IP / cabecera de CDN).
  r.get("/geo", wrap(async (req, res) => res.json({ pais: await geo.detectarPais(req) })));

  // ─── Rampa de lanzamiento (objetivo absoluto) ────────────────────────────
  // El número mostrado sube de RAMP_DESDE_N → RAMP_HASTA_N en RAMP_HORAS, suave y
  // proporcional (escala el agregado para clavar ese objetivo en cada momento; así
  // nunca hay saltos aunque cambie el universo guardado). Env (cambiables en vivo):
  //   RAMP_INICIO   ISO date del arranque (sin esto → sin rampa, muestra el agregado tal cual)
  //   RAMP_DESDE_N  total inicial (default 180000)
  //   RAMP_HASTA_N  total final / universo (default 1000000)
  //   RAMP_HORAS    duración (default 60 ≈ 2,5 días)
  //   RAMP_CURVA    >1 arranca un poco más rápido (default 1.25)
  // Curva de lanzamiento por PUNTOS CLAVE (offset en horas desde RAMP_INICIO → total).
  // Forma pedida: arranque lento 21:15→21:30, surge fuerte hasta ~23:30 (≈250k esta
  // noche), ritmo bajo de madrugada (hasta ~06:30) y subida sostenida de día, hasta
  // ~1.000.000 el martes 21:15. Interpolación lineal por tramo (ritmo distinto por
  // tramo = exactamente la curva pedida). Monótona y determinista.
  // RAMP_INICIO = Jue 21:48 PY. Ritmo MUY LENTO y LÓGICO: imita el pulso natural de
  // registros — madrugadas casi planas (~1k/h), días en subida suave (~3k/h), tardes/
  // noches apenas más. Sin saltos. Mediodía del viernes como referencia (~213k de rampa;
  // +reales ≈ 218k mostrado). Crecimiento contenido. Offsets en horas desde 21:48 (Jue).
  // FRENO TOTAL: de Vie 19:14 a Sáb 09:00 va MUY MUY lento (~0.7k/h, casi plano).
  // Recién después de las 09:00 retoma suave. Offsets en horas desde Jue 21:48.
  // RAMP_INICIO = Jue 18/06 21:48 PY. Estiramiento a 1.000.000 el 25/07/2026, crecimiento
  // natural y sostenido (~600→1.000/h, sube de a poco a mitad de campaña y afloja al final).
  // Anclas diarias a las 21:00 PY (offset = 71.2 + 24·día). Continuidad en "ahora" sin salto.
  // Nota: el mostrado = curva + registros reales, así que cruza el millón alrededor del 25/07.
  const _CURVA = [
    [0,     188500], // Jue 18/06 21:48 — lanzamiento
    [8.2,   198500], // Vie 06:00
    [20.2,  231000], // Vie 18:00
    [35.2,  245000], // Sáb 09:00
    [50.2,  306000], // Dom 00:00
    [62.2,  345000], // Dom 12:00
    [69.2,  380000], // Dom 21/06 19:02
    [71.2,  382000], // Dom 21/06 21:00
    [95.2,  397000], // Lun 22/06
    [119.2, 413000], // Mar 23/06
    [143.2, 430000], // Mié 24/06
    [167.2, 448000], // Jue 25/06
    [191.2, 467000], // Vie 26/06
    [215.2, 487000], // Sáb 27/06
    [239.2, 508000], // Dom 28/06
    [263.2, 530000], // Lun 29/06
    [287.2, 553000], // Mar 30/06
    [311.2, 577000], // Mié 01/07
    // ─── AHORA (Mié 02/07 ~01:14 UTC, eH≈312.4): ancla en el valor real actual.
    // Desde acá, subida MÍNIMA y realista (~+800/día) — la curva deja de dispararse a 1M.
    [312.4, 578241], // ancla (continuidad exacta, sin salto ni caída)
    [480,   583800], // ~+800/día
    [648,   589400],
    [816,   595000],
    [1000,  601000],
    [1400,  614500], // ~mediados de agosto; luego se aplana
  ];
  function rampaObjetivo() {
    const ini = process.env.RAMP_INICIO;
    if (!ini) return null; // sin rampa
    const t0 = Date.parse(ini);
    if (isNaN(t0)) return null;
    const A = _CURVA;
    const eH = (Date.now() - t0) / 3600000;
    if (eH <= A[0][0]) return A[0][1];
    if (eH >= A[A.length - 1][0]) return A[A.length - 1][1];
    for (let i = 1; i < A.length; i++) {
      if (eH <= A[i][0]) {
        const [t1, v1] = A[i - 1], [t2, v2] = A[i];
        return Math.round(v1 + (v2 - v1) * ((eH - t1) / (t2 - t1)));
      }
    }
    return A[A.length - 1][1];
  }

  // ─── Stats: contador global + datos del globo (agregado PESADO, cacheado) ─────
  // Anti-saturación: cache largo + single-flight (un solo refresh a la vez, sin
  // stampede que agote el pool del DB) + stale-while-revalidate (si hay cache vieja
  // se sirve YA y se refresca atrás; nunca bloquea salvo el primer cold-start).
  let _stats = null, _statsTs = 0, _statsInFlight = null;
  const STATS_TTL = 120000; // 2 min — el agregado es caro en el DB; refrescamos poco
  async function getStats() {
    if (_stats && Date.now() - _statsTs < STATS_TTL) return _stats;
    if (!_statsInFlight) {
      _statsInFlight = _computeStats()
        .then((s) => { _stats = s; _statsTs = Date.now(); return s; })
        .catch((e) => { log.error({ err: e.message }, "stats refresh"); return _stats; })
        .finally(() => { _statsInFlight = null; });
    }
    return _stats || _statsInFlight; // cache vieja → SWR; si no hay nada → esperá el refresh
  }
  async function _computeStats() {
    const [totalReal, porPaisRaw, porCiudadRaw, demo] = await Promise.all([
      store.contarTotal(), store.contarPorPais(), store.contarPorCiudad(), store.demoAgregado(),
    ]);
    // Rampa: escala el agregado para clavar el objetivo del momento (180k → 1M).
    const demoSum = demo.reduce((s, r) => s + Number(r.count || 0), 0) || 1;
    const objetivo = rampaObjetivo();
    const fRampa = objetivo != null ? objetivo / demoSum : 1;

    // ── Merge miembros REALES + agregado de demo, por país y por ciudad ──
    const paisMap = new Map();   // iso → count
    const add = (map, key, n) => map.set(key, (map.get(key) || 0) + Number(n || 0));
    for (const r of porPaisRaw) add(paisMap, r.pais_iso, r.count);

    const ciudadMap = new Map(); // "iso|ciudad" → { iso, ciudad, count, lat, lng }
    const upCiudad = (iso, ciudad, count, lat, lng) => {
      const k = iso + "|" + (ciudad || "");
      const e = ciudadMap.get(k) || { iso, ciudad: ciudad || "", count: 0, lat: null, lng: null };
      e.count += Number(count || 0);
      if (lat != null && lng != null) { e.lat = Number(lat); e.lng = Number(lng); } // demo trae coords exactas
      ciudadMap.set(k, e);
    };
    for (const r of porCiudadRaw) upCiudad(r.pais_iso, r.ciudad, r.count, r.lat, r.lng);
    // Agregado escalado por la rampa de lanzamiento.
    const escala = (n) => Math.round(Number(n || 0) * fRampa);
    for (const r of demo) { const c = escala(r.count); add(paisMap, r.pais_iso, c); upCiudad(r.pais_iso, r.ciudad, c, r.lat, r.lng); }

    const demoTotal = demo.reduce((s, r) => s + escala(r.count), 0);
    const total = totalReal + demoTotal;

    const porPais = [...paisMap.entries()]
      .map(([iso, count]) => {
        const c = paisCentroide(iso);
        return c ? { iso, nombre: paisNombre(iso), count, lat: c.lat, lng: c.lng } : null;
      })
      .filter((p) => p && p.count > 0)
      .sort((a, b) => b.count - a.count);

    // Puntos del globo (banderas por ciudad): coords exactas o centroide del país.
    const puntos = [...ciudadMap.values()]
      .map((r) => {
        const c = paisCentroide(r.iso);
        const lat = r.lat != null ? r.lat : (c ? c.lat : null);
        const lng = r.lng != null ? r.lng : (c ? c.lng : null);
        if (lat == null || r.count <= 0) return null;
        return { iso: r.iso, pais: paisNombre(r.iso), ciudad: r.ciudad, count: r.count, lat, lng };
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count)
      .slice(0, 600);

    return { total, paises: porPais.length, porPais, puntos, totalReal, demoSum, actualizado: new Date().toISOString() };
  }
  r.get("/stats", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");   // el CDN absorbe el pico
    // Privacidad/estrategia: NO exponer el número real ni el demo al público (desarmaría la rampa).
    // El front solo necesita total/paises/porPais/puntos. totalReal/demoSum quedan solo para el admin.
    const { totalReal, demoSum, ...publico } = await getStats();
    res.json(publico);
  }));

  // Contador "casi en vivo": recalcula SOLO el total con la rampa del momento.
  // NUNCA bloquea en el agregado pesado de getStats(): si hay base cacheada (aunque
  // esté vieja) responde al instante y refresca en segundo plano. El total sube igual
  // porque depende de la rampa (cálculo puro), no de la DB.
  r.get("/contador", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=5");
    const obj = rampaObjetivo();
    if (_stats) {
      if (Date.now() - _statsTs > 30000) getStats().catch(() => {}); // refresco no bloqueante
      const total = obj != null ? (Number(_stats.totalReal) || 0) + Math.round(obj) : _stats.total;
      return res.json({ total, paises: _stats.paises, actualizado: new Date().toISOString() });
    }
    // Cold start (sin base aún): recién acá esperamos getStats una vez.
    const s = await getStats();
    const total = obj != null ? (Number(s.totalReal) || 0) + Math.round(obj) : s.total;
    res.json({ total, paises: s.paises, actualizado: new Date().toISOString() });
  }));

  // Banderas individuales ("casa") del recuadro visible — zoom alto del globo público.
  // bbox = minLng,minLat,maxLng,maxLat. Solo miembros que optaron por el punto exacto.
  r.get("/flags", wrap(async (req, res) => {
    const parts = String(req.query.bbox || "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
      throw httpError(400, "bbox inválido (se espera minLng,minLat,maxLng,maxLat)");
    const [minLng, minLat, maxLng, maxLat] = parts;
    const raw = await store.flagsEnBBox({ minLng, minLat, maxLng, maxLat, limit: req.query.limit });
    // Privacidad: NUNCA exponer el domicilio exacto en público. Difuminamos la coordenada
    // ~150m con un offset determinístico por socio (estable, no salta) y mostramos solo el
    // nombre de pila. El punto exacto solo lo ve el propio socio en su perfil.
    const flags = raw.map((f) => {
      const h = crypto.createHash("sha256").update(String(f.id)).digest();
      const dLat = ((h[0] / 255) - 0.5) * 0.003;  // ±0.0015° ≈ ±165m
      const dLng = ((h[1] / 255) - 0.5) * 0.003;
      return { nombre: String(f.nombre || "").split(" ")[0], ciudad: f.ciudad, lat: Number(f.lat) + dLat, lng: Number(f.lng) + dLng };
    });
    res.setHeader("Cache-Control", "public, max-age=20");
    res.json({ flags });
  }));

  const soloDigitos = (s) => String(s || "").replace(/\D/g, "");
  // Enmascara el nombre de un pujador para el feed PÚBLICO de una subasta (no revelar
  // identidad real ni capacidad de gasto de otros socios). "Eduardo" → "E*****o".
  const enmascararNombre = (s) => {
    const n = String(s || "").trim();
    if (n.length <= 1) return "Pujador";
    if (n.length === 2) return n[0] + "*";
    return n[0] + "*".repeat(n.length - 2) + n[n.length - 1];
  };

  // ─── Auth ───────────────────────────────────────────────────────────────────
  // Instancia 1 — alta de cuenta (mínima). La validación de socio (cédula) es la
  // instancia 3 (/perfil/validar-socio), porque el tier depende de la edad.
  r.post("/auth/registro", wrap(async (req, res) => {
    const { email, password } = req.body || {};
    // Sanitiza nombre/apellido en origen (anti-XSS, defensa en profundidad).
    const limpiar = (s) => (typeof s === "string" ? s.replace(/[<>]/g, "").trim().slice(0, 120) : s);
    const nombre = limpiar((req.body || {}).nombre);
    const apellido = limpiar((req.body || {}).apellido);
    const ref = String((req.body || {}).ref || "").trim().slice(0, 16) || null; // código de quien lo invitó
    const idioma = (req.body || {}).idioma === "en" ? "en" : "es"; // idioma del socio para correos
    const { socio, token } = await auth.registrar({ email, password, nombre, apellido, ref, idioma });
    setSessionCookie(res, token);
    // El registro = alta automática como Olimpista gratis (el embudo).
    await store.setMembresia(socio.id, { tierSlug: "olimpista", ciclo: "anio" });
    // Staging: registramos el alta en la base de Actualización.
    if (store.crearActualizacion) {
      store.crearActualizacion({ socioId: socio.id, tipo: "alta", nombre, apellido, email: socio.email, estado: "pendiente" }).catch(() => {});
    }
    // Verificación de email (best-effort: nunca rompe el registro si falta la columna/proveedor).
    // No gatea nada: la cuenta funciona sin verificar. Kill-switch en vivo EMAIL_VERIF=off
    // para proteger la cuota de Resend (50k/mes compartida) y ahorrar 1 escritura de DB por
    // alta durante el pico, dejando intactos los emails de socio/pago. Default = ON.
    if (process.env.EMAIL_VERIF !== "off") {
      try {
        const vtoken = crypto.randomBytes(24).toString("base64url");
        await store.updateSocio(socio.id, { verif_token: vtoken, email_verificado: false });
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const link = `${proto}://${req.headers.host}/api/auth/verificar?token=${vtoken}`;
        mailer.enviarVerificacion(socio, link).catch(() => {});
      } catch (e) { log.error({ err: e.message }, "verificación de email no disponible"); }
    }
    // Notificar a quien lo invitó (best-effort, no bloquea el alta).
    if (socio.referido_por && store.getSocioById) {
      store.getSocioById(socio.referido_por).then(async (ref) => {
        if (ref && ref.email && mailer.enviarReferidoSumado) {
          const total = store.contarReferidos ? await store.contarReferidos(ref.id).catch(() => 0) : 0;
          // Privacidad: solo nombre + inicial del apellido (nunca el email ni el apellido completo).
          const invitado = nombre ? (nombre + (apellido ? " " + apellido[0].toUpperCase() + "." : "")) : null;
          mailer.enviarReferidoSumado(ref, { invitado, total }).catch(() => {});
        }
      }).catch(() => {});
    }
    res.status(201).json({ socio, token });
  }));

  // ¿Ya sos socio de Olimpia? Chequeo previo (sin crear cuenta) por email o cédula.
  r.post("/auth/verificar-socio", wrap(async (req, res) => {
    const { email, cedula } = req.body || {};
    if (!store.buscarPadron) return res.json({ esSocio: false });
    const fila = await store.buscarPadron({ email, cedula });
    // No devolvemos el nombre: evita enumerar el padrón y filtrar PII por cédula.
    res.json({ esSocio: !!fila, reclamado: fila ? !!fila.reclamado : false });
  }));

  r.post("/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const { socio, token } = await auth.login({ email, password });
    setSessionCookie(res, token);
    res.json({ socio, token });
  }));

  // Recuperar contraseña: pedir el enlace. Responde SIEMPRE ok (no revela si el email existe).
  r.post("/auth/recuperar", wrap(async (req, res) => {
    const r0 = await auth.solicitarReset({ email: (req.body || {}).email });
    if (r0.token && mailer.enviarReset) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const link = `${proto}://${req.headers.host}/reset?token=${r0.token}`;
      mailer.enviarReset(r0.socio, link).catch(() => {});
    }
    res.json({ ok: true });
  }));
  // Setear la nueva contraseña con el token del email.
  r.post("/auth/reset", wrap(async (req, res) => {
    const { token, password } = req.body || {};
    await auth.resetearPassword({ token, password });
    res.json({ ok: true });
  }));

  r.post("/auth/logout", wrap(async (req, res) => {
    await auth.logout(req.sessionToken);
    res.clearCookie(auth.COOKIE);
    res.json({ ok: true });
  }));

  r.get("/auth/yo", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    const referidos = store.contarReferidos ? await store.contarReferidos(req.socio.id).catch(() => 0) : 0;
    res.json({ socio: req.socio, membresia, progreso: perfilProgreso(req.socio), referidos });
  }));

  // Ranking de referidores ("la hinchada que más suma"). Público, cacheado liviano.
  r.get("/referidos/ranking", wrap(async (_req, res) => {
    const items = store.topReferidores ? await store.topReferidores(20).catch(() => []) : []; // resiliente si la migración aún no corrió
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ items });
  }));

  // Verificación de email (link del correo). Tolerante: nunca tira error feo.
  r.get("/auth/verificar", wrap(async (req, res) => {
    let ok = false;
    try {
      const socio = req.query.token ? await store.getSocioByVerifToken(String(req.query.token)) : null;
      if (socio) { await store.updateSocio(socio.id, { email_verificado: true, verif_token: null }); ok = true; }
    } catch (e) { log.error({ err: e.message }, "verificar email"); }
    res.redirect("/miembro?verificado=" + (ok ? "1" : "0"));
  }));

  // ─── Perfil (enriquecimiento + barra de progreso) ────────────────────────────
  r.get("/perfil", auth.requireSocio, wrap(async (req, res) => {
    res.json({ socio: req.socio, progreso: perfilProgreso(req.socio) });
  }));

  r.patch("/perfil", auth.requireSocio, wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const key of ["nombre", "apellido", "whatsapp", "ciudad"]) {
      // Sanitiza: sin <> (anti-XSS en origen, defensa en profundidad) + recorte.
      if (typeof b[key] === "string") patch[key] = b[key].replace(/[<>]/g, "").trim().slice(0, 120);
    }
    // País: acepta código ISO ("PY") o nombre ("Paraguay"); guardamos iso + nombre.
    if (typeof b.pais === "string") {
      const raw = b.pais.trim();
      if (!raw) { patch.pais_iso = ""; patch.pais = ""; }
      else {
        let iso = raw.toUpperCase();
        if (!PAISES[iso]) {
          const porNombre = Object.keys(PAISES).find((k) => PAISES[k].nombre.toLowerCase() === raw.toLowerCase());
          iso = porNombre || null;
        }
        if (!iso) throw httpError(400, "País inválido");
        patch.pais_iso = iso;
        patch.pais = paisNombre(iso);
      }
    }
    // Ubicación exacta (opcional): lat/lng numéricos y dentro de rango.
    if (b.lat != null && b.lng != null) {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw httpError(400, "Coordenadas inválidas");
      patch.lat = lat; patch.lng = lng;
    }
    // Gamificación: "poné tu bandera en tu casa" (mostrar el punto exacto en público).
    if (typeof b.mostrar_exacto === "boolean") patch.mostrar_exacto = b.mostrar_exacto;
    // Avisos por email, granulares (independientes del opt-out global marketing_baja).
    for (const key of ["avisos_subastas", "avisos_sorteos", "avisos_contenido"]) {
      if (typeof b[key] === "boolean") patch[key] = b[key];
    }
    // Fecha de nacimiento (define el tier por edad). Formato YYYY-MM-DD.
    if (typeof b.fecha_nacimiento === "string" && b.fecha_nacimiento) {
      const f = b.fecha_nacimiento.slice(0, 10);
      const d = new Date(f);
      const edad = edadDesde(f);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || isNaN(d.getTime()) || edad == null || edad < 0 || edad > 120)
        throw httpError(400, "Fecha de nacimiento inválida");
      patch.fecha_nacimiento = f;
    }
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const socio = auth.sanitize(await store.updateSocio(req.socio.id, patch));
    res.json({ socio, progreso: perfilProgreso(socio) });
  }));

  r.post("/perfil/foto", auth.requireSocio, wrap(async (req, res) => {
    const { foto } = req.body || {};
    if (typeof foto !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(foto))
      throw httpError(400, "Imagen inválida (se espera un data URL de imagen)");
    if (foto.length > 800_000) throw httpError(413, "La imagen es muy grande (máx ~600KB)");
    const socio = auth.sanitize(await store.updateSocio(req.socio.id, { foto }));
    res.json({ ok: true, foto: socio.foto, progreso: perfilProgreso(socio) });
  }));

  // ─── Instancia 3 — Validación de socio (cédula → nivel SOCIO otorgado) ──
  // Reglas: cédula ÚNICA (1 cédula = 1 cuenta); el socio del club obtiene el nivel
  // "Socio" (superior a Plus, otorgado, no comprable), a cualquier edad;
  // todo el padrón = al día; entrega automática + se registra en staging para verificar.
  r.post("/perfil/validar-socio", auth.requireSocio, wrap(async (req, res) => {
    const cedula = soloDigitos(req.body?.cedula);
    if (cedula.length < 5 || cedula.length > 12) throw httpError(400, "Número de cédula inválido");

    // El socio real del club recibe SIEMPRE el nivel "Socio" (la cima institucional),
    // sin importar la edad — es superior a Plus y no se compra, se otorga.
    const socioFull = await store.getSocioById(req.socio.id);
    const tier = "socio";

    // Cédula ÚNICA: no puede estar en otra cuenta.
    if (store.getSocioByCedula) {
      const otra = await store.getSocioByCedula(cedula);
      if (otra && otra.id !== req.socio.id) throw httpError(409, "Esa cédula ya está registrada en otra cuenta de Olimpistas");
    }
    // Guardamos la cédula en la cuenta (el índice único de la DB es el backstop).
    try { await store.updateSocio(req.socio.id, { cedula }); }
    catch (e) { throw httpError(409, "Esa cédula ya está registrada en otra cuenta de Olimpistas"); }

    // Match contra el padrón (todo el padrón se considera AL DÍA).
    let fila = null, validado = false;
    if (store.buscarPadron) fila = await store.buscarPadron({ cedula });
    if (fila) {
      // Reclamo atómico de la fila del padrón.
      let gano = true;
      if (store.marcarPadronReclamado) {
        gano = await store.marcarPadronReclamado(fila.id, req.socio.id);
        if (!gano && fila.socio_id && fila.socio_id !== req.socio.id)
          throw httpError(409, "Ese socio ya fue validado en otra cuenta");
      }
      // Entrega AUTOMÁTICA del nivel Socio (otorgado, no comprable). pagoRef "socio:" = marcador de socio del club.
      await store.setMembresia(req.socio.id, { tierSlug: tier, ciclo: "anio", pagoRef: "socio:" + fila.id });
      await store.updateSocio(req.socio.id, { es_socio_olimpia: true });
      validado = true;
      mailer.enviarReconocido && mailer.enviarReconocido({ ...socioFull, cedula }, tier).catch(() => {});
    }
    // Staging: registramos el claim para verificar/unificar después.
    if (store.crearActualizacion) {
      store.crearActualizacion({
        socioId: req.socio.id, tipo: "socio_claim",
        nombre: socioFull.nombre, apellido: socioFull.apellido, email: socioFull.email,
        cedula, pais: socioFull.pais, ciudad: socioFull.ciudad, fechaNacimiento: socioFull.fecha_nacimiento,
        tieneSelfie: !!socioFull.foto, tierPretendido: tier, matchPadronId: fila ? fila.id : null,
        estado: validado ? "validado_auto" : "a_revisar",
        notas: validado ? "Match padrón, carnet entregado automático" : "Cédula sin match en padrón — revisar manual",
      }).catch(() => {});
    }
    if (!validado) {
      mailer.enviarEnRevision && mailer.enviarEnRevision(socioFull).catch(() => {});
    }
    res.json({ validado, tier, estado: validado ? "validado_auto" : "a_revisar" });
  }));

  // ─── Membresía ──────────────────────────────────────────────────────────────
  r.get("/membresia", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    res.json({ membresia, tier: membresia ? tierBySlug(membresia.tier_slug) : null });
  }));

  // Subir de nivel → crea pedido de pago. En el COBRO manda el botón que tocó el
  // usuario (Junior → Junior, Plus → Plus). La edad solo define el carnet gratis
  // incluido para socios (en /perfil/validar-socio). Cobro anual único.
  r.post("/membresia/unirse", auth.requireSocio, wrap(async (req, res) => {
    const tier = tierBySlug(req.body?.tier);
    if (!tier) throw httpError(400, "Nivel inválido");

    // Niveles OTORGADOS (ej. Socio): no se compran. Blindaje antes de la rama "gratis"
    // (si no, un precio 0 caería como membresía gratis por error).
    if (tier.comprable === false) throw httpError(403, "Ese nivel es exclusivo de los socios del Club — se otorga, no se adquiere");

    // Nivel gratis → membresía activa inmediata, sin pago.
    if (tier.slug === "olimpista" || !tier.precioAnio || tier.precioAnio <= 0) {
      const membresia = await store.setMembresia(req.socio.id, { tierSlug: "olimpista", ciclo: "anio" });
      return res.json({ gratis: true, membresia });
    }

    const monto = tier.precioAnio;

    // Moneda elegida por el socio (selector de la landing). Determina el link de pago.
    const moneda = (req.body?.moneda === "USD") ? "USD" : "PYG";
    const linkPago = moneda === "USD" ? tier.linkPagoUsd : tier.linkPagoGs;

    // CANDADO DE PRUEBA (staging): solo cuando el body trae la clave secreta correcta
    // se fuerza el flujo dinámico de PAGOPAR, saltándose el link estático. Los usuarios
    // reales NUNCA mandan esta clave → su flujo (link estático) queda intacto. Al pasar
    // a producción se quita PAGOPAR_TEST_KEY y el flujo dinámico vale para todos.
    const modoPrueba = !!process.env.PAGOPAR_TEST_KEY && req.body?.testPagopar === process.env.PAGOPAR_TEST_KEY;

    // Si hay link de pago estático configurado → creamos el pedido (queda PENDIENTE,
    // se confirma desde el panel admin tras verificar el pago) y redirigimos al link.
    if (linkPago && !modoPrueba) {
      const pedido = await store.createPedidoPago({
        socioId: req.socio.id, concepto: `Membresía ${tier.nombre}`,
        monto, moneda: moneda === "USD" ? "USD" : BRAND.monedaCod, tierSlug: tier.slug, ciclo: "anio",
      });
      return res.json({ gratis: false, pedido, pago: { urlPago: linkPago, modo: "link" }, tier: tier.slug });
    }

    // Sin link configurado → flujo PAGOPAR dinámico (iniciar-transaccion) / simulado (dev).
    // El cobro es SIEMPRE en guaraníes (precioAnio). El USD del selector es solo REFERENCIA
    // visual para la diáspora — no cambia el monto ni convierte nada.
    // PAGOPAR EXIGE la cédula del comprador: si el socio no la tiene, la pedimos en el checkout.
    const sFull = await store.getSocioById(req.socio.id).catch(() => null);
    let documento = soloDigitos((sFull && sFull.cedula) || "");
    const cedulaBody = soloDigitos(req.body?.cedula || "");
    if (!documento && cedulaBody) {
      if (cedulaBody.length < 5 || cedulaBody.length > 12) throw httpError(400, "Número de cédula inválido");
      if (store.getSocioByCedula) {
        const otra = await store.getSocioByCedula(cedulaBody);
        if (otra && otra.id !== req.socio.id) throw httpError(409, "Esa cédula ya está registrada en otra cuenta");
      }
      try { await store.updateSocio(req.socio.id, { cedula: cedulaBody }); documento = cedulaBody; }
      catch (e) { throw httpError(409, "Esa cédula ya está registrada en otra cuenta"); }
    }
    if (!documento) return res.json({ falta_cedula: true }); // el front pide la cédula y reintenta

    const pedido = await store.createPedidoPago({
      socioId: req.socio.id, concepto: `Membresía ${tier.nombre}`,
      monto: tier.precioAnio, moneda: BRAND.monedaCod, tierSlug: tier.slug, ciclo: "anio",
    });
    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto: tier.precioAnio, concepto: pedido.concepto,
      comprador: {
        email: req.socio.email,
        nombre: [req.socio.nombre, sFull && sFull.apellido].filter(Boolean).join(" ") || req.socio.nombre,
        documento,
        telefono: (sFull && (sFull.whatsapp || sFull.telefono)) || "",
      },
    });
    // Guardamos el hash de PAGOPAR en ref_externa → el webhook encuentra este pedido por ahí.
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    res.json({ gratis: false, pedido, pago, tier: tier.slug });
  }));

  // Cancelar membresía paga → vuelve a Olimpista gratis de inmediato. Sin encuesta ni
  // oferta de retención (regla F2): el cobro es anual único, no hay nada recurrente
  // que frenar — "cancelar" acá es "dejar de tener el nivel pago desde ahora".
  r.post("/membresia/cancelar", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    const tier = membresia ? tierBySlug(membresia.tier_slug) : null;
    if (!tier || tier.slug === "olimpista") throw httpError(400, "No tenés una membresía paga para cancelar");
    if (tier.comprable === false) throw httpError(403, "Ese nivel no se cancela desde acá");
    const nueva = await store.setMembresia(req.socio.id, { tierSlug: "olimpista", ciclo: "anio" });
    res.json({ ok: true, membresia: nueva });
  }));

  // Qué hacer cuando un pedido se confirma pagado, según su tipo (membresía / entrada de
  // preventa / subasta) — un solo lugar, usado tanto por el webhook real de PAGOPAR como
  // por la confirmación simulada de dev, para que nunca se desalineen entre sí.
  async function cumplirPedidoPagado(pedido) {
    if (pedido.tier_slug) {
      const tier = tierBySlug(pedido.tier_slug);
      if (!tier) return null;
      const membresia = await store.setMembresia(pedido.socio_id, { tierSlug: tier.slug, ciclo: pedido.ciclo || "anio", pagoRef: pedido.id });
      const s = await store.getSocioById(pedido.socio_id).catch(() => null);
      if (s && s.email && mailer.enviarBienvenidaCompra) {
        const dias = membresia.ciclo === "mes" ? 30 : 365;
        const vencimiento = new Date(new Date(membresia.inicio).getTime() + dias * 86400000);
        mailer.enviarBienvenidaCompra(s, tier.slug, { vencimiento, refExterna: pedido.ref_externa }).catch(() => {});
      }
      log.info({ tier: pedido.tier_slug, socioId: pedido.socio_id }, "pago confirmado → membresía");
      return { membresia };
    }
    if (pedido.reserva_id && store.confirmarReserva) {
      await store.confirmarReserva(pedido.reserva_id);
      try {
        const reserva = store.getReserva ? await store.getReserva(pedido.reserva_id) : null;
        const preventa = reserva && store.getPreventa ? await store.getPreventa(reserva.preventa_id) : null;
        const s = await store.getSocioById(pedido.socio_id).catch(() => null);
        if (s && s.email && preventa && mailer.enviarEntradaConfirmada)
          mailer.enviarEntradaConfirmada(s, { evento: preventa.evento, fecha: preventa.fecha, sede: preventa.sede, cantidad: reserva.cantidad }).catch(() => {});
      } catch (e) { log.warn({ err: e.message }, "pagopar mail entrada"); }
      log.info({ reservaId: pedido.reserva_id, socioId: pedido.socio_id }, "pago confirmado → entrada");
      return null;
    }
    if (pedido.subasta_id) {
      // El pago ONLINE confirma el lote; la entrega se coordina por privado (WhatsApp)
      // recién ahora — antes de esto no hace falta que el equipo escriba a nadie.
      if (store.marcarSubastaPagada) await store.marcarSubastaPagada(pedido.subasta_id);
      const s = await store.getSubasta(pedido.subasta_id).catch(() => null);
      const socio = await store.getSocioById(pedido.socio_id).catch(() => null);
      if (socio && socio.email && s && mailer.enviarSubastaPagoConfirmado) {
        const urlCertificado = (process.env.APP_URL || "https://www.olimpistas.com") + "/subasta/" + encodeURIComponent(s.slug || s.id) + "/certificado";
        mailer.enviarSubastaPagoConfirmado(socio, { titulo: s.titulo, urlCertificado, monto: pedido.monto, refExterna: pedido.ref_externa }).catch(() => {});
      }
      if (socio && s) {
        const contacto = socio.whatsapp || socio.telefono || "sin teléfono";
        alertar("subasta:pago:" + s.id, "Subasta pagada — coordinar entrega",
          `"${s.titulo}" → ${socio.nombre || socio.email} · ₲ ${Number(s.puja_actual || 0).toLocaleString("es-PY")} · contacto: ${contacto} · email: ${socio.email}`);
      }
      log.info({ subastaId: pedido.subasta_id, socioId: pedido.socio_id }, "pago confirmado → subasta");
    }
    return null;
  }

  // Confirmación de pago en modo SIMULADO (solo DEV). En producción está deshabilitado:
  // el cobro real es por los links de pago y la activación se hace desde el panel admin.
  r.post("/pagos/confirmar-simulado", auth.requireSocio, wrap(async (req, res) => {
    if (process.env.NODE_ENV === "production") throw httpError(403, "No disponible");
    if (pagopar.habilitado) throw httpError(400, "PAGOPAR está activo: usá el flujo real");
    const pedido = await store.getPedidoPago(req.body?.pedidoId);
    if (!pedido || pedido.socio_id !== req.socio.id) throw httpError(404, "Pedido no encontrado");

    await store.updatePedidoPago(pedido.id, { estado: "pagado" });
    const out = await cumplirPedidoPagado(pedido);
    res.json({ ok: true, membresia: (out && out.membresia) || null });
  }));

  // ─── Webhook de PAGOPAR (Paso #3): notificación de pago/reversión ──────────────
  // Configurar en Pagopar.com ("Integrar con mi sitio web") la URL de respuesta:
  //   https://www.olimpistas.com/api/pagos/webhook
  // SEGURIDAD OBLIGATORIA: se valida token === sha1(private + hash_pedido) antes de
  // tocar nada (si no, cualquiera podría marcar pedidos como pagados). Se responde
  // devolviendo el array `resultado` con HTTP 200 (si no, Pagopar reintenta c/10 min).
  r.post("/pagos/webhook", wrap(async (req, res) => {
    const row = req.body && req.body.resultado && req.body.resultado[0];
    const hash = row && row.hash_pedido;
    if (!row || !pagopar.validarWebhook(hash, row.token)) {
      log.warn("pagopar webhook rechazado: token inválido o payload incompleto");
      return res.status(401).json({ error: "token inválido" });
    }

    const pedido = store.getPedidoByRefExterna ? await store.getPedidoByRefExterna(hash) : null;
    if (!pedido) {
      log.warn({ hash }, "pagopar webhook sin pedido");
    } else if (row.pagado === true) {
      // Pago confirmado → marcar pedido pagado + ENTREGAR según el tipo (idempotente).
      if (pedido.estado !== "pagado") {
        await store.updatePedidoPago(pedido.id, { estado: "pagado" });
        await cumplirPedidoPagado(pedido);
      }
    } else if (row.pagado === false && pedido.estado === "pagado") {
      // Reversión de un pago ya confirmado.
      await store.updatePedidoPago(pedido.id, { estado: "reversado" });
      if (pedido.reserva_id && store.cancelarReservaYreponer) {
        // Entradas: cancelamos la reserva y reponemos el stock.
        await store.cancelarReservaYreponer(pedido.reserva_id);
      } else if (store.crearActualizacion) {
        // Membresía: la dejamos para revisión manual (NO revocamos automáticamente).
        store.crearActualizacion({
          socioId: pedido.socio_id, tipo: "pago_reversado", tierPretendido: pedido.tier_slug || "",
          estado: "a_revisar", notas: `PAGOPAR reversó el pago del pedido ${pedido.id} (hash ${hash}). Revisar membresía.`,
        }).catch(() => {});
      }
      log.warn({ pedidoId: pedido.id }, "pagopar pago REVERSADO — revisar");
    }

    // Responder devolviendo el resultado (lo que espera Pagopar) + 200.
    res.status(200).json(req.body.resultado);
  }));

  // ─── Estado de un pago (Paso #4): la página de resultado consulta en vivo ──────
  // Pagopar redirige a la URL de resultado configurada con ?hash_pedido=...; el front
  // puede llamar acá para mostrar Pagado/Pendiente/Cancelado (fuente de verdad = Pagopar).
  r.get("/pagos/estado", wrap(async (req, res) => {
    const hash = String(req.query.hash || req.query.hash_pedido || "");
    if (!hash) throw httpError(400, "Falta el hash del pedido");
    const pedido = store.getPedidoByRefExterna ? await store.getPedidoByRefExterna(hash) : null;
    let estado = (pedido && pedido.estado) || "pendiente";
    // Consulta en vivo a Pagopar (best-effort: si falla, usamos el estado local).
    try {
      const v = await pagopar.verificarPago({ hash });
      if (v.pagado) estado = "pagado";
      else if (v.cancelado) estado = "cancelado";
    } catch (e) { log.warn({ err: e.message }, "pagopar estado: consulta falló"); }
    res.json({ estado, pagado: estado === "pagado" });
  }));

  // ─── Cron diario (Cloud Scheduler): cumpleaños + renovaciones. Gateado por CRON_SECRET. ──
  // Configurar en Cloud Scheduler: POST https://www.olimpistas.com/api/cron/diario con header
  // x-cron-token = CRON_SECRET, frecuencia diaria. Reemplaza correr los scripts a mano.
  r.post("/cron/diario", wrap(async (req, res) => {
    const tok = process.env.CRON_SECRET;
    if (!tok || (req.headers["x-cron-token"] || "") !== tok) return res.status(401).json({ error: "no autorizado" });
    const out = { cumples: 0, renovaciones: 0, subastas: 0, sesionesPurgadas: 0 };
    const hoy = new Date().toISOString().slice(0, 10);
    // IDEMPOTENCIA: Cloud Scheduler es at-least-once. `reservarNotificacion` es atómico
    // (INSERT ON CONFLICT) → si el cron corre 2 veces el mismo día, o falla a mitad y
    // reintenta, cada socio recibe el correo UNA sola vez. Sin esto = spam + gasto de cuota.
    const puede = store.reservarNotificacion ? (clave) => store.reservarNotificacion(clave) : async () => true;
    try { out.subastas = await cerrarYnotificarSubastas(); } catch (e) { log.error({ err: e.message }, "cron subastas"); }
    try {
      const cumples = store.cumplenHoy ? await store.cumplenHoy() : [];
      for (const s of cumples) {
        if (!(await puede(`cumple:${s.id}:${hoy}`))) continue;
        if (mailer.enviarCumple) await mailer.enviarCumple(s).catch(() => {}); out.cumples++; await new Promise((done) => setTimeout(done, 300));
      }
    } catch (e) { log.error({ err: e.message }, "cron cumples"); }
    try {
      const venc = store.membresiasPorVencer ? await store.membresiasPorVencer(7) : [];
      for (const s of venc) {
        if (!(await puede(`renov:${s.id}:${hoy}`))) continue;
        if (mailer.enviarRenovacion) await mailer.enviarRenovacion(s, { tier: s.tier_slug, dias: Number(s.dias_rest) }).catch(() => {}); out.renovaciones++; await new Promise((done) => setTimeout(done, 300));
      }
    } catch (e) { log.error({ err: e.message }, "cron renov"); }
    try { if (store.purgarSesionesVencidas) out.sesionesPurgadas = await store.purgarSesionesVencidas(); } catch (e) { log.error({ err: e.message }, "cron purga sesiones"); }
    log.info(out, "cron diario");
    res.json({ ok: true, ...out });
  }));

  // ─── Webhook de Resend: eventos de email (métricas + supresión de rebotes/quejas) ──
  // Configurar en Resend → Webhooks: URL https://www.olimpistas.com/api/webhooks/resend.
  // Secreto de firma (whsec_...) en env RESEND_WEBHOOK_SECRET. Se verifica ANTES de procesar
  // (si no, cualquiera podría dar de baja correos o falsear métricas).
  r.post("/webhooks/resend", wrap(async (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) { log.warn("resend webhook sin RESEND_WEBHOOK_SECRET — ignorado"); return res.status(200).json({ ok: true, skipped: true }); }
    const okSig = resend.verificarSvix(secret, {
      id: req.headers["svix-id"], timestamp: req.headers["svix-timestamp"], signature: req.headers["svix-signature"],
    }, req.rawBody);
    if (!okSig) { log.warn("resend firma inválida"); return res.status(401).json({ error: "firma inválida" }); }

    const ev = req.body || {};
    const tipo = String(ev.type || "").replace(/^email\./, "");
    const data = ev.data || {};
    const email = (Array.isArray(data.to) ? data.to[0] : (data.to || data.email || "")) || "";
    if (store.registrarEmailEvento) await store.registrarEmailEvento({ tipo, email, messageId: data.email_id || data.id || "", asunto: data.subject || "" }).catch(() => {});
    // Rebote duro o queja de spam → baja de marketing (protege la reputación del dominio).
    if ((tipo === "bounced" || tipo === "complained") && email && store.marcarBajaPorEmail) {
      const n = await store.marcarBajaPorEmail(email).catch(() => 0);
      log.info({ tipo, email, n }, "resend supresión");
    }
    res.status(200).json({ ok: true });
  }));

  // ─── Baja de correos de MARKETING (List-Unsubscribe) ──────────────────────────
  // Link del footer de los correos de marketing. GET = página para humanos; POST =
  // one-click (RFC 8058, lo dispara Gmail/Apple Mail). El token `u` va en la URL, así
  // que ambos lo leen de la query. NO afecta los correos transaccionales (pagos, seguridad).
  async function procesarBaja(u) {
    const id = mailer.unsubValido ? mailer.unsubValido(u) : null;
    if (id) { try { await store.updateSocio(id, { marketing_baja: true, marketing_baja_en: new Date().toISOString() }); } catch (e) {} }
    return !!id;
  }
  r.post("/baja", wrap(async (req, res) => {
    await procesarBaja(req.query.u || (req.body && req.body.u));
    res.status(200).json({ ok: true }); // one-click: siempre 200
  }));
  r.get("/baja", wrap(async (req, res) => {
    const ok = await procesarBaja(req.query.u);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja de novedades — Olimpistas</title></head><body style="margin:0;background:#0b0b0f;color:#fff;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center"><div style="text-align:center;padding:32px;max-width:460px"><div style="font-size:15px;letter-spacing:2px;color:#c9a227;font-weight:800;margin-bottom:14px">OLIMPISTAS</div><h1 style="font-size:24px;margin:0 0 12px">${ok ? "Listo, te diste de baja" : "No pudimos procesar la baja"}</h1><p style="color:#c6c6d0;line-height:1.6;font-size:15px">${ok ? "No vas a recibir más correos de novedades y promociones. Los correos importantes de tu cuenta (pagos, seguridad) van a seguir llegando." : "El enlace no es válido o expiró. Escribinos respondiendo cualquier correo y te damos de baja a mano."}</p><a href="https://www.olimpistas.com" style="display:inline-block;margin-top:20px;color:#1a1500;background:linear-gradient(120deg,#f0d873,#c9a227);text-decoration:none;font-weight:800;padding:13px 28px;border-radius:10px">Volver a Olimpistas</a></div></body></html>`);
  }));

  // ─── Webhook de Metrepay: ELIMINADO ──────────────────────────────────────
  // Dejamos de usar Metrepay; los pagos van por Pagopar (webhook /pagos/webhook,
  // fail-closed + firma). El endpoint viejo se quitó porque fallaba-abierto si
  // faltaba el token. El histórico de pagos Metrepay se conserva en la tabla
  // `actualizaciones` (tipo pago_metrepay) para el cuadre y el export contable.

  // ─── Panel admin: sesión (usuario+contraseña) con roles + clave break-glass ──
  // Cuentas reales en admin_usuarios. Break-glass: ADMIN_KEYS="nombre:clave,..." + ADMIN_KEY
  // → rol owner (UI de emergencia + scripts CLI), para no quedar nunca afuera.
  const ADMIN_KEYS = (process.env.ADMIN_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":"); return i > 0 ? { nombre: p.slice(0, i), key: p.slice(i + 1) } : { nombre: "admin", key: p };
  });
  if (process.env.ADMIN_KEY) ADMIN_KEYS.push({ nombre: "admin", key: process.env.ADMIN_KEY });
  const requireAdmin = async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // NUNCA cachear datos admin (ni en CDN ni navegador)
    try {
      const token = req.headers["x-admin-token"] || "";
      if (token && store.getAdminSession) {
        const s = await store.getAdminSession(token);
        if (s) { req.adminUser = s.usuario; req.adminRole = s.rol; req.adminId = s.admin_id; return next(); }
      }
      const key = req.headers["x-admin-key"] || ""; // break-glass → owner
      if (key) {
        const kb = Buffer.from(key);
        const found = ADMIN_KEYS.find((a) => { const ab = Buffer.from(a.key); return ab.length === kb.length && crypto.timingSafeEqual(ab, kb); });
        if (found) {
          req.adminUser = found.nombre; req.adminRole = "owner";
          // Auditoría: la llave break-glass concede owner → dejar rastro SIEMPRE (acción sensible).
          if (store.logAccionAdmin) store.logAccionAdmin({ accion: "break-glass", detalle: `${req.method} ${req.originalUrl || req.url}`, por: found.nombre });
          return next();
        }
      }
      return res.status(401).json({ error: "No autorizado" });
    } catch (e) { return res.status(500).json({ error: "Error de autenticación" }); }
  };
  // Permiso por rol (la seguridad real). Las lecturas no lo usan; las escrituras sí.
  const requirePerm = (perm) => (req, res, next) => {
    if (adminAuth.can(req.adminRole, perm)) return next();
    return res.status(403).json({ error: "No tenés permiso para esta acción" });
  };
  // Cache corto para reportes pesados (evita re-correr agregados en cada carga del panel).
  const _adminMemo = {};
  const memoAdmin = async (key, ttlMs, fn) => {
    const c = _adminMemo[key];
    if (c && Date.now() - c.t < ttlMs) return c.v;
    const v = await fn();
    _adminMemo[key] = { v, t: Date.now() };
    return v;
  };

  // ─── Login / sesión / gestión de usuarios del panel ──────────────────────────
  r.post("/admin/login", wrap(async (req, res) => {
    const b = req.body || {};
    const out = await adminAuth.loginAdmin({ usuario: b.usuario, password: b.password });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "login", detalle: out.rol, por: out.usuario });
    res.json(out);
  }));
  r.post("/admin/logout", requireAdmin, wrap(async (req, res) => {
    await adminAuth.logoutAdmin(req.headers["x-admin-token"] || "");
    res.json({ ok: true });
  }));
  r.get("/admin/whoami", requireAdmin, wrap(async (req, res) => {
    const rol = req.adminRole || "owner";
    res.json({ usuario: req.adminUser, rol, areas: adminAuth.AREAS_POR_ROL[rol] || adminAuth.AREAS_POR_ROL.owner, perms: adminAuth.PERMS_POR_ROL[rol] || [] });
  }));
  // Gestión de usuarios (solo owner).
  r.get("/admin/usuarios", requireAdmin, requirePerm("usuarios"), wrap(async (_req, res) => {
    res.json({ items: store.listAdminUsuarios ? await store.listAdminUsuarios() : [], roles: adminAuth.ROLES });
  }));
  r.post("/admin/usuarios", requireAdmin, requirePerm("usuarios"), wrap(async (req, res) => {
    const b = req.body || {};
    const u = await adminAuth.crearAdminUsuario({ usuario: b.usuario, nombre: b.nombre, password: b.password, rol: b.rol });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "usuario:crear", targetId: u.id, detalle: u.usuario + " (" + u.rol + ")", por: req.adminUser });
    res.status(201).json({ ok: true, usuario: u });
  }));
  r.patch("/admin/usuarios/:id", requireAdmin, requirePerm("usuarios"), wrap(async (req, res) => {
    const b = req.body || {};
    const target = store.getAdminUsuarioById ? await store.getAdminUsuarioById(req.params.id) : null;
    if (!target) throw httpError(404, "Usuario no encontrado");
    // Proteger al último owner: no bajarle el rol ni desactivarlo si es el único.
    const bajaOwner = (b.rol && b.rol !== "owner" && target.rol === "owner") || (b.activo === false && target.rol === "owner");
    if (bajaOwner && (await store.contarAdminPorRol("owner")) <= 1) throw httpError(400, "No podés dejar el sistema sin ningún owner");
    const patch = {};
    if (b.nombre !== undefined) patch.nombre = String(b.nombre);
    if (b.rol !== undefined) { if (!adminAuth.ROLES.includes(b.rol)) throw httpError(400, "Rol inválido"); patch.rol = b.rol; }
    if (b.activo !== undefined) patch.activo = !!b.activo;
    if (Object.keys(patch).length) await store.updateAdminUsuario(req.params.id, patch);
    if (b.password) await adminAuth.setAdminPassword(req.params.id, b.password); // re-hashea + invalida sesiones
    if (!b.password && ((patch.rol && patch.rol !== target.rol) || b.activo === false)) await store.deleteAdminSessionsByUser(req.params.id);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "usuario:editar", targetId: req.params.id, detalle: Object.keys(patch).concat(b.password ? ["password"] : []).join(","), por: req.adminUser });
    res.json({ ok: true });
  }));
  r.delete("/admin/usuarios/:id", requireAdmin, requirePerm("usuarios"), wrap(async (req, res) => {
    const target = store.getAdminUsuarioById ? await store.getAdminUsuarioById(req.params.id) : null;
    if (!target) throw httpError(404, "Usuario no encontrado");
    if (req.adminId && req.adminId === req.params.id) throw httpError(400, "No podés borrarte a vos mismo");
    if (target.rol === "owner" && (await store.contarAdminPorRol("owner")) <= 1) throw httpError(400, "No podés borrar al último owner");
    await store.deleteAdminUsuario(req.params.id);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "usuario:borrar", targetId: req.params.id, detalle: target.usuario, por: req.adminUser });
    res.json({ ok: true });
  }));

  // Resumen: total de socios reales + pedidos pendientes de confirmar.
  r.get("/admin/resumen", requireAdmin, wrap(async (_req, res) => {
    const [totalReal, pendientes, subastas] = await Promise.all([
      store.contarTotal ? store.contarTotal() : 0,
      store.listPedidos ? store.listPedidos({ estado: "pendiente", limit: 200 }) : [],
      store.listSubastas ? store.listSubastas() : [],
    ]);
    // Precio a mostrar según la moneda del pedido (Gs y USD son independientes).
    const enrich = pendientes.map((p) => {
      const t = tierBySlug(p.tier_slug);
      const precioTxt = p.moneda === "USD"
        ? "US$ " + (t && t.precioUSD != null ? Number(t.precioUSD).toFixed(2) : p.monto)
        : "₲ " + Number((t && t.precioAnio) || p.monto || 0).toLocaleString("es-PY");
      return { ...p, precioTxt };
    });
    // Atención de subastas: ganadores que todavía no pagaron (con o sin pedido iniciado)
    // + pausadas, que son fáciles de olvidar una vez que dejan de aparecer en el home.
    const subastasSinPagar = (subastas || []).filter((s) => s.estado === "cerrada" && s.ganador_id && s.pago_estado !== "pagado").length;
    const subastasPausadas = (subastas || []).filter((s) => s.estado === "pausada").length;
    res.json({ totalReal, pendientes: enrich, subastasSinPagar, subastasPausadas });
  }));
  // Reportes de negocio: embudo, membresías (pagas vs gratis), top países, altas/día.
  r.get("/admin/reportes", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("reportes", 30000, async () => {
    const [est, porPais] = await Promise.all([
      store.estadisticasAdmin ? store.estadisticasAdmin() : { embudo: {}, membresias: [], altas: [] },
      store.contarPorPais ? store.contarPorPais() : [],
    ]);
    // Nombre legible del tier + ordenar países desc.
    const membresias = (est.membresias || []).map((m) => {
      const t = tierBySlug(m.tier_slug);
      return { ...m, gratis: Math.max(0, (m.total || 0) - (m.pagados || 0)), nombre: (t && t.nombre) || m.tier_slug };
    });
    const paises = [...porPais]
      .map((p) => ({ iso: p.pais_iso, nombre: paisNombre(p.pais_iso) || p.pais_iso, count: Number(p.count || 0) }))
      .sort((a, b) => b.count - a.count).slice(0, 15);
    return { embudo: est.embudo || {}, membresias, altas: est.altas || [], paises, tiempo: est.tiempo || {} };
    }));
  }));
  // Activar/cambiar el tier de un socio a mano (resuelve pagos sin match, etc.).
  r.post("/admin/socios/:id/membresia", requireAdmin, requirePerm("socios.write"), wrap(async (req, res) => {
    const tier = tierBySlug((req.body || {}).tier);
    if (!tier) throw httpError(400, "Nivel inválido");
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const membresia = await store.setMembresia(socio.id, { tierSlug: tier.slug, ciclo: "anio", pagoRef: "admin-manual" });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "activar_tier", targetId: socio.id, detalle: (socio.email || "") + " → " + tier.slug, por: req.adminUser });
    res.json({ ok: true, membresia });
  }));
  // Ficha completa de un socio: perfil + membresía actual + historial + pedidos + actualizaciones.
  r.get("/admin/socios/:id", requireAdmin, wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const [membresia, historial, pedidos, actualizaciones] = await Promise.all([
      store.getMembresia(socio.id),
      store.listMembresias ? store.listMembresias(socio.id) : [],
      store.listPedidos ? store.listPedidos({ socioId: socio.id, limit: 50 }) : [],
      store.listActualizaciones ? store.listActualizaciones({ socioId: socio.id, limit: 50 }) : [],
    ]);
    const safe = { ...socio }; delete safe.password_hash; delete safe.password; delete safe.verif_token;
    res.json({ socio: safe, membresia, historial, pedidos, actualizaciones });
  }));
  // Editar datos del socio (corregir email/cédula mal cargados = arregla matches de pago).
  r.patch("/admin/socios/:id", requireAdmin, requirePerm("socios.write"), wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const b = req.body || {};
    const limpiar = (s) => (typeof s === "string" ? s.replace(/[<>]/g, "").trim().slice(0, 160) : undefined);
    const patch = {};
    for (const f of ["nombre", "apellido", "ciudad", "pais"]) if (b[f] != null) patch[f] = limpiar(b[f]);
    if (b.pais_iso != null) patch.pais_iso = String(b.pais_iso).toUpperCase().slice(0, 2);
    if (b.email != null) {
      const email = String(b.email).toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "Email inválido");
      if (email !== socio.email && store.getSocioByEmail) {
        const dup = await store.getSocioByEmail(email);
        if (dup && dup.id !== socio.id) throw httpError(409, "Ese email ya está en uso");
      }
      patch.email = email;
    }
    if (b.cedula != null) {
      const ced = String(b.cedula).trim();
      if (ced && store.getSocioByCedula) {
        const dup = await store.getSocioByCedula(ced);
        if (dup && dup.id !== socio.id) throw httpError(409, "Esa cédula ya está en otra cuenta");
      }
      patch.cedula = ced;
    }
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const actualizado = await store.updateSocio(socio.id, patch);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "editar_socio", targetId: socio.id, detalle: Object.keys(patch).join(", "), por: req.adminUser });
    const safe = { ...actualizado }; delete safe.password_hash; delete safe.password; delete safe.verif_token;
    res.json({ ok: true, socio: safe });
  }));
  // Reenviar el email de verificación a un socio.
  r.post("/admin/socios/:id/reenviar-verificacion", requireAdmin, requirePerm("socios.write"), wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const vtoken = crypto.randomBytes(24).toString("base64url");
    await store.updateSocio(socio.id, { verif_token: vtoken, email_verificado: false });
    const proto = req.headers["x-forwarded-proto"] || "https";
    const link = `${proto}://${req.headers.host}/api/auth/verificar?token=${vtoken}`;
    const r0 = await mailer.enviarVerificacion(socio, link);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "reenviar_verif", targetId: socio.id, detalle: socio.email || "" });
    res.json({ ok: !!(r0 && r0.ok), modo: r0 && r0.modo });
  }));
  // Abandonos de pago: iniciaron checkout y no completaron (conversión).
  r.get("/admin/abandonos", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("abandonos", 30000, async () => {
      const items = store.abandonosPago ? await store.abandonosPago() : [];
      return { total: items.length, items };
    }));
  }));
  // Salud del sistema: ping DB, estado de la rampa, edad del cache, flags, revisión.
  r.get("/admin/salud", requireAdmin, wrap(async (_req, res) => {
    const t0 = Date.now();
    let dbOk = true, dbMs = null;
    try { await store.contarTotal(); dbMs = Date.now() - t0; } catch (e) { dbOk = false; }
    res.json({
      db: { ok: dbOk, ms: dbMs },
      ramp: { activo: !!process.env.RAMP_INICIO, objetivo: rampaObjetivo() },
      statsCacheEdadSeg: _statsTs ? Math.round((Date.now() - _statsTs) / 1000) : null,
      emailVerif: process.env.EMAIL_VERIF === "off" ? "off" : "on",
      rev: process.env.K_REVISION || null,
    });
  }));
  // Cuadre de pagos (conciliación pedidos / membresías pagas / Metrepay).
  r.get("/admin/pagos-recibidos", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("pagos-recibidos", 30000, () => (store.pagosRecibidos ? store.pagosRecibidos() : { totales: {}, porConcepto: [], ultimos: [] })));
  }));
  r.get("/admin/email-metricas", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("email-metricas", 30000, () => (store.metricasEmail ? store.metricasEmail(30) : { ventana: {}, total: {} })));
  }));
  r.get("/admin/cuadre", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("cuadre", 30000, () => (store.cuadrePagos ? store.cuadrePagos() : {})));
  }));
  // Log de acciones del panel (auditoría).
  r.get("/admin/acciones", requireAdmin, wrap(async (req, res) => {
    const items = store.listAccionesAdmin ? await store.listAccionesAdmin({ limit: req.query.limit }) : [];
    res.json({ items });
  }));
  // Export CSV de los pagos Metrepay (contabilidad).
  r.get("/admin/export/pagos.csv", requireAdmin, requirePerm("export"), wrap(async (_req, res) => {
    const items = store.listActualizaciones ? await store.listActualizaciones({ tipo: "pago_metrepay", limit: 2000 }) : [];
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const head = ["fecha", "pagador", "cedula_o_tel", "nivel", "estado", "notas"];
    const rows = items.map((a) => [a.creado, [a.nombre, a.apellido].filter(Boolean).join(" "), a.email, a.tier_pretendido, a.estado, a.notas].map(q).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="pagos-metrepay.csv"');
    res.send(head.join(",") + "\n" + rows.join("\n"));
  }));
  // Segmento de socios (filtros: tier, país, validó socio, sin foto, texto).
  r.get("/admin/segmento", requireAdmin, wrap(async (req, res) => {
    const f = { tier: req.query.tier || undefined, paisIso: req.query.pais || undefined, validoSocio: req.query.validoSocio === "1", sinFoto: req.query.sinFoto === "1", q: req.query.q || undefined, limit: 500 };
    const items = store.filtrarSocios ? await store.filtrarSocios(f) : [];
    res.json({ total: items.length, items });
  }));
  r.get("/admin/export/socios.csv", requireAdmin, requirePerm("export"), wrap(async (req, res) => {
    const f = { tier: req.query.tier || undefined, paisIso: req.query.pais || undefined, validoSocio: req.query.validoSocio === "1", sinFoto: req.query.sinFoto === "1", q: req.query.q || undefined, limit: 5000 };
    const items = store.filtrarSocios ? await store.filtrarSocios(f) : [];
    const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const head = ["nombre", "apellido", "email", "cedula", "pais", "pais_iso", "tier", "socio_olimpia", "tiene_foto", "creado"];
    const rows = items.map((s) => [s.nombre, s.apellido, s.email, s.cedula, s.pais, s.pais_iso, s.tier_slug, s.es_socio_olimpia ? "si" : "no", s.tiene_foto ? "si" : "no", s.creado].map(q).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="socios.csv"');
    res.send(head.join(",") + "\n" + rows.join("\n"));
  }));
  // Dar de baja → revertir a Olimpista gratis (el reembolso real se hace en Metrepay).
  r.post("/admin/socios/:id/baja", requireAdmin, requirePerm("socios.write"), wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const motivo = String((req.body || {}).motivo || "").slice(0, 200);
    const membresia = await store.setMembresia(socio.id, { tierSlug: "olimpista", ciclo: "anio", pagoRef: "admin-baja" });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "baja", targetId: socio.id, detalle: (socio.email || "") + (motivo ? " · " + motivo : ""), por: req.adminUser });
    res.json({ ok: true, membresia });
  }));

  // ─── CRUD admin de sorteos / preventas / contenido ──────────────────────────
  const limpiarCampos = (body, campos) => {
    const b = body || {}, out = {};
    for (const f in campos) {
      if (b[f] == null) continue;
      const t = campos[f];
      if (t === "int") out[f] = b[f] === "" ? null : Number(b[f]);
      else if (t === "date") out[f] = b[f] === "" ? null : String(b[f]).slice(0, 10);
      // "imagen": puede ser una data URL subida desde el admin (varios KB/MB de base64),
      // no una URL corta — el tope de "text" (500 chars) la truncaría y la rompería.
      // Tope generoso pero por debajo del límite de body JSON (express.json 1mb).
      else if (t === "imagen") out[f] = typeof b[f] === "string" ? b[f].trim().slice(0, 900000) : b[f];
      else out[f] = typeof b[f] === "string" ? b[f].replace(/[<>]/g, "").trim().slice(0, 500) : b[f];
    }
    return out;
  };
  const crudEntidad = (nombre, o) => {
    r.get(`/admin/${nombre}`, requireAdmin, wrap(async (_req, res) => res.json({ items: await o.list() })));
    r.post(`/admin/${nombre}`, requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
      const item = await o.crear(limpiarCampos(req.body, o.campos));
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":crear", targetId: item && item.id, por: req.adminUser });
      res.status(201).json({ ok: true, item });
    }));
    r.patch(`/admin/${nombre}/:id`, requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
      const d = limpiarCampos(req.body, o.campos);
      if (!Object.keys(d).length) throw httpError(400, "Nada para actualizar");
      const item = await o.update(req.params.id, d);
      if (!item) throw httpError(404, "No encontrado");
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":editar", targetId: req.params.id, por: req.adminUser });
      res.json({ ok: true, item });
    }));
    r.delete(`/admin/${nombre}/:id`, requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
      const ok = await o.del(req.params.id);
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":borrar", targetId: req.params.id, por: req.adminUser });
      res.json({ ok });
    }));
  };
  crudEntidad("sorteos", { list: () => store.listSorteos(), crear: (d) => store.crearSorteo(d), update: (id, d) => store.updateSorteo(id, d), del: (id) => store.deleteSorteo(id), campos: { titulo: "text", descripcion: "text", tier_min: "text", cierra: "date", imagen: "text" } });
  crudEntidad("preventas", { list: () => store.listPreventas(), crear: (d) => store.crearPreventa(d), update: (id, d) => store.updatePreventa(id, d), del: (id) => store.deletePreventa(id), campos: { evento: "text", fecha: "date", sede: "text", abre: "date", tier_min: "text", precio_desde: "int", stock: "int", imagen: "text" } });
  crudEntidad("contenido", { list: () => store.listContenido(), crear: (d) => store.crearContenido(d), update: (id, d) => store.updateContenido(id, d), del: (id) => store.deleteContenido(id), campos: { titulo: "text", tipo: "text", tier_min: "text", duracion: "text", descripcion: "text", thumb: "text", publicado: "date" } });
  // Red de Beneficios (admin). comercio_id enlaza el beneficio; niveles = "todos" o CSV "premium,socio".
  crudEntidad("comercios", { list: () => store.listComercios(), crear: (d) => store.crearComercio(d), update: (id, d) => store.updateComercio(id, d), del: (id) => store.deleteComercio(id), campos: { nombre: "text", rubro: "text", ciudad: "text", direccion: "text", contacto: "text", logo: "text", estado: "text" } });
  crudEntidad("beneficios", { list: () => store.listBeneficios(), crear: (d) => store.crearBeneficio(d), update: (id, d) => store.updateBeneficio(id, d), del: (id) => store.deleteBeneficio(id), campos: { comercio_id: "text", titulo: "text", descripcion: "text", tipo: "text", valor: "text", niveles: "text", pct: "int", ahorro_estimado: "int", vigencia_desde: "date", vigencia_hasta: "date", limite_dias: "int" } });
  // Subastas (admin). Se crean como BORRADOR; se publican con /publicar (setea termina = now + duracion_horas).
  crudEntidad("subastas", {
    list: () => store.listSubastas(), crear: (d) => store.crearSubasta(d), del: (id) => store.deleteSubasta(id),
    update: async (id, d) => {
      // Si ya está en vivo (activa o pausada), "duración" editada sin más queda guardada
      // pero SIN NINGÚN EFECTO — el reloj real es `termina`, fijado una sola vez al
      // publicar, y nunca se recalculaba acá (bug reportado: cambiar duración no movía
      // nada en vivo). Recalculamos termina = inicia + nueva duración en ese caso.
      if (d.duracion_horas != null) {
        const actual = await store.getSubasta(id);
        if (actual && actual.inicia && (actual.estado === "activa" || actual.estado === "pausada")) {
          d.termina = new Date(new Date(actual.inicia).getTime() + Number(d.duracion_horas) * 3600000).toISOString();
        }
      }
      const item = await store.updateSubasta(id, d);
      _subCache.delete(id); _listaSub = null; // que se vea al toque, no hasta que expire el cache
      return item;
    },
    campos: { titulo: "text", descripcion: "text", emoji: "text", imagen: "imagen", nivel_min: "text", precio_inicial: "int", incremento: "int", duracion_horas: "int" },
  });
  // Encuestas (admin). `opciones` = texto separado por "|". `estado` = borrador|activa|cerrada (editable en el form o con las acciones de fila).
  crudEntidad("encuestas", { list: () => store.listEncuestas(), crear: (d) => store.crearEncuesta(d), update: (id, d) => store.updateEncuesta(id, d), del: (id) => store.deleteEncuesta(id), campos: { titulo: "text", pregunta: "text", opciones: "text", tipo: "text", nivel_min: "text", estado: "text" } });
  r.get("/admin/encuestas/:id/resultados", requireAdmin, wrap(async (req, res) => res.json((await store.resultadosEncuesta(req.params.id)) || {})));
  // Participantes de un sorteo + sortear ganador al azar (queda en el log).
  r.get("/admin/sorteos/:id/participantes", requireAdmin, wrap(async (req, res) => {
    res.json({ items: store.listParticipantesSorteo ? await store.listParticipantesSorteo(req.params.id) : [] });
  }));
  r.post("/admin/sorteos/:id/ganador", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const parts = store.listParticipantesSorteo ? await store.listParticipantesSorteo(req.params.id) : [];
    if (!parts.length) throw httpError(400, "Este sorteo no tiene participantes");
    const g = parts[Math.floor(Math.random() * parts.length)];
    await store.updateSorteo(req.params.id, { ganador_id: g.id }); // queda registrado — antes se sorteaba y se perdía
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "sorteo:ganador", targetId: req.params.id, detalle: [g.nombre, g.apellido].filter(Boolean).join(" ") + " <" + (g.email || "") + ">" });
    // Avisar al ganador (best-effort).
    if (g && g.email && mailer.enviarSorteoGanador) {
      const sorteo = store.getSorteo ? await store.getSorteo(req.params.id).catch(() => null) : null;
      mailer.enviarSorteoGanador(g, { titulo: sorteo && sorteo.titulo }).catch(() => {});
    }
    res.json({ ok: true, ganador: g, total: parts.length });
  }));

  // ─── Padrón explorer ─────────────────────────────────────────────────────────
  r.get("/admin/padron", requireAdmin, wrap(async (req, res) => {
    const [items, stats] = await Promise.all([
      store.buscarPadronLista ? store.buscarPadronLista(req.query.q || "", 200) : [],
      store.statsPadron ? store.statsPadron() : {},
    ]);
    res.json({ items, stats });
  }));

  // ─── Moderación de selfies (lista liviana; la foto se ve en la ficha) ────────
  r.get("/admin/selfies", requireAdmin, wrap(async (_req, res) => {
    res.json({ items: store.listSociosConFoto ? await store.listSociosConFoto({ limit: 100 }) : [] });
  }));
  r.post("/admin/socios/:id/quitar-foto", requireAdmin, requirePerm("moderacion"), wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    await store.updateSocio(socio.id, { foto: "" });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "quitar_foto", targetId: socio.id, detalle: socio.email || "", por: req.adminUser });
    res.json({ ok: true });
  }));

  // ─── GoHighLevel: estado + push de segmento (se enchufa luego vía GHL_WEBHOOK_URL) ─
  r.get("/admin/ghl", requireAdmin, wrap(async (_req, res) => {
    res.json({ configurado: !!process.env.GHL_WEBHOOK_URL });
  }));
  r.post("/admin/ghl/sync", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    const url = process.env.GHL_WEBHOOK_URL;
    if (!url) throw httpError(400, "GoHighLevel no conectado (falta GHL_WEBHOOK_URL)");
    const f = { tier: req.query.tier || undefined, paisIso: req.query.pais || undefined, validoSocio: req.query.validoSocio === "1", sinFoto: req.query.sinFoto === "1", q: req.query.q || undefined, limit: 2000 };
    const socios = store.filtrarSocios ? await store.filtrarSocios(f) : [];
    const contactos = socios.map((s) => ({ firstName: s.nombre || "", lastName: s.apellido || "", email: s.email, country: s.pais_iso || "", tags: ["olimpista", s.tier_slug].filter(Boolean) }));
    let enviados = 0, fallidos = 0;
    try {
      const r0 = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "olimpistas", total: contactos.length, contactos }) });
      if (r0.ok) enviados = contactos.length; else fallidos = contactos.length;
    } catch (e) { fallidos = contactos.length; }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "ghl:sync", detalle: enviados + " contactos", por: req.adminUser });
    res.json({ ok: enviados > 0, enviados, fallidos, total: contactos.length });
  }));

  // ─── Campañas + tasa de conversión ───────────────────────────────────────────
  r.get("/admin/campanas", requireAdmin, wrap(async (_req, res) => {
    res.json({ items: store.listCampanas ? await store.listCampanas() : [] });
  }));
  // Lanzar "Completá tu pago": congela el cohort de abandonos como envíos de la campaña.
  // El email se manda aparte por CLI (166+ envíos no entran en un request); acá solo se
  // arma el cohort para poder medir la conversión.
  r.post("/admin/campanas/pago", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    if (!store.crearCampana || !store.abandonosPago) throw httpError(503, "No disponible");
    const cohort = await store.abandonosPago();
    if (!cohort.length) throw httpError(400, "No hay abandonos de pago para la campaña");
    const camp = await store.crearCampana({ nombre: "Completá tu pago", tipo: "pago" });
    await store.crearEnviosCampana(camp.id, cohort.map((s) => ({ id: s.id, email: s.email, tier_slug: s.tier_slug, estado_inicial: "olimpista" })));
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "campana:crear", targetId: camp.id, detalle: cohort.length + " destinatarios", por: req.adminUser });
    res.status(201).json({ ok: true, id: camp.id, total: cohort.length });
  }));
  r.post("/admin/campanas/:id/recalcular", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    if (!store.recalcularConversion) throw httpError(503, "No disponible");
    const r0 = await store.recalcularConversion(req.params.id);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "campana:recalcular", targetId: req.params.id, detalle: r0.convertidos + "/" + r0.enviados, por: req.adminUser });
    res.json({ ok: true, enviados: r0.enviados, convertidos: r0.convertidos });
  }));
  // Confirmar un pago (tras verificarlo en la pasarela) → activa la membresía.
  r.post("/admin/pedidos/:id/activar", requireAdmin, requirePerm("pagos.write"), wrap(async (req, res) => {
    const pedido = await store.getPedidoPago(req.params.id);
    if (!pedido) throw httpError(404, "Pedido no encontrado");
    await store.updatePedidoPago(pedido.id, { estado: "pagado" });
    const tier = tierBySlug(pedido.tier_slug);
    const membresia = tier
      ? await store.setMembresia(pedido.socio_id, { tierSlug: tier.slug, ciclo: pedido.ciclo, pagoRef: pedido.id })
      : null;
    res.json({ ok: true, membresia });
  }));
  // Rechazar/cancelar un pedido.
  r.post("/admin/pedidos/:id/rechazar", requireAdmin, requirePerm("pagos.write"), wrap(async (req, res) => {
    const pedido = await store.getPedidoPago(req.params.id);
    if (!pedido) throw httpError(404, "Pedido no encontrado");
    await store.updatePedidoPago(pedido.id, { estado: "rechazado" });
    res.json({ ok: true });
  }));
  // Buscar socios por email / nombre / cédula.
  r.get("/admin/buscar", requireAdmin, wrap(async (req, res) => {
    const socios = store.buscarSocios ? await store.buscarSocios(req.query.q || "", 50) : [];
    res.json({ socios });
  }));

  // Cola de Actualización (staging): listar y resolver (unificar/rechazar).
  r.get("/admin/actualizaciones", requireAdmin, wrap(async (req, res) => {
    const items = store.listActualizaciones ? await store.listActualizaciones({ estado: req.query.estado || undefined, tipo: req.query.tipo || undefined, limit: 300 }) : [];
    res.json({ items });
  }));
  r.post("/admin/actualizaciones/:id/:accion", requireAdmin, requirePerm("padron.resolve"), wrap(async (req, res) => {
    const map = { unificar: "unificado", rechazar: "rechazado", revisar: "a_revisar" };
    const estado = map[req.params.accion];
    if (!estado) throw httpError(400, "Acción inválida");
    if (!store.updateActualizacion) throw httpError(503, "No disponible");
    const r0 = await store.updateActualizacion(req.params.id, { estado, verificado_por: "admin", verificado_en: new Date().toISOString() });
    if (!r0) throw httpError(404, "No encontrado");
    res.json({ ok: true, item: r0 });
  }));

  // ─── Contenido exclusivo (Olimpia Media+) ───────────────────────────────────
  r.get("/contenido", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await store.listContenido()).map((c) => ({
      ...c,
      desbloqueado: access.puedeAcceder(membresia, c.tier_min),
    }));
    res.json({ items, miNivel: access.nivelDeMembresia(membresia) });
  }));

  r.get("/contenido/:id", auth.requireSocio, wrap(async (req, res) => {
    const item = await store.getContenido(req.params.id);
    if (!item) throw httpError(404, "Contenido no encontrado");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, item.tier_min))
      throw httpError(403, "Este contenido es para Olimpistas Premium");
    res.json({ item, streamUrl: `/assets/demo-stream.mp4` });
  }));

  // ─── Sorteos ────────────────────────────────────────────────────────────────
  r.get("/sorteos", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const mias = req.socio ? await store.listParticipaciones(req.socio.id) : [];
    const setMios = new Set(mias.map(p => p.sorteo_id));
    const hoy = new Date().toISOString().slice(0, 10);
    // Los cerrados quedan (con resultado, si hubo sorteo) como historial en Descubrir —
    // antes se filtraban del todo y el ganador se perdía sin quedar registrado en ningún lado.
    const items = (await store.listSorteos()).map((s) => {
      const abierto = !s.cierra || String(s.cierra).slice(0, 10) >= hoy;
      return {
        ...s,
        estado: abierto ? "activa" : "cerrada",
        elegible: access.puedeAcceder(membresia, s.tier_min),
        participando: setMios.has(s.id),
        gano: !abierto && !!(req.socio && s.ganador_id === req.socio.id),
        ganador_nombre: (!abierto && s.ganador_id && s.ganador_nombre) ? enmascararNombre(s.ganador_nombre) : null,
      };
    });
    res.json({ items });
  }));

  r.post("/sorteos/:id/participar", auth.requireSocio, wrap(async (req, res) => {
    const sorteo = await store.getSorteo(req.params.id);
    if (!sorteo) throw httpError(404, "Sorteo no encontrado");
    const hoy = new Date().toISOString().slice(0, 10);
    if (sorteo.cierra && String(sorteo.cierra).slice(0, 10) < hoy)
      throw httpError(409, "Este sorteo ya cerró");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, sorteo.tier_min))
      throw httpError(403, "Este sorteo es para un nivel superior");
    const participacion = await store.participarSorteo(sorteo.id, req.socio.id);
    res.json({ ok: true, participacion });
  }));

  // ─── Encuestas (Fan Survey) ───────────────────────────────────────────────
  // Encuestas cortas para enriquecer el perfil del hincha. Al responder se ven los
  // resultados agregados (enganche + prueba social). Una respuesta por socio (upsert).
  // Cache corto (8s) de resultados agregados: con miles de socios abriendo el tab, la DB
  // recibe ~1 agregado cada 8s por encuesta/instancia en vez de uno por socio. Bust al votar.
  const _encResCache = new Map();
  async function resultadosCached(id) {
    const c = _encResCache.get(id);
    if (c && Date.now() - c.t < 8000) return c.v;
    const v = await store.resultadosEncuesta(id);
    _encResCache.set(id, { t: Date.now(), v });
    return v;
  }
  r.get("/encuestas", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    const items = [];
    for (const e of await store.encuestasActivas()) {
      if (!access.puedeAcceder(membresia, e.nivel_min || "olimpista")) continue;
      const mia = await store.miRespuestaEncuesta(e.id, req.socio.id);
      const item = { id: e.id, titulo: e.titulo, pregunta: e.pregunta, tipo: e.tipo, opciones: e.opciones || [],
        respondida: !!mia, mi_opcion: mia ? mia.opcion : null };
      if (mia) item.resultados = await resultadosCached(e.id);
      items.push(item);
    }
    res.json({ items });
  }));

  r.post("/encuestas/:id/responder", auth.requireSocio, wrap(async (req, res) => {
    const e = await store.getEncuesta(req.params.id);
    if (!e) throw httpError(404, "Encuesta no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, e.nivel_min || "olimpista")) throw httpError(403, "No disponible");
    let opcion = req.body && req.body.opcion, texto = req.body && req.body.texto;
    if (e.tipo === "texto") {
      texto = String(texto || "").replace(/[<>]/g, "").trim().slice(0, 500);
      if (!texto) throw httpError(400, "Escribí tu respuesta"); opcion = null;
    } else {
      opcion = Number(opcion);
      if (!Number.isInteger(opcion) || opcion < 0 || opcion >= (e.opciones || []).length) throw httpError(400, "Opción inválida");
      texto = null;
    }
    const rr = await store.responderEncuesta({ encuestaId: e.id, socioId: req.socio.id, opcion, texto });
    if (!rr.ok) throw httpError(409, "La encuesta está cerrada");
    _encResCache.delete(e.id); // el voto debe reflejarse al toque
    res.json({ ok: true, resultados: await store.resultadosEncuesta(e.id) });
  }));

  // ─── Subastas ─────────────────────────────────────────────────────────────
  // Puja Plus y Socio (nivel_min = "premium"). Gateo en el server. El líder actual
  // = subasta.ganador_id. Anti-sniping y guard de monto viven en store.pujar (atómico).
  function subastaAbierta(s) { return s.estado === "activa" && new Date(s.termina).getTime() > Date.now(); }
  // Notifica a los ganadores de subastas recién cerradas (email + alerta al EQUIPO para
  // coordinar WhatsApp). Idempotente (flag `notificado`). La query que arma la lista es
  // liviana e indexada, y en el caso común vuelve vacía → segura de llamar seguido.
  async function notificarGanadoresPendientes() {
    try {
      const pend = store.subastasSinNotificar ? await store.subastasSinNotificar() : [];
      for (const s of pend) {
        try {
          const ganador = await store.getSocioById(s.ganador_id);
          const urlSubasta = (process.env.APP_URL || "https://www.olimpistas.com") + "/subasta/" + encodeURIComponent(s.slug || s.id);
          if (ganador && mailer.enviarSubastaGanador) {
            const limitePago = new Date(Date.now() + 7 * 86400000); // plazo de pago: 7 días
            await mailer.enviarSubastaGanador(ganador, { titulo: s.titulo, monto: s.puja_actual, urlSubasta, limitePago }).catch(() => {});
          }
          // Avisar AL EQUIPO (no solo al ganador): así saben que hay un ganador, aunque
          // recién escriban por WhatsApp cuando el pago esté confirmado (ver
          // cumplirPedidoPagado → alerta "subasta:pago:").
          if (ganador) {
            const monto = "₲ " + Number(s.puja_actual || 0).toLocaleString("es-PY");
            alertar(
              "subasta:cierre:" + s.id,
              "Subasta cerrada — esperando pago del ganador",
              `"${s.titulo}" → ganador: ${ganador.nombre || ganador.email} · ${monto} · email: ${ganador.email}`
            );
          }
        } catch (e) { /* seguir con las demás */ }
        await store.marcarSubastaNotificada(s.id);
      }
      return pend.length;
    } catch (e) { log.error({ err: e.message }, "subastas notificar"); return 0; }
  }
  // Abre programadas + cierra vencidas + notifica. Usado por el cron diario (backstop)
  // y al cerrar manualmente desde el admin.
  async function cerrarYnotificarSubastas() {
    try {
      if (store.abrirProgramadas) await store.abrirProgramadas();
      if (store.cerrarSubastasVencidas) await store.cerrarSubastasVencidas();
      return await notificarGanadoresPendientes();
    } catch (e) { log.error({ err: e.message }, "subastas cierre"); return 0; }
  }
  // Barrido de estados THROTTLEADO a 1 cada 15s process-wide: abrir programadas + cerrar
  // vencidas + notificar ganadores pendientes. Antes la notificación esperaba al cron
  // DIARIO (hasta 24h de demora) — ahora el ganador y el equipo se enteran en segundos,
  // sin reintroducir el N+1 que se sacó del listado (ver listaSubastasBase).
  let _barridoSubT = 0;
  async function barrerEstadosSubastas() {
    if (Date.now() - _barridoSubT < 15000) return;
    _barridoSubT = Date.now();
    try {
      if (store.abrirProgramadas) await store.abrirProgramadas();
      if (store.cerrarSubastasVencidas) await store.cerrarSubastasVencidas();
      await notificarGanadoresPendientes();
    }
    catch (e) { log.error({ err: e.message }, "subastas barrido"); }
  }
  // Cache corto (3s) del listado base (subastas visibles + pujadores). Absorbe el polling:
  // ~1 lectura cada 3s por instancia en vez de (lista + N counts) por cada mirador.
  let _listaSub = null;
  async function listaSubastasBase() {
    if (_listaSub && Date.now() - _listaSub.t < 3000) return _listaSub.v;
    const raw = (await store.listSubastas()).filter((s) => s.estado === "activa" || s.estado === "cerrada");
    const v = [];
    for (const s of raw) v.push({ s, pujadores: await store.contarPujadores(s.id) });
    _listaSub = { t: Date.now(), v };
    return v;
  }
  r.get("/subastas", auth.attachSocio, wrap(async (req, res) => {
    await barrerEstadosSubastas();
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await listaSubastasBase()).map(({ s, pujadores }) => {
      const abierta = subastaAbierta(s);
      return {
        id: s.id, slug: s.slug, titulo: s.titulo, descripcion: s.descripcion, imagen: s.imagen, emoji: s.emoji,
        nivel_min: s.nivel_min, precio_inicial: s.precio_inicial, incremento: s.incremento,
        puja_actual: s.puja_actual, termina: s.termina, estado: abierta ? "activa" : "cerrada",
        pago_estado: s.pago_estado || null,
        desbloqueado: access.puedeAcceder(membresia, s.nivel_min),
        pujadores,
        gano: !abierta && !!(req.socio && s.ganador_id === req.socio.id),
        // Nombre del ganador SOLO si ya cerró (mientras está activa, ganador_id es apenas
        // el líder actual — mostrarlo sería el mismo leak de privacidad que ya arreglamos
        // en el feed de pujas). Enmascarado igual que ahí.
        ganador_nombre: (!abierta && s.ganador_id && s.ganador_nombre) ? enmascararNombre(s.ganador_nombre) : null,
      };
    });
    res.json({ items });
  }));
  // Cache corto (2s) del "cuerpo compartido" del detalle (subasta + feed + pujadores).
  // Absorbe el polling en vivo: con N miradores, la DB recibe ~1 lectura cada 2s por
  // instancia, no N. Se invalida al pujar. Lo per-usuario (mi puja, voy-ganando) se
  // calcula aparte, barato. Clave para aguantar un pico de tráfico.
  //
  // stale-while-error (caída del 2026-08-09): si la base está momentáneamente saturada
  // o el query se corta por plazo, esto ANTES tiraba el error para arriba y el visitante
  // veía la página caerse. Ahora, mientras haya un valor previo (aunque tenga más de 2s),
  // se sirve ese en vez de fallar — un precio con unos segundos de atraso es un precio
  // desactualizado; un 504 es la página rota. Solo falla de verdad si nunca hubo un valor
  // bueno para esa subasta.
  const _subCache = new Map();
  async function detalleBase(id) {
    const c = _subCache.get(id);
    if (c && Date.now() - c.t < 2000) return c.data;
    try {
      const s = await store.getSubasta(id);
      if (!s) return null;
      // OJO: usar s.id (el id real resuelto), no el "id" del parámetro — si vino por slug,
      // pujasDeSubasta/contarPujadores con el slug no matchean nada en la tabla de pujas.
      const [feedRaw, pujadores] = await Promise.all([store.pujasDeSubasta(s.id, 8), store.contarPujadores(s.id)]);
      const data = { s, feedRaw, pujadores };
      _subCache.set(id, { t: Date.now(), data });
      return data;
    } catch (e) {
      if (c) { log.warn({ id, err: e.message }, "subasta: sirviendo último valor conocido (la base no respondió a tiempo)"); return c.data; }
      throw e;
    }
  }
  r.get("/subastas/:id", auth.attachSocio, wrap(async (req, res) => {
    const base = await detalleBase(req.params.id);
    if (!base) throw httpError(404, "Subasta no encontrada");
    const s = base.s;
    if (s.estado !== "activa" && s.estado !== "cerrada") throw httpError(404, "Subasta no encontrada"); // borrador → oculto
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const abierta = subastaAbierta(s);
    const feed = base.feedRaw.map((p) => {
      const yo = !!(req.socio && p.socio_id === req.socio.id);
      return { nombre: yo ? (p.nombre || "Olimpista") : enmascararNombre(p.nombre), monto: p.monto, creado: p.creado, yo, pais_iso: p.pais_iso || null };
    });
    // ?liviano=1: el polling en vivo (cada 4-5s, por cada mirador) nunca pinta la foto
    // ni la descripción de nuevo — solo precio/cierre/feed. Bajo un pico de tráfico real
    // (campaña + redes) reenviar la imagen base64 (100KB+) en cada tick satura CPU/ancho
    // de banda del proceso y termina afectando a TODOS los endpoints, no solo este.
    const liviano = req.query.liviano === "1";
    res.json({
      subasta: {
        id: s.id, slug: s.slug, titulo: s.titulo,
        descripcion: liviano ? undefined : s.descripcion,
        imagen: liviano ? undefined : s.imagen,
        emoji: s.emoji,
        nivel_min: s.nivel_min, precio_inicial: s.precio_inicial, incremento: s.incremento,
        puja_actual: s.puja_actual, termina: s.termina, estado: abierta ? "activa" : "cerrada",
        pago_estado: s.pago_estado || null,
      },
      desbloqueado: access.puedeAcceder(membresia, s.nivel_min),
      pujadores: base.pujadores,
      voyGanando: !!(req.socio && s.ganador_id === req.socio.id),
      miPuja: req.socio ? await store.miPujaMax(s.id, req.socio.id) : 0,
      gano: !abierta && !!(req.socio && s.ganador_id === req.socio.id),
      feed,
    });
  }));
  r.post("/subastas/:id/pujar", auth.requireSocio, wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, s.nivel_min))
      throw httpError(403, "Las subastas son para Olimpistas Plus y Socio");
    const monto = Math.round(Number(req.body && req.body.monto) || 0);
    if (!monto) throw httpError(400, "Monto inválido");
    const out = await store.pujar({ subastaId: s.id, socioId: req.socio.id, monto });
    if (!out.ok) {
      const msg = {
        cerrada: "La subasta ya cerró",
        monto_bajo: "Tu puja debe ser al menos ₲ " + Number(out.minima || 0).toLocaleString("es-PY"),
        no_existe: "Subasta no encontrada",
      }[out.motivo] || "No se pudo registrar la puja";
      throw httpError(409, msg);
    }
    _subCache.delete(s.id); _listaSub = null; // la puja debe reflejarse al toque
    // Avisar por email al líder anterior que lo superaron (best-effort, no rompe la puja).
    if (out.prevGanador) {
      store.getSocioById(out.prevGanador).then((prev) => {
        if (prev && mailer.enviarSubastaSuperado) mailer.enviarSubastaSuperado(prev, { titulo: s.titulo, monto: out.subasta.puja_actual, minimo: out.subasta.puja_actual + out.subasta.incremento, cierre: out.subasta.termina }).catch(() => {});
      }).catch(() => {});
    }
    res.json({ ok: true, puja_actual: out.subasta.puja_actual, termina: out.subasta.termina, extendida: out.extendida });
  }));

  // El ganador paga ONLINE (Pagopar) para confirmar el lote — la entrega recién se
  // coordina por privado (WhatsApp) después de acreditado el pago (ver cumplirPedidoPagado).
  // Mismo manejo de cédula que /membresia/unirse: Pagopar la exige, se pide una sola vez.
  r.post("/subastas/:id/pagar", auth.requireSocio, wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado !== "cerrada" || s.ganador_id !== req.socio.id) throw httpError(403, "No ganaste esta subasta");
    if (s.pago_estado === "pagado") return res.json({ ya_pagado: true });

    const sFull = await store.getSocioById(req.socio.id).catch(() => null);
    let documento = soloDigitos((sFull && sFull.cedula) || "");
    const cedulaBody = soloDigitos(req.body?.cedula || "");
    if (!documento && cedulaBody) {
      if (cedulaBody.length < 5 || cedulaBody.length > 12) throw httpError(400, "Número de cédula inválido");
      if (store.getSocioByCedula) {
        const otra = await store.getSocioByCedula(cedulaBody);
        if (otra && otra.id !== req.socio.id) throw httpError(409, "Esa cédula ya está registrada en otra cuenta");
      }
      try { await store.updateSocio(req.socio.id, { cedula: cedulaBody }); documento = cedulaBody; }
      catch (e) { throw httpError(409, "Esa cédula ya está registrada en otra cuenta"); }
    }
    if (!documento) return res.json({ falta_cedula: true });

    // Reusar el pedido pendiente si el ganador ya había iniciado el pago antes (evita
    // duplicar pedidos en PAGOPAR si reintenta o vuelve a entrar a la página).
    const existente = store.getPedidoPorSubasta ? await store.getPedidoPorSubasta(s.id) : null;
    const pedido = (existente && existente.estado === "pendiente")
      ? existente
      : await store.createPedidoPago({ socioId: req.socio.id, concepto: `Subasta: ${s.titulo}`, monto: s.puja_actual, moneda: BRAND.monedaCod, subastaId: s.id });

    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto: s.puja_actual, concepto: pedido.concepto,
      comprador: {
        email: req.socio.email,
        nombre: [req.socio.nombre, sFull && sFull.apellido].filter(Boolean).join(" ") || req.socio.nombre,
        documento, telefono: (sFull && (sFull.whatsapp || sFull.telefono)) || "",
      },
    });
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    res.json({ pago });
  }));

  // ── Admin de subastas: poner en vivo / cerrar / ver pujas (además del CRUD) ──
  r.post("/admin/subastas/:id/publicar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (!s.titulo || !(s.precio_inicial > 0)) throw httpError(400, "Faltan datos: título y precio inicial");
    const horas = Number(s.duracion_horas) || Number(req.body && req.body.horas) || 48;
    const inicia = new Date().toISOString();
    const termina = new Date(Date.now() + horas * 3600 * 1000).toISOString();
    const item = await store.updateSubasta(s.id, { estado: "activa", inicia, termina, ganador_id: null, puja_actual: s.precio_inicial, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:publicar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/despublicar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado === "cerrada") throw httpError(409, "La subasta ya cerró; no se puede volver a borrador");
    const item = await store.updateSubasta(s.id, { estado: "borrador", ganador_id: null, termina: null, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:despublicar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  // Pausar/reanudar: frena la puja y la esconde del home + hub SIN cerrarla (no se
  // elige ganador ni se avisa a nadie) — válvula de seguridad durante una subasta en
  // vivo. Al reanudar, el reloj se corre exactamente lo que estuvo en pausa.
  r.post("/admin/subastas/:id/pausar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado !== "activa") throw httpError(409, "Solo se puede pausar una subasta en vivo");
    const item = await store.updateSubasta(s.id, { estado: "pausada", pausada_en: new Date().toISOString() });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:pausar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/reanudar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado !== "pausada") throw httpError(409, "La subasta no está pausada");
    const pausadaMs = Date.now() - new Date(s.pausada_en).getTime();
    const termina = s.termina ? new Date(new Date(s.termina).getTime() + Math.max(0, pausadaMs)).toISOString() : s.termina;
    const item = await store.updateSubasta(s.id, { estado: "activa", termina, pausada_en: null });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:reanudar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/programar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (!s.titulo || !(s.precio_inicial > 0)) throw httpError(400, "Faltan datos: título y precio inicial");
    const t = new Date((req.body && req.body.inicia) || "");
    if (isNaN(t.getTime()) || t.getTime() <= Date.now()) throw httpError(400, "La fecha de inicio debe ser válida y futura");
    const item = await store.updateSubasta(s.id, { estado: "programada", inicia: t.toISOString(), termina: null, ganador_id: null, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:programar", targetId: s.id, detalle: t.toISOString(), por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/cerrar", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const item = await store.updateSubasta(s.id, { estado: "cerrada", termina: new Date().toISOString() });
    _subCache.delete(s.id); _listaSub = null;
    await cerrarYnotificarSubastas(); // avisa al ganador al toque
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:cerrar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.get("/admin/subastas/:id/pujas", requireAdmin, wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    let ganador = null;
    if (s.ganador_id) { const g = await store.getSocioById(s.ganador_id); if (g) ganador = { nombre: g.nombre, email: g.email, whatsapp: g.whatsapp || g.telefono || "" }; }
    res.json({
      subasta: { titulo: s.titulo, estado: s.estado, puja_actual: s.puja_actual, termina: s.termina },
      pujadores: await store.contarPujadores(s.id), ganador, pujas: await store.pujasDeSubasta(s.id, 50),
    });
  }));

  // ─── Preventas de entradas ──────────────────────────────────────────────────
  r.get("/preventas", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await store.listPreventas()).map((p) => ({
      ...p,
      habilitada: access.puedeAcceder(membresia, p.tier_min),
    }));
    res.json({ items });
  }));

  r.post("/preventas/:id/reservar", auth.requireSocio, wrap(async (req, res) => {
    const preventa = await store.getPreventa(req.params.id);
    if (!preventa) throw httpError(404, "Preventa no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, preventa.tier_min))
      throw httpError(403, "La preventa es para Olimpistas Premium");
    const cantidad = Math.max(1, Math.min(4, parseInt(req.body?.cantidad || "1", 10)));
    const reserva = await store.reservarPreventa(preventa.id, req.socio.id, cantidad);
    if (reserva?.error === "sin_stock") throw httpError(409, "No hay stock suficiente");
    res.json({ ok: true, reserva });
  }));

  // ─── Comprar entradas de una preventa (PAGO por PAGOPAR) ──────────────────────
  // Reserva el cupo (queda 'pendiente_pago') y crea el pedido de pago; el webhook
  // confirma la reserva al acreditarse. Sirve para socios y todos (el nivel solo gatea
  // el ACCESO, el precio es la entrada). Mientras estamos en staging, el cobro real
  // solo se dispara con la clave de prueba o con PAGOPAR_PREVENTAS_LIVE=1 (los usuarios
  // reales siguen reservando gratis, sin cobro fake).
  r.post("/preventas/:id/comprar", auth.requireSocio, wrap(async (req, res) => {
    const preventa = await store.getPreventa(req.params.id);
    if (!preventa) throw httpError(404, "Preventa no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, preventa.tier_min))
      throw httpError(403, "Esta preventa es para un nivel superior");
    const cantidad = Math.max(1, Math.min(4, parseInt(req.body?.cantidad || "1", 10)));
    const precioUnit = Number(preventa.precio_desde) || 0;

    const reserva = await store.reservarPreventa(preventa.id, req.socio.id, cantidad);
    if (!reserva) throw httpError(404, "Preventa no encontrada");
    if (reserva.error === "sin_stock") throw httpError(409, "No hay stock suficiente");

    const modoPrueba = !!process.env.PAGOPAR_TEST_KEY && req.body?.testPagopar === process.env.PAGOPAR_TEST_KEY;
    const cobrar = precioUnit > 0 && pagopar.habilitado && (process.env.PAGOPAR_PREVENTAS_LIVE === "1" || modoPrueba);

    // Gratis (precio 0) o todavía sin cobro activo → reserva confirmada directa.
    if (!cobrar) {
      await store.confirmarReserva(reserva.id);
      return res.json({ gratis: true, reserva });
    }

    const monto = precioUnit * cantidad;
    const pedido = await store.createPedidoPago({
      socioId: req.socio.id, concepto: `Entradas: ${preventa.evento} x${cantidad}`,
      monto, moneda: BRAND.monedaCod, reservaId: reserva.id,
    });
    const sFull = await store.getSocioById(req.socio.id).catch(() => null);
    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto, concepto: pedido.concepto,
      comprador: {
        email: req.socio.email,
        nombre: [req.socio.nombre, sFull && sFull.apellido].filter(Boolean).join(" ") || req.socio.nombre,
        documento: (sFull && sFull.cedula) || "",
        telefono: (sFull && (sFull.whatsapp || sFull.telefono)) || "",
      },
    });
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    res.json({ gratis: false, reserva, pedido, pago });
  }));

  // ─── Red de Beneficios (socio): beneficios aplicables a SU nivel ──
  r.get("/beneficios", auth.requireSocio, wrap(async (req, res) => {
    const [m, sFull] = await Promise.all([store.getMembresia(req.socio.id), store.getSocioById(req.socio.id).catch(() => null)]);
    const tier = (m && m.tier_slug) || "olimpista";
    const ciudad = ((sFull && sFull.ciudad) || "").trim().toLowerCase();
    let items = store.beneficiosParaNivel ? await store.beneficiosParaNivel(tier) : [];
    // Orden: desbloqueados primero (lo tuyo) y, dentro de eso, local-first (comercio de tu ciudad).
    const esLocal = (x) => (ciudad && String(x.comercio_ciudad || "").toLowerCase() === ciudad) ? 1 : 0;
    items = items.slice().sort((a, b) => ((b.desbloqueado ? 1 : 0) - (a.desbloqueado ? 1 : 0)) || (esLocal(b) - esLocal(a)));
    const ahorro = store.resumenAhorroSocio ? await store.resumenAhorroSocio(req.socio.id).catch(() => ({ mes: 0, total: 0 })) : { mes: 0, total: 0 };
    const codigo = (sFull && sFull.ref_codigo) || "";
    res.json({ tier, ciudad: (sFull && sFull.ciudad) || "", codigo, items, ahorro });
  }));

  // ─── Panel de validación del COMERCIO (Red de Beneficios) ─────────────────────
  // Alta de acceso (admin): setea usuario+contraseña del comercio para su panel.
  r.post("/admin/comercios/:id/acceso", requireAdmin, requirePerm("contenido.write"), wrap(async (req, res) => {
    const usuario = String(req.body?.usuario || "").toLowerCase().trim();
    const password = String(req.body?.password || "");
    if (usuario.length < 3) throw httpError(400, "Usuario inválido (mín. 3)");
    if (password.length < 6) throw httpError(400, "Contraseña muy corta (mín. 6)");
    if (store.getComercioByUsuario) { const otro = await store.getComercioByUsuario(usuario); if (otro && otro.id !== req.params.id) throw httpError(409, "Ese usuario ya está en uso"); }
    const hash = await bcrypt.hash(password, 10);
    const c = store.setComercioAcceso ? await store.setComercioAcceso(req.params.id, usuario, hash) : null;
    if (!c) throw httpError(404, "Comercio no encontrado");
    res.json({ ok: true, usuario });
  }));
  // Login del comercio.
  r.post("/comercio/login", wrap(async (req, res) => {
    const usuario = String(req.body?.usuario || "").toLowerCase().trim();
    const c = store.getComercioByUsuario ? await store.getComercioByUsuario(usuario) : null;
    if (!c || c.estado !== "activo" || !c.password_hash) throw httpError(401, "Usuario o contraseña incorrectos");
    const ok = await bcrypt.compare(String(req.body?.password || ""), c.password_hash);
    if (!ok) throw httpError(401, "Usuario o contraseña incorrectos");
    const token = crypto.randomBytes(32).toString("base64url");
    const expira = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    await store.createComercioSession(c.id, token, expira);
    res.json({ token, comercio: { id: c.id, nombre: c.nombre } });
  }));
  // Middleware: sesión de comercio (header x-comercio-token).
  async function requireComercio(req, res, next) {
    try {
      const token = req.headers["x-comercio-token"] || "";
      const s = token && store.getComercioSession ? await store.getComercioSession(token) : null;
      if (!s) return res.status(401).json({ error: "Sesión de comercio inválida" });
      req.comercio = { id: s.comercio_id, nombre: s.nombre };
      next();
    } catch (e) { res.status(401).json({ error: "no autorizado" }); }
  }
  // Beneficios del comercio (para elegir cuál validar).
  r.get("/comercio/beneficios", requireComercio, wrap(async (req, res) => {
    res.json({ comercio: req.comercio, items: store.beneficiosDeComercio ? await store.beneficiosDeComercio(req.comercio.id) : [] });
  }));
  // Validar un canje: código de socio + beneficio + monto → registra canje y calcula ahorro.
  r.post("/comercio/validar", requireComercio, wrap(async (req, res) => {
    const codigo = String(req.body?.codigo || "").trim().toLowerCase();
    const monto = Math.max(0, Number(req.body?.monto) || 0);
    const socio = codigo && store.getSocioByRefCodigo ? await store.getSocioByRefCodigo(codigo) : null;
    if (!socio) return res.json({ ok: false, motivo: "socio_no_encontrado" });
    const ben = store.getBeneficio ? await store.getBeneficio(req.body?.beneficioId) : null;
    if (!ben || ben.comercio_id !== req.comercio.id || ben.activo === false) return res.json({ ok: false, motivo: "beneficio_invalido" });
    const m = await store.getMembresia(socio.id);
    const tier = (m && m.tier_slug) || "olimpista";
    const nivs = ben.niveles === "todos" ? "todos" : String(ben.niveles).split(",").map((x) => x.trim());
    const socioOut = { nombre: [socio.nombre, socio.apellido].filter(Boolean).join(" ") || socio.email, tier };
    if (!(nivs === "todos" || nivs.indexOf(tier) > -1)) return res.json({ ok: false, motivo: "nivel_no_aplica", socio: socioOut, requiere: (nivs === "todos" ? "olimpista" : nivs[0]) });
    if (ben.limite_dias && store.ultimoCanje) {
      const u = await store.ultimoCanje(socio.id, ben.id);
      if (u && (Date.now() - new Date(u.creado).getTime()) / 86400000 < Number(ben.limite_dias)) return res.json({ ok: false, motivo: "limite", socio: socioOut });
    }
    const ahorro = ben.pct ? Math.round(monto * Number(ben.pct) / 100) : (Number(ben.ahorro_estimado) || 0);
    await store.registrarCanje({ beneficioId: ben.id, socioId: socio.id, comercioId: req.comercio.id, validadoPor: req.comercio.nombre, monto: monto || null, ahorro: ahorro || null });
    res.json({ ok: true, socio: socioOut, beneficio: ben.titulo, ahorro: ahorro });
  }));

  // ─── Carnet digital ─────────────────────────────────────────────────────────
  r.get("/carnet", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    if (!membresia) throw httpError(404, "Todavía no sos Olimpista. Registrate para tener carnet.");
    const tier = tierBySlug(membresia.tier_slug);
    res.json({
      carnet: {
        socioId: req.socio.id,
        nombre: [req.socio.nombre, req.socio.apellido].filter(Boolean).join(" ") || req.socio.email,
        iso: req.socio.pais_iso || "",
        foto: req.socio.foto || "",
        tier: tier?.nombre || membresia.tier_slug,
        tierSlug: membresia.tier_slug,
        color: tier?.color || "#000",
        desde: membresia.inicio,
        numero: "OLI-" + req.socio.id.replace(/\D/g, "").slice(0, 8).padStart(8, "0"),
      },
    });
  }));

  return r;
}

module.exports = { buildRouter };
