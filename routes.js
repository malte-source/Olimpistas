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
const pushLib = require("./lib/push");
const clubSync = require("./lib/club-sync");
const { claveCedula } = require("./lib/club-import");
const { clasificar, confianza, PORTAL_URL } = require("./lib/club-estado");
const mailer = require("./lib/email");
const access = require("./lib/access");
const log = require("./lib/log");
const pagopar = require("./lib/pagopar");
const resend = require("./lib/resend");
const { alertar } = require("./lib/alert");
const bcrypt = require("bcrypt");
const geo = require("./lib/geo");
const tutiApi = require("./lib/tuti");
const { baseUrl } = require("./lib/url");
const { urlImagen } = require("./lib/imagen-subasta");
const { escalonDe, REGLAS_META, semanaIso, mesPy, diaDelMesPy } = require("./lib/puntos");
const carnetLib = require("./lib/carnet");
const atencionLib = require("./lib/atencion");
const campanasLib = require("./lib/campanas");
const h3lib = require("./lib/h3");
const mapaLib = require("./lib/mapa");
const ciudadesLib = require("./lib/ciudades");
const mapaUrl = require("./lib/mapaurl");
const { periodo } = require("./lib/periodo");
// Comparación de secretos en tiempo constante (sha256 de ambos → mismo largo, sin filtrar el largo).
const igualesSeguro = (a, b) => {
  const h = (x) => require("crypto").createHash("sha256").update(String(x == null ? "" : x)).digest();
  return require("crypto").timingSafeEqual(h(a), h(b));
};
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
    const lleno = socio && (String(socio[c.key] || "").trim() !== "" || (c.key === "foto" && !!socio.tiene_foto));
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
    // ticketera: Liberá tu Lugar y el abono dependen de los endpoints nuevos de Tuti. Hasta que existan (TUTI_TICKETERA=1)
    // la pestaña Partidos explica qué viene; la compra de entradas la vende Tuti (TUTI_TICKETERA_URL si está definida).
    res.json({ portal_socios: PORTAL_URL(), brand: BRAND, tiers: TIERS, paises: listaPaises(), ticketera: { activa: process.env.TUTI_TICKETERA === "1", url: /^https:\/\//.test(process.env.TUTI_TICKETERA_URL || "") ? process.env.TUTI_TICKETERA_URL : "" } });
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
    // DESACTIVADO por privacidad: devolvía casas con un desfase fijo y sin k-anonimato (se podía recorrer el mapa en teselas).
    // La app usa /api/mapa/celdas. Se deja la ruta (responde vacío) para no romper cachés de versiones viejas del navegador.
    const raw = [];
    // Privacidad: NUNCA exponer el domicilio exacto en público. Difuminamos la coordenada
    // ~150m con un offset determinístico por socio (estable, no salta) y mostramos solo el
    // ni nombre ni ciudad: solo una bandera. El punto exacto solo lo ve el propio socio en su perfil.
    const flags = raw.map((f) => {
      const h = crypto.createHash("sha256").update(String(f.id)).digest();
      const dLat = ((h[0] / 255) - 0.5) * 0.003;  // ±0.0015° ≈ ±165m
      const dLng = ((h[1] / 255) - 0.5) * 0.003;
      return { lat: Number(f.lat) + dLat, lng: Number(f.lng) + dLng };
    });
    res.setHeader("Cache-Control", "public, max-age=20");
    res.json({ flags });
  }));

  // Barrios en hexágonos H3 con k-anonimato (lib/h3.js): reemplaza a /flags, que queda unas versiones más para no romper a nadie.
  // Pública a propósito: no lleva ids ni nombres, y una celda con menos de K hinchas no se entrega.
  let _celdasGlobal = null;
  r.get("/mapa/celdas", wrap(async (req, res) => {
    const p = String(req.query.bbox || "").split(",").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw httpError(400, "bbox inválido (se espera minLng,minLat,maxLng,maxLat)");
    const [minLng, minLat, maxLng, maxLat] = p;
    if (minLng >= maxLng || minLat >= maxLat || maxLng - minLng > 2 || maxLat - minLat > 2) throw httpError(400, "Acercate más: el recuadro es demasiado grande para dibujar barrios.");
    // Se agrupa y se aplica el k-anonimato sobre TODOS los puntos (caché 5 min) y recién después se recorta por recuadro. Si se agrupara
    // solo lo que cae dentro del recuadro, deslizar el borde mostraría cuándo aparece o desaparece una celda y delataría a cada persona.
    if (!_celdasGlobal || Date.now() - _celdasGlobal.t > (process.env.NODE_ENV === "test" ? 0 : 300000)) {
      const todos = await store.puntosPublicosEnBBox({ minLng: -180, minLat: -90, maxLng: 180, maxLat: 90, limit: 50000 });
      _celdasGlobal = { t: Date.now(), v: h3lib.celdasAnonimas(todos).map((c) => { const [la, lo] = h3lib.centro(c.c); return { ...c, la, lo }; }) };
    }
    const dentro = _celdasGlobal.v.filter((c) => c.lo >= minLng && c.lo <= maxLng && c.la >= minLat && c.la <= maxLat).slice(0, 2000).map(({ c, n, r: rr }) => ({ c, n, r: rr }));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ k: h3lib.K, celdas: dentro });
  }));

  // Para "Compartir mi bandera": cuántos olimpistas REALES hay en tu ciudad y en tu país (sin la rampa ni el agregado de demo).
  r.get("/perfil/mapa", auth.requireSocio, wrap(async (req, res) => {
    const s = (await store.getSocioById(req.socio.id)) || req.socio;
    const ciudadN = s.ciudad_id && store.contarPorCiudadId ? await store.contarPorCiudadId(s.ciudad_id) : 0;
    const iso = String(s.pais_iso || "").toUpperCase();
    const porPais = store.contarPorPais ? await store.contarPorPais() : [];
    const paisN = Number((porPais.find((p) => String(p.pais_iso || "").toUpperCase() === iso) || {}).count || 0);
    res.json({ nombre: s.nombre || "", ciudad: s.ciudad || "", ciudad_n: ciudadN, pais: s.pais || "", iso, pais_n: paisN });
  }));
  // "Mirá cómo crece": altas acumuladas por mes y país, solo hinchas reales. Totales por país: nada de una persona.
  r.get("/mapa/historia", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json({ meses: mapaLib.acumularHistoria(await store.historiaAltas()) });
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
  // Hitos del socio con fecha (lib/eventos.js): alimentan el embudo por cohorte. Nunca frenan ni rompen el flujo que los origina.
  const evento = (socioId, tipo, meta) => { if (store.registrarEvento && socioId) store.registrarEvento(socioId, tipo, meta).catch(() => {}); };
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
    // Cédula opcional en la inscripción ("¿sos socio del club?"): se guarda y se consulta ya su estado en el club (queda guardado). El nivel Socio
    // se activa cuando confirme su correo (ver /auth/verificar); acá no se le dice nada del resultado para no revelar el estado de nadie.
    try {
      const ced = soloDigitos((req.body || {}).cedula);
      if (ced.length >= 5 && ced.length <= 12) {
        const otra = store.getSocioByCedula ? await store.getSocioByCedula(ced) : null;
        if (!otra) { await store.updateSocio(socio.id, { cedula: ced }); estadoTuti(ced, { maxHoras: 24 }).catch(() => {}); }
      }
    } catch (e) { log.warn({ err: e.message }, "registro: no se pudo guardar la cédula"); }
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
        // Pendiente de validar: solo se exige confirmar si de verdad podemos mandar el correo.
        await store.updateSocio(socio.id, { verif_token: vtoken, email_verificado: false, verif_exigida: mailer.habilitado === true });
        const link = `${baseUrl()}/api/auth/verificar?token=${vtoken}`;
        mailer.enviarVerificacion(socio, link).catch(() => {});
      } catch (e) { log.error({ err: e.message }, "verificación de email no disponible"); }
    }
    evento(socio.id, "registro", { referido: !!socio.referido_por });
    // Peña: ?pena=slug (igual que ?ref=). Solo cuenta una peña VERIFICADA; un slug inválido nunca rompe el alta.
    const penaSlug = String((req.body || {}).pena || "").trim().toLowerCase().slice(0, 60);
    if (penaSlug && store.getPenaPorSlug) {
      try {
        const pe = await store.getPenaPorSlug(penaSlug);
        if (pe && pe.estado === "verificada") {
          await store.updateSocio(socio.id, { pena_id: pe.id });
          socio.pena_id = pe.id; _penasPub = null;
          avisarPenaSumo(pe, { nombre, apellido }).catch(() => {});
        }
      } catch (e) { log.warn({ err: e.message }, "registro: no se pudo asignar la peña"); }
    }
    // Puntos al que invitó: una vez por referido (ref = el id del invitado).
    if (socio.referido_por) darPuntos(socio.referido_por, "referido", socio.id, "Referido: " + (nombre || "un hincha")).catch(() => {});
    if (socio.referido_por) evento(socio.referido_por, "referido", { invitado: socio.id });
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
      const link = `${baseUrl()}/reset?token=${r0.token}`;
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

  // req.socio (la sesión) no trae la foto para no arrastrarla en cada request; las pantallas que la muestran la piden acá.
  async function conFoto(socio) {
    const foto = store.getSocioFoto ? await store.getSocioFoto(socio.id) : socio.foto;
    return { ...socio, foto: foto || "" };
  }
  r.get("/auth/yo", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    const referidos = store.contarReferidos ? await store.contarReferidos(req.socio.id).catch(() => 0) : 0;
    res.json({ socio: await conFoto(req.socio), membresia, progreso: perfilProgreso(req.socio), referidos });
  }));

  // Ranking de referidores ("la hinchada que más suma"). Público, cacheado liviano.
  r.get("/referidos/ranking", wrap(async (_req, res) => {
    const items = store.topReferidores ? await store.topReferidores(20).catch(() => []) : []; // resiliente si la migración aún no corrió
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ items });
  }));

  // Verificación de email (link del correo). Tolerante: nunca tira error feo.
  // Reenviar el enlace para confirmar el correo (una vez por minuto por cuenta).
  const _reenvioVerif = new Map();
  r.post("/auth/reenviar-verificacion", auth.requireSocio, wrap(async (req, res) => {
    const s = req.socio;
    if (s.email_verificado) return res.json({ ok: true, ya: true });
    const ult = _reenvioVerif.get(s.id) || 0;
    if (Date.now() - ult < 60000) throw httpError(429, "Ya te enviamos el correo hace un momento. Revisá tu bandeja (y el correo no deseado) y probá de nuevo en un minuto.");
    _reenvioVerif.set(s.id, Date.now());
    if (_reenvioVerif.size > 20000) _reenvioVerif.clear();
    const vtoken = crypto.randomBytes(24).toString("base64url");
    await store.updateSocio(s.id, { verif_token: vtoken });
    const out = await mailer.enviarVerificacion(s, `${baseUrl()}/api/auth/verificar?token=${vtoken}`);
    res.json({ ok: true, enviado: !!(out && out.ok) });
  }));
  r.get("/auth/verificar", wrap(async (req, res) => {
    let ok = false;
    try {
      const socio = req.query.token ? await store.getSocioByVerifToken(String(req.query.token)) : null;
      if (socio) {
        await store.updateSocio(socio.id, { email_verificado: true, verif_token: null }); ok = true;
        evento(socio.id, "correo_verificado");
        // Si se inscribió con su cédula, el nivel Socio se activa ahora que el correo está confirmado (en segundo plano).
        const ced = soloDigitos(socio.cedula);
        if (ced.length >= 5 && !socio.es_socio_olimpia) validarSocioCore(socio.id, ced, { silencioso: true }).catch((e) => log.warn({ err: e.message }, "verificar: validación de socio"));
      }
    } catch (e) { log.error({ err: e.message }, "verificar email"); }
    res.redirect("/miembro?verificado=" + (ok ? "1" : "0"));
  }));

  // ─── Perfil (enriquecimiento + barra de progreso) ────────────────────────────
  r.get("/perfil", auth.requireSocio, wrap(async (req, res) => {
    res.json({ socio: await conFoto(req.socio), progreso: perfilProgreso(req.socio) });
  }));

  // Autocompletar de ciudades (público): por prefijo, sin acentos, por población. Tope de 10.
  r.get("/ciudades", wrap(async (req, res) => {
    const items = store.buscarCiudades ? await store.buscarCiudades({ q: String(req.query.q || "").slice(0, 60), pais: req.query.pais, limit: 10 }) : [];
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ items: items.map((c) => ({ id: c.id, nombre: c.nombre, pais_iso: c.pais_iso })) });
  }));
  async function asignarCiudad(socio, patch, b) {
    if (!store.getCiudad) return;
    const iso = String(patch.pais_iso != null ? patch.pais_iso : (socio.pais_iso || "")).toUpperCase();
    if (b.ciudad_id != null && b.ciudad_id !== "") {
      const c = await store.getCiudad(Number(b.ciudad_id));
      if (c) { patch.ciudad_id = c.id; patch.ciudad = c.nombre; }
    } else if (typeof patch.ciudad === "string") {
      if (!patch.ciudad) patch.ciudad_id = null;
      else { const c = await store.ciudadPorNombre({ nombre: patch.ciudad, pais: iso }); patch.ciudad_id = c ? c.id : null; }
    } else if (patch.lat != null && patch.lng != null && !socio.ciudad_id) {
      // Eligió su casa y todavía no tiene ciudad: la más cercana del mismo país (hasta 60 km).
      const c = await store.ciudadMasCercana({ lat: patch.lat, lng: patch.lng, pais: iso, maxKm: 60 });
      if (c) { patch.ciudad_id = c.id; if (!socio.ciudad) patch.ciudad = c.nombre; }
    }
  }
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
    // Apariencia: auto (sigue al dispositivo) | claro | oscuro.
    if (b.tema !== undefined) {
      if (!["auto", "claro", "oscuro"].includes(b.tema)) throw httpError(400, "Apariencia inválida (auto, claro u oscuro)");
      patch.tema = b.tema;
    }
    // Ciudad oficial (GeoNames): la elegida con el autocompletado, la que coincide con el texto, o la más cercana a su casa.
    await asignarCiudad(req.socio, patch, b);
    // Peña: sumarse a una peña verificada, o dejarla (null / "").
    if (b.pena_id !== undefined) {
      if (b.pena_id === null || b.pena_id === "") patch.pena_id = null;
      else {
        const pe = store.getPena ? await store.getPena(String(b.pena_id)) : null;
        if (!pe || pe.estado !== "verificada") throw httpError(400, "Esa peña no está disponible");
        patch.pena_id = pe.id;
      }
      _penasPub = null;
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
    const progreso = perfilProgreso(socio);
    if (progreso.pct >= 100) darPuntos(req.socio.id, "perfil", "completo", "Perfil completo").catch(() => {});
    res.json({ socio, progreso });
  }));

  r.post("/perfil/foto", auth.requireSocio, wrap(async (req, res) => {
    const { foto } = req.body || {};
    if (typeof foto !== "string" || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(foto))
      throw httpError(400, "Imagen inválida (se espera un data URL de imagen)");
    if (foto.length > 800_000) throw httpError(413, "La imagen es muy grande (máx ~600KB)");
    const socio = auth.sanitize(await store.updateSocio(req.socio.id, { foto }));
    evento(req.socio.id, "foto");
    const progreso = perfilProgreso(socio);
    if (progreso.pct >= 100) darPuntos(req.socio.id, "perfil", "completo", "Perfil completo").catch(() => {});
    res.json({ ok: true, foto: socio.foto, progreso });
  }));

  // Cuenta nueva con el correo sin confirmar: no puede pujar, pagar ni validar su cédula hasta confirmarlo.
  // (Las cuentas anteriores a esta regla tienen verif_exigida = false: ven el aviso, pero no se les bloquea nada.)
  const correoPendiente = (s) => !!(s && s.verif_exigida && !s.email_verificado);
  const exigirCorreo = (req, paraQue) => {
    if (correoPendiente(req.socio)) throw httpError(403, `Confirmá tu correo para ${paraQue}. Te enviamos un enlace al registrarte; si no lo ves, pedí otro desde el aviso de arriba.`);
  };
  // Estado de una cédula en el club. Si ya lo consultamos hace poco (cron de fondo o una validación anterior) se usa lo guardado y no se vuelve
  // a molestar a la API; si no, se consulta en vivo y se deja guardado. Devuelve la misma forma que tutiApi.consultarSocio (o null sin API).
  async function estadoTuti(cedula, { maxHoras = 24 } = {}) {
    const clave = claveCedula(cedula);
    const ref = clave && store.getSocioClub ? await store.getSocioClub(clave).catch(() => null) : null;
    if (ref && ref.tuti_consultado && ref.tuti_estado && Date.now() - new Date(ref.tuti_consultado).getTime() < maxHoras * 3600000) {
      if (ref.tuti_estado === "NO_ENCONTRADO") return { ok: true, encontrado: false, guardado: true };
      const deuda = Number(ref.tuti_deuda) || 0;
      return { ok: true, encontrado: true, guardado: true, socio: { status: ref.tuti_estado, plan: ref.tuti_plan || "", numeroSocio: ref.tuti_numero || "", alDia: !!ref.tuti_al_dia, deuda, deudor: deuda > 0, email: ref.tuti_correo || "", nombre: ref.tuti_nombre || "", apellido: "" } };
    }
    if (!tutiApi.habilitado()) return null;
    const v = await tutiApi.consultarSocio(cedula);
    if (v && v.ok && clave && store.guardarEstadoTuti) store.guardarEstadoTuti(clave, clubSync.aEstado(v)).catch(() => {});
    return v;
  }

  // ─── Instancia 3 — Validación de socio (cédula → nivel SOCIO otorgado) ──
  // Reglas: cédula ÚNICA (1 cédula = 1 cuenta); el socio del club obtiene el nivel
  // "Socio" (superior a Plus, otorgado, no comprable), a cualquier edad;
  // todo el padrón = al día; entrega automática + se registra en staging para verificar.
  //
  // Automática: se consulta al club en el momento. Con `silencioso` (la app lo manda sola al abrir, con la cédula
  // que la cuenta ya tiene) se reintenta sin dejar un reclamo en la bandeja ni mandar el mail de "en revisión":
  // así quien se puso al día en el club sube de nivel solo, sin volver a escribir nada.
  const _reintentoClub = new Map();   // cuenta → último "Ya pagué, revisar" (una consulta en vivo por minuto)
  const _revalidacion = new Map();   // socio → última consulta silenciosa (cuida el límite de la API del club)
  r.post("/perfil/validar-socio", auth.requireSocio, wrap(async (req, res) => {
    const silencioso = req.body?.silencioso === true;
    if (correoPendiente(req.socio)) { if (silencioso) return res.json({ validado: false, omitido: true }); exigirCorreo(req, "validar tu cédula de socio"); }
    const socioFull = await store.getSocioById(req.socio.id);
    const reintentar = req.body?.reintentar === true;
    const cedula = soloDigitos(req.body?.cedula || ((silencioso || reintentar) ? socioFull.cedula : ""));
    if (silencioso) {
      if (socioFull.es_socio_olimpia || !cedula) return res.json({ validado: false, omitido: true });
      const ult = _revalidacion.get(req.socio.id) || 0;
      if (Date.now() - ult < 6 * 3600000) return res.json({ validado: false, omitido: true });
      _revalidacion.set(req.socio.id, Date.now());
      if (_revalidacion.size > 20000) _revalidacion.clear();
    }
    if (cedula.length < 5 || cedula.length > 12) throw httpError(400, "Número de cédula inválido");

    let forzar = false;
    if (reintentar && !silencioso) {
      const u = _reintentoClub.get(req.socio.id) || 0;
      if (Date.now() - u >= 60000) { forzar = true; _reintentoClub.set(req.socio.id, Date.now()); if (_reintentoClub.size > 20000) _reintentoClub.clear(); }
    }
    res.json(await validarSocioCore(req.socio.id, cedula, { silencioso, forzar }));
  }));

  // Valida la cédula de una cuenta contra el club y, si corresponde, le da el nivel Socio. La usan la pantalla de validación,
  // el reintento silencioso al abrir la app y la confirmación del correo.
  const hoyPy = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  async function validarSocioCore(socioId, cedula, { silencioso, forzar } = {}) {
    const socioFull = await store.getSocioById(socioId);
    const previo = socioFull.club_estado || "";   // lo que figuraba antes de esta consulta (se lee ahora: más abajo la cuenta se actualiza)
    // El socio real del club recibe SIEMPRE el nivel "Socio" (la cima institucional),
    // sin importar la edad — es superior a Plus y no se compra, se otorga.
    const tier = "socio";

    // Cédula ÚNICA: no puede estar en otra cuenta.
    if (store.getSocioByCedula) {
      const otra = await store.getSocioByCedula(cedula);
      if (otra && otra.id !== socioId) throw httpError(409, "Esa cédula ya está registrada en otra cuenta de Olimpistas");
    }
    // Guardamos la cédula en la cuenta (el índice único de la DB es el backstop).
    try { await store.updateSocio(socioId, { cedula }); }
    catch (e) { throw httpError(409, "Esa cédula ya está registrada en otra cuenta de Olimpistas"); }
    unirPenaPorCedula(socioId);

    // Estado en el club (API de socios, ITI/Tuti: lo guardado si es reciente, si no en vivo) + padrón estático como respaldo.
    //  · 200 = autoritativo (solo trae titulares): al día → se activa el nivel Socio solo; mora → se le pide que pague en el portal de socios y se
    //    revisa de nuevo (a mano con "Ya pagué" y solo, cada hora); baja → puede reactivar en el portal. Ni mora ni baja pasan por el padrón viejo.
    //  · 404 = no concluyente: la API no conoce a los ADHERENTES de un plan familiar (probado 2026-10-05) — se cae al padrón, donde sí están.
    //  · sin respuesta (límite, red, API apagada) = "reintentar": no se crea ningún reclamo ni se manda el aviso de "en revisión".
    const vivo = await estadoTuti(cedula, { maxHoras: forzar ? 0 : silencioso ? 24 : 1 });
    const enClub = vivo && vivo.ok && vivo.encontrado ? vivo.socio : null;
    const sinRespuesta = !vivo || !vivo.ok;
    const cls = enClub ? clasificar(enClub) : { estado: sinRespuesta ? "sin_respuesta" : "no_encontrado", deuda: 0 };
    const noAlDia = !!enClub && cls.estado !== "al_dia";
    const ref = store.getSocioClub ? await store.getSocioClub(claveCedula(cedula)).catch(() => null) : null;   // base de referencia: antigüedad, grupo, número
    const conf = confianza({ cuenta: socioFull, tutiSocio: enClub, ref });   // ¿la cuenta coincide con la persona del club? decide cuánto detalle se muestra
    if (enClub && enClub.plan) store.updateSocio(socioId, { plan_club: enClub.plan }).catch(() => {}); // copia de lectura del plan
    const ahora = new Date().toISOString();
    const eraSocio = !!socioFull.es_socio_olimpia;   // antes de actualizar la cuenta (el almacén en memoria devuelve el mismo objeto)

    // Match contra el padrón (foto de agosto: todo el padrón se tomó como AL DÍA).
    let fila = null, validado = false;
    if (store.buscarPadron && !noAlDia) fila = await store.buscarPadron({ cedula });
    if (fila || cls.estado === "al_dia") {
      // Reclamo atómico de la fila del padrón (si matcheó por padrón).
      let gano = true;
      if (fila && store.marcarPadronReclamado) {
        gano = await store.marcarPadronReclamado(fila.id, socioId);
        if (!gano && fila.socio_id && fila.socio_id !== socioId)
          throw httpError(409, "Ese socio ya fue validado en otra cuenta");
      }
      // Entrega AUTOMÁTICA del nivel Socio (otorgado, no comprable). pagoRef "socio:" = marcador
      // de socio del club (id de padrón, o "tuti-<nº de socio>" si vino sólo de la API en vivo).
      const marca = fila ? fila.id : "tuti-" + ((enClub && enClub.numeroSocio) || cedula);
      await store.setMembresia(socioId, { tierSlug: tier, ciclo: "anio", pagoRef: "socio:" + marca });
      // "Socio desde" siempre queda definido: padrón, base del club (que ya trae su cadena de respaldo) o API; si nadie sabe, cuenta desde hoy.
      // Si el club cargó mal su fecha (fecha_fuente "dudosa") no hay fecha: se le pide a la persona. Una fecha declarada por ella o fijada por un admin no se pisa.
      const antig = {};
      const manual = ["declarada", "admin"].includes(socioFull.socio_desde_fuente);
      const dudosa = !!ref && ref.fecha_fuente === "dudosa";
      const desde = dudosa ? null : (fila && fila.socio_desde) || (ref && ref.socio_desde) || (enClub && enClub.desde) || hoyPy();
      if (desde && !manual) antig.socio_desde = String(desde).slice(0, 10);
      const nro = (fila && fila.nro_socio) || (ref && ref.nro_socio) || (enClub && enClub.numeroSocio) || "";
      if (ref && ref.grupo) antig.grupo_club = String(ref.grupo).slice(0, 40);
      if (nro) antig.nro_socio = String(nro).slice(0, 40);
      await store.updateSocio(socioId, { es_socio_olimpia: true, club_estado: "al_dia", club_deuda: null, club_consulta: ahora, ...antig });
      validado = true;
      if (!eraSocio) evento(socioId, "nivel_socio_activado", { fuente: fila ? "padron" : "api" });
      mailer.enviarReconocido && mailer.enviarReconocido({ ...socioFull, cedula }, tier).catch(() => {});
    }

    // Lo que se le cuenta a la persona. El detalle (mora, baja, monto) solo se muestra si la cuenta coincide con la persona del club
    // (correo confirmado igual al del club = "alta" → con monto; nombre y apellido iguales = "media" → sin monto); si no, respuesta neutra,
    // igual que para quien no figura: la cédula no es secreta y probar cédulas ajenas no debe revelar el estado de pago de nadie.
    let estadoCuenta = "revision", respuesta = { validado: true, tier, estado: "validado_auto" };
    if (!validado) {
      if (cls.estado === "sin_respuesta") respuesta = { validado: false, tier, estado: "reintentar" };
      else {
        const detalle = conf !== "baja";
        if (cls.estado === "mora" && detalle) { estadoCuenta = "mora"; respuesta = { validado: false, tier, estado: "mora", deuda: conf === "alta" ? Math.round(cls.deuda) : null, portal: PORTAL_URL() }; }
        else if (cls.estado === "baja" && detalle) { estadoCuenta = "baja"; respuesta = { validado: false, tier, estado: "baja", portal: PORTAL_URL() }; }
        else respuesta = { validado: false, tier, estado: "a_revisar" };
        await store.updateSocio(socioId, { club_estado: estadoCuenta, club_deuda: estadoCuenta === "mora" && conf === "alta" ? Math.round(cls.deuda) : null, club_consulta: ahora });
      }
    }

    // Reclamo para revisar a mano: al validar, y cuando cambia lo que figura (no uno por cada "Ya pagué").
    if (store.crearActualizacion && (validado || (cls.estado !== "sin_respuesta" && !silencioso && previo !== estadoCuenta))) {
      store.crearActualizacion({
        socioId: socioId, tipo: "socio_claim",
        nombre: socioFull.nombre, apellido: socioFull.apellido, email: socioFull.email,
        cedula, pais: socioFull.pais, ciudad: socioFull.ciudad, fechaNacimiento: socioFull.fecha_nacimiento,
        tieneSelfie: !!socioFull.foto, tierPretendido: tier, matchPadronId: fila ? fila.id : null,
        estado: validado ? "validado_auto" : "a_revisar",
        notas: validado
          ? (enClub ? `API de socios: ${enClub.status} (${enClub.plan}) nº ${enClub.numeroSocio}, carnet entregado automático` : "Match padrón, carnet entregado automático")
          : noAlDia
            ? `API de socios: estado ${enClub.status}${cls.deuda ? ` (deuda ₲${cls.deuda})` : ""} — ${cls.estado === "mora" ? "EN MORA: se le pidió pagar en el portal de socios" : "NO está al día"}; coincidencia de la cuenta con el club: ${conf}`
            : "Cédula sin match en padrón ni en la API de socios — revisar manual",
      }).catch(() => {});
    }
    // El aviso de "en revisión" se manda una sola vez, y solo cuando de verdad queda en revisión (no por mora, baja ni por una API caída).
    if (!validado && !silencioso && estadoCuenta === "revision" && cls.estado !== "sin_respuesta" && previo !== "revision") {
      mailer.enviarEnRevision && mailer.enviarEnRevision(socioFull).catch(() => {});
    }
    return respuesta;
  }

  // Cuentas en mora: se revisan de nuevo solas (cada hora, un lote chico) y, apenas el club dice "al día", se les activa el nivel Socio.
  // Sincroniza el nivel Socio con lo último que dijo el club de cada persona (lo guardado por el barrido y las revisiones; no consulta de nuevo).
  //  · al día → mantiene nivel y beneficios; · mora o baja → el nivel queda en pausa (pasa a Olimpista), se avisa UNA vez con el camino para volver, y la
  //  revisión automática (revisarMoras) lo devuelve solo apenas el club vuelva a decir "al día".
  //  · lo que un admin dio a mano (pago_ref "admin…") no se toca, y las respuestas no concluyentes (404 de adherentes) no figuran acá.
  // SOCIO_SINCRONIZAR=on enciende la bajada; apagada solo cuenta a quién bajaría (se ve en el panel). SOCIO_SINC_LOTE limita las bajadas (y avisos) por hora.
  const estadoGuardado = (f) => clasificar({ status: f.tuti_estado, deuda: f.tuti_deuda, alDia: f.tuti_al_dia });
  const elegibleSync = (f) => String(f.pago_ref || "").startsWith("socio:");
  async function resumenSincronizacion() {
    const out = { activada: process.env.SOCIO_SINCRONIZAR === "on", socios_con_estado: 0, al_dia: 0, por_pausar_mora: 0, por_pausar_baja: 0 };
    if (!store.sociosConEstadoClub) return out;
    for (const f of await store.sociosConEstadoClub()) {
      if (!elegibleSync(f)) continue;
      out.socios_con_estado++;
      const e = estadoGuardado(f).estado;
      if (e === "al_dia") out.al_dia++; else if (e === "mora") out.por_pausar_mora++; else out.por_pausar_baja++;
    }
    return out;
  }
  async function sincronizarSocios() {
    const out = { al_dia: 0, pausados_mora: 0, pausados_baja: 0, pendientes: 0 };
    if (!store.sociosConEstadoClub) return out;
    const aplicar = process.env.SOCIO_SINCRONIZAR === "on", tope = Math.min(Number(process.env.SOCIO_SINC_LOTE) || 50, 500), ahora = new Date().toISOString();
    for (const f of await store.sociosConEstadoClub()) {
      if (!elegibleSync(f)) continue;
      const cls = estadoGuardado(f);
      if (cls.estado === "al_dia") {
        if (!f.club_consulta || new Date(f.club_consulta) < new Date(f.tuti_consultado)) { await store.updateSocio(f.id, { club_estado: "al_dia", club_deuda: null, club_consulta: ahora }); out.al_dia++; }
        continue;
      }
      out.pendientes++;
      if (!aplicar || out.pausados_mora + out.pausados_baja >= tope) continue;
      const mora = cls.estado === "mora";
      await store.setMembresia(f.id, { tierSlug: "olimpista", ciclo: "anio", pagoRef: "club:" + cls.estado });
      await store.updateSocio(f.id, { es_socio_olimpia: false, club_estado: cls.estado, club_deuda: mora && cls.deuda ? Math.round(cls.deuda) : null, club_consulta: ahora });
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: "pausar_socio_club", targetId: f.id, detalle: cls.estado, por: "sistema" });
      evento(f.id, "nivel_socio_pausado", { motivo: cls.estado });
      if (mora) { out.pausados_mora++; mailer.enviarCuotaPendiente && mailer.enviarCuotaPendiente(f, { deuda: cls.deuda, portal: PORTAL_URL() }).catch(() => {}); }
      else { out.pausados_baja++; mailer.enviarSocioBaja && mailer.enviarSocioBaja(f, { portal: PORTAL_URL() }).catch(() => {}); }
    }
    return out;
  }
  async function revisarMoras() {
    const out = { revisadas: 0, activadas: 0 };
    if (!store.cuentasEnMora || !tutiApi.habilitado() || process.env.TUTI_BARRIDO === "off") return out;
    // mora: cada hora (apenas paga vuelve el nivel); baja: una vez al día (no hay apuro y son muchas más)
    const cuentas = [
      ...(await store.cuentasEnMora({ limite: Math.min(Number(process.env.TUTI_LOTE_MORA) || 30, 100), desdeMin: 60 })),
      ...(await store.cuentasEnMora({ limite: Math.min(Number(process.env.TUTI_LOTE_BAJA) || 10, 100), desdeMin: 1440, estado: "baja" })),
    ];
    for (const c of cuentas) {
      const ced = soloDigitos(c.cedula);
      const v = await tutiApi.consultarSocio(ced);
      if (!v.ok) { if (/limite|credenciales/.test(String(v.motivo || ""))) break; continue; }
      if (store.guardarEstadoTuti) await store.guardarEstadoTuti(claveCedula(ced), clubSync.aEstado(v));
      out.revisadas++;
      try { const r0 = await validarSocioCore(c.id, ced, { silencioso: true }); if (r0.validado) out.activadas++; }
      catch (e) { log.warn({ err: e.message }, "revisar mora: validación"); }
      await new Promise((x) => setTimeout(x, Number(process.env.TUTI_PAUSA_MS) || 400));
    }
    return out;
  }
  // ─── Membresía ──────────────────────────────────────────────────────────────
  r.get("/membresia", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    res.json({ membresia, tier: membresia ? tierBySlug(membresia.tier_slug) : null });
  }));

  // Subir de nivel → crea pedido de pago. En el COBRO manda el botón que tocó el
  // usuario (Junior → Junior, Plus → Plus). La edad solo define el carnet gratis
  // incluido para socios (en /perfil/validar-socio). Cobro anual único.
  r.post("/membresia/unirse", auth.requireSocio, wrap(async (req, res) => {
    exigirCorreo(req, "comprar una membresía");
    const tier = tierBySlug(req.body?.tier);
    if (!tier) throw httpError(400, "Nivel inválido");

    // Niveles OTORGADOS (ej. Socio): no se compran. Blindaje antes de la rama "gratis"
    // (si no, un precio 0 caería como membresía gratis por error).
    if (tier.comprable === false) throw httpError(403, "Ese nivel es exclusivo de los socios del Club — se otorga, no se adquiere");
    if (tier.oculto) throw httpError(403, "Ese nivel ya no se ofrece");

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
      try { await store.updateSocio(req.socio.id, { cedula: cedulaBody }); documento = cedulaBody; unirPenaPorCedula(req.socio.id); }
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
    evento(pedido.socio_id, "primer_pago", { tipo: pedido.tier_slug ? "membresia" : pedido.subasta_id ? "lote" : "entrada" });
    if (pedido.tier_slug) {
      const tier = tierBySlug(pedido.tier_slug);
      if (!tier) throw new Error("el pedido " + pedido.id + " es de un nivel que ya no existe (" + pedido.tier_slug + ")");
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
      const conf = await store.confirmarReserva(pedido.reserva_id);
      if (conf && conf.error === "sin_stock") {
        // El pago llegó después de que se liberó el cupo (no se pagó a tiempo) y ya no quedan entradas.
        log.error({ pedidoId: pedido.id, reservaId: pedido.reserva_id, socioId: pedido.socio_id }, "pago recibido por una reserva liberada y sin stock");
        alertar("preventa:pago-sin-stock:" + pedido.id, "Pago recibido por entradas que ya no hay — REEMBOLSAR",
          "Pedido " + pedido.id + " · ₲ " + Number(pedido.monto || 0).toLocaleString("es-PY") + " · la reserva se liberó por falta de pago a tiempo y las entradas se agotaron. Reembolsar por Pagopar.");
        return { huerfano: true };
      }
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
      const actual = await store.getSubasta(pedido.subasta_id).catch(() => null);
      if (!actual || actual.estado !== "cerrada" || (actual.adjudicado_a || actual.ganador_id) !== pedido.socio_id) {
        log.error({ pedidoId: pedido.id, subastaId: pedido.subasta_id, socioId: pedido.socio_id }, "pago recibido por un lote que ya no está adjudicado a ese socio");
        alertar("subasta:pago-huerfano:" + pedido.id, "Pago recibido por un lote que ya no es de esa persona — REEMBOLSAR",
          "Pedido " + pedido.id + " · ₲ " + Number(pedido.monto || 0).toLocaleString("es-PY") + " · el plazo venció y el lote pasó a otro postor o volvió a borrador. Reembolsar por Pagopar.");
        return { huerfano: true };
      }
      if (store.marcarSubastaPagada) await store.marcarSubastaPagada(pedido.subasta_id);
      const s = actual;
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

  // ÚNICA puerta para dar un pedido por pagado y entregarlo (webhook, conciliación, admin y
  // confirmación simulada pasan todos por acá). El cobro y la entrega son dos hechos:
  //  1) reclamarCumplimiento: UPDATE atómico → lo gana UNA sola llamada (dos webhooks a la vez,
  //     o el reintento de Pagopar, no entregan dos veces);
  //  2) se entrega; si falla, se libera el candado y se propaga el error → el webhook responde
  //     500, Pagopar reintenta y la entrega se completa (antes el pedido quedaba "pagado" sin
  //     entregar y el reintento lo salteaba para siempre);
  //  3) marcarCumplido.
  async function acreditarPago(pedidoId, origen) {
    const p = await store.reclamarCumplimiento(pedidoId);
    if (!p) return { estado: "ya_procesado" };
    try {
      const out = await cumplirPedidoPagado(p);
      await store.marcarCumplido(p.id);
      if (!(out && out.huerfano)) await acreditarFondoPena(p); // el 10 % (decisión pct) al fondo de la peña del hincha
      return { estado: "entregado", out };
    } catch (e) {
      await store.liberarCumplimiento(p.id).catch(() => {});
      log.error({ pedidoId: p.id, origen, err: e.message }, "pago acreditado pero la entrega falló: se reintenta");
      alertar("pago:entrega-fallo:" + p.id, "Pago acreditado y NO entregado",
        "Pedido " + p.id + " (" + p.concepto + ") · origen " + origen + " · " + e.message + ". Se reintenta solo (conciliación); si persiste, revisar a mano.");
      throw e;
    }
  }

  // Red de seguridad por si un webhook se pierde o una entrega queda a medias: pregunta a
  // Pagopar por los pedidos que siguen pendientes y completa las entregas inconclusas.
  async function conciliarPagos() {
    const out = { verificados: 0, acreditados: 0, reintentados: 0, errores: 0 };
    if (!store.pedidosParaConciliar) return out;
    const { abiertos, sinEntregar } = await store.pedidosParaConciliar();
    if (pagopar.habilitado) {
      for (const p of abiertos) {
        try {
          const v = await pagopar.verificarPago({ hash: p.ref_externa });
          out.verificados++;
          if (v.pagado) { const r = await acreditarPago(p.id, "conciliacion"); if (r.estado === "entregado") out.acreditados++; }
        } catch (e) { out.errores++; log.warn({ pedidoId: p.id, err: e.message }, "conciliación: no se pudo verificar"); }
      }
    }
    for (const p of sinEntregar) {
      try { const r = await acreditarPago(p.id, "reintento"); if (r.estado === "entregado") out.reintentados++; }
      catch (e) { out.errores++; }
    }
    if (out.acreditados || out.reintentados)
      alertar("pagos:conciliacion:" + new Date().toISOString().slice(0, 13), "Conciliación de pagos: se recuperaron entregas",
        "Acreditados que el webhook no avisó: " + out.acreditados + " · entregas completadas: " + out.reintentados);
    return out;
  }

  // Confirmación de pago en modo SIMULADO (solo DEV). En producción está deshabilitado:
  // el cobro real es por los links de pago y la activación se hace desde el panel admin.
  r.post("/pagos/confirmar-simulado", auth.requireSocio, wrap(async (req, res) => {
    if (process.env.NODE_ENV === "production") throw httpError(403, "No disponible");
    if (pagopar.habilitado) throw httpError(400, "PAGOPAR está activo: usá el flujo real");
    const pedido = await store.getPedidoPago(req.body?.pedidoId);
    if (!pedido || pedido.socio_id !== req.socio.id) throw httpError(404, "Pedido no encontrado");

    const r0 = await acreditarPago(pedido.id, "simulado");
    res.json({ ok: true, membresia: (r0.out && r0.out.membresia) || null });
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
      // Pago confirmado → marcar pagado + ENTREGAR según el tipo. Atómico e idempotente: si la
      // entrega falla se propaga el error (500) y Pagopar reintenta; ver acreditarPago.
      await acreditarPago(pedido.id, "webhook");
    } else if (row.pagado === false && pedido.estado === "pagado" && (await store.marcarReversado(pedido.id))) {
      // Reversión de un pago ya confirmado (la transición pagado → reversado es atómica).
      if (store.revertirIngresoPena) await store.revertirIngresoPena(pedido.id).catch((e) => log.error({ pedidoId: pedido.id, err: e.message }, "peña: no se pudo revertir el aporte"));
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
  // Tarea horaria (Cloud Scheduler): vence plazos de pago de subastas + conciliación de pagos.
  // Entradas reservadas que no se pagaron dentro de la ventana de Pagopar (3 días + margen) vuelven al stock.
  async function liberarReservas() {
    if (!store.liberarReservasVencidas) return 0;
    const n = await store.liberarReservasVencidas({ horas: Number(process.env.RESERVA_HORAS) || 75 });
    if (n) log.info({ liberadas: n }, "reservas de preventa liberadas por falta de pago");
    return n;
  }
  // Medición real de velocidad (anónima, muestreada en el navegador). Sin cédula, correo ni IP: solo pantalla y números.
  const PAGINAS_VITALES = new Set(["landing", "inicio", "partidos", "carnet", "beneficios", "puntos", "perfil", "descubrir", "otra"]);
  r.post("/vitales", wrap(async (req, res) => {
    const b = req.body || {};
    const num = (x, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 1000) / 1000 : null; };
    const v = {
      pagina: PAGINAS_VITALES.has(b.p) ? b.p : "otra",
      lcp: num(b.lcp, 60000), inp: num(b.inp, 60000), cls: num(b.cls, 10), fcp: num(b.fcp, 60000), ttfb: num(b.ttfb, 60000),
      dispositivo: ["movil", "tablet", "escritorio"].includes(b.d) ? b.d : "",
      conexion: ["slow-2g", "2g", "3g", "4g"].includes(b.c) ? b.c : "",
    };
    if (store.registrarVitales && [v.lcp, v.inp, v.cls, v.fcp, v.ttfb].some((x) => x != null)) store.registrarVitales(v).catch(() => {});
    res.status(204).end();
  }));
  r.post("/cron/horario", wrap(async (req, res) => {
    const tok = process.env.CRON_SECRET;
    if (!tok || !igualesSeguro(req.headers["x-cron-token"], tok)) return res.status(401).json({ error: "no autorizado" });
    const out = {};
    try { await cerrarYnotificarSubastas(); } catch (e) { log.error({ err: e.message }, "cron horario: cierre"); }
    try { out.subastas = await procesarPlazosSubastas(); } catch (e) { out.subastas = { error: true }; log.error({ err: e.message }, "cron horario: plazos"); }
    try { out.pagos = await conciliarPagos(); } catch (e) { out.pagos = { error: true }; log.error({ err: e.message }, "cron horario: pagos"); }
    try { out.campanas = await campanasLib.procesarLote({ store, log: () => {} }); } catch (e) { out.campanas = { error: true }; log.error({ err: e.message }, "cron horario: campañas"); }
    try { out.moras = await revisarMoras(); } catch (e) { out.moras = { error: true }; log.error({ err: e.message }, "cron horario: moras"); }
    try { if (store.completarSociosDesdeClub) out.sociosCompletados = await store.completarSociosDesdeClub(); } catch (e) { log.error({ err: e.message }, "cron horario: completar socios"); }
    try { out.clubSync = await clubSync.procesarLote({ store, tuti: tutiApi }); } catch (e) { out.clubSync = { error: true }; log.error({ err: e.message }, "cron horario: club-sync"); }
    try { out.sincronizacionSocios = await sincronizarSocios(); } catch (e) { out.sincronizacionSocios = { error: true }; log.error({ err: e.message }, "cron horario: sincronizar socios"); }
    try { out.reservasLiberadas = await liberarReservas(); } catch (e) { out.reservasLiberadas = { error: true }; log.error({ err: e.message }, "cron horario: reservas"); }
    res.json(out);
  }));
  r.post("/cron/conciliar-pagos", wrap(async (req, res) => {
    const tok = process.env.CRON_SECRET;
    if (!tok || !igualesSeguro(req.headers["x-cron-token"], tok)) return res.status(401).json({ error: "no autorizado" });
    res.json(await conciliarPagos());
  }));
  r.post("/cron/diario", wrap(async (req, res) => {
    const tok = process.env.CRON_SECRET;
    if (!tok || !igualesSeguro(req.headers["x-cron-token"], tok)) return res.status(401).json({ error: "no autorizado" });
    const out = { cumples: 0, renovaciones: 0, subastas: 0, sesionesPurgadas: 0 };
    const hoy = new Date().toISOString().slice(0, 10);
    // IDEMPOTENCIA: Cloud Scheduler es at-least-once. `reservarNotificacion` es atómico
    // (INSERT ON CONFLICT) → si el cron corre 2 veces el mismo día, o falla a mitad y
    // reintenta, cada socio recibe el correo UNA sola vez. Sin esto = spam + gasto de cuota.
    const puede = store.reservarNotificacion ? (clave) => store.reservarNotificacion(clave) : async () => true;
    const falla = (paso) => (e) => { log.error({ err: e.message }, "cron " + paso); alertar("cron:diario:" + paso, "Falló un paso del cron diario: " + paso, String(e && e.message)); };
    try { out.subastas = await cerrarYnotificarSubastas(); } catch (e) { falla("subastas")(e); }
    try { out.pagos = await conciliarPagos(); } catch (e) { falla("conciliación de pagos")(e); }
    try { out.plazosSubastas = await procesarPlazosSubastas(); } catch (e) { falla("plazos de subastas")(e); }
    try { out.puntos = await procesarPuntosDiario(); } catch (e) { falla("puntos")(e); }
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
    try { if (store.purgarVitales) out.vitalesPurgados = await store.purgarVitales(); } catch (e) { log.error({ err: e.message }, "cron purga vitales"); }
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
    // Si no se pudo guardar, el error sube (500): NO se le dice "listo, te diste de baja" a quien va a seguir recibiendo correos.
    if (id) await store.updateSocio(id, { marketing_baja: true, marketing_baja_en: new Date().toISOString() });
    return !!id;
  }
  r.post("/baja", wrap(async (req, res) => {
    await procesarBaja(req.query.u || (req.body && req.body.u));
    res.status(200).json({ ok: true }); // one-click (RFC 8058): 200 cuando quedó guardada; 5xx si no, para que el cliente de correo reintente
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
  // Roles restringidos (CD, marketing, comercial, operaciones): solo entran a las secciones que les corresponden.
  const pasaSeccion = (req, res, next) => {
    const ruta = (req.originalUrl || req.url || "").split("?")[0].replace(/^\/api(?=\/)/, "");
    const a = adminAuth.accesoRuta(req.adminRole, ruta);
    if (a.ok) return next();
    return res.status(403).json({ error: req.adminRole === "cd" ? "La Comisión Directiva no tiene acceso a esta sección" : "Tu rol no tiene acceso a esta sección" });
  };
  const requireAdmin = async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // NUNCA cachear datos admin (ni en CDN ni navegador)
    try {
      const token = req.headers["x-admin-token"] || "";
      if (token && store.getAdminSession) {
        const s = await store.getAdminSession(token);
        if (s) { req.adminUser = s.usuario; req.adminRole = s.rol; req.adminId = s.admin_id; return pasaSeccion(req, res, next); }
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
  const requirePerm = (...perms) => (req, res, next) => {
    if (perms.some((p) => adminAuth.can(req.adminRole, p))) return next();
    if (req.adminRole === "cd") return res.status(403).json({ error: "La Comisión Directiva ve esta sección en solo lectura" });
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
    res.json({
      usuario: req.adminUser, rol,
      areas: adminAuth.AREAS_POR_ROL[rol] || adminAuth.AREAS_POR_ROL.owner,
      secciones: adminAuth.seccionesVisibles(rol),
      solo_lectura: adminAuth.SOLO_LECTURA.includes(rol),
      perms: adminAuth.PERMS_POR_ROL[rol] || [],
    });
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
  r.get("/admin/resumen", requireAdmin, wrap(async (req, res) => {
    const [totalReal, pendientes, subastas] = await Promise.all([
      store.contarTotal ? store.contarTotal() : 0,
      store.listPedidos ? store.listPedidos({ estado: "pendiente", limit: 200 }) : [],
      store.listSubastasPublicas ? store.listSubastasPublicas() : [],
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
    // Los pedidos pendientes traen nombre y correo de quien paga: solo los ve quien tiene Pagos o Hinchas (la CD y el rol comercial reciben solo el número).
    const verPersonas = adminAuth.puedeVer(req.adminRole, "pagos") || adminAuth.puedeVer(req.adminRole, "hinchas");
    res.json({ totalReal, pendientes: verPersonas ? enrich : [], pendientesTotal: enrich.length, subastasSinPagar, subastasPausadas });
  }));
  // ─── Notificaciones push ──────────────────────────────────────────────────────
  // El navegador pide permiso en la pantalla (nunca al entrar). Cuatro tipos de aviso; cada persona elige cuáles.
  r.get("/push/config", auth.requireSocio, wrap(async (req, res) => {
    const subs = store.listarPushDeSocio ? await store.listarPushDeSocio(req.socio.id) : [];
    res.json({ habilitado: pushLib.habilitado(), clave: pushLib.clavePublica(), tipos: pushLib.TIPOS, prefs: pushLib.prefsDe(req.socio), dispositivos: subs.length });
  }));
  r.post("/push/suscribir", auth.requireSocio, wrap(async (req, res) => {
    if (!pushLib.habilitado()) throw httpError(503, "Los avisos todavía no están disponibles.");
    const sub = (req.body && req.body.subscription) || {};
    const endpoint = String(sub.endpoint || ""), p256dh = String((sub.keys || {}).p256dh || ""), authK = String((sub.keys || {}).auth || "");
    const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 700 || !b64.test(p256dh) || p256dh.length > 200 || !b64.test(authK) || authK.length > 100) throw httpError(400, "Suscripción inválida");
    await store.guardarPushSuscripcion({ socioId: req.socio.id, endpoint, p256dh, auth: authK, ua: String(req.headers["user-agent"] || "").slice(0, 160) });
    res.json({ ok: true, prefs: pushLib.prefsDe(req.socio) });
  }));
  r.post("/push/baja", auth.requireSocio, wrap(async (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || "");
    if (endpoint && store.borrarPushSuscripcion) {
      const mias = await store.listarPushDeSocio(req.socio.id);
      if (mias.some((x) => x.endpoint === endpoint)) await store.borrarPushSuscripcion(endpoint);   // solo borra los propios
    }
    res.json({ ok: true });
  }));
  r.patch("/push/preferencias", auth.requireSocio, wrap(async (req, res) => {
    const nuevas = pushLib.prefsDe(req.socio);
    for (const t of pushLib.TIPOS) if (req.body && typeof req.body[t] === "boolean") nuevas[t] = req.body[t];
    await store.updateSocio(req.socio.id, { push_prefs: nuevas });
    res.json({ ok: true, prefs: nuevas });
  }));
  // Aviso del club (partido de hoy, novedad): lo manda el equipo; opcionalmente solo a una ciudad. Máx. 1 por persona y día.
  r.post("/admin/push/enviar", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    const b = req.body || {};
    const tipo = pushLib.TIPOS.includes(b.tipo) ? b.tipo : "partido";
    const titulo = String(b.titulo || "").trim(), cuerpo = String(b.cuerpo || "").trim();
    if (titulo.length < 3 || titulo.length > 80 || cuerpo.length > 160) throw httpError(400, "El título lleva entre 3 y 80 caracteres y el texto hasta 160.");
    const out = await pushLib.difundir(store, { tipo, ciudad: b.ciudad, payload: { titulo, cuerpo, url: b.url || "/miembro", tag: "club-" + tipo }, base: baseUrl(), clave: crypto.createHash("sha1").update(titulo + cuerpo).digest("hex").slice(0, 8) });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "push:enviar", targetId: tipo, detalle: titulo.slice(0, 80) + " · " + out.enviados + "/" + out.destinatarios, por: req.adminUser });
    res.json(out);
  }));
  r.get("/admin/push/resumen", requireAdmin, wrap(async (_req, res) => {
    res.json({ habilitado: pushLib.habilitado(), ...(store.contarPush ? await store.contarPush() : { dispositivos: 0, personas: 0 }) });
  }));
  // Base del club: cuántas cédulas tenemos, cuántas ya se consultaron a la API y qué estados devolvió. Sin datos personales.
  // Perfiles guardados para la campaña de validación de datos (las campañas siguen apagadas hasta que se decida activarlas). Son segmentos normales:
  // aparecen en Campañas y se pueden usar o ajustar como cualquier otro.
  const PERFILES_CAMPANA = [
    { clave: "porReconocer", nombre: "Validación de datos · cuentas por reconocer", filtros: { porReconocer: true } },
    { clave: "candidataCorreo", nombre: "Validación de datos · sin cédula, con correo en la base del club", filtros: { candidataCorreo: true } },
    { clave: "enMora", nombre: "Validación de datos · socios en mora", filtros: { enMora: true } },
  ];
  const totalPerfil = async (p) => (store.paginaSocios ? (await store.paginaSocios({ ...p.filtros, limite: 1 })).total : 0);
  r.get("/admin/club/resumen", requireAdmin, wrap(async (_req, res) => {
    const r0 = store.resumenSociosClub ? await store.resumenSociosClub() : { total: 0, en_base: 0, consultados: 0, pendientes: 0, estados: [], cuentas_para_reconocer: 0 };
    const perfiles = [];
    for (const p of PERFILES_CAMPANA) perfiles.push({ nombre: p.nombre, total: await totalPerfil(p) });
    res.json({ ...r0, perfiles, sincronizacion: await resumenSincronizacion().catch(() => null), api_habilitada: tutiApi.habilitado(), barrido: process.env.TUTI_BARRIDO !== "off", lote: Number(process.env.TUTI_LOTE) || 120 });
  }));
  r.post("/admin/club/perfiles", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    if (!store.crearSegmento || !store.listSegmentos) throw httpError(503, "No disponible");
    const existentes = new Set((await store.listSegmentos()).map((x) => x.nombre));
    const out = { creados: [], existentes: [] };
    for (const p of PERFILES_CAMPANA) {
      if (existentes.has(p.nombre)) { out.existentes.push(p.nombre); continue; }
      await store.crearSegmento({ nombre: p.nombre, filtros: limpiarFiltros(p.filtros), por: req.adminUser });
      out.creados.push(p.nombre);
    }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "club:guardar_perfiles", targetId: "campana_validacion", detalle: JSON.stringify(out), por: req.adminUser });
    res.json({ ...out, perfiles: await Promise.all(PERFILES_CAMPANA.map(async (p) => ({ nombre: p.nombre, total: await totalPerfil(p) }))) });
  }));
  // Rendimiento real: p75 de LCP / INP / CLS / TTFB por pantalla y tipo de dispositivo (últimos N días).
  r.get("/admin/vitales", requireAdmin, wrap(async (req, res) => {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 45);
    const filas = store.resumenVitales ? await store.resumenVitales(dias) : [];
    res.json({ dias, filas: filas.map((f) => ({ ...f, lcp_p75: f.lcp_p75 == null ? null : Math.round(f.lcp_p75), inp_p75: f.inp_p75 == null ? null : Math.round(f.inp_p75), ttfb_p75: f.ttfb_p75 == null ? null : Math.round(f.ttfb_p75), cls_p75: f.cls_p75 == null ? null : Math.round(f.cls_p75 * 1000) / 1000 })) });
  }));
  // Reportes de negocio: embudo, membresías (pagas vs gratis), top países, altas/día.
  // Cohortes de alta (semana de Paraguay): cuántos se registraron y llegaron a cada hito, y mediana de días hasta el primer canje; más los movimientos del club.
  r.get("/admin/cohortes", requireAdmin, wrap(async (req, res) => {
    const semanas = Math.min(Math.max(parseInt(req.query.semanas, 10) || 8, 1), 52), ahora = Date.now();
    const [cohortes, club7, club30] = await Promise.all([
      store.cohortesDeAlta ? store.cohortesDeAlta({ semanas }) : [],
      store.resumenHistorialClub ? store.resumenHistorialClub({ desde: new Date(ahora - 7 * 86400000).toISOString() }) : null,
      store.resumenHistorialClub ? store.resumenHistorialClub({ desde: new Date(ahora - 30 * 86400000).toISOString() }) : null,
    ]);
    res.json({ cohortes, club: { dias7: club7, dias30: club30 } });
  }));
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
    const safe = { ...socio }; delete safe.password_hash; delete safe.password; delete safe.verif_token; delete safe.reset_token; delete safe.reset_token_exp; delete safe.carnet_secreto;
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
    if (b.socio_desde != null) {   // "Socio desde": fecha (AAAA-MM-DD) fijada por un admin; vacío = que vuelva a decidirlo la base del club
      const v = String(b.socio_desde).trim();
      if (!v) { patch.socio_desde = null; patch.socio_desde_fuente = ""; }
      else {
        const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + "T00:00:00Z") : NaN;
        if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v || v < "1950-01-01" || v > hoyPy()) throw httpError(400, "Fecha de socio inválida (AAAA-MM-DD, entre 1950 y hoy)");
        patch.socio_desde = v; patch.socio_desde_fuente = "admin";
      }
    }
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
    if (patch.cedula) unirPenaPorCedula(socio.id);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "editar_socio", targetId: socio.id, detalle: Object.keys(patch).join(", "), por: req.adminUser });
    const safe = { ...actualizado }; delete safe.password_hash; delete safe.password; delete safe.verif_token; delete safe.reset_token; delete safe.reset_token_exp; delete safe.carnet_secreto;
    res.json({ ok: true, socio: safe });
  }));
  // Reenviar el email de verificación a un socio.
  r.post("/admin/socios/:id/reenviar-verificacion", requireAdmin, requirePerm("socios.write"), wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const vtoken = crypto.randomBytes(24).toString("base64url");
    await store.updateSocio(socio.id, { verif_token: vtoken, email_verificado: false });
    const link = `${baseUrl()}/api/auth/verificar?token=${vtoken}`;
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
  // Tablero del club: lo que mira la Comisión Directiva de un vistazo (todo agregado, sin datos personales).
  r.get("/admin/tablero", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("tablero", 30000, async () => {
      // Sin atajos: si la base falla, el tablero falla (un tablero que muestra ceros cuando la base está caída engaña a la CD).
      const [total, est, pagos, subastas, puntos, penas, beneficios, decs, canjesPena] = await Promise.all([
        store.contarTotal ? store.contarTotal() : 0,
        store.estadisticasAdmin ? store.estadisticasAdmin() : { embudo: {}, membresias: [], tiempo: {} },
        store.pagosRecibidos ? store.pagosRecibidos() : { totales: {}, porConcepto: [] },
        store.listSubastasPublicas ? store.listSubastasPublicas() : [],
        store.resumenPuntos ? store.resumenPuntos() : {},
        store.listPenas ? store.listPenas() : [],
        store.listBeneficios ? store.listBeneficios() : [],
        store.listDecisiones ? store.listDecisiones() : [],
        store.canjesPendientesPena ? store.canjesPendientesPena() : [],
      ]);
      const pagantes = (est.membresias || []).reduce((a, m) => a + (Number(m.pagados) || 0), 0);
      return {
        hinchas: { total: Number(total) || 0, hoy: (est.tiempo || {}).hoy || 0, ayer: (est.tiempo || {}).ayer || 0, pagantes, socios_validados: (est.embudo || {}).valido_socio || 0 },
        ingresos: { hoy: (pagos.totales || {}).hoy || 0, d7: (pagos.totales || {}).d7 || 0, d30: (pagos.totales || {}).d30 || 0, total: (pagos.totales || {}).total || 0, por_concepto: pagos.porConcepto || [] },
        subastas: {
          activas: (subastas || []).filter((s) => s.estado === "activa").length,
          sin_pagar: (subastas || []).filter((s) => s.estado === "cerrada" && s.ganador_id && s.pago_estado !== "pagado").length,
          pausadas: (subastas || []).filter((s) => s.estado === "pausada").length,
        },
        puntos: { pasivo: puntos.pasivo || 0, socios_con_saldo: puntos.socios_con_saldo || 0, canjes_pendientes: puntos.canjes_pendientes || 0 },
        penas: { total: (penas || []).length, verificadas: (penas || []).filter((p) => p.estado === "verificada").length, canjes_pendientes: (canjesPena || []).length },
        beneficios: { publicados: (beneficios || []).filter((b) => b.estado === "aprobado").length, por_aprobar: (beneficios || []).filter((b) => b.estado === "borrador").length },
        decisiones: { total: Object.keys(DECISIONES).length, tomadas: (decs || []).filter((d) => DECISIONES[d.clave]).length },
        generado: new Date().toISOString(),
      };
    }));
  }));
  // Qué secciones tiene cada rol EN SU MENÚ (las lecturas por API de algunos roles son más amplias que su menú: los tableros nuevos siguen estrictamente el menú).
  const vePanel = (rol, seccion) => rol === "owner" || (adminAuth.VER_POR_ROL[rol] || []).includes(seccion);
  // ── Para hacer ahora: todo lo que espera a una persona del equipo, en un solo lugar (cada fila lleva al área donde se resuelve) ──
  // Solo trae las colas de las secciones que el rol puede ver, y solo números y antigüedad: nunca nombres ni datos personales.
  r.get("/admin/pendientes", requireAdmin, wrap(async (req, res) => {
    const rol = req.adminRole || "owner", ve = (s) => vePanel(rol, s), ahora = Date.now(), H48 = ahora - 48 * 3600000;
    const cola = (clave, titulo, seccion, area, filas, nota) => {
      const fechas = (filas || []).map((f) => (f && (f.creado || f.fecha)) || null).filter(Boolean).map((x) => new Date(x).getTime()).filter((t) => Number.isFinite(t));
      return { clave, titulo, seccion, area, n: (filas || []).length, envejecidos: fechas.filter((t) => t < H48).length, mas_viejo: fechas.length ? new Date(Math.min(...fechas)).toISOString() : null, nota: nota || "" };
    };
    const lee = async (seccion, fn) => (ve(seccion) ? fn().catch(() => []) : null);
    const [pagos, valid, ofertas, penas, canjesPena, subastas, canjesPuntos, atencion] = await Promise.all([
      lee("pagos", async () => (store.listPedidos ? store.listPedidos({ estado: "pendiente", limit: 500 }) : [])),
      lee("contenido", async () => (store.listActualizaciones ? store.listActualizaciones({ estado: "pendiente", limit: 500 }) : [])),
      lee("beneficios", async () => ((store.listBeneficios ? await store.listBeneficios() : []).filter((b) => b.estado === "borrador"))),
      lee("penas", async () => (store.listPenas ? store.listPenas({ estado: "pendiente" }) : [])),
      lee("penas", async () => (store.canjesPendientesPena ? store.canjesPendientesPena() : [])),
      lee("subastas", async () => ((store.listSubastasPublicas ? await store.listSubastasPublicas() : []).filter((s) => s.estado === "cerrada" && s.ganador_id && s.pago_estado !== "pagado").map((s) => ({ creado: s.pago_vence || s.termina })))),
      lee("puntos", async () => (store.listCanjesPremio ? store.listCanjesPremio({ estado: "pendiente", limit: 500 }) : [])),
      ve("atencion") ? (store.listBandejaAtencion ? store.listBandejaAtencion({ estado: "humano", limit: 200 }).catch(() => []) : []) : null,
    ]);
    const colas = [
      pagos && cola("pagos", "Pagos pendientes de acreditar", "pagos", "pagos", pagos, "Pedidos que el hincha inició y todavía no se acreditaron."),
      subastas && cola("subastas", "Lotes ganados sin pagar", "subastas", "contenido", subastas, "El ganador todavía no pagó: pueden vencer y pasar al siguiente."),
      atencion && cola("atencion", "Conversaciones esperando a una persona", "atencion", "atencion", (atencion || []).map((c) => ({ creado: c.derivada_en || c.actualizado || c.creado })), "El asistente las pasó al equipo."),
      valid && cola("validaciones", "Validaciones y actualizaciones por revisar", "contenido", "contenido", valid, "Reclamos de socio y datos que hay que unificar o rechazar."),
      ofertas && cola("ofertas", "Ofertas de comercios por aprobar", "beneficios", "contenido", ofertas, "Los comercios las cargan en borrador y el club las aprueba."),
      penas && cola("penas", "Peñas por verificar", "penas", "contenido", penas, "Solicitudes nuevas desde la app."),
      canjesPena && cola("canjes_pena", "Canjes del fondo de peñas por aprobar", "penas", "contenido", canjesPena),
      canjesPuntos && cola("canjes_puntos", "Premios de puntos por entregar", "puntos", "contenido", canjesPuntos),
    ].filter(Boolean);
    res.json({ colas, total: colas.reduce((a, c) => a + c.n, 0), envejecidos: colas.reduce((a, c) => a + c.envejecidos, 0), generado: new Date(ahora).toISOString() });
  }));

  // ── Gerencia: este período contra el anterior (todo agregado, sin datos personales) ──
  r.get("/admin/gerencia", requireAdmin, wrap(async (_req, res) => {
    res.json(await memoAdmin("gerencia", 30000, async () => {
      const ahora = Date.now(), iso = (ms) => new Date(ms).toISOString(), fin = iso(ahora + 1000), d = (n) => iso(ahora - n * 86400000);
      const [i30, i30p, i7, i7p, a30, a30p, a7, a7p, c30, c30p, nivel, club30, penas, pagos] = await Promise.all([
        store.ingresosEntre({ desde: d(30), hasta: fin }), store.ingresosEntre({ desde: d(60), hasta: d(30) }), store.ingresosEntre({ desde: d(7), hasta: fin }), store.ingresosEntre({ desde: d(14), hasta: d(7) }),
        store.altasEntre({ desde: d(30), hasta: fin }), store.altasEntre({ desde: d(60), hasta: d(30) }), store.altasEntre({ desde: d(7), hasta: fin }), store.altasEntre({ desde: d(14), hasta: d(7) }),
        store.resumenCanjesEntre({ desde: d(30), hasta: fin }), store.resumenCanjesEntre({ desde: d(60), hasta: d(30) }),
        store.resumenNivelClub(), store.resumenHistorialClub ? store.resumenHistorialClub({ desde: d(30) }) : null, store.actividadPenas({ desde: d(60) }),
        store.pagosRecibidos ? store.pagosRecibidos() : { totales: {} },
      ]);
      const par = (actual, previo) => ({ actual, previo, delta_pct: previo ? Math.round(((actual - previo) / previo) * 100) : null });
      const dormidas = penas.filter((p) => !p.altas);
      return {
        ingresos: { d30: par(i30.total, i30p.total), d7: par(i7.total, i7p.total), pagos_30: par(i30.n, i30p.n), total_historico: (pagos.totales || {}).total || 0 },
        altas: { d30: par(a30, a30p), d7: par(a7, a7p) },
        canjes: { d30: par(c30.canjes, c30p.canjes), ahorro_entregado_30: par(c30.ahorro, c30p.ahorro), socios_que_usaron_30: par(c30.socios, c30p.socios) },
        club: { ...nivel, movimientos_30: club30 },
        penas: { verificadas: penas.length, activas_60: penas.length - dormidas.length, dormidas_60: dormidas.length, dormidas_top: dormidas.slice(0, 8).map((p) => ({ nombre: p.nombre, ciudad: p.ciudad, total: p.total })), top_altas_60: penas.filter((p) => p.altas).slice(0, 5).map((p) => ({ nombre: p.nombre, altas: p.altas })) },
        generado: iso(ahora),
      };
    }));
  }));

  // ── Red de comercios: ranking, dormidos, mes contra mes y ofertas por vencer (agregado, sin datos de hinchas) ──
  r.get("/admin/comercial", requireAdmin, wrap(async (req, res) => {
    if (!vePanel(req.adminRole || "owner", "beneficios")) throw httpError(403, "Tu rol no tiene acceso a la red de comercios");
    res.json(await memoAdmin("comercial", 30000, async () => {
      const ahora = Date.now(), d = (n) => new Date(ahora - n * 86400000).toISOString();
      const [r30, r60, bens] = await Promise.all([store.resumenComercios({ desde: d(30) }), store.resumenComercios({ desde: d(60) }), store.listBeneficios ? store.listBeneficios() : []]);
      const prev = new Map(r60.map((c) => [c.id, c]));
      const filas = r30.map((c) => { const p = prev.get(c.id) || {}; return { id: c.id, nombre: c.nombre, ciudad: c.ciudad || "", estado: c.estado, canjes_30: Number(c.canjes_mes) || 0, ahorro_30: Number(c.ahorro_mes) || 0, canjes_prev: Math.max(0, (Number(p.canjes_mes) || 0) - (Number(c.canjes_mes) || 0)), ultimo_canje: c.ultimo_canje || null, publicados: Number(c.beneficios_pub) || 0 }; });
      const activos = filas.filter((c) => c.estado === "activo");
      const dormidos = activos.filter((c) => c.publicados > 0 && !c.canjes_30).sort((a, b) => String(a.ultimo_canje || "").localeCompare(String(b.ultimo_canje || "")));
      const en14 = ahora + 14 * 86400000;
      const porVencer = (bens || []).filter((b) => b.estado === "aprobado" && b.activo !== false && b.vigencia_hasta && new Date(b.vigencia_hasta).getTime() > ahora && new Date(b.vigencia_hasta).getTime() <= en14)
        .sort((a, b) => new Date(a.vigencia_hasta) - new Date(b.vigencia_hasta)).map((b) => ({ titulo: b.titulo, comercio: b.comercio_nombre || "", hasta: b.vigencia_hasta }));
      const tot = (k) => filas.reduce((a, c) => a + c[k], 0);
      return {
        red: { comercios: filas.length, activos: activos.length, con_ofertas: activos.filter((c) => c.publicados > 0).length, dormidos: dormidos.length, canjes_30: tot("canjes_30"), canjes_prev: tot("canjes_prev"), ahorro_30: tot("ahorro_30") },
        ranking: filas.slice().sort((a, b) => b.canjes_30 - a.canjes_30 || b.ahorro_30 - a.ahorro_30).slice(0, 10).filter((c) => c.canjes_30 > 0),
        dormidos: dormidos.slice(0, 15).map((c) => ({ nombre: c.nombre, ciudad: c.ciudad, ultimo_canje: c.ultimo_canje, publicados: c.publicados })),
        por_vencer: porVencer.slice(0, 15),
        generado: new Date(ahora).toISOString(),
      };
    }));
  }));
  // Integraciones: qué está conectado y qué no (solo estado; nunca valores ni claves).
  r.get("/admin/integraciones", requireAdmin, wrap(async (_req, res) => {
    const hay = (...vars) => vars.every((v) => !!process.env[v]);
    const simulado = process.env.ENTORNO === "staging";
    const estado = (ok, simul) => (ok ? "conectado" : simul && simulado ? "simulado" : "sin_conectar");
    res.json({
      entorno: process.env.ENTORNO || "produccion",
      items: [
        { id: "tuti", nombre: "Tuti (padrón de socios)", detalle: "Valida la cédula contra el padrón del club.", estado: estado(hay("TUTI_API_KEY", "TUTI_MERCHANT_KEY"), true) },
        { id: "pagopar", nombre: "Pagopar (cobros)", detalle: "Tarjetas, transferencias y billeteras.", estado: estado(hay("PAGOPAR_PUBLIC_TOKEN", "PAGOPAR_PRIVATE_TOKEN"), true) },
        { id: "email", nombre: "Correo (Resend)", detalle: "Verificación, avisos y recibos.", estado: estado(hay("RESEND_API_KEY"), true) },
        { id: "ghl", nombre: "GoHighLevel", detalle: "Sincronía de contactos y campañas.", estado: estado(hay("GHL_WEBHOOK_URL")) },
        { id: "ia", nombre: "Atención con IA", detalle: "Asistente de atención a hinchas (Gemini; Anthropic como respaldo).", estado: estado(atencionLib.proveedores().length > 0) },
        { id: "alertas", nombre: "Alertas operativas", detalle: "Avisos cuando algo falla.", estado: estado(hay("ALERT_WEBHOOK_URL") || hay("ALERT_EMAIL")) },
        { id: "cron", nombre: "Tareas programadas", detalle: "Plazos de subastas, conciliación y puntos.", estado: estado(hay("CRON_SECRET")) },
      ],
    });
  }));
  // Roles: matriz de quién ve y quién edita cada sección (para que el club audite los accesos).
  r.get("/admin/roles", requireAdmin, requirePerm("usuarios"), wrap(async (_req, res) => {
    const secciones = adminAuth.SECCIONES;
    res.json({
      secciones,
      roles: adminAuth.ROLES.map((rol) => ({
        rol, restringido: adminAuth.RESTRINGIDOS.includes(rol), solo_lectura: adminAuth.SOLO_LECTURA.includes(rol),
        ve: adminAuth.seccionesVisibles(rol), perms: adminAuth.PERMS_POR_ROL[rol] || [],
      })),
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
    const q = csvCelda; // neutraliza = + - @ (inyección de fórmulas en Excel)
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
  // Filtros de la tabla de socios (y de su exportación): nivel, socio del club, correo confirmado, foto y texto libre.
  const filtrosSociosTabla = (q) => ({
    q: String(q.q || "").trim().slice(0, 80) || undefined,
    tier: ["olimpista", "kids", "premium", "socio"].includes(q.tier) ? q.tier : undefined,
    club: q.club === "1" ? true : q.club === "0" ? false : undefined,
    verificado: q.verificado === "1" ? true : q.verificado === "0" ? false : undefined,
    conFoto: q.foto === "1" ? true : undefined,
    sinFoto: q.foto === "0" ? true : undefined,
    paisIso: q.pais || undefined,
    validoSocio: q.validoSocio === "1" ? true : undefined,
    ciudad: String(q.ciudad || "").trim().slice(0, 60) || undefined,
  });
  // Tabla de socios: página con total y orden elegido (solo columnas conocidas).
  r.get("/admin/socios", requireAdmin, wrap(async (req, res) => {
    if (!store.paginaSocios) return res.json({ items: [], total: 0, pagina: 0, limite: 25 });
    const out = await store.paginaSocios({ ...filtrosSociosTabla(req.query), orden: String(req.query.orden || ""), dir: req.query.dir === "asc" ? "asc" : "desc", pagina: req.query.pagina, limite: req.query.limite });
    res.json(out);
  }));
  r.get("/admin/export/socios.csv", requireAdmin, requirePerm("export"), wrap(async (req, res) => {
    const f = { ...filtrosSociosTabla(req.query), limit: 5000 };
    const items = store.filtrarSocios ? await store.filtrarSocios(f) : [];
    const q = csvCelda; // neutraliza = + - @ (inyección de fórmulas en Excel)
    const head = ["nombre", "apellido", "email", "cedula", "pais", "pais_iso", "tier", "socio_olimpia", "tiene_foto", "creado"];   // el orden de las columnas existentes no cambia
    const rows = items.map((s) => [s.nombre, s.apellido, s.email, s.cedula, s.pais, s.pais_iso, s.tier_slug, s.es_socio_olimpia ? "si" : "no", s.tiene_foto ? "si" : "no", s.creado].map(q).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="socios.csv"');
    res.send(head.join(",") + "\n" + rows.join("\n"));
  }));
  // ─── Ficha 360 del hincha + "buscar parecidos" + segmentos guardados ───────────
  // Estado en el club: el Portal de Socios (ITTI) manda; si no responde se usa lo que Olimpistas
  // ya sabía (padrón) y se marca "sin confirmar". Nunca se inventa un estado.
  async function estadoClubDe(socio) {
    const base = { es_socio_olimpia: !!socio.es_socio_olimpia, plan_club: socio.plan_club || "" };
    const ced = soloDigitos(socio.cedula);
    if (!ced) return { ...base, fuente: "ninguna", confirmado: false, motivo: "sin_cedula" };
    if (!tutiApi.habilitado()) return { ...base, fuente: "padron", confirmado: false, motivo: "deshabilitado" };
    const v = await tutiApi.consultarSocio(ced);
    if (v.ok && v.encontrado) {
      const s = v.socio;
      if (s.plan && s.plan !== socio.plan_club) store.updateSocio(socio.id, { plan_club: s.plan }).catch(() => {}); // copia de lectura
      return { ...base, plan_club: s.plan || base.plan_club, fuente: "portal", confirmado: true, encontrado: true,
        status: s.status, al_dia: s.alDia, deuda: s.deuda, numero_socio: s.numeroSocio, debito_automatico: s.debitoAutomatico };
    }
    if (v.ok) return { ...base, fuente: "portal", confirmado: true, encontrado: false, nota: "No figura como titular (la API no trae adherentes de un plan familiar)." };
    return { ...base, fuente: "padron", confirmado: false, motivo: v.motivo };
  }
  const FILTROS_SEGMENTO = ["paisIso", "tier", "validoSocio", "sinFoto", "canjes", "pujas", "gasto", "ciudad", "q", "porReconocer", "candidataCorreo", "enMora"];
  function limpiarFiltros(f) {
    const out = {}, src = f && typeof f === "object" ? f : {};
    if (typeof src.paisIso === "string" && /^[A-Za-z]{2}$/.test(src.paisIso)) out.paisIso = src.paisIso.toUpperCase();
    if (typeof src.tier === "string" && tierBySlug(src.tier)) out.tier = src.tier;
    for (const k of ["validoSocio", "sinFoto", "porReconocer", "candidataCorreo", "enMora"]) if (src[k] === true) out[k] = true;
    for (const k of ["canjes", "pujas", "gasto"]) if (typeof src[k] === "boolean") out[k] = src[k];
    for (const k of ["ciudad", "q"]) if (typeof src[k] === "string" && src[k].trim()) out[k] = src[k].trim().slice(0, 80);
    return out;
  }
  r.get("/admin/socios/:id/360", requireAdmin, wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const [membresia, historial, pedidos, ahorro, canjes, pujasRaw, actualizaciones, club] = await Promise.all([
      store.getMembresia(socio.id),
      store.listMembresias ? store.listMembresias(socio.id) : [],
      store.listPedidos ? store.listPedidos({ socioId: socio.id, limit: 100 }) : [],
      store.resumenAhorroSocio ? store.resumenAhorroSocio(socio.id) : { mes: 0, anio: 0, total: 0, canjes_mes: 0 },
      store.canjesDeSocio ? store.canjesDeSocio(socio.id, 30) : [],
      store.pujasDeSocio ? store.pujasDeSocio(socio.id, 30) : [],
      store.listActualizaciones ? store.listActualizaciones({ socioId: socio.id, limit: 30 }) : [],
      estadoClubDe(socio),
    ]);
    const tier = (membresia && membresia.tier_slug) || "olimpista";
    const resultado = (p) => p.estado === "activa" ? "en_vivo" : (p.adjudicado_a || p.ganador_id) === socio.id ? (p.pago_estado === "pagado" ? "pagado" : "gano_sin_pagar") : "no_gano";
    const puntosSaldo = store.saldoPuntos ? await store.saldoPuntos(socio.id) : 0;
    const puntosMov = store.movimientosPuntos ? await store.movimientosPuntos(socio.id, 10) : [];
    const pena = socio.pena_id && store.getPena ? await store.getPena(socio.pena_id).catch(() => null) : null;
    const pujas = pujasRaw.map((p) => ({ subasta_id: p.subasta_id, titulo: p.titulo, mejor_oferta: p.mejor_oferta, pujas: p.pujas, ultima: p.ultima, resultado: resultado(p) }));
    const pagados = pedidos.filter((p) => p.estado === "pagado");
    const bloqueo = socio.subastas_bloqueo_hasta && new Date(socio.subastas_bloqueo_hasta).getTime() > Date.now() ? socio.subastas_bloqueo_hasta : null;

    // Hitos con fecha (socio_eventos) e historial del estado del club (por cédula): lo que antes no se podía reconstruir.
    const hitos = store.eventosDeSocio ? await store.eventosDeSocio(socio.id, 100).catch(() => []) : [];
    const tramosClub = store.historialClubDeCedula && soloDigitos(socio.cedula).length >= 5 ? await store.historialClubDeCedula(claveCedula(socio.cedula)).catch(() => []) : [];
    // Línea de tiempo (lo más nuevo primero): alta, membresías, pagos, canjes, pujas, validaciones.
    const eventos = [{ tipo: "alta", titulo: "Se registró", detalle: "", fecha: socio.creado }];
    for (const m of historial) eventos.push({ tipo: "membresia", titulo: "Nivel " + ((tierBySlug(m.tier_slug) || {}).nombre || m.tier_slug), detalle: m.estado, fecha: m.inicio });
    for (const p of pagados) eventos.push({ tipo: "pago", titulo: "Pagó " + (p.concepto || "un pedido"), detalle: "₲ " + Number(p.monto || 0).toLocaleString("es-PY"), fecha: p.pagado_en || p.creado });
    for (const c of canjes) eventos.push({ tipo: "canje", titulo: "Usó un beneficio" + (c.beneficio ? ": " + c.beneficio : ""), detalle: [c.comercio, c.ahorro ? "ahorró ₲ " + Number(c.ahorro).toLocaleString("es-PY") : ""].filter(Boolean).join(" · "), fecha: c.creado });
    for (const p of pujas) eventos.push({ tipo: "puja", titulo: "Pujó en " + (p.titulo || "un lote"), detalle: "mejor oferta ₲ " + Number(p.mejor_oferta).toLocaleString("es-PY") + " · " + p.resultado.replace(/_/g, " "), fecha: p.ultima });
    for (const a of actualizaciones.filter((x) => x.tipo !== "alta")) eventos.push({ tipo: "validacion", titulo: a.tipo === "socio_claim" ? "Pidió validar que es socio" : "Actualización: " + a.tipo, detalle: a.estado || "", fecha: a.creado || a.creada });
    const atenciones = store.listConversacionesDeSocio ? await store.listConversacionesDeSocio(socio.id, 10) : [];
    for (const c of atenciones) {
      eventos.push({ tipo: "atencion", titulo: "Escribió a Atención" + (c.canal === "whatsapp" ? " (WhatsApp)" : ""), detalle: c.motivo || (c.derivada_en ? "Pasó a una persona" : "Lo atendió el asistente"), fecha: c.creado });
      if (c.resuelta_en) eventos.push({ tipo: "atencion", titulo: "Atención resuelta", detalle: c.motivo || "", fecha: c.resuelta_en });
    }
    if (bloqueo) eventos.push({ tipo: "suspension", titulo: "Suspendido de las subastas", detalle: "hasta " + fechaCorta(bloqueo), fecha: bloqueo });
    const TIT_HITO = { correo_verificado: "Confirmó su correo", foto: "Subió su foto", nivel_socio_activado: "Se activó su nivel Socio", nivel_socio_pausado: "Su nivel Socio quedó en pausa", primera_puja: "Hizo su primera puja", referido: "Invitó a alguien que se registró" };
    for (const h of hitos) if (TIT_HITO[h.tipo]) eventos.push({ tipo: "hito", titulo: TIT_HITO[h.tipo], detalle: (() => { try { const m = h.meta ? JSON.parse(h.meta) : null; return m && m.motivo ? "por " + m.motivo : ""; } catch (e) { return ""; } })(), fecha: h.ts });
    const ETQ_CLASE = { al_dia: "Al día con el club", mora: "En mora con el club", baja: "De baja en el club" };
    for (const t of tramosClub.filter((x) => !x.inicial)) eventos.push({ tipo: "club", titulo: ETQ_CLASE[t.clase] || t.clase, detalle: t.hasta ? "hasta " + fechaCorta(t.hasta) : "hoy", fecha: t.desde });
    eventos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    res.json({
      socio: { id: socio.id, nombre: socio.nombre, apellido: socio.apellido, email: socio.email, cedula: socio.cedula, pais: socio.pais, pais_iso: socio.pais_iso,
        ciudad: socio.ciudad, creado: socio.creado, ultima_actividad: socio.ultima_actividad || null, es_socio_olimpia: !!socio.es_socio_olimpia,
        plan_club: club.plan_club || "", tier, tiene_foto: !!socio.foto },
      indicadores: {
        gasto_total: socio.gasto_total || 0, pagos: pagados.length, ahorro_mes: ahorro.mes, ahorro_anio: ahorro.anio, ahorro_total: ahorro.total,
        canjes: canjes.length, lotes_pujados: pujas.length, lotes_ganados: pujas.filter((p) => p.resultado === "pagado" || p.resultado === "gano_sin_pagar").length,
      },
      estado_club: club,
      suspension_subastas: bloqueo,
      canjes, pujas,
      // El abono llega con los endpoints nuevos de Tuti.
      abono: null,
      puntos: { saldo: puntosSaldo, escalon: escalonDe(puntosSaldo).nombre, movimientos: puntosMov },
      pena: pena ? { id: pena.id, nombre: pena.nombre, slug: pena.slug, ciudad: pena.ciudad } : null,
      eventos: eventos.slice(0, 60),
    });
  }));
  // "Buscar parecidos": por PERFIL (mismo país y nivel) o por HÁBITO (mismo nivel y mismo uso de la
  // plataforma: canjes, pujas, gasto). Devuelve cuántos hay y los filtros, listos para guardar.
  r.get("/admin/socios/:id/parecidos", requireAdmin, wrap(async (req, res) => {
    const socio = await store.getSocioById(req.params.id);
    if (!socio) throw httpError(404, "Socio no encontrado");
    const por = req.query.por === "habito" ? "habito" : "perfil";
    const m = await store.getMembresia(socio.id);
    const tier = (m && m.tier_slug) || "olimpista";
    let filtros;
    if (por === "perfil") {
      filtros = { tier };
      if (socio.pais_iso) filtros.paisIso = String(socio.pais_iso).toUpperCase();
      if (socio.es_socio_olimpia) filtros.validoSocio = true;
    } else {
      const [canjes, pujas] = await Promise.all([store.canjesDeSocio(socio.id, 1), store.pujasDeSocio(socio.id, 1)]);
      filtros = { tier, canjes: canjes.length > 0, pujas: pujas.length > 0, gasto: (socio.gasto_total || 0) > 0 };
    }
    const TOPE = 5000;
    const items = await store.filtrarSocios({ ...filtros, excluirId: socio.id, limit: TOPE });
    res.json({ por, filtros, total: items.length, tope: items.length >= TOPE,
      muestra: items.slice(0, 10).map((s) => ({ id: s.id, nombre: [s.nombre, s.apellido].filter(Boolean).join(" "), email: s.email, pais_iso: s.pais_iso, tier_slug: s.tier_slug })) });
  }));
  r.get("/admin/segmentos", requireAdmin, wrap(async (_req, res) => {
    res.json({ items: store.listSegmentos ? await store.listSegmentos() : [] });
  }));
  r.post("/admin/segmentos", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    const nombre = String((req.body && req.body.nombre) || "").trim();
    if (nombre.length < 2 || nombre.length > 80) throw httpError(400, "Poné un nombre de 2 a 80 caracteres");
    const filtros = limpiarFiltros(req.body && req.body.filtros);
    if (!Object.keys(filtros).length) throw httpError(400, "El segmento no tiene filtros");
    const seg = await store.crearSegmento({ nombre, filtros, por: req.adminUser });
    const total = (await store.filtrarSocios({ ...filtros, limit: 5000 })).length;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "segmento:guardar", targetId: seg.id, detalle: nombre + " (" + total + ")", por: req.adminUser });
    res.status(201).json({ ok: true, segmento: seg, total });
  }));
  r.get("/admin/segmentos/:id/socios", requireAdmin, wrap(async (req, res) => {
    const seg = (await store.listSegmentos()).find((s) => s.id === req.params.id);
    if (!seg) throw httpError(404, "Segmento no encontrado");
    const items = await store.filtrarSocios({ ...limpiarFiltros(seg.filtros), limit: 500 });
    res.json({ segmento: { id: seg.id, nombre: seg.nombre, filtros: seg.filtros }, total: items.length, items });
  }));
  r.delete("/admin/segmentos/:id", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    await store.deleteSegmento(req.params.id);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "segmento:borrar", targetId: req.params.id, por: req.adminUser });
    res.json({ ok: true });
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
      else if (t === "num") out[f] = b[f] === "" || b[f] === null ? null : (Number.isFinite(Number(b[f])) ? Number(b[f]) : null);
      else if (t === "date") out[f] = b[f] === "" ? null : String(b[f]).slice(0, 10);
      // "imagen": puede ser una data URL subida desde el admin (varios KB/MB de base64),
      // no una URL corta — el tope de "text" (500 chars) la truncaría y la rompería.
      // Tope generoso pero por debajo del límite de body JSON (express.json 1mb).
      else if (t === "imagen") out[f] = typeof b[f] === "string" ? b[f].trim().slice(0, 900000) : b[f];
      else out[f] = typeof b[f] === "string" ? b[f].replace(/[<>]/g, "").trim().slice(0, 500) : b[f];
    }
    return out;
  };
  const PERM_ENTIDAD = { sorteos: "subastas.write", subastas: "subastas.write", comercios: "beneficios.write", beneficios: "beneficios.write" };
  const crudEntidad = (nombre, o) => {
    const permEscritura = PERM_ENTIDAD[nombre] || "contenido.write";
    r.get(`/admin/${nombre}`, requireAdmin, wrap(async (_req, res) => res.json({ items: await o.list() })));
    r.post(`/admin/${nombre}`, requireAdmin, requirePerm(permEscritura), wrap(async (req, res) => {
      const d = limpiarCampos(req.body, o.campos);
      if (o.preparar) await o.preparar(d, req.body || {}, true);
      const item = await o.crear(d);
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":crear", targetId: item && item.id, por: req.adminUser });
      res.status(201).json({ ok: true, item });
    }));
    r.patch(`/admin/${nombre}/:id`, requireAdmin, requirePerm(permEscritura), wrap(async (req, res) => {
      const d = limpiarCampos(req.body, o.campos);
      if (o.preparar) await o.preparar(d, req.body || {}, false);
      if (!Object.keys(d).length) throw httpError(400, "Nada para actualizar");
      const item = await o.update(req.params.id, d);
      if (!item) throw httpError(404, "No encontrado");
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":editar", targetId: req.params.id, por: req.adminUser });
      res.json({ ok: true, item });
    }));
    r.delete(`/admin/${nombre}/:id`, requireAdmin, requirePerm(permEscritura), wrap(async (req, res) => {
      const ok = await o.del(req.params.id);
      if (store.logAccionAdmin) store.logAccionAdmin({ accion: nombre + ":borrar", targetId: req.params.id, por: req.adminUser });
      res.json({ ok });
    }));
  };
  crudEntidad("sorteos", { list: () => store.listSorteos(), crear: (d) => store.crearSorteo(d), update: (id, d) => store.updateSorteo(id, d), del: (id) => store.deleteSorteo(id), campos: { titulo: "text", descripcion: "text", tier_min: "text", cierra: "date", imagen: "text" } });
  crudEntidad("preventas", { list: () => store.listPreventas(), crear: (d) => store.crearPreventa(d), update: (id, d) => store.updatePreventa(id, d), del: (id) => store.deletePreventa(id), campos: { evento: "text", fecha: "date", sede: "text", abre: "date", tier_min: "text", precio_desde: "int", stock: "int", imagen: "text" } });
  crudEntidad("contenido", { list: () => store.listContenido(), crear: (d) => store.crearContenido(d), update: (id, d) => store.updateContenido(id, d), del: (id) => store.deleteContenido(id), campos: { titulo: "text", tipo: "text", tier_min: "text", duracion: "text", descripcion: "text", thumb: "text", publicado: "date" } });
  // Red de Beneficios (admin). comercio_id enlaza el beneficio; niveles = "todos" o CSV "premium,socio".
  const sinHash = (c) => { if (!c) return c; const { password_hash, ...resto } = c; return resto; }; // nunca el hash de la contraseña del comercio
  crudEntidad("comercios", { list: async () => (await store.listComercios()).map(sinHash), crear: async (d) => sinHash(await store.crearComercio(d)), update: async (id, d) => sinHash(await store.updateComercio(id, d)), del: (id) => store.deleteComercio(id), campos: { nombre: "text", rubro: "text", ciudad: "text", direccion: "text", contacto: "text", logo: "text", estado: "text", lat: "num", lng: "num" },
    // La ubicación se carga pegando el link de Google Maps del local ("mapa_url"); si es un alta sin ubicación, se usa su ciudad.
    preparar: async (d, body, alta) => {
      const link = String(body.mapa_url || "").trim();
      if (link) {
        const p = await mapaUrl.resolver(link);
        if (!p) throw httpError(400, "No pude leer la ubicación de ese link. Copiá el link de Google Maps del local (Compartir → Copiar link).");
        d.lat = p.lat; d.lng = p.lng;
      } else if (alta && d.lat == null && d.lng == null && d.ciudad && store.ciudadPorNombre) {
        const c = await store.ciudadPorNombre({ nombre: d.ciudad, pais: "PY" }).catch(() => null);
        if (c) { d.lat = c.lat; d.lng = c.lng; }
      }
      if ((d.lat != null && Math.abs(d.lat) > 90) || (d.lng != null && Math.abs(d.lng) > 180)) throw httpError(400, "Coordenadas inválidas");
    } });
  // Destacar / quitar de destacados: los destacados van de banner arriba de la Red de Beneficios.
  r.post("/admin/beneficios/:id/destacar", requireAdmin, requirePerm("beneficios.write"), wrap(async (req, res) => {
    const destacado = req.body && req.body.destacado === true;
    const item = await store.updateBeneficio(req.params.id, { destacado });
    if (!item) throw httpError(404, "Beneficio no encontrado");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: destacado ? "beneficios:destacar" : "beneficios:quitar_destacado", targetId: req.params.id, por: req.adminUser });
    // Destacar = avisar a quienes tienen avisos de beneficios activados en la ciudad del comercio (máx. 1 por persona y día).
    if (destacado && pushLib.habilitado() && store.getComercio) {
      store.getComercio(item.comercio_id).then((c) => c && c.ciudad ? pushLib.difundir(store, { tipo: "beneficio", ciudad: c.ciudad, base: baseUrl(), clave: item.id, payload: { titulo: "Beneficio destacado en " + c.ciudad, cuerpo: (c.nombre || "") + (item.valor ? " · " + item.valor : "") + (item.titulo ? " · " + item.titulo : ""), url: "/miembro/beneficios", tag: "ben-" + item.id } }) : null).catch(() => {});
    }
    res.json({ ok: true, item });
  }));
  // Beneficios de muestra del club (exclusivos para socios): comercios + ofertas ya aprobadas. Idempotente: no duplica ni pisa ediciones.
  r.post("/admin/beneficios/muestra", requireAdmin, requirePerm("beneficios.write"), wrap(async (req, res) => {
    const out = await require("./lib/beneficios-muestra").cargarMuestra(store, { actualizar: req.query.actualizar === "1" });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "beneficios:cargar_muestra", targetId: "muestra", detalle: JSON.stringify(out), por: req.adminUser });
    res.json({ ok: true, ...out });
  }));
  // ── Admin: aprobar o rechazar ofertas de comercios, y el reporte para sponsors ──
  // Se registra ANTES del CRUD genérico: con `estado` en el cuerpo resuelve la oferta; sin él, cede el paso al CRUD.
  r.patch("/admin/beneficios/:id", requireAdmin, requirePerm("beneficios.write"), (req, res, next) => (!req.body || req.body.estado === undefined) ? next("route") : next(), wrap(async (req, res) => {
    const estado = String(req.body.estado);
    if (!["aprobado", "rechazado"].includes(estado)) throw httpError(400, "Estado inválido (aprobado | rechazado)");
    const motivo = String(req.body.motivo || "").replace(/[<>]/g, "").trim().slice(0, 200);
    if (estado === "rechazado" && motivo.length < 3) throw httpError(400, "Contale al comercio por qué se rechaza (mínimo 3 caracteres)");
    const b = await store.resolverOferta(req.params.id, { estado, motivo });
    if (!b) throw httpError(404, "Oferta no encontrada");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "beneficios:" + estado, targetId: b.id, detalle: b.titulo + (motivo ? " · " + motivo : ""), por: req.adminUser });
    if (estado === "aprobado" && mailer.enviarOfertaAprobada && store.getComercio) {
      const co = await store.getComercio(b.comercio_id).catch(() => null);
      if (co && emailOk(co.contacto)) mailer.enviarOfertaAprobada({ email: co.contacto }, { comercio: co.nombre, titulo: b.titulo }).catch(() => {});
    }
    if (estado === "rechazado" && mailer.enviarOfertaRechazada && store.getComercio) {
      const co = await store.getComercio(b.comercio_id).catch(() => null);
      if (co && emailOk(co.contacto)) mailer.enviarOfertaRechazada({ email: co.contacto }, { comercio: co.nombre, titulo: b.titulo, motivo }).catch(() => {});
    }
    res.json({ ok: true, oferta: ofertaOut(b) });
  }));
  // Resumen de la red de comercios (qué le falta a cada uno + canjes del mes, mes calendario de Paraguay). Sin contraseñas ni datos de hinchas.
  r.get("/admin/comercios/resumen", requireAdmin, wrap(async (_req, res) => {
    const L = new Date(Date.now() - 3 * 3600000);
    const desde = new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), 1) + 3 * 3600000).toISOString();
    const items = store.resumenComercios ? await store.resumenComercios({ desde }) : [];
    res.json({ mes: desde.slice(0, 7), items: items.map((c) => ({ ...c, ahorro_mes: Number(c.ahorro_mes) || 0 })) });
  }));
  r.get("/admin/comercios/estadisticas.csv", requireAdmin, requirePerm("export"), wrap(async (req, res) => {
    const p = periodo({ desde: req.query.desde, hasta: req.query.hasta });
    const filas = await store.estadisticasPorComercio({ desde: p.desde, hasta: p.hasta });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "export:sponsors", detalle: p.etiqueta, por: req.adminUser });
    enviarCsv(res, "sponsors-" + p.etiqueta.replace(/ a /, "_") + ".csv", ["comercio", "ciudad", "nivel", "canjes", "ahorro", "ventas"], filas.map((f) => [f.comercio, f.ciudad, f.nivel, f.canjes, Number(f.ahorro), Number(f.ventas)]));
  }));

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
  r.post("/admin/sorteos/:id/ganador", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
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

  // Mapa del panel del club: SOLO agregados por ciudad, peña y comercio. Nunca una persona ni una casa.
  r.get("/admin/mapa", requireAdmin, wrap(async (req, res) => {
    const capa = String(req.query.capa || "ciudades");
    if (capa === "penas") {
      const filas = (await store.listPenas({ estado: "verificada" })).filter((p) => p.lat != null && p.lng != null);
      return res.json({ capa, items: filas.map((p) => ({ id: p.id, nombre: p.nombre, ciudad: p.ciudad, lat: Number(p.lat), lng: Number(p.lng), altas: p.altas || 0, socios: p.socios || 0, plus: p.plus || 0 })) });
    }
    if (capa === "comercios") {
      const [cs, canjes] = await Promise.all([store.listComercios(), store.canjesPorComercio ? store.canjesPorComercio() : []]);
      const porId = new Map(canjes.map((c) => [c.comercio_id, c]));
      return res.json({ capa, items: cs.filter((c) => c.lat != null && c.lng != null).map((c) => ({ id: c.id, nombre: c.nombre, ciudad: c.ciudad || "", rubro: c.rubro || "", estado: c.estado, lat: Number(c.lat), lng: Number(c.lng), canjes: (porId.get(c.id) || {}).canjes || 0, ahorro: Number((porId.get(c.id) || {}).ahorro || 0) })) });
    }
    if (capa !== "ciudades" && capa !== "plus") throw httpError(400, "Capa inválida (ciudades, plus, penas o comercios)");
    const filas = store.resumenPorCiudad ? await store.resumenPorCiudad(600) : [];
    res.json({ capa, items: filas.map((c) => ({ id: c.id, nombre: c.nombre, pais_iso: c.pais_iso, lat: Number(c.lat), lng: Number(c.lng), total: c.total, plus: c.plus, socios: c.socios })) });
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
  // ─── Compositor de campañas (correo / WhatsApp): a quién · por dónde · qué · vista previa · envío por tandas ───
  // Mandar de verdad lo hace el cron por tandas (lib/campanas.js procesarLote), nunca este request.
  const whatsappConectado = () => /^https:\/\//i.test(String(process.env.GHL_WHATSAPP_URL || "").trim());
  async function audienciaDe(body) {
    let filtros;
    if (body.segmento_id) {
      const seg = (await store.listSegmentos()).find((s) => s.id === body.segmento_id);
      if (!seg) throw httpError(404, "Segmento no encontrado");
      filtros = limpiarFiltros(seg.filtros);
    } else filtros = limpiarFiltros(body.filtros);
    if (!Object.keys(filtros).length && body.todos !== true) throw httpError(400, "Elegí a quién va: un segmento, un filtro o todos los hinchas.");
    return { filtros, socios: await store.filtrarSocios({ ...filtros, paraEnvio: true }) };
  }
  const camposDe = (body) => { const v = campanasLib.validarCampos(body); if (!v.ok) throw httpError(400, v.error); return v.campos; };
  const SOCIO_MUESTRA = { id: "muestra", nombre: "Marcos", tier_slug: "premium" };
  r.get("/admin/campanas/plantillas", requireAdmin, wrap(async (_req, res) => {
    res.json({ items: campanasLib.PLANTILLAS, activas: campanasLib.activas(), whatsapp_conectado: whatsappConectado(), limites: { asunto: campanasLib.MAX_ASUNTO, titulo: campanasLib.MAX_TITULO, cuerpo: campanasLib.MAX_CUERPO } });
  }));
  r.post("/admin/campanas/vista-previa", requireAdmin, wrap(async (req, res) => {
    const c = camposDe(req.body || {});
    const mail = campanasLib.renderEmail(c, SOCIO_MUESTRA);
    res.json({ asunto: mail.subject, html: mail.html, whatsapp: campanasLib.renderWhatsApp(c, SOCIO_MUESTRA) });
  }));
  r.post("/admin/campanas/audiencia", requireAdmin, wrap(async (req, res) => {
    const canal = (req.body && req.body.canal) === "whatsapp" ? "whatsapp" : "email";
    const { socios } = await audienciaDe(req.body || {});
    const { reciben, excluidos } = campanasLib.clasificarAudiencia(socios, canal);
    res.json({ canal, total: socios.length, reciben: reciben.length, excluidos, whatsapp_conectado: whatsappConectado() });
  }));
  const exigirActivas = () => { if (!campanasLib.activas()) throw httpError(403, "Las campañas todavía no están activas. Podés armarlas y ver la vista previa; se encienden cuando el club lo decida."); };
  r.post("/admin/campanas/prueba", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    exigirActivas();
    const b = req.body || {};
    if (b.canal === "whatsapp") throw httpError(400, "La prueba por WhatsApp se hace desde GoHighLevel. Probá el texto con la vista previa.");
    const a = String(b.a || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw httpError(400, "Poné un correo válido para la prueba.");
    const mail = campanasLib.renderEmail(camposDe(b), { ...SOCIO_MUESTRA, id: undefined });
    const out = await mailer.enviar({ to: a, subject: "[PRUEBA] " + mail.subject, html: mail.html });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "campana:prueba", detalle: a, por: req.adminUser });
    res.json({ ok: !!(out && out.ok), modo: out && out.modo });
  }));
  r.post("/admin/campanas/enviar", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    exigirActivas();
    const b = req.body || {};
    const canal = b.canal === "whatsapp" ? "whatsapp" : "email";
    if (canal === "whatsapp" && !whatsappConectado()) throw httpError(400, "WhatsApp no está conectado todavía (falta GHL_WHATSAPP_URL).");
    const c = camposDe(b);
    const nombre = String(b.nombre || "").trim().slice(0, 80) || (campanasLib.PLANTILLAS.find((p) => p.id === b.plantilla) || { nombre: "Campaña" }).nombre + " · " + new Date().toLocaleDateString("es-PY");
    const { filtros, socios } = await audienciaDe(b);
    const { reciben, excluidos } = campanasLib.clasificarAudiencia(socios, canal);
    if (!reciben.length) throw httpError(400, "Nadie recibiría esta campaña: todos están dados de baja o sin " + (canal === "whatsapp" ? "teléfono" : "correo") + ".");
    if (reciben.length > 50000) throw httpError(400, "La audiencia es muy grande (" + reciben.length + "). Dividila con un segmento.");
    // Seguro contra errores: tiene que coincidir con lo que la pantalla mostró (la audiencia pudo cambiar).
    if (Number(b.total_esperado) !== reciben.length) throw httpError(409, "La audiencia cambió: ahora son " + reciben.length + " destinatarios. Revisala y confirmá de nuevo.");
    // Contra el doble clic: la misma campaña, en curso, no se crea dos veces.
    const enCurso = await store.campanasEnCurso();
    if (enCurso.some((x) => x.asunto === c.asunto && x.canal === canal && x.total_enviados === reciben.length && Date.now() - new Date(x.creada).getTime() < 10 * 60000)) throw httpError(409, "Esa campaña ya se está enviando.");
    const camp = await store.crearCampanaEnvio({ nombre, canal, plantilla: String(b.plantilla || ""), ...c, filtros, por: req.adminUser });
    await store.agregarEnviosPendientes(camp.id, reciben);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "campana:enviar", targetId: camp.id, detalle: nombre + " · " + canal + " · " + reciben.length, por: req.adminUser });
    res.status(201).json({ ok: true, id: camp.id, total: reciben.length, excluidos });
  }));
  r.post("/admin/campanas/:id/cancelar", requireAdmin, requirePerm("campanas.write"), wrap(async (req, res) => {
    const c = await store.cancelarCampana(req.params.id);
    if (!c) throw httpError(409, "La campaña no existe o ya terminó.");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "campana:cancelar", targetId: c.id, por: req.adminUser });
    res.json({ ok: true });
  }));
  r.get("/admin/campanas/:id", requireAdmin, wrap(async (req, res) => {
    const d = await store.getCampanaDetalle(req.params.id);
    if (!d) throw httpError(404, "Campaña no encontrada");
    res.json(d);
  }));
  // Cloud Scheduler (cada minuto): manda la siguiente tanda de las campañas en curso.
  r.post("/cron/campanas", wrap(async (req, res) => {
    const tok = process.env.CRON_SECRET;
    if (!tok || !igualesSeguro(req.headers["x-cron-token"], tok)) return res.status(401).json({ error: "no autorizado" });
    res.json(await campanasLib.procesarLote({ store, log: (...a) => log.info({ detalle: a.map(String).join(" ") }, "campañas") }));
  }));
  // Confirmar un pago (tras verificarlo en la pasarela) → activa la membresía.
  r.post("/admin/pedidos/:id/activar", requireAdmin, requirePerm("pagos.write"), wrap(async (req, res) => {
    const pedido = await store.getPedidoPago(req.params.id);
    if (!pedido) throw httpError(404, "Pedido no encontrado");
    // Misma puerta que el webhook: entrega según el tipo de pedido (membresía, entrada o lote;
    // antes solo activaba membresías) y no entrega dos veces si el webhook ya lo hizo.
    const r0 = await acreditarPago(pedido.id, "admin");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "pedido:activar", targetId: pedido.id, detalle: r0.estado, por: req.adminUser });
    const membresia = (r0.out && r0.out.membresia) || (pedido.tier_slug ? await store.getMembresia(pedido.socio_id) : null);
    res.json({ ok: true, membresia, ya_procesado: r0.estado === "ya_procesado" });
  }));
  // Rechazar/cancelar un pedido.
  r.post("/admin/pedidos/:id/rechazar", requireAdmin, requirePerm("pagos.write"), wrap(async (req, res) => {
    const pedido = await store.getPedidoPago(req.params.id);
    if (!pedido) throw httpError(404, "Pedido no encontrado");
    if (pedido.estado !== "pendiente") throw httpError(409, "Solo se puede rechazar un pedido pendiente (este está " + pedido.estado + "): lo ya cobrado se revierte desde el reembolso, no desde acá.");
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
    darPuntos(req.socio.id, "mision", "encuesta:" + e.id, "Respondió una encuesta").catch(() => {}); // "misión semanal o encuesta"
    res.json({ ok: true, resultados: await store.resultadosEncuesta(e.id) });
  }));

  // ─── Subastas ─────────────────────────────────────────────────────────────
  // Puja Plus y Socio (nivel_min = "premium"). Gateo en el server. El líder actual
  // = subasta.ganador_id. Anti-sniping y guard de monto viven en store.pujar (atómico).
  // ── Decisiones de la Comisión Directiva (tabla decisiones_club; sin fila = valor por defecto) ──
  // La plataforma las lee en cada uso (caché de 30 s) — ver docs del handoff, 08-decisiones.
  const DECISIONES = {
    deuda: { def: "no_bloquear", opciones: ["no_bloquear", "mas_2_cuotas", "cualquier"], texto: "¿Con qué deuda se bloquea una puja?" },
    plazo: { def: "72_48", opciones: ["72_48", "48_24"], texto: "Plazo de pago de subastas (horas ronda 1 + ronda 2)" },
    base: { def: "por_nivel", opciones: ["por_nivel", "por_plan", "ambos"], texto: "¿Beneficios por nivel o por plan del club?" },
    pct: { def: "10", opciones: ["10", "15"], texto: "Fondo de las peñas (%)" },
    venc: { def: "12_meses", opciones: ["12_meses", "no_vencen"], texto: "Vencimiento de puntos" },
    oro: { def: "no_publicar", opciones: ["no_publicar", "habilita_futbol"], texto: "Experiencias Oro" },
  };
  let _decCache = null;
  async function decisiones() {
    if (_decCache && Date.now() - _decCache.t < 30000) return _decCache.v;
    const filas = store.listDecisiones ? await store.listDecisiones() : [];
    const v = {};
    for (const [k, d] of Object.entries(DECISIONES)) v[k] = d.def;
    for (const f of filas) if (DECISIONES[f.clave] && DECISIONES[f.clave].opciones.includes(f.valor)) v[f.clave] = f.valor;
    _decCache = { t: Date.now(), v };
    return v;
  }
  const decision = async (clave) => (await decisiones())[clave];
  // Horas de plazo de pago: ronda 1 (ganador) y ronda 2 (segundo postor).
  async function plazosHoras() { return (await decision("plazo")) === "48_24" ? { r1: 48, r2: 24 } : { r1: 72, r2: 48 }; }
  const BLOQUEO_SUBASTAS_DIAS = 90;
  const fechaCorta = (d) => new Date(d).toLocaleDateString("es-PY", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Asuncion" });

  // Regla de deuda para pujar (decisión `deuda`). Por defecto NO se bloquea a ningún socio.
  // Si el club decide bloquear, se consulta el estado EN VIVO a Tuti; si Tuti no responde se deja
  // pujar (nunca se castiga a un hincha por una caída del proveedor). Jamás se usa `DEBT` solo:
  // es "tiene un pago pendiente", no mora (ver lib/tuti.js).
  async function chequearDeudaPuja(socio) {
    const regla = await decision("deuda");
    if (regla === "no_bloquear") return;
    const cedula = soloDigitos(socio && socio.cedula);
    if (!cedula || !tutiApi.habilitado()) return;
    const r = await tutiApi.consultarSocio(cedula);
    if (!r.ok || !r.encontrado) return;
    const deuda = Number(r.socio.deuda) || 0;
    let bloquea = false;
    if (regla === "cualquier") bloquea = !!r.socio.deudor && deuda > 0;
    else if (regla === "mas_2_cuotas") {
      const cuota = Number(process.env.CUOTA_SOCIO_GS) || 0; // valor de una cuota del club
      if (cuota > 0) bloquea = deuda > 2 * cuota;
      else log.warn("decisión deuda=mas_2_cuotas pero falta CUOTA_SOCIO_GS: no se bloquea a nadie");
    }
    if (bloquea) throw httpError(403, "Tenés una deuda pendiente con el club. Regularizala para poder pujar.");
  }

  function subastaAbierta(s) { return s.estado === "activa" && new Date(s.termina).getTime() > Date.now(); }
  // Notifica a los ganadores de subastas recién cerradas (email + alerta al EQUIPO para
  // coordinar WhatsApp). Idempotente (flag `notificado`). La query que arma la lista es
  // liviana e indexada, y en el caso común vuelve vacía → segura de llamar seguido.
  async function notificarGanadoresPendientes() {
    try {
      const pend = store.subastasSinNotificar ? await store.subastasSinNotificar() : [];
      for (const s of pend) {
        let enviado = true;
        try {
          const ganador = await store.getSocioById(s.ganador_id);
          const urlSubasta = urlLote(s);
          if (ganador && mailer.enviarSubastaGanador) {
            const limitePago = s.pago_vence || null; // fijado al cerrar, según la decisión del club (72 h por defecto)
            const horas = limitePago ? Math.max(1, Math.round((new Date(limitePago).getTime() - Date.now()) / 3600000)) : undefined;
            const r0 = await mailer.enviarSubastaGanador(ganador, { titulo: s.titulo, monto: s.puja_actual, urlSubasta, limitePago, horas }).catch((e) => ({ ok: false, error: e && e.message }));
            enviado = !!(r0 && r0.ok !== false);
            if (!enviado) alertar("subasta:aviso:fallo:" + s.id, "No se pudo avisar al ganador de una subasta", `"${s.titulo}" → ${ganador.email}. Se reintenta en el próximo barrido; mientras tanto avisale a mano: el plazo de pago corre.`);
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
        } catch (e) { enviado = false; log.error({ err: e && e.message, subasta: s.id }, "aviso al ganador de subasta"); }
        // Solo se da por avisado si el correo salió: si falló, el próximo barrido lo reintenta (antes quedaba "notificado" sin enviar).
        if (enviado) await store.marcarSubastaNotificada(s.id);
      }
      return pend.length;
    } catch (e) { log.error({ err: e.message }, "subastas notificar"); return 0; }
  }
  // Abre programadas + cierra vencidas + notifica. Usado por el cron diario (backstop)
  // y al cerrar manualmente desde el admin.
  async function cerrarYnotificarSubastas() {
    try {
      if (store.abrirProgramadas) await store.abrirProgramadas();
      await cerrarVencidas();
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
      await cerrarVencidas();
      await notificarGanadoresPendientes();
    }
    catch (e) { log.error({ err: e.message }, "subastas barrido"); }
  }
  // Cierra las vencidas con el plazo de pago vigente (decisión `plazo`).
  async function cerrarVencidas() {
    if (!store.cerrarSubastasVencidas) return;
    await store.cerrarSubastasVencidas({ plazoHoras: (await plazosHoras()).r1 });
  }
  const gsTxt = (n) => "₲ " + Math.round(Number(n) || 0).toLocaleString("es-PY");
  const urlLote = (s) => baseUrl() + "/subasta/" + encodeURIComponent(s.slug || s.id);

  // Resuelve el vencimiento de UN lote (por plazo, o forzado desde el admin). Atómico en la base:
  // si dos instancias lo intentan a la vez, una sola lo resuelve y la otra recibe null.
  async function resolverVencimientoSubasta(id, { forzar = false, por = "sistema" } = {}) {
    const pl = await plazosHoras();
    const r = await store.vencerPlazoSubasta(id, { plazoRonda2Horas: pl.r2, bloqueoDias: BLOQUEO_SUBASTAS_DIAS, forzar });
    if (!r) return null;
    _subCache.delete(id); _listaSub = null;
    const s = r.subasta;
    const [anterior, segundo] = await Promise.all([
      store.getSocioById(r.anterior).catch(() => null),
      r.segundo ? store.getSocioById(r.segundo).catch(() => null) : null,
    ]);
    if (anterior && mailer.enviarSubastaCancelada)
      mailer.enviarSubastaCancelada(anterior, { titulo: s.titulo, bloqueadoHasta: r.bloqueadoHasta }).catch(() => {});
    if (segundo && mailer.enviarSubastaSegundaOportunidad)
      mailer.enviarSubastaSegundaOportunidad(segundo, { titulo: s.titulo, monto: r.monto, urlSubasta: urlLote(s), limitePago: s.pago_vence, horas: pl.r2 }).catch(() => {});
    const quien = (x) => (x ? (x.nombre || x.email) : "?");
    alertar("subasta:vencida:" + id + ":" + (r.accion === "ronda2" ? 1 : 2),
      r.accion === "ronda2" ? "Subasta: venció el plazo, pasa al segundo postor" : "Subasta: venció el plazo, el lote vuelve a borrador",
      `"${s.titulo}" · no pagó: ${quien(anterior)}${r.bloqueadoHasta ? " (suspendido hasta " + fechaCorta(r.bloqueadoHasta) + ")" : ""}` +
      (r.accion === "ronda2" ? ` · ahora: ${quien(segundo)} a ₲ ${Number(r.monto).toLocaleString("es-PY")}` : " · no había otro postor elegible"));
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:vencimiento", targetId: id, detalle: r.accion + (forzar ? " (forzado)" : ""), por });
    log.info({ subastaId: id, accion: r.accion, forzado: forzar }, "subasta: plazo de pago resuelto");
    return r;
  }

  // Tarea horaria (y respaldo del cron diario): vence los plazos y avisa 24 h antes. Idempotente:
  // el vencimiento es atómico y el recordatorio se reserva una vez por lote y ronda.
  async function procesarPlazosSubastas() {
    const out = { vencidos: 0, ronda2: 0, borrador: 0, recordatorios: 0 };
    if (!store.subastasPlazoVencido) return out;
    for (const s of await store.subastasPlazoVencido()) {
      try {
        const r = await resolverVencimientoSubasta(s.id);
        if (r) { out.vencidos++; out[r.accion === "ronda2" ? "ronda2" : "borrador"]++; }
      } catch (e) { log.error({ subastaId: s.id, err: e.message }, "subasta: no se pudo vencer el plazo"); }
    }
    const reservar = store.reservarNotificacion ? (k) => store.reservarNotificacion(k) : async () => true;
    for (const s of await store.subastasPagoPorVencer({ horas: 24 })) {
      try {
        if (!(await reservar("subasta:porvencer:" + s.id + ":" + (s.ronda || 1)))) continue;
        const socio = await store.getSocioById(s.adjudicado_a);
        pushLib.avisar(store, s.adjudicado_a, "pago", { titulo: "Se vence tu plazo para pagar", cuerpo: s.titulo + " · " + gsTxt(s.puja_actual), url: urlLote(s), tag: "pago-" + s.id }, { base: baseUrl() }).catch(() => {});
        if (socio && mailer.enviarSubastaPagoPorVencer) {
          await mailer.enviarSubastaPagoPorVencer(socio, { titulo: s.titulo, monto: s.puja_actual, urlSubasta: urlLote(s), vence: s.pago_vence }).catch(() => {});
          out.recordatorios++;
        }
      } catch (e) { log.error({ subastaId: s.id, err: e.message }, "subasta: recordatorio de pago"); }
    }
    return out;
  }

  // Cache corto (3s) del listado base (subastas visibles + pujadores). Absorbe el polling:
  // ~1 lectura cada 3s por instancia en vez de (lista + N counts) por cada mirador.
  let _listaSub = null;
  async function listaSubastasBase() {
    if (_listaSub && Date.now() - _listaSub.t < 3000) return _listaSub.v;
    const raw = (await store.listSubastasPublicas()).filter((s) => s.estado === "activa" || s.estado === "cerrada");
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
        id: s.id, slug: s.slug, titulo: s.titulo, descripcion: s.descripcion, imagen_url: urlImagen(s), emoji: s.emoji,
        nivel_min: s.nivel_min, precio_inicial: s.precio_inicial, incremento: s.incremento,
        puja_actual: s.puja_actual, termina: s.termina, estado: abierta ? "activa" : "cerrada",
        pago_estado: s.pago_estado || null,
        desbloqueado: access.puedeAcceder(membresia, s.nivel_min),
        pujadores,
        gano: !abierta && !!(req.socio && s.ganador_id === req.socio.id),
        // Solo el adjudicado ve su plazo de pago (y mientras no haya pagado).
        pago_vence: (!abierta && req.socio && s.ganador_id === req.socio.id && s.pago_estado !== "pagado") ? (s.pago_vence || null) : null,
        ronda: (!abierta && req.socio && s.ganador_id === req.socio.id) ? (s.ronda || 1) : undefined,
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
        imagen_url: liviano ? undefined : urlImagen(s),
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
      pago_vence: (!abierta && req.socio && s.ganador_id === req.socio.id && s.pago_estado !== "pagado") ? (s.pago_vence || null) : null,
      ronda: (!abierta && req.socio && s.ganador_id === req.socio.id) ? (s.ronda || 1) : undefined,
      feed,
    });
  }));
  r.post("/subastas/:id/pujar", auth.requireSocio, wrap(async (req, res) => {
    exigirCorreo(req, "pujar");
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, s.nivel_min))
      throw httpError(403, "Las subastas son para Olimpistas Plus y Socio");
    if (req.socio.subastas_bloqueo_hasta && new Date(req.socio.subastas_bloqueo_hasta).getTime() > Date.now())
      throw httpError(403, "Estás suspendido de las subastas hasta el " + fechaCorta(req.socio.subastas_bloqueo_hasta) + " por no haber pagado un lote a tiempo.");
    await chequearDeudaPuja(req.socio);
    const monto = Math.round(Number(req.body && req.body.monto) || 0);
    if (!monto) throw httpError(400, "Monto inválido");
    // Tope: una puja absurda (p. ej. 2.147.483.647) no la supera nadie, desborda el integer de la base y traba el lote.
    const TOPE_PUJA = Math.min(Number(process.env.PUJA_MAX) || 200000000, 2000000000);
    if (monto < 0 || monto > TOPE_PUJA) throw httpError(400, "Monto fuera de rango: la puja máxima es ₲ " + TOPE_PUJA.toLocaleString("es-PY"));
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
    evento(req.socio.id, "primera_puja");
    // Avisar por email al líder anterior que lo superaron (best-effort, no rompe la puja).
    if (out.prevGanador) {
      pushLib.avisar(store, out.prevGanador, "subasta", { titulo: "Te superaron en " + s.titulo, cuerpo: "Ahora van " + gsTxt(out.subasta.puja_actual) + ". Entrá y subí tu puja.", url: "/subasta/" + encodeURIComponent(s.slug || s.id), tag: "sub-" + s.id }, { base: baseUrl() }).catch(() => {});
      store.getSocioById(out.prevGanador).then((prev) => {
        if (prev && mailer.enviarSubastaSuperado) mailer.enviarSubastaSuperado(prev, { titulo: s.titulo, monto: out.subasta.puja_actual, minimo: out.subasta.puja_actual + out.subasta.incremento, cierre: out.subasta.termina }).catch(() => {});
      }).catch(() => {});
    }
    res.json({ ok: true, puja_actual: out.subasta.puja_actual, termina: out.subasta.termina, extendida: out.extendida });
  }));

  // El ganador paga ONLINE (Pagopar) para confirmar el lote — la entrega recién se
  // coordina por privado (WhatsApp) después de acreditado el pago (ver cumplirPedidoPagado).
  // Mismo manejo de cédula que /membresia/unirse: Pagopar la exige, se pide una sola vez.
  // Arma (o reutiliza) el pedido del lote ganado y pide el link de pago. { falta_cedula } si todavía no hay documento.
  async function iniciarPagoSubasta(socio, s, cedulaIngresada) {
    const sFull = await store.getSocioById(socio.id).catch(() => null);
    let documento = soloDigitos((sFull && sFull.cedula) || "");
    const cedulaBody = soloDigitos(cedulaIngresada || "");
    if (!documento && cedulaBody) {
      if (cedulaBody.length < 5 || cedulaBody.length > 12) throw httpError(400, "Número de cédula inválido");
      if (store.getSocioByCedula) {
        const otra = await store.getSocioByCedula(cedulaBody);
        if (otra && otra.id !== socio.id) throw httpError(409, "Esa cédula ya está registrada en otra cuenta");
      }
      try { await store.updateSocio(socio.id, { cedula: cedulaBody }); documento = cedulaBody; unirPenaPorCedula(socio.id); }
      catch (e) { throw httpError(409, "Esa cédula ya está registrada en otra cuenta"); }
    }
    if (!documento) return { falta_cedula: true };

    // Reusar el pedido pendiente si el ganador ya había iniciado el pago antes (evita
    // duplicar pedidos en PAGOPAR si reintenta o vuelve a entrar a la página).
    const existente = store.getPedidoPorSubasta ? await store.getPedidoPorSubasta(s.id) : null;
    const pedido = (existente && existente.estado === "pendiente" && existente.socio_id === socio.id)
      ? existente
      : await store.createPedidoPago({ socioId: socio.id, concepto: `Subasta: ${s.titulo}`, monto: s.puja_actual, moneda: BRAND.monedaCod, subastaId: s.id });

    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto: s.puja_actual, concepto: pedido.concepto,
      comprador: {
        email: socio.email,
        nombre: [socio.nombre, sFull && sFull.apellido].filter(Boolean).join(" ") || socio.nombre,
        documento, telefono: (sFull && (sFull.whatsapp || sFull.telefono)) || "",
      },
    });
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    return { pago };
  }
  r.post("/subastas/:id/pagar", auth.requireSocio, wrap(async (req, res) => {
    exigirCorreo(req, "pagar un lote");
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado !== "cerrada" || (s.adjudicado_a || s.ganador_id) !== req.socio.id) throw httpError(403, "Este lote no está adjudicado a vos");
    if (s.pago_estado === "pagado") return res.json({ ya_pagado: true });
    // Sin pago_vence = lote anterior a esta función: sin plazo (se resuelve a mano desde el admin).
    if (s.pago_vence && new Date(s.pago_vence).getTime() < Date.now()) throw httpError(409, "El plazo de pago de este lote venció.");

    res.json(await iniciarPagoSubasta(req.socio, s, req.body && req.body.cedula));
  }));

  // ── Admin de subastas: poner en vivo / cerrar / ver pujas (además del CRUD) ──
  r.post("/admin/subastas/:id/publicar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (!s.titulo || !(s.precio_inicial > 0)) throw httpError(400, "Faltan datos: título y precio inicial");
    if (s.estado === "cerrada" || s.estado === "activa") throw httpError(409, "Este lote está " + (s.estado === "activa" ? "en vivo" : "cerrado") + ": publicarlo de nuevo borraría el ganador y el estado de pago.");
    const horas = Number(s.duracion_horas) || Number(req.body && req.body.horas) || 48;
    const inicia = new Date().toISOString();
    const termina = new Date(Date.now() + horas * 3600 * 1000).toISOString();
    const item = await store.updateSubasta(s.id, { estado: "activa", inicia, termina, ganador_id: null, adjudicado_a: null, ronda: 1, pago_vence: null, pago_estado: null, puja_actual: s.precio_inicial, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:publicar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/despublicar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado === "cerrada") throw httpError(409, "La subasta ya cerró; no se puede volver a borrador");
    const item = await store.updateSubasta(s.id, { estado: "borrador", ganador_id: null, adjudicado_a: null, ronda: 1, pago_vence: null, termina: null, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:despublicar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  // Pausar/reanudar: frena la puja y la esconde del home + hub SIN cerrarla (no se
  // elige ganador ni se avisa a nadie) — válvula de seguridad durante una subasta en
  // vivo. Al reanudar, el reloj se corre exactamente lo que estuvo en pausa.
  r.post("/admin/subastas/:id/pausar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (s.estado !== "activa") throw httpError(409, "Solo se puede pausar una subasta en vivo");
    const item = await store.updateSubasta(s.id, { estado: "pausada", pausada_en: new Date().toISOString() });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:pausar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/reanudar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
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
  r.post("/admin/subastas/:id/programar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    if (!s.titulo || !(s.precio_inicial > 0)) throw httpError(400, "Faltan datos: título y precio inicial");
    const t = new Date((req.body && req.body.inicia) || "");
    if (isNaN(t.getTime()) || t.getTime() <= Date.now()) throw httpError(400, "La fecha de inicio debe ser válida y futura");
    const item = await store.updateSubasta(s.id, { estado: "programada", inicia: t.toISOString(), termina: null, ganador_id: null, adjudicado_a: null, ronda: 1, pago_vence: null, pago_estado: null, notificado: false });
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:programar", targetId: s.id, detalle: t.toISOString(), por: req.adminUser });
    res.json({ ok: true, item });
  }));
  r.post("/admin/subastas/:id/cerrar", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const item = (await store.cerrarSubasta(s.id, { plazoHoras: (await plazosHoras()).r1 })) || s;
    _subCache.delete(s.id); _listaSub = null;
    await cerrarYnotificarSubastas(); // avisa al ganador al toque
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:cerrar", targetId: s.id, por: req.adminUser });
    res.json({ ok: true, item });
  }));
  // Extender el plazo de pago (horas, 1 a 168). Si ya había vencido o el lote no tenía plazo, cuenta desde ahora.
  r.post("/admin/subastas/:id/extender", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const horas = Math.round(Number(req.body && req.body.horas) || 24);
    if (!(horas >= 1 && horas <= 168)) throw httpError(400, "Las horas deben estar entre 1 y 168");
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const item = await store.extenderPlazoSubasta(s.id, horas);
    if (!item) throw httpError(409, "Solo se extiende el plazo de un lote cerrado, adjudicado y sin pagar");
    _subCache.delete(s.id); _listaSub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "subastas:extender", targetId: s.id, detalle: "+" + horas + " h", por: req.adminUser });
    res.json({ ok: true, item: { id: item.id, pago_vence: item.pago_vence, ronda: item.ronda } });
  }));
  // Pasar al segundo postor ahora (sin esperar el vencimiento). Suspende al primero igual que un vencimiento.
  r.post("/admin/subastas/:id/segundo", requireAdmin, requirePerm("subastas.write"), wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    const r0 = await resolverVencimientoSubasta(s.id, { forzar: true, por: req.adminUser });
    if (!r0) throw httpError(409, "Solo se pasa al segundo un lote cerrado, adjudicado, sin pagar y en la primera ronda");
    res.json({ ok: true, accion: r0.accion, segundo: r0.segundo || null, monto: r0.monto || null });
  }));
  // Decisiones de la Comisión Directiva. Leer: cualquier admin. Registrar: solo quien tenga decisiones.write (owner).
  r.get("/admin/decisiones", requireAdmin, wrap(async (_req, res) => {
    const vig = await decisiones();
    const filas = store.listDecisiones ? await store.listDecisiones() : [];
    res.json({ items: Object.entries(DECISIONES).map(([clave, d]) => {
      const f = filas.find((x) => x.clave === clave);
      return { clave, pregunta: d.texto, opciones: d.opciones, defecto: d.def, valor: vig[clave], decidido: !!f, decidido_por: f ? f.decidido_por : null, decidido_en: f ? f.decidido_en : null };
    }) });
  }));
  r.put("/admin/decisiones/:clave", requireAdmin, requirePerm("decisiones.write"), wrap(async (req, res) => {
    const d = DECISIONES[req.params.clave];
    if (!d) throw httpError(404, "Decisión desconocida");
    const valor = String(req.body && req.body.valor);
    if (!d.opciones.includes(valor)) throw httpError(400, "Valor inválido. Opciones: " + d.opciones.join(", "));
    const out = await store.setDecision(req.params.clave, valor, req.adminUser || "admin");
    _decCache = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "decisiones:registrar", targetId: req.params.clave, detalle: valor, por: req.adminUser });
    res.json({ ok: true, clave: req.params.clave, valor: out.valor });
  }));
  r.get("/admin/subastas/:id/pujas", requireAdmin, wrap(async (req, res) => {
    const s = await store.getSubasta(req.params.id);
    if (!s) throw httpError(404, "Subasta no encontrada");
    let ganador = null;
    if (s.ganador_id) { const g = await store.getSocioById(s.ganador_id); if (g) ganador = { nombre: g.nombre, email: g.email, whatsapp: g.whatsapp || g.telefono || "" }; }
    res.json({
      subasta: { titulo: s.titulo, estado: s.estado, puja_actual: s.puja_actual, termina: s.termina, pago_vence: s.pago_vence || null, ronda: s.ronda || 1, pago_estado: s.pago_estado || null },
      pujadores: await store.contarPujadores(s.id), ganador, pujas: await store.pujasDeSubasta(s.id, 50),
    });
  }));

  // ─── Motor de puntos: reglas, escalones, misión semanal y catálogo de canje ──────
  let _reglasCache = null;
  async function reglasPuntos() {
    if (_reglasCache && Date.now() - _reglasCache.t < 30000) return _reglasCache.v;
    const filas = store.listReglas ? await store.listReglas() : [];
    const v = {};
    for (const f of filas) v[f.clave] = { puntos: f.puntos, activa: f.activa };
    _reglasCache = { t: Date.now(), v };
    return v;
  }
  // Suma los puntos de una regla UNA vez por hecho (socio + regla + ref): un evento repetido no suma dos veces.
  // Una falla acá nunca rompe la acción que la disparó (alta, perfil, encuesta…).
  async function darPuntos(socioId, clave, refId, detalle) {
    try {
      if (!store.sumarPuntos) return null;
      const regla = (await reglasPuntos())[clave];
      if (!regla || !regla.activa || !(regla.puntos > 0)) return null;
      return await store.sumarPuntos({ socioId, motivo: clave, refId, puntos: regla.puntos, detalle });
    } catch (e) { log.error({ socioId, clave, err: e.message }, "puntos: no se pudo sumar"); return null; }
  }
  const oroHabilitado = async () => (await decision("oro")) === "habilita_futbol";
  // Todo socio con sesión es al menos Olimpista: una cuenta sin fila de membresía (importada, por ejemplo) no es "público".
  const membresiaDe = async (socioId) => (await store.getMembresia(socioId)) || { tier_slug: "olimpista" };

  async function misionParaSocio(socioId) {
    const m = store.getMisionDeSemana ? await store.getMisionDeSemana(semanaIso()) : null;
    if (!m) return null;
    const resp = await store.respuestaMision(m.id, socioId);
    const regla = (await reglasPuntos()).mision || {};
    // Nunca se manda cuál es la correcta: solo si ya respondió y si acertó.
    return { id: m.id, semana: m.semana, pregunta: m.pregunta, opciones: m.opciones, puntos: regla.activa ? regla.puntos : 0, respondida: resp ? { opcion: resp.opcion, correcta: resp.correcta } : null };
  }

  r.get("/puntos", auth.requireSocio, wrap(async (req, res) => {
    const id = req.socio.id;
    const [saldo, movimientos, reglas, membresia, mision, venc] = await Promise.all([
      store.saldoPuntos(id), store.movimientosPuntos(id, 20), reglasPuntos(), store.getMembresia(id), misionParaSocio(id), decision("venc"),
    ]);
    const esSocio = !!req.socio.es_socio_olimpia || (membresia && membresia.tier_slug === "socio");
    res.json({
      saldo, escalon: escalonDe(saldo), movimientos, mision, vencen: venc === "12_meses",
      reglas: Object.entries(REGLAS_META).map(([clave, m]) => ({
        clave, titulo: m.t, fuente: m.fuente, quien: m.quien, pendiente: !!m.pendiente,
        puntos: (reglas[clave] || {}).puntos || 0, activa: !!(reglas[clave] || {}).activa,
        aplica: m.quien === "todos" || (m.quien === "socios" && esSocio),
      })),
    });
  }));
  r.get("/puntos/premios", auth.requireSocio, wrap(async (req, res) => {
    const [saldo, membresia, premios, oro] = await Promise.all([store.saldoPuntos(req.socio.id), membresiaDe(req.socio.id), store.listPremios(), oroHabilitado()]);
    res.json({
      saldo,
      items: premios.filter((p) => access.puedeAcceder(membresia, p.nivel_min)).map((p) => {
        const proximamente = p.escalon === "oro" && !oro, agotado = p.stock !== null && p.stock <= 0;
        return { id: p.id, titulo: p.titulo, descripcion: p.descripcion, escalon: p.escalon, costo: p.costo, agotado, proximamente,
          puede_canjear: !proximamente && !agotado && saldo >= p.costo, faltan: Math.max(0, p.costo - saldo) };
      }),
    });
  }));
  r.post("/puntos/premios/:id/canjear", auth.requireSocio, wrap(async (req, res) => {
    const p = await store.getPremio(req.params.id);
    if (!p || !p.activo) throw httpError(404, "Premio no encontrado");
    const membresia = await membresiaDe(req.socio.id);
    if (!access.puedeAcceder(membresia, p.nivel_min)) throw httpError(403, "Este premio es para otro nivel");
    if (p.escalon === "oro" && !(await oroHabilitado())) throw httpError(409, "Las experiencias Oro llegan pronto");
    const out = await store.canjearPremio({ socioId: req.socio.id, premioId: p.id });
    if (!out.ok) {
      if (out.motivo === "saldo") throw httpError(409, "Te faltan " + Number(out.costo - out.saldo).toLocaleString("es-PY") + " puntos");
      if (out.motivo === "stock") throw httpError(409, "Este premio se agotó");
      throw httpError(404, "Premio no encontrado");
    }
    alertar("puntos:canje:" + out.canje.id, "Canje de premio por entregar", `${p.titulo} · ${req.socio.nombre || req.socio.email} · ${p.costo} puntos`);
    res.status(201).json({ ok: true, saldo: out.saldo, canje: { id: out.canje.id, estado: out.canje.estado } });
  }));
  // Misión de la semana: UNA respuesta por hincha (con tres opciones, dejar reintentar equivale a regalar los puntos).
  r.post("/puntos/mision/:id", auth.requireSocio, wrap(async (req, res) => {
    const m = await store.getMision(req.params.id);
    if (!m || !m.activa) throw httpError(404, "Misión no encontrada");
    if (m.semana !== semanaIso()) throw httpError(409, "Esa misión ya no está disponible");
    const opcion = Number(req.body && req.body.opcion);
    if (!Number.isInteger(opcion) || opcion < 0 || opcion >= m.opciones.length) throw httpError(400, "Opción inválida");
    const correcta = opcion === m.correcta;
    const reg = await store.responderMision({ misionId: m.id, socioId: req.socio.id, opcion, correcta });
    if (!reg) throw httpError(409, "Ya respondiste la misión de esta semana");
    let puntos = 0;
    if (correcta) { const mov = await darPuntos(req.socio.id, "mision", m.semana, "Misión de la semana"); puntos = mov ? mov.puntos : 0; }
    res.json({ ok: true, correcta, puntos, saldo: await store.saldoPuntos(req.socio.id) });
  }));

  // ── Admin de puntos ──
  r.get("/admin/puntos/reglas", requireAdmin, wrap(async (_req, res) => {
    const reglas = await reglasPuntos();
    res.json({ items: Object.entries(REGLAS_META).map(([clave, m]) => ({ clave, titulo: m.t, fuente: m.fuente, quien: m.quien, pendiente: !!m.pendiente, puntos: (reglas[clave] || {}).puntos || 0, activa: !!(reglas[clave] || {}).activa })) });
  }));
  r.put("/admin/puntos/reglas", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    const b = req.body || {};
    if (!REGLAS_META[b.clave]) throw httpError(404, "Regla desconocida");
    const patch = {};
    if (b.puntos !== undefined) { const n = Math.round(Number(b.puntos)); if (!(n >= 0 && n <= 100000)) throw httpError(400, "Los puntos van de 0 a 100.000"); patch.puntos = n; }
    if (typeof b.activa === "boolean") patch.activa = b.activa;
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const out = await store.setRegla(b.clave, patch);
    if (!out) throw httpError(404, "Regla desconocida");
    _reglasCache = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "puntos:regla", targetId: b.clave, detalle: JSON.stringify(patch), por: req.adminUser });
    res.json({ ok: true, regla: out });
  }));
  r.get("/admin/puntos/resumen", requireAdmin, wrap(async (_req, res) => { res.json(await store.resumenPuntos()); }));
  r.get("/admin/puntos/premios", requireAdmin, wrap(async (_req, res) => { res.json({ items: await store.listPremios({ soloActivos: false }) }); }));
  const limpiarPremio = (b, parcial) => {
    const p = {};
    const txt = (k, max) => { if (b[k] !== undefined) p[k] = String(b[k]).replace(/[<>]/g, "").trim().slice(0, max); };
    txt("titulo", 120); txt("descripcion", 400);
    if (b.escalon !== undefined) { if (!["bronce", "plata", "oro"].includes(b.escalon)) throw httpError(400, "Escalón inválido (bronce, plata u oro)"); p.escalon = b.escalon; }
    if (b.nivel_min !== undefined) { if (!tierBySlug(b.nivel_min)) throw httpError(400, "Nivel mínimo inválido"); p.nivel_min = b.nivel_min; }
    if (b.costo !== undefined) { const n = Math.round(Number(b.costo)); if (!(n >= 1 && n <= 1000000)) throw httpError(400, "El costo va de 1 a 1.000.000 de puntos"); p.costo = n; }
    if (b.stock !== undefined) { if (b.stock === null || b.stock === "") p.stock = null; else { const n = Math.round(Number(b.stock)); if (!(n >= 0 && n <= 100000)) throw httpError(400, "Stock inválido"); p.stock = n; } }
    if (typeof b.activo === "boolean") p.activo = b.activo;
    if (!parcial && (!p.titulo || p.titulo.length < 3)) throw httpError(400, "Poné un título");
    if (!parcial && p.costo === undefined) throw httpError(400, "Poné el costo en puntos");
    return p;
  };
  r.post("/admin/puntos/premios", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    const p = await store.crearPremio(limpiarPremio(req.body || {}, false));
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "puntos:premio-crear", targetId: p.id, detalle: p.titulo, por: req.adminUser });
    res.status(201).json({ ok: true, premio: p });
  }));
  r.patch("/admin/puntos/premios/:id", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    const patch = limpiarPremio(req.body || {}, true);
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const p = await store.updatePremio(req.params.id, patch);
    if (!p) throw httpError(404, "Premio no encontrado");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "puntos:premio-editar", targetId: p.id, detalle: JSON.stringify(patch), por: req.adminUser });
    res.json({ ok: true, premio: p });
  }));
  r.get("/admin/puntos/canjes", requireAdmin, wrap(async (req, res) => {
    res.json({ items: await store.listCanjesPremio({ estado: req.query.estado || undefined }) });
  }));
  // Entregar (avisa al hincha) o cancelar (devuelve los puntos y el stock) un canje pendiente.
  r.patch("/admin/puntos/canjes/:id", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    const estado = String(req.body && req.body.estado);
    if (!["entregado", "cancelado"].includes(estado)) throw httpError(400, "Estado inválido (entregado | cancelado)");
    const out = await store.resolverCanjePremio(req.params.id, { estado });
    if (!out.ok) throw httpError(out.motivo === "no_existe" ? 404 : 409, out.motivo === "no_existe" ? "Canje no encontrado" : "Ese canje ya se resolvió (" + out.estado + ")");
    if (estado === "entregado" && mailer.enviarPremioListo) {
      const socio = await store.getSocioById(out.canje.socio_id).catch(() => null);
      if (socio && socio.email) mailer.enviarPremioListo(socio, { premio: out.premio && out.premio.titulo }).catch(() => {});
    }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "puntos:canje-" + estado, targetId: req.params.id, detalle: out.premio && out.premio.titulo, por: req.adminUser });
    res.json({ ok: true, estado: out.canje.estado });
  }));
  r.get("/admin/puntos/misiones", requireAdmin, wrap(async (_req, res) => { res.json({ items: await store.listMisiones(30), semana_actual: semanaIso() }); }));
  r.post("/admin/puntos/misiones", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    const b = req.body || {};
    const semana = String(b.semana || ""), pregunta = String(b.pregunta || "").replace(/[<>]/g, "").trim();
    const opciones = Array.isArray(b.opciones) ? b.opciones.map((o) => String(o).replace(/[<>]/g, "").trim().slice(0, 60)).filter(Boolean) : [];
    const correcta = Number(b.correcta);
    if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(semana)) throw httpError(400, "La semana va como 2026-W43");
    if (pregunta.length < 5 || pregunta.length > 200) throw httpError(400, "La pregunta va de 5 a 200 caracteres");
    if (opciones.length < 2 || opciones.length > 4) throw httpError(400, "Poné entre 2 y 4 opciones");
    if (!Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) throw httpError(400, "Indicá cuál opción es la correcta");
    let m;
    try { m = await store.crearMision({ semana, pregunta, opciones, correcta }); }
    catch (e) { if (e.code === "23505") throw httpError(409, "Ya hay una misión para esa semana"); throw e; }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "puntos:mision-crear", targetId: m.id, detalle: semana, por: req.adminUser });
    res.status(201).json({ ok: true, mision: m });
  }));
  r.patch("/admin/puntos/misiones/:id", requireAdmin, requirePerm("puntos.write"), wrap(async (req, res) => {
    if (typeof (req.body && req.body.activa) !== "boolean") throw httpError(400, "Indicá activa: true o false");
    const m = await store.updateMision(req.params.id, { activa: req.body.activa });
    if (!m) throw httpError(404, "Misión no encontrada");
    res.json({ ok: true, mision: m });
  }));

  // ── Tareas del cron diario: cuota y débito (Portal de Socios) y vencimiento por inactividad ──
  // La cuota al día suma con status ACTIVE o LIFETIME (nunca DEBT: es un pago pendiente). La API de socios tiene
  // límite de velocidad, así que se revisan lotes durante los primeros 5 días del mes; cada socio queda marcado
  // (un movimiento de 0 puntos) para no volver a consultarlo ese mes.
  async function procesarCuotasMes() {
    const out = { revisados: 0, cuota: 0, debito: 0, pausado: null };
    if (!tutiApi.habilitado() || !store.sociosParaCuota || diaDelMesPy() > (Number(process.env.PUNTOS_CUOTA_DIAS) || 5)) return out; // PUNTOS_CUOTA_DIAS: hasta qué día del mes se revisan cuotas (5 por defecto)
    const mes = mesPy(), reglas = await reglasPuntos(), rc = reglas.cuota || {};
    const t0 = Date.now();
    for (const c of await store.sociosParaCuota({ mes, limit: 120 })) {
      if (Date.now() - t0 > 90000) { out.pausado = "tiempo"; break; }
      const v = await tutiApi.consultarSocio(c.cedula);
      if (!v.ok) { if (v.motivo === "limite" || v.motivo === "credenciales") { out.pausado = v.motivo; break; } continue; } // error puntual: mañana se reintenta
      out.revisados++;
      const s = v.encontrado ? v.socio : null;
      if (s && ["ACTIVE", "LIFETIME"].includes(s.status) && rc.activa && rc.puntos > 0) {
        await store.sumarPuntos({ socioId: c.id, motivo: "cuota", refId: mes, puntos: rc.puntos, detalle: "Cuota al día · " + mes });
        out.cuota++;
      } else {
        await store.sumarPuntos({ socioId: c.id, motivo: "cuota", refId: mes, puntos: 0, detalle: s ? "Cuota sin confirmar al día (" + s.status + ")" : "No figura como titular" });
      }
      if (s && s.debitoAutomatico && (await darPuntos(c.id, "debito", "debito", "Débito automático activado"))) out.debito++;
    }
    return out;
  }
  async function procesarVencimientoPuntos() {
    const out = { vencidos: 0, puntos: 0, avisos: 0 };
    if ((await decision("venc")) !== "12_meses" || !store.puntosInactivos) return out;
    const haceMeses = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
    const dia = (f) => new Date(f).toISOString().slice(0, 10);
    for (const s of await store.puntosInactivos({ desde: "1970-01-01T00:00:00Z", hasta: haceMeses(12) })) {
      const m = await store.vencerPuntosSocio(s.id, "inact:" + dia(s.ultima_actividad));
      if (m) { out.vencidos++; out.puntos += -m.puntos; }
    }
    const reservar = store.reservarNotificacion ? (k) => store.reservarNotificacion(k) : async () => true;
    for (const s of await store.puntosInactivos({ desde: haceMeses(12), hasta: haceMeses(11) })) {
      if (!(await reservar("puntos:aviso:" + s.id + ":" + dia(s.ultima_actividad)))) continue;
      const vence = new Date(s.ultima_actividad); vence.setUTCMonth(vence.getUTCMonth() + 12);
      if (mailer.enviarPuntosPorVencer) { await mailer.enviarPuntosPorVencer(s, { saldo: s.saldo, vence }).catch(() => {}); out.avisos++; }
    }
    return out;
  }
  async function procesarPuntosDiario() {
    const out = {};
    try { out.cuotas = await procesarCuotasMes(); } catch (e) { log.error({ err: e.message }, "puntos: cuotas del mes"); }
    try { out.vencimiento = await procesarVencimientoPuntos(); } catch (e) { log.error({ err: e.message }, "puntos: vencimiento"); }
    return out;
  }

  // ─── Peñas oficiales: link de captación, panel de la comisión y fondo ───────────
  const emailOk = (e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const limpioTxt = (s, max) => (typeof s === "string" ? s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const linkPena = (p) => baseUrl() + "/?pena=" + encodeURIComponent(p.slug);
  // Privacidad: la comisión ve el nombre y la inicial del apellido de quien se sumó, nunca email, cédula ni teléfono.
  const nombreCorto = (s) => [s.nombre, s.apellido ? s.apellido[0].toUpperCase() + "." : ""].filter(Boolean).join(" ") || "Hincha";

  // Ranking público de peñas verificadas por altas (caché de 30 s: la home lo pide seguido).
  let _penasPub = null;
  async function penasVerificadas() {
    if (_penasPub && Date.now() - _penasPub.t < 30000) return _penasPub.v;
    const filas = store.listPenas ? await store.listPenas({ estado: "verificada" }) : [];
    const v = filas.map((p, i) => ({ id: p.id, slug: p.slug, nombre: p.nombre, ciudad: p.ciudad, pais_iso: p.pais_iso, lat: p.lat != null ? Number(p.lat) : null, lng: p.lng != null ? Number(p.lng) : null, altas: p.altas, miembros: p.miembros || 0, hinchada: p.hinchada != null ? p.hinchada : p.altas, socios: p.socios, plus: p.plus, ranking: i + 1 }));
    _penasPub = { t: Date.now(), v };
    return v;
  }
  r.get("/penas", wrap(async (req, res) => {
    const mia = req.socio && req.socio.pena_id;
    // ?cerca=lat,lng → las peñas con ubicación, de la más cercana a la más lejana (con la distancia en km). "Encontrá tu peña".
    const cerca = String(req.query.cerca || "").split(",").map(Number);
    const conUbic = cerca.length === 2 && cerca.every(Number.isFinite) && Math.abs(cerca[0]) <= 90 && Math.abs(cerca[1]) <= 180;
    let items = (await penasVerificadas()).map((p) => ({ id: p.id, slug: p.slug, nombre: p.nombre, ciudad: p.ciudad, pais_iso: p.pais_iso, lat: p.lat, lng: p.lng, altas: p.altas, miembros: p.miembros, hinchada: p.hinchada, ranking: p.ranking, es_tuya: p.id === mia }));
    if (conUbic) {
      items = items.filter((p) => p.lat != null && p.lng != null).map((p) => ({ ...p, distancia_km: Math.round(ciudadesLib.distanciaKm(cerca[0], cerca[1], p.lat, p.lng) * 10) / 10 })).sort((a, b) => a.distancia_km - b.distancia_km).slice(0, 5);
    }
    res.json({ items, mia: mia || null });
  }));
  r.get("/penas/:slug", wrap(async (req, res) => {
    const p = (await penasVerificadas()).find((x) => x.slug === String(req.params.slug).toLowerCase());
    if (!p) throw httpError(404, "Peña no encontrada");
    res.json({ id: p.id, slug: p.slug, nombre: p.nombre, ciudad: p.ciudad, pais_iso: p.pais_iso, altas: p.altas, ranking: p.ranking, link: linkPena(p), es_tuya: !!(req.socio && req.socio.pena_id === p.id) });
  }));
  // Pedir que el club verifique una peña nueva. Queda PENDIENTE: no aparece en el ranking ni recibe aportes hasta que el club la verifique.
  r.post("/penas/solicitud", wrap(async (req, res) => {
    const b = req.body || {};
    const nombre = limpioTxt(b.nombre, 80), ciudad = limpioTxt(b.ciudad, 60), presidente = limpioTxt(b.presidente, 80), contacto = limpioTxt(b.contacto, 120).toLowerCase();
    const iso = String(b.pais_iso || "PY").toUpperCase();
    if (nombre.length < 3) throw httpError(400, "Poné el nombre de la peña");
    if (ciudad.length < 2) throw httpError(400, "Poné la ciudad");
    if (presidente.length < 3) throw httpError(400, "Poné el nombre de quien preside");
    if (!emailOk(contacto)) throw httpError(400, "Poné un email de contacto válido: ahí te mandamos el acceso al panel");
    if (!PAISES[iso]) throw httpError(400, "País inválido");
    const pendientes = await store.listPenas({ estado: "pendiente" });
    if (pendientes.some((p) => String(p.contacto).toLowerCase() === contacto)) throw httpError(409, "Ya recibimos una solicitud con ese email. Te vamos a escribir.");
    let p = await store.crearPena({ nombre, ciudad, pais_iso: iso, presidente, contacto });
    // Ubicación de la peña = su ciudad (GeoNames): así aparece en "la peña más cercana" apenas se verifica.
    try { const c = store.ciudadPorNombre ? await store.ciudadPorNombre({ nombre: ciudad, pais: iso }) : null; if (c) p = (await store.updatePena(p.id, { lat: c.lat, lng: c.lng })) || p; } catch (e) { /* sin ubicación: se carga después */ }
    alertar("pena:solicitud:" + p.id, "Peña nueva para verificar", `${nombre} · ${ciudad} · preside ${presidente} · ${contacto}`);
    if (mailer.enviarPenaSolicitudRecibida) mailer.enviarPenaSolicitudRecibida({ email: contacto }, { pena: p }).catch(() => {});
    res.status(201).json({ ok: true, id: p.id });
  }));

  // ── Panel de la comisión (usuario de peña, sesión de 12 h, header x-pena-token) ──
  async function requirePena(req, res, next) {
    try {
      const tok = req.headers["x-pena-token"] || "";
      const s = await store.getPenaSesion(tok);
      if (!s) return res.status(401).json({ error: "Sesión de peña inválida" });
      req.soloLectura = esSesionVerComo(tok);
      if (s.estado !== "verificada" && !req.soloLectura) return res.status(403).json({ error: "Tu peña está en pausa. Escribinos al club." });
      req.pena = { id: s.pena_id, nombre: s.nombre, slug: s.slug };
      next();
    } catch (e) { res.status(401).json({ error: "no autorizado" }); }
  }
  // "Ver como" (solo owner): el login de la peña y del comercio acepta las credenciales de un owner del panel y le deja
  // elegir a quién mirar. La sesión resultante es de SOLO LECTURA (token con prefijo VER_COMO) y cada ingreso queda en la auditoría.
  const VER_COMO = "adm_";
  const esSesionVerComo = (tok) => String(tok || "").startsWith(VER_COMO);
  const noLectura = (req, res, next) => (req.soloLectura ? res.status(403).json({ error: "Modo lectura: entraste como administrador del club, no podés hacer cambios desde acá." }) : next());
  async function loginOwner(usuario, password) {
    try {
      const out = await adminAuth.loginAdmin({ usuario: String(usuario || "").toLowerCase().trim(), password: String(password || "") });
      if (out.rol === "owner") return out;
      await adminAuth.logoutAdmin(out.token);
    } catch (e) { /* credenciales que no son de un admin: se sigue con el login normal */ }
    return null;
  }
  const exigirOwner = (req, res, next) => (req.adminRole === "owner" ? next() : res.status(403).json({ error: "Solo el owner del panel puede entrar como otro usuario." }));
  async function abrirSesionPena(penaId, prefijo = "") {
    const token = prefijo + crypto.randomBytes(32).toString("base64url");
    await store.crearPenaSesion(penaId, token, new Date(Date.now() + 12 * 3600 * 1000).toISOString());
    return token;
  }
  r.post("/pena/login", wrap(async (req, res) => {
    const u = store.getPenaUsuarioPorUsuario ? await store.getPenaUsuarioPorUsuario(String(req.body?.usuario || "")) : null;
    const ok = u && (await bcrypt.compare(String(req.body?.password || ""), u.password_hash));
    if (!ok) {
      const owner = await loginOwner(req.body?.usuario, req.body?.password);
      if (owner) {
        const peñas = (await store.listPenas()).map((p) => ({ id: p.id, nombre: p.nombre, ciudad: p.ciudad || "", estado: p.estado }));
        return res.json({ admin: true, token_admin: owner.token, opciones: peñas });
      }
      throw httpError(401, "Usuario o contraseña incorrectos");
    }
    const p = await store.getPena(u.pena_id);
    if (!p || p.estado !== "verificada") throw httpError(403, "Tu peña todavía no está verificada o está en pausa.");
    res.json({ token: await abrirSesionPena(p.id), pena: { nombre: p.nombre, slug: p.slug } });
  }));
  // Elegir la contraseña con el link de un solo uso del correo de verificación.
  r.post("/pena/clave", wrap(async (req, res) => {
    const password = String(req.body?.password || "");
    if (password.length < 8) throw httpError(400, "La contraseña debe tener al menos 8 caracteres");
    const u = await store.getPenaUsuarioPorSetupToken(String(req.body?.token || ""));
    if (!u) throw httpError(400, "El link venció o ya se usó. Pedile al club que te mande otro.");
    await store.updatePenaUsuario(u.id, { password_hash: await bcrypt.hash(password, 10), setup_token: null, setup_exp: null });
    if (store.borrarSesionesDePena) await store.borrarSesionesDePena(u.pena_id);   // al cambiar la contraseña se cierran las sesiones abiertas con la anterior
    const p = await store.getPena(u.pena_id);
    if (!p || p.estado !== "verificada") throw httpError(403, "Tu peña todavía no está verificada o está en pausa.");
    res.json({ token: await abrirSesionPena(p.id), pena: { nombre: p.nombre, slug: p.slug } });
  }));
  // ── Recuperar la contraseña (peña y comercio): correo con un link de un solo uso que vence en 1 hora ──
  // La respuesta es siempre la misma exista o no la cuenta (no se puede averiguar qué usuarios hay) y cada cuenta tiene un respiro de 5 minutos entre correos.
  const RESP_OLVIDE = { ok: true, mensaje: "Si el usuario existe y tiene un correo cargado, te mandamos un link para elegir una contraseña nueva. Vence en 1 hora." };
  const olvideReciente = new Map();
  const respiroOlvide = (clave) => {
    if (Date.now() - (olvideReciente.get(clave) || 0) < 5 * 60000) return false;
    if (olvideReciente.size > 5000) olvideReciente.clear();
    olvideReciente.set(clave, Date.now());
    return true;
  };
  const huellaToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  r.post("/pena/olvide", wrap(async (req, res) => {
    const dato = String(req.body?.usuario || "").trim().toLowerCase().slice(0, 160);
    if (dato) {
      let u = null, p = null;
      if (dato.includes("@")) {   // también se puede pedir con el correo de contacto de la peña
        p = (await store.listPenas({ estado: "verificada" })).find((x) => String(x.contacto || "").toLowerCase() === dato) || null;
        u = p && store.getPenaUsuarioDePena ? await store.getPenaUsuarioDePena(p.id) : null;
      } else {
        u = store.getPenaUsuarioPorUsuario ? await store.getPenaUsuarioPorUsuario(dato) : null;
        p = u ? await store.getPena(u.pena_id) : null;
      }
      if (u && p && p.estado === "verificada" && emailOk(p.contacto) && respiroOlvide("pena:" + p.id)) {
        const token = crypto.randomBytes(24).toString("base64url");
        await store.updatePenaUsuario(u.id, { setup_token: token, setup_exp: new Date(Date.now() + 3600000).toISOString() });
        if (mailer.enviarRecuperarClave) mailer.enviarRecuperarClave({ email: p.contacto }, { nombre: p.nombre, usuario: u.usuario, url: baseUrl() + "/pena?token=" + encodeURIComponent(token), tipo: "peña" }).catch(() => {});
      }
    }
    res.json(RESP_OLVIDE);
  }));
  r.post("/comercio/olvide", wrap(async (req, res) => {
    const dato = String(req.body?.usuario || "").trim().toLowerCase().slice(0, 160);
    if (dato) {
      const c = dato.includes("@")
        ? (await store.listComercios()).find((x) => String(x.contacto || "").toLowerCase() === dato && x.usuario) || null
        : (store.getComercioByUsuario ? await store.getComercioByUsuario(dato) : null);
      if (c && c.estado === "activo" && c.usuario && emailOk(c.contacto) && respiroOlvide("com:" + c.id)) {
        const token = crypto.randomBytes(24).toString("base64url");
        await store.updateComercio(c.id, { clave_token: huellaToken(token), clave_exp: new Date(Date.now() + 3600000).toISOString() });
        if (mailer.enviarRecuperarClave) mailer.enviarRecuperarClave({ email: c.contacto }, { nombre: c.nombre, usuario: c.usuario, url: baseUrl() + "/comercio?clave=" + encodeURIComponent(token), tipo: "comercio" }).catch(() => {});
      }
    }
    res.json(RESP_OLVIDE);
  }));
  r.post("/comercio/clave", wrap(async (req, res) => {
    const password = String(req.body?.password || "");
    if (password.length < 8) throw httpError(400, "La contraseña debe tener al menos 8 caracteres");
    const c = store.getComercioPorClaveToken ? await store.getComercioPorClaveToken(huellaToken(req.body?.token || "")) : null;
    if (!c || c.estado !== "activo") throw httpError(400, "El link venció o ya se usó. Pedí uno nuevo desde «Olvidé mi contraseña».");
    await store.updateComercio(c.id, { password_hash: await bcrypt.hash(password, 10), clave_token: null, clave_exp: null });
    if (store.borrarSesionesDeComercio) await store.borrarSesionesDeComercio(c.id);   // se cierran las sesiones abiertas con la contraseña anterior
    const token = crypto.randomBytes(32).toString("base64url");
    await store.createComercioSession(c.id, token, new Date(Date.now() + 12 * 3600 * 1000).toISOString());
    res.json({ token, comercio: { id: c.id, nombre: c.nombre } });
  }));
  r.post("/pena/entrar-como", requireAdmin, exigirOwner, wrap(async (req, res) => {
    const [p] = await store.listPenas({ id: String(req.body?.id || "") });
    if (!p) throw httpError(404, "Peña no encontrada");
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "ver_como:pena", targetId: p.id, detalle: p.nombre, por: req.adminUser });
    res.json({ token: await abrirSesionPena(p.id, VER_COMO), pena: { nombre: p.nombre, slug: p.slug }, solo_lectura: true });
  }));
  r.post("/pena/logout", requirePena, wrap(async (req, res) => { await store.borrarPenaSesion(req.headers["x-pena-token"]); res.json({ ok: true }); }));

  async function fondoDe(penaId) {
    const [p] = await store.listPenas({ id: penaId });
    return { saldo: p.saldo, pendiente: p.canje_pendiente, disponible: Math.max(0, p.saldo - p.canje_pendiente), pena: p };
  }
  r.get("/pena/panel", requirePena, wrap(async (req, res) => {
    const [f, altas, ranking, pct] = await Promise.all([fondoDe(req.pena.id), store.ultimasAltasPena(req.pena.id, 8), penasVerificadas(), decision("pct")]);
    const mia = ranking.find((x) => x.id === req.pena.id);
    res.json({
      pena: { nombre: f.pena.nombre, slug: f.pena.slug, ciudad: f.pena.ciudad, pais_iso: f.pena.pais_iso, estado: f.pena.estado },
      ranking: mia ? mia.ranking : null, total_penas: ranking.length,
      kpis: { altas: f.pena.altas, socios: f.pena.socios, plus: f.pena.plus, saldo: f.saldo, miembros: f.pena.miembros || 0, hinchada: f.pena.hinchada != null ? f.pena.hinchada : f.pena.altas },
      link: linkPena(f.pena), pct: Number(pct) || 10, fondo_activo: process.env.PENA_FONDO_ACTIVO === "1",
      // Del padrón del club la comisión ve solo CUÁNTOS son y cuántos ya usan la app; nunca quién debe ni las cédulas.
      padron: { miembros: f.pena.miembros || 0, con_cuenta: f.pena.vinculados || 0, pendientes: Math.max(0, (f.pena.miembros || 0) - (f.pena.vinculados || 0)) },
      top: ranking.slice(0, 5).map((x) => ({ nombre: x.nombre, ciudad: x.ciudad || "", hinchada: x.hinchada != null ? x.hinchada : x.altas, es_tuya: x.id === req.pena.id })),
      datos: { nombre: f.pena.nombre, ciudad: f.pena.ciudad || "", pais_iso: f.pena.pais_iso || "PY", presidente: f.pena.presidente || "", contacto: f.pena.contacto || "" },
      ultimas_altas: altas.map((s) => ({ nombre: nombreCorto(s), ciudad: s.ciudad || "", nivel: (tierBySlug(s.tier_slug) || {}).nombre || "Olimpista", creado: s.creado })),
    });
  }));
  // La comisión completa y corrige los datos de su peña (se ven en el listado público: ciudad, país; presidente y contacto son internos).
  r.patch("/pena/perfil", requirePena, noLectura, wrap(async (req, res) => {
    const b = req.body || {}, patch = {};
    if (b.ciudad !== undefined) patch.ciudad = limpioTxt(b.ciudad, 60);
    if (b.presidente !== undefined) patch.presidente = limpioTxt(b.presidente, 80);
    if (b.pais_iso !== undefined) { const iso = String(b.pais_iso || "").toUpperCase().trim(); if (!/^[A-Z]{2}$/.test(iso)) throw httpError(400, "El país va con su código de 2 letras (ej. PY, AR, US)"); patch.pais_iso = iso; }
    if (b.contacto !== undefined) { const c = limpioTxt(b.contacto, 120).toLowerCase(); if (c && !emailOk(c)) throw httpError(400, "Poné un correo de contacto válido"); patch.contacto = c; }
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const p = await store.updatePena(req.pena.id, patch);
    _penasPub = null;
    log.info({ penaId: req.pena.id, campos: Object.keys(patch) }, "peña: datos editados por la comisión");
    res.json({ ok: true, datos: { nombre: p.nombre, ciudad: p.ciudad || "", pais_iso: p.pais_iso || "PY", presidente: p.presidente || "", contacto: p.contacto || "" } });
  }));
  r.get("/pena/fondo", requirePena, wrap(async (req, res) => {
    const [f, mov, pct] = await Promise.all([fondoDe(req.pena.id), store.movimientosPena(req.pena.id, 40), decision("pct")]);
    res.json({ saldo: f.saldo, pendiente: f.pendiente, disponible: f.disponible, pct: Number(pct) || 10,
      movimientos: mov.map((m) => ({ id: m.id, motivo: m.motivo, monto: m.monto, detalle: m.detalle, estado: m.estado, creado: m.creado })) });
  }));
  r.post("/pena/fondo/canje", requirePena, noLectura, wrap(async (req, res) => {
    const item = limpioTxt(req.body?.item, 120), monto = Math.round(Number(req.body?.monto) || 0);
    if (item.length < 3) throw httpError(400, "Contanos qué querés canjear (ej: bus para ir al estadio)");
    if (!(monto >= 1000)) throw httpError(400, "El monto mínimo es ₲ 1.000");
    const out = await store.pedirCanjePena({ penaId: req.pena.id, monto, detalle: item });
    if (!out || !out.ok) throw httpError(409, "El fondo disponible es ₲ " + Number((out && out.disponible) || 0).toLocaleString("es-PY"));
    alertar("pena:canje:" + out.movimiento.id, "Peña pide canjear su fondo", `${req.pena.nombre} · ${item} · ₲ ${monto.toLocaleString("es-PY")}`);
    res.status(201).json({ ok: true, movimiento: { id: out.movimiento.id, monto: out.movimiento.monto, detalle: out.movimiento.detalle, estado: out.movimiento.estado } });
  }));

  // ── Admin (club): verificar, pausar, aprobar canjes ──
  r.get("/admin/penas", requireAdmin, wrap(async (req, res) => {
    const [items, canjes, pct, padron] = await Promise.all([store.listPenas(), store.canjesPendientesPena(), decision("pct"), store.resumenMiembrosPena ? store.resumenMiembrosPena() : []]);
    const porPena = new Map(padron.map((x) => [x.pena_id, x]));
    const esOwner = req.adminRole === "owner";
    // El estado de la cuota (al día / en mora) solo lo ve el owner; el resto ve cuántos miembros hay.
    res.json({ items: items.map((p) => { const x = porPena.get(p.id) || {}; return { ...p, padron: { miembros: x.miembros || 0, con_cuenta: x.con_cuenta || 0, ...(esOwner ? { al_dia: x.al_dia || 0, en_mora: x.en_mora || 0, sin_dato: x.sin_dato || 0 } : {}) } }; }), canjes, pct: Number(pct) || 10, owner: esOwner });
  }));
  async function enviarAccesoPena(pena, { renovar = false } = {}) {
    let u = await store.getPenaUsuarioDePena(pena.id);
    const setupToken = crypto.randomBytes(24).toString("base64url");
    const setupExp = new Date(Date.now() + 7 * 86400000).toISOString();
    if (!u) {
      let usuario = pena.slug, n = 1;
      while (await store.getPenaUsuarioPorUsuario(usuario)) usuario = pena.slug + "-" + (++n);
      // Contraseña al azar que nadie conoce: la comisión elige la suya con el link de un solo uso.
      u = await store.crearPenaUsuario({ penaId: pena.id, usuario, passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10), setupToken, setupExp });
    } else {
      u = await store.updatePenaUsuario(u.id, { setup_token: setupToken, setup_exp: setupExp });
      if (renovar && store.borrarSesionesDePena) await store.borrarSesionesDePena(pena.id);
    }
    const urlClave = baseUrl() + "/pena?token=" + encodeURIComponent(setupToken);
    let correo = false;
    if (emailOk(pena.contacto) && mailer.enviarPenaVerificada) {
      await mailer.enviarPenaVerificada({ email: pena.contacto }, { pena, usuario: u.usuario, urlClave, urlLink: linkPena(pena) }).then((e) => { correo = !!(e && e.ok && e.modo === "resend"); }).catch(() => {});   // enviar() no lanza si falla: hay que mirar el resultado
    }
    return { usuario: u.usuario, urlClave, correo };
  }
  r.post("/admin/penas/:id/verificar", requireAdmin, requirePerm("penas.write"), wrap(async (req, res) => {
    const pena = await store.getPena(req.params.id);
    if (!pena) throw httpError(404, "Peña no encontrada");
    const p = await store.updatePena(pena.id, { estado: "verificada" });
    _penasPub = null;
    const acceso = await enviarAccesoPena(p);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "penas:verificar", targetId: p.id, detalle: p.nombre, por: req.adminUser });
    // Si no hay correo válido, el admin recibe el link para pasárselo a la comisión por otro medio.
    res.json({ ok: true, pena: { id: p.id, slug: p.slug, estado: p.estado }, usuario: acceso.usuario, correo_enviado: acceso.correo, ...(acceso.correo ? {} : { url_clave: acceso.urlClave }) });
  }));
  r.post("/admin/penas/:id/acceso", requireAdmin, requirePerm("penas.write"), wrap(async (req, res) => {
    const pena = await store.getPena(req.params.id);
    if (!pena || pena.estado !== "verificada") throw httpError(409, "Solo se reenvía el acceso de una peña verificada");
    const acceso = await enviarAccesoPena(pena, { renovar: true });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "penas:acceso", targetId: pena.id, detalle: pena.nombre, por: req.adminUser });
    res.json({ ok: true, usuario: acceso.usuario, correo_enviado: acceso.correo, ...(acceso.correo ? {} : { url_clave: acceso.urlClave }) });
  }));
  r.post("/admin/penas/:id/estado", requireAdmin, requirePerm("penas.write"), wrap(async (req, res) => {
    const estado = String(req.body?.estado || "");
    if (!["verificada", "pausada"].includes(estado)) throw httpError(400, "Estado inválido (verificada | pausada)");
    const pena = await store.getPena(req.params.id);
    if (!pena || pena.estado === "pendiente") throw httpError(409, "Una peña pendiente se verifica, no se pausa");
    const previo = pena.estado;   // el almacén en memoria devuelve el mismo objeto: hay que guardar el estado antes de actualizar
    const p = await store.updatePena(pena.id, { estado });
    if (estado === "pausada" && store.borrarSesionesDePena) await store.borrarSesionesDePena(pena.id);
    _penasPub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "penas:" + estado, targetId: pena.id, detalle: pena.nombre, por: req.adminUser });
    if (previo !== estado && mailer.enviarPenaEstado && emailOk(pena.contacto)) mailer.enviarPenaEstado({ email: pena.contacto }, { pena, estado }).catch(() => {});
    res.json({ ok: true, pena: { id: p.id, estado: p.estado } });
  }));
  // Aprobar (resta del saldo) o rechazar un canje pedido por una peña.
  r.post("/admin/penas/canje/:id", requireAdmin, requirePerm("pagos.write", "penas.write"), wrap(async (req, res) => {
    const aprobar = !(req.body && req.body.rechazar === true);
    const out = await store.resolverCanjePena(req.params.id, { aprobar });
    if (!out.ok) {
      if (out.motivo === "no_existe") throw httpError(404, "Canje no encontrado");
      if (out.motivo === "ya_resuelto") throw httpError(409, "Ese canje ya se resolvió (" + out.estado + ")");
      throw httpError(409, "El fondo de la peña ya no alcanza para este canje");
    }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: aprobar ? "penas:canje-aprobado" : "penas:canje-rechazado", targetId: req.params.id, detalle: out.movimiento.detalle, por: req.adminUser });
    res.json({ ok: true, estado: out.movimiento.estado });
  }));

  // Aporte al fondo: el % que decide el club (10 por defecto) de lo que paga cada hincha de la peña.
  // Un pedido acredita UNA vez (pedido_id único en el libro). Una falla acá nunca frena la entrega del pago.
  // APAGADO por decisión del club (2026-10-23): ya no se acredita el 10 % al fondo de la peña; se va a reemplazar por puntos u otra
  // recompensa. Se puede volver a encender con PENA_FONDO_ACTIVO=1 sin tocar código.
  async function acreditarFondoPena(pedido) {
    try {
      if (process.env.PENA_FONDO_ACTIVO !== "1") return;
      if (!store.acreditarPena || !pedido.socio_id) return;
      const socio = await store.getSocioById(pedido.socio_id);
      if (!socio || !socio.pena_id) return;
      const pena = await store.getPena(socio.pena_id);
      if (!pena || pena.estado !== "verificada") return;
      const pct = Number(await decision("pct")) || 10;
      const monto = Math.floor(Number(pedido.monto || 0) * pct / 100);
      if (monto <= 0) return;
      const m = await store.acreditarPena({ penaId: pena.id, pedidoId: pedido.id, monto, detalle: `${pedido.concepto || "Pago"} · ${nombreCorto(socio)} (${pct}%)` });
      if (m) log.info({ penaId: pena.id, pedidoId: pedido.id, monto }, "peña: aporte al fondo");
    } catch (e) {
      log.error({ pedidoId: pedido.id, err: e.message }, "peña: no se pudo acreditar el fondo");
      alertar("pena:fondo-fallo:" + pedido.id, "Falló el aporte al fondo de una peña", `Pedido ${pedido.id}: ${e.message}. El pago se entregó igual; hay que acreditar el fondo a mano.`);
    }
  }
  // Cuando alguien carga o valida su cédula: si figura en el padrón de una peña se vincula con su cuenta y, si no tenía peña, se suma a la primera
  // según el informe del club. Nunca frena el flujo que la dispara.
  function unirPenaPorCedula(socioId) {
    if (!store.sincronizarMiembrosPena) return;
    store.sincronizarMiembrosPena({ socioId }).then((r) => { if (r && r.asignados) { _penasPub = null; log.info({ socioId }, "peña: asignada por el padrón del club"); } }).catch((e) => log.warn({ err: e.message }, "peña: no se pudo vincular con el padrón"));
  }
  // Padrón de una peña (solo el owner del panel): incluye el estado de la cuota, que es dato del club y no se comparte con la comisión.
  r.get("/admin/penas/:id/miembros", requireAdmin, exigirOwner, wrap(async (req, res) => {
    const pena = await store.getPena(req.params.id);
    if (!pena) throw httpError(404, "Peña no encontrada");
    const items = store.listarMiembrosPena ? await store.listarMiembrosPena(pena.id) : [];
    if (req.query.format === "csv") {
      const ETQ = { al_dia: "Al día", en_mora: "En mora", sin_dato: "Sin dato" };
      return enviarCsv(res, "padron-" + pena.slug + ".csv", ["nombre", "cedula", "n_socio", "estado_cuota", "tiene_cuenta", "peña_asignada"],
        items.map((m) => [m.nombre, m.cedula, m.nro_socio, ETQ[m.estado_cuota] || "", m.socio_id ? "sí" : "no", m.es_su_pena ? "sí" : "no"]));
    }
    res.json({ pena: { id: pena.id, nombre: pena.nombre }, items });
  }));
  // Completar o corregir los datos de una peña (ciudad, país, presidente, contacto, nombre).
  r.patch("/admin/penas/:id", requireAdmin, requirePerm("penas.write"), wrap(async (req, res) => {
    const b = req.body || {}, patch = {};
    for (const [k, max] of [["nombre", 80], ["ciudad", 60], ["presidente", 80], ["contacto", 120]]) if (b[k] !== undefined) patch[k] = limpioTxt(b[k], max);
    if (b.pais_iso !== undefined) patch.pais_iso = String(b.pais_iso || "PY").toUpperCase().slice(0, 2);
    if (patch.nombre === "") throw httpError(400, "El nombre no puede quedar vacío");
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const p = await store.updatePena(req.params.id, patch);
    if (!p) throw httpError(404, "Peña no encontrada");
    _penasPub = null;
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "penas:editar", targetId: p.id, detalle: Object.keys(patch).join(","), por: req.adminUser });
    res.json({ ok: true, pena: p });
  }));
  // Aviso a la comisión de que se sumó un hincha: como máximo uno por día y peña.
  async function avisarPenaSumo(pena, socio) {
    if (!emailOk(pena.contacto) || !mailer.enviarPenaSumoSocio) return;
    const reservar = store.reservarNotificacion ? (k) => store.reservarNotificacion(k) : async () => true;
    if (!(await reservar("pena:sumo:" + pena.id + ":" + new Date().toISOString().slice(0, 10)))) return;
    const [p] = await store.listPenas({ id: pena.id });
    await mailer.enviarPenaSumoSocio({ email: pena.contacto }, { pena, invitado: nombreCorto(socio), total: p ? p.altas : undefined }).catch(() => {});
  }

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
    if (reserva?.error === "limite") throw httpError(409, "Ya tenés el máximo de 4 entradas para esta preventa");
    await store.confirmarReserva(reserva.id); // reserva sin cobro: queda confirmada (no se libera por falta de pago)
    res.json({ ok: true, reserva: { ...reserva, estado: "pagada" } });
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
    if (reserva.error === "limite") throw httpError(409, "Ya tenés el máximo de 4 entradas para esta preventa");

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
  // Billetera de Ahorro: lo que ahorró este mes y en el año (mes calendario en hora de Paraguay).
  r.get("/beneficios/ahorro", auth.requireSocio, wrap(async (req, res) => {
    const a = store.resumenAhorroSocio ? await store.resumenAhorroSocio(req.socio.id) : { mes: 0, anio: 0, total: 0, canjes_mes: 0 };
    res.json({ mes: a.mes, anio: a.anio, total: a.total, canjes_mes: a.canjes_mes });
  }));
  // Lo que ahorraría una persona siendo socia: se toman los beneficios que se desbloquean con el nivel Socio, se calcula cuánto se ahorra en cada uno
  // (el ahorro estimado que cargó el comercio o, si no, su porcentaje sobre una compra promedio supuesta) y se suman los 4 de mayor ahorro, como
  // si usara uno por semana. Es una estimación y se dice así en pantalla. Es igual para todos: se calcula una vez cada 2 minutos.
  const TICKET_PROMEDIO = () => Number(process.env.TICKET_PROMEDIO) || 100000;
  const USOS_AL_MES = 4;
  let _potencial = { t: 0, v: null };
  async function potencialAhorro() {
    if (_potencial.v && Date.now() - _potencial.t < 120000) return _potencial.v;
    const todos = store.beneficiosParaNivel ? await store.beneficiosParaNivel("socio") : [];
    const ticket = TICKET_PROMEDIO();
    const ahorroDe = (b) => { const e = Number(b.ahorro_estimado) || 0; if (e > 0) return e; const p = Number(b.pct) || 0; return p > 0 ? Math.round((ticket * p) / 100) : 0; };
    const mejores = todos.map((b) => ({ comercio: b.comercio_nombre || "", valor: b.valor || "", ahorro: ahorroDe(b) })).filter((x) => x.ahorro > 0).sort((a, b) => b.ahorro - a.ahorro).slice(0, USOS_AL_MES);
    const mensual = mejores.reduce((a, x) => a + x.ahorro, 0);
    const v = { mensual, anual: mensual * 12, usos: Math.max(mejores.length, 0), ticket, beneficios: todos.length, ejemplos: mejores.slice(0, 3).map((x) => ({ comercio: x.comercio, valor: x.valor })) };
    _potencial = { t: Date.now(), v };
    return v;
  }
  r.get("/beneficios", auth.requireSocio, wrap(async (req, res) => {
    const [m, sFull] = await Promise.all([store.getMembresia(req.socio.id), store.getSocioById(req.socio.id).catch(() => null)]);
    const tier = (m && m.tier_slug) || "olimpista";
    const ciudad = ((sFull && sFull.ciudad) || "").trim().toLowerCase();
    let items = store.beneficiosParaNivel ? await store.beneficiosParaNivel(tier) : [];
    // Orden: desbloqueados primero (lo tuyo) y, dentro de eso, local-first (comercio de tu ciudad).
    const esLocal = (x) => (ciudad && String(x.comercio_ciudad || "").toLowerCase() === ciudad) ? 1 : 0;
    items = items.slice().sort((a, b) => ((b.desbloqueado ? 1 : 0) - (a.desbloqueado ? 1 : 0)) || (esLocal(b) - esLocal(a)));
    const ahorro = store.resumenAhorroSocio ? await store.resumenAhorroSocio(req.socio.id).catch(() => ({ mes: 0, anio: 0, total: 0 })) : { mes: 0, anio: 0, total: 0 };
    const codigo = (sFull && sFull.ref_codigo) || "";
    items = items.map((b) => ({ ...b, agotado: b.stock != null && Number(b.stock) <= 0 }));
    // Para quien todavía no es socio: cuánto ahorraría siéndolo (los beneficios se muestran bloqueados y la pantalla lo invita a asociarse).
    const esSocio = !!(sFull && sFull.es_socio_olimpia) || tier === "socio";
    const potencial = esSocio ? null : await potencialAhorro().catch(() => null);
    res.json({ tier, ciudad: (sFull && sFull.ciudad) || "", codigo, items, ahorro, potencial: potencial && potencial.mensual > 0 ? potencial : null });
  }));

  // La persona cuenta desde qué año es socia del club (la base del club se equivoca en algunos grupos). Queda marcado como declarado por ella:
  // la base del club y las revalidaciones no lo pisan, y el administrador lo ve en la ficha y puede corregirlo.
  r.post("/socio-desde", auth.requireSocio, wrap(async (req, res) => {
    if (!req.socio.es_socio_olimpia) throw httpError(403, "Esto es para socios del club");
    const anio = Number(req.body && req.body.anio);
    const tope = Number(hoyPy().slice(0, 4));
    if (!Number.isInteger(anio) || anio < 1950 || anio > tope) throw httpError(400, "Escribí un año entre 1950 y " + tope);
    const fecha = anio + "-01-01";
    await store.updateSocio(req.socio.id, { socio_desde: fecha, socio_desde_fuente: "declarada" });
    res.json({ ok: true, socio_desde: fecha, socio_desde_fuente: "declarada" });
  }));

  // ─── Tu historia: el recorrido de la persona con el club y con Olimpistas ─────────────────────────────
  // Todo sale de lo que ya tenemos de ella (registro, nivel, canjes, subastas, puntos, referidos, peña); nada se inventa: sin dato, no hay hito.
  r.get("/historia", auth.requireSocio, wrap(async (req, res) => {
    const id = req.socio.id;
    const [s, m, ahorro, canjes, pujas, puntos, referidos] = await Promise.all([
      store.getSocioById(id), store.getMembresia(id), store.resumenAhorroSocio ? store.resumenAhorroSocio(id).catch(() => ({ total: 0 })) : { total: 0 },
      store.canjesDeSocio ? store.canjesDeSocio(id, 500).catch(() => []) : [], store.pujasDeSocio ? store.pujasDeSocio(id, 200).catch(() => []) : [],
      store.saldoPuntos ? store.saldoPuntos(id).catch(() => 0) : 0, store.contarReferidos ? store.contarReferidos(id).catch(() => 0) : 0,
    ]);
    const pena = s.pena_id && store.getPena ? await store.getPena(s.pena_id).catch(() => null) : null;
    const esSocio = !!s.es_socio_olimpia || (m && m.tier_slug === "socio");
    const dia = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const socioDesde = esSocio && s.socio_desde ? String(s.socio_desde).slice(0, 10) : "";
    const hitos = [];
    if (socioDesde) hitos.push({ tipo: "socio", fecha: socioDesde });
    hitos.push({ tipo: "miembro", fecha: dia(s.creado) });
    if (esSocio && m && m.tier_slug === "socio" && dia(m.inicio) && Math.abs(new Date(dia(m.inicio)) - new Date(dia(s.creado))) > 86400000) hitos.push({ tipo: "nivel", fecha: dia(m.inicio) });
    const primero = (canjes || []).length ? canjes[canjes.length - 1] : null;
    if (primero) hitos.push({ tipo: "canje", fecha: dia(primero.creado), detalle: [primero.comercio, primero.beneficio].filter(Boolean).join(" · ") });
    const ganadas = (pujas || []).filter((x) => x.adjudicado_a === id);
    if (ganadas.length) hitos.push({ tipo: "subasta", fecha: dia(ganadas[ganadas.length - 1].ultima), detalle: ganadas[ganadas.length - 1].titulo });
    hitos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    const anios = socioDesde ? Math.max(0, Math.floor((Date.now() - new Date(socioDesde + "T12:00:00").getTime()) / 31557600000)) : null;
    res.json({
      es_socio: esSocio, nivel: (m && m.tier_slug) || "olimpista", miembro_desde: dia(s.creado), socio_desde: socioDesde, anios_socio: anios, socio_desde_fuente: socioDesde ? s.socio_desde_fuente || "" : "",
      grupo_club: esSocio ? s.grupo_club || "" : "", nro_socio: esSocio ? s.nro_socio || "" : "",
      stats: { canjes: (canjes || []).length, ahorro_total: Number(ahorro.total) || 0, puntos, pujas: (pujas || []).length, subastas_ganadas: ganadas.length, referidos, pena: pena ? pena.nombre : "" },
      hitos, potencial: esSocio ? null : await potencialAhorro().catch(() => null),
    });
  }));

  // ─── Panel de validación del COMERCIO (Red de Beneficios) ─────────────────────
  // Alta de acceso (admin): setea usuario+contraseña del comercio para su panel.
  r.post("/admin/comercios/:id/acceso", requireAdmin, requirePerm("beneficios.write"), wrap(async (req, res) => {
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
    const ok = c && c.estado === "activo" && c.password_hash && (await bcrypt.compare(String(req.body?.password || ""), c.password_hash));
    if (!ok) {
      const owner = await loginOwner(usuario, req.body?.password);
      if (owner) {
        const comercios = (await store.listComercios()).map((x) => ({ id: x.id, nombre: x.nombre, ciudad: x.ciudad || "", estado: x.estado }));
        return res.json({ admin: true, token_admin: owner.token, opciones: comercios });
      }
      throw httpError(401, "Usuario o contraseña incorrectos");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expira = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    await store.createComercioSession(c.id, token, expira);
    res.json({ token, comercio: { id: c.id, nombre: c.nombre } });
  }));
  r.post("/comercio/entrar-como", requireAdmin, exigirOwner, wrap(async (req, res) => {
    const c = (await store.listComercios()).find((x) => x.id === String(req.body?.id || ""));
    if (!c) throw httpError(404, "Comercio no encontrado");
    const token = VER_COMO + crypto.randomBytes(32).toString("base64url");
    await store.createComercioSession(c.id, token, new Date(Date.now() + 4 * 3600 * 1000).toISOString());
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "ver_como:comercio", targetId: c.id, detalle: c.nombre, por: req.adminUser });
    res.json({ token, comercio: { id: c.id, nombre: c.nombre }, solo_lectura: true });
  }));
  // Middleware: sesión de comercio (header x-comercio-token).
  async function requireComercio(req, res, next) {
    try {
      const token = req.headers["x-comercio-token"] || "";
      const s = token && store.getComercioSession ? await store.getComercioSession(token) : null;
      if (!s) return res.status(401).json({ error: "Sesión de comercio inválida" });
      req.comercio = { id: s.comercio_id, nombre: s.nombre };
      req.soloLectura = esSesionVerComo(token);
      next();
    } catch (e) { res.status(401).json({ error: "no autorizado" }); }
  }
  // Beneficios del comercio: `items` = lo publicado (para elegir cuál validar en caja), `ofertas` = todo lo suyo con su estado.
  r.get("/comercio/beneficios", requireComercio, wrap(async (req, res) => {
    const ofertas = store.ofertasDeComercio ? await store.ofertasDeComercio(req.comercio.id) : [];
    // Datos públicos del comercio (para la vista previa de sus promociones): nunca el usuario ni la contraseña.
    const c = store.getComercio ? await store.getComercio(req.comercio.id).catch(() => null) : null;
    const comercio = c ? { id: c.id, nombre: c.nombre, rubro: c.rubro || "", ciudad: c.ciudad || "", direccion: c.direccion || "", logo: c.logo || "" } : req.comercio;
    res.json({ comercio, items: store.beneficiosDeComercio ? await store.beneficiosDeComercio(req.comercio.id) : [],
      ofertas: ofertas.map(ofertaOut) });
  }));
  const ofertaOut = (b) => ({ id: b.id, titulo: b.titulo, descripcion: b.descripcion, valor: b.valor, niveles: b.niveles, pct: b.pct, ahorro_estimado: b.ahorro_estimado,
    stock: b.stock == null ? null : b.stock, activo: b.activo, estado: b.estado || "aprobado", origen: b.origen || "club", motivo_rechazo: b.motivo_rechazo || null, vigencia_hasta: b.vigencia_hasta || null });

  // ── Ofertas que carga el propio comercio: nacen en BORRADOR y el club las aprueba antes de publicarse ──
  const NIVELES_OFERTA = { todos: "todos", plus: "premium,socio", socio: "socio" };
  function limpiarOferta(b, parcial) {
    const o = {};
    const txt = (k, min, max, msg) => { if (b[k] !== undefined) { const v = String(b[k]).replace(/[<>]/g, "").replace(/\s+/g, " ").trim(); if (v.length < min || v.length > max) throw httpError(400, msg); o[k] = v; } };
    txt("titulo", 3, 100, "El título va de 3 a 100 caracteres");
    txt("valor", 1, 30, "Poné el beneficio en pocas palabras (ej. 10%, 2x1)");
    if (b.descripcion !== undefined) o.descripcion = String(b.descripcion).replace(/[<>]/g, "").trim().slice(0, 1000);
    if (b.para !== undefined) { if (!NIVELES_OFERTA[b.para]) throw httpError(400, "Elegí para quién es: todos, plus o socio"); o.niveles = NIVELES_OFERTA[b.para]; }
    if (o.valor !== undefined || b.valor !== undefined) { const m = /^(\d{1,3})\s*%$/.exec(o.valor || ""); if (m && Number(m[1]) >= 1 && Number(m[1]) <= 100) o.pct = Number(m[1]); else if (o.valor !== undefined) o.pct = null; }
    if (b.ahorro_estimado !== undefined) {
      if (b.ahorro_estimado === null || b.ahorro_estimado === "") o.ahorro_estimado = null;
      else { const n = Math.round(Number(b.ahorro_estimado)); if (!(n >= 0 && n <= 10000000)) throw httpError(400, "El ahorro estimado va de 0 a ₲ 10.000.000"); o.ahorro_estimado = n; }
    }
    if (b.stock !== undefined) {
      if (b.stock === null || b.stock === "") o.stock = null;
      else { const n = Math.round(Number(b.stock)); if (!(n >= 0 && n <= 100000)) throw httpError(400, "El cupo va de 0 a 100.000"); o.stock = n; }
    }
    if (b.vigencia_hasta !== undefined) {
      if (b.vigencia_hasta === null || b.vigencia_hasta === "") o.vigencia_hasta = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.vigencia_hasta)) && !isNaN(new Date(b.vigencia_hasta).getTime())) o.vigencia_hasta = String(b.vigencia_hasta);
      else throw httpError(400, "Fecha de vigencia inválida (AAAA-MM-DD)");
    }
    if (typeof b.activo === "boolean") o.activo = b.activo;
    if (!parcial && (!o.titulo || !o.valor)) throw httpError(400, "Poné el título y el beneficio");
    return o;
  }
  r.post("/comercio/beneficios", requireComercio, noLectura, wrap(async (req, res) => {
    const o = limpiarOferta(req.body || {}, false);
    const abiertas = (await store.ofertasDeComercio(req.comercio.id)).filter((x) => (x.estado || "aprobado") === "borrador").length;
    if (abiertas >= 10) throw httpError(409, "Ya tenés 10 ofertas esperando aprobación. Esperá a que el club las revise.");
    const b = await store.crearBeneficioComercio({ comercioId: req.comercio.id, titulo: o.titulo, descripcion: o.descripcion, valor: o.valor, niveles: o.niveles || "todos",
      pct: o.pct == null ? null : o.pct, ahorro_estimado: o.ahorro_estimado == null ? null : o.ahorro_estimado, stock: o.stock == null ? null : o.stock, vigencia_hasta: o.vigencia_hasta || null });
    alertar("oferta:nueva:" + b.id, "Oferta nueva de un comercio para aprobar", `${req.comercio.nombre}: "${b.titulo}" (${b.valor})`);
    res.status(201).json({ ok: true, oferta: ofertaOut(b) });
  }));
  // Editar una oferta PROPIA. Cambiar lo que ve el hincha (título, beneficio, para quién, ahorro, vigencia) de una oferta ya
  // aprobada o rechazada la devuelve a "espera aprobación"; pausarla o ajustar el cupo no.
  r.patch("/comercio/beneficios/:id", requireComercio, noLectura, wrap(async (req, res) => {
    const actual = (await store.ofertasDeComercio(req.comercio.id)).find((x) => x.id === req.params.id);
    if (!actual) throw httpError(404, "Oferta no encontrada");
    const patch = limpiarOferta(req.body || {}, true);
    delete patch.para;
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const CAMBIOS_VISIBLES = ["titulo", "valor", "descripcion", "niveles", "pct", "ahorro_estimado", "vigencia_hasta"];
    const cambioVisible = CAMBIOS_VISIBLES.some((k) => patch[k] !== undefined && String(patch[k] == null ? "" : patch[k]) !== String(actual[k] == null ? "" : actual[k]));
    if (cambioVisible && (actual.estado || "aprobado") !== "borrador") { patch.estado = "borrador"; patch.motivo_rechazo = null; }
    const b = await store.updateBeneficioComercio(actual.id, req.comercio.id, patch);
    if (cambioVisible && patch.estado === "borrador") alertar("oferta:editada:" + b.id + ":" + Date.now(), "Un comercio editó una oferta: vuelve a aprobación", `${req.comercio.nombre}: "${b.titulo}"`);
    res.json({ ok: true, oferta: ofertaOut(b), vuelve_a_aprobacion: !!(cambioVisible && patch.estado === "borrador") });
  }));

  // ── Estadísticas del comercio: canjes, ahorro entregado, ventas, ticket promedio y mix por nivel ──
  const csvCelda = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // sin inyección de fórmulas en Excel
  const enviarCsv = (res, nombre, cabecera, filas) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.send("﻿" + [cabecera.map(csvCelda).join(","), ...filas.map((f) => f.map(csvCelda).join(","))].join("\n"));
  };
  r.get("/comercio/estadisticas", requireComercio, wrap(async (req, res) => {
    const p = periodo({ desde: req.query.desde, hasta: req.query.hasta });
    if (req.query.format === "csv") {
      const filas = await store.canjesDeComercio({ comercioId: req.comercio.id, desde: p.desde, hasta: p.hasta });
      return enviarCsv(res, "canjes-" + p.etiqueta.replace(/ a /, "_") + ".csv", ["fecha", "beneficio", "nivel", "monto", "ahorro"],
        filas.map((f) => [new Date(f.creado).toISOString(), f.beneficio, f.nivel, f.monto, f.ahorro]));
    }
    res.json({ periodo: p.etiqueta, ...(await store.estadisticasComercio({ comercioId: req.comercio.id, desde: p.desde, hasta: p.hasta })) });
  }));

  // Lo de hoy en la caja (día calendario de Paraguay): totales y los últimos canjes. Del hincha solo se ve el nombre y la inicial del apellido.
  r.get("/comercio/hoy", requireComercio, wrap(async (req, res) => {
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" });
    const p = periodo({ desde: hoy, hasta: hoy });
    const filas = await store.canjesDeComercio({ comercioId: req.comercio.id, desde: p.desde, hasta: p.hasta, limit: 500 });
    const quien = (f) => {
      const n = String(f.socio_nombre || "").trim().split(" ")[0], a = String(f.socio_apellido || "").trim().charAt(0).toUpperCase();
      return [n, a ? a + "." : ""].filter(Boolean).join(" ") || "Socio";
    };
    const suma = (k) => filas.reduce((t, f) => t + (Number(f[k]) || 0), 0);
    res.json({
      fecha: hoy, canjes: filas.length, ahorro: suma("ahorro"), ventas: suma("monto"),
      ultimos: filas.slice(0, 15).map((f) => ({ hora: new Date(f.creado).toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Asuncion" }), socio: quien(f), beneficio: f.beneficio || "", monto: f.monto != null ? Number(f.monto) : null, ahorro: f.ahorro != null ? Number(f.ahorro) : null })),
    });
  }));

  // Validar un canje en caja: QR del carnet (rota cada 60 s) o código fijo del socio, + beneficio + monto.
  // Con QR: se verifica la firma y la ventana (±1) y cada QR sirve UNA vez. El registro (stock, límite de días, QR usado y canje)
  // es una sola transacción: dos cajas escaneando a la vez no duplican el canje ni pasan el cupo.
  r.post("/comercio/validar", requireComercio, noLectura, wrap(async (req, res) => {
    const monto = Math.max(0, Number(req.body?.monto) || 0);
    const tokenQr = String(req.body?.token || "").trim();
    let socio = null, ventana = null, via = "codigo";
    if (tokenQr) {
      const v = await carnetLib.verificarToken(tokenQr, (id) => store.getCarnetSecreto(id));
      if (!v.ok) return res.json({ ok: false, motivo: v.motivo === "vencido" ? "qr_vencido" : "qr_invalido" });
      socio = await store.getSocioById(v.socioId); ventana = v.ventana; via = "qr";
    } else {
      // Sin cámara: "<código de socio> <6 dígitos>" (los 6 dígitos rotan cada minuto y se ven junto al QR). El código de socio solo no alcanza:
      // es el de su link de invitación y lo conoce cualquiera que lo haya recibido.
      const m = /^([a-z0-9]{4,32})[\s\-._:]+(\d{3}[\s\-]?\d{3})$/i.exec(String(req.body?.codigo || "").trim());
      if (!m) return res.json({ ok: false, motivo: "codigo_incompleto" });
      const cand = store.getSocioByRefCodigo ? await store.getSocioByRefCodigo(m[1].toLowerCase()) : null;
      const secreto = cand ? await store.getCarnetSecreto(cand.id) : null;
      const v = cand ? carnetLib.verificarCodigo(cand.id, secreto, m[2].replace(/[\s\-]/g, "")) : { ok: false };
      if (!v.ok) return res.json({ ok: false, motivo: "codigo_invalido" });   // mismo motivo si el socio no existe o el código está mal: no se puede adivinar socios
      socio = cand; ventana = v.ventana;
    }
    if (!socio) return res.json({ ok: false, motivo: "socio_no_encontrado" });
    const ben = store.getBeneficio ? await store.getBeneficio(req.body?.beneficioId) : null;
    if (!ben || ben.comercio_id !== req.comercio.id || ben.activo === false || (ben.estado || "aprobado") !== "aprobado") return res.json({ ok: false, motivo: "beneficio_invalido" });
    const m = await store.getMembresia(socio.id);
    const tier = (m && m.tier_slug) || "olimpista";
    const nivs = ben.niveles === "todos" ? "todos" : String(ben.niveles).split(",").map((x) => x.trim());
    const socioOut = { nombre: [socio.nombre, socio.apellido].filter(Boolean).join(" ") || socio.email, tier };
    if (!access.nivelAplica(tier, nivs)) return res.json({ ok: false, motivo: "nivel_no_aplica", socio: socioOut, requiere: (nivs === "todos" ? "olimpista" : nivs[0]) });
    const ahorro = ben.pct ? Math.round(monto * Number(ben.pct) / 100) : (Number(ben.ahorro_estimado) || 0);
    const out = await store.canjearBeneficio({ beneficioId: ben.id, socioId: socio.id, comercioId: req.comercio.id, validadoPor: req.comercio.nombre, monto: monto || null, ahorro: ahorro || null, tierSlug: tier, ventana });
    if (!out.ok) return res.json({ ok: false, motivo: out.motivo, socio: socioOut });
    evento(socio.id, "primer_canje", { comercio: req.comercio.id, via });
    // Aviso al socio con lo que ahorró (la prueba de valor del producto); no demora la respuesta de la caja.
    if (mailer.enviarCanjeExitoso && store.getSocioById) store.getSocioById(socio.id).then((s) => { if (s && s.email) return mailer.enviarCanjeExitoso(s, { comercio: req.comercio.nombre, beneficio: ben.titulo, ahorro }); }).catch(() => {});
    res.json({ ok: true, socio: socioOut, beneficio: ben.titulo, ahorro, via, stock: out.stock });
  }));

  // QR rotativo del carnet: el hincha lo pide cada minuto y lo muestra en caja.
  r.get("/carnet/token", auth.requireSocio, wrap(async (req, res) => {
    const secreto = await store.asegurarCarnetSecreto(req.socio.id);
    if (!secreto) throw httpError(404, "Cuenta no encontrada");
    const t = carnetLib.generarToken(req.socio.id, secreto);
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: t.token, codigo: t.codigo, ref: req.socio.ref_codigo || "", vence_en: t.vence_en, ventana_s: carnetLib.VENTANA_S });
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
        foto: (store.getSocioFoto ? await store.getSocioFoto(req.socio.id) : req.socio.foto) || "",
        tier: tier?.nombre || membresia.tier_slug,
        tierSlug: membresia.tier_slug,
        color: tier?.color || "#000",
        desde: membresia.inicio,
        // Para un Socio, la antigüedad que vale es la del club (si la tenemos), no la de su registro en Olimpistas.
        socioDesde: req.socio.es_socio_olimpia && req.socio.socio_desde ? String(req.socio.socio_desde).slice(0, 10) : "",
        socioDesdeFuente: req.socio.es_socio_olimpia && req.socio.socio_desde ? req.socio.socio_desde_fuente || "" : "",
        nroSocio: req.socio.es_socio_olimpia ? (req.socio.nro_socio || "") : "",
        esSocio: !!req.socio.es_socio_olimpia,
        numero: "OLI-" + req.socio.id.replace(/\D/g, "").slice(0, 8).padStart(8, "0"),
      },
    });
  }));

  // ─── Atención: asistente con IA + bandeja del club ───────────────────────────
  // El hincha escribe en la app (o por WhatsApp, que entra a la misma función con canal='whatsapp'); el asistente
  // contesta con la API de Anthropic en el servidor. Si la IA falla, responde por palabras clave. Si pide una
  // persona, la conversación pasa a la bandeja y la IA calla hasta que se resuelva.
  const diaPy = (d) => new Date((d ? new Date(d).getTime() : Date.now()) - 3 * 3600000).toISOString().slice(0, 10);
  const _atRafaga = new Map();   // hincha → marcas de tiempo (ráfaga por minuto)
  function atRafagaOk(id) {
    const n = Date.now(), max = Number(process.env.ATENCION_RAFAGA) || 8;
    const v = (_atRafaga.get(id) || []).filter((x) => n - x < 60000);
    if (v.length >= max) { _atRafaga.set(id, v); return false; }
    v.push(n); _atRafaga.set(id, v);
    if (_atRafaga.size > 5000) for (const [k, a] of _atRafaga) if (!a.length || n - a[a.length - 1] > 60000) _atRafaga.delete(k);
    return true;
  }
  const llamarIA = () => atencionLib.crearLlamador();
  const iaConectada = () => atencionLib.proveedores().length > 0;
  const msgPublico = (m) => { let meta = null; try { meta = m.meta ? JSON.parse(m.meta) : null; } catch (e) { meta = null; } return { id: m.id, de: m.de, texto: m.texto, meta, creado: m.creado }; };

  // Lo que el asistente sabe del hincha que escribe (nunca de otro).
  async function cuentaParaAtencion(socio) {
    const full = (await store.getSocioById(socio.id)) || socio;
    const [m, ahorro, saldo, pujas, club] = await Promise.all([
      store.getMembresia(socio.id),
      store.resumenAhorroSocio ? store.resumenAhorroSocio(socio.id).catch(() => ({ mes: 0, anio: 0 })) : { mes: 0, anio: 0 },
      store.saldoPuntos ? store.saldoPuntos(socio.id) : 0,
      store.pujasDeSocio ? store.pujasDeSocio(socio.id, 5) : [],
      estadoClubDe(full),
    ]);
    const pena = full.pena_id && store.getPena ? await store.getPena(full.pena_id).catch(() => null) : null;
    const tier = (m && m.tier_slug) || "olimpista", t = tierBySlug(tier) || {}, plus = tierBySlug("premium") || {};
    const bloqueo = full.subastas_bloqueo_hasta && new Date(full.subastas_bloqueo_hasta).getTime() > Date.now() ? full.subastas_bloqueo_hasta : null;
    const resultado = (p) => p.estado === "activa" ? "en_vivo" : (p.adjudicado_a || p.ganador_id) === socio.id ? (p.pago_estado === "pagado" ? "pagado" : "ganaste_sin_pagar") : "no_ganaste";
    return {
      nombre: full.nombre || "", nivel: t.nombre || tier, plan_club: club.plan_club || "", ciudad: full.ciudad || "", pais: full.pais || "",
      puntos: saldo, escalon: escalonDe(saldo).nombre, ahorro_mes: ahorro.mes || 0, ahorro_anio: ahorro.anio || 0,
      pena: pena ? pena.nombre : null,
      abono: "todavía no disponible en la app", credito: "todavía no disponible en la app",
      subastas: { lotes: pujas.map((p) => ({ titulo: p.titulo, mejor_oferta: p.mejor_oferta, resultado: resultado(p) })), bloqueado_hasta: bloqueo, puede_pujar: !bloqueo },
      estado_socio: club.confirmado ? (club.encontrado === false ? "no figura como titular" : club.al_dia === false ? "con un pago pendiente" : "al día") : "sin confirmar",
      plus: { precio_anio_gs: plus.precioAnio || 0, beneficios: plus.beneficios || [] },
    };
  }
  function ejecutoresAtencion({ socio, conv }) {
    return {
      consultar_cuenta: async () => ({ resultado: await cuentaParaAtencion(socio) }),
      // Beneficios para vender: primero los destacados y los de su ciudad; los que ya puede usar antes que los bloqueados.
      listar_beneficios: async () => {
        const [m, full] = await Promise.all([store.getMembresia(socio.id), store.getSocioById(socio.id).catch(() => null)]);
        const items = store.beneficiosParaNivel ? await store.beneficiosParaNivel((m && m.tier_slug) || "olimpista") : [];
        const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const ciudad = norm(full && full.ciudad);
        const TL = { olimpista: "Olimpista", kids: "Junior", premium: "Plus", socio: "Socio" };
        const lista = items.map((b) => ({ b, local: !!(ciudad && norm(b.comercio_ciudad) === ciudad) }))
          .sort((x, y) => ((y.b.destacado ? 1 : 0) - (x.b.destacado ? 1 : 0)) || ((y.b.desbloqueado ? 1 : 0) - (x.b.desbloqueado ? 1 : 0)) || ((y.local ? 1 : 0) - (x.local ? 1 : 0)) || ((Number(y.b.pct) || 0) - (Number(x.b.pct) || 0)));
        const resultado = lista.slice(0, 12).map(({ b, local }) => ({
          comercio: b.comercio_nombre || "", valor: b.valor || "", titulo: b.titulo || "", rubro: b.comercio_rubro || "", ciudad: b.comercio_ciudad || "",
          destacado: !!b.destacado, en_tu_ciudad: local, puede_usarlo: !!b.desbloqueado, ...(b.desbloqueado ? {} : { requiere: TL[b.nivel_min] || "Plus" }),
        }));
        // Tarjeta con los 3 mejores para mirar de un vistazo (logo, comercio, descuento).
        const top = lista.slice(0, 3).map(({ b }) => ({ comercio: b.comercio_nombre || "", valor: b.valor || "", dias: b.titulo || "", logo: /^\/assets\//.test(b.comercio_logo || "") ? b.comercio_logo : "", bloqueado: !b.desbloqueado }));
        return { resultado, ...(top.length ? { tarjeta: { tipo: "beneficios", titulo: lista.some(({ b }) => b.destacado) ? "Beneficios destacados" : "Beneficios para vos", url: baseUrl() + "/miembro/beneficios", items: top } } : {}) };
      },
      abrir_pago_subasta: async () => {
        const pujas = store.pujasDeSocio ? await store.pujasDeSocio(socio.id, 30) : [];
        const ganado = pujas.find((p) => p.estado === "cerrada" && (p.adjudicado_a || p.ganador_id) === socio.id && p.pago_estado !== "pagado");
        if (!ganado) return { resultado: { ok: false, motivo: "no_tenes_lotes_para_pagar" } };
        const s = await store.getSubasta(ganado.subasta_id);
        if (!s) return { resultado: { ok: false, motivo: "lote_no_encontrado" } };
        if (s.pago_vence && new Date(s.pago_vence).getTime() < Date.now()) return { resultado: { ok: false, motivo: "plazo_vencido", detalle: "El plazo de pago venció: lo resuelve una persona del club." } };
        const r0 = await iniciarPagoSubasta(socio, s, null);
        if (r0.falta_cedula) return { resultado: { ok: false, motivo: "falta_cedula" }, tarjeta: { tipo: "pago_subasta", titulo: "Completá tu cédula para pagar el lote", url: baseUrl() + "/socio" } };
        return { resultado: { ok: true, lote: s.titulo, monto: s.puja_actual }, tarjeta: { tipo: "pago_subasta", titulo: "Pagar «" + s.titulo + "»", url: r0.pago.urlPago } };
      },
      derivar_a_humano: async ({ motivo }) => {
        const mot = String(motivo || "").replace(/[<>]/g, "").trim().slice(0, 200) || "Sin motivo";
        const [m, full] = await Promise.all([store.getMembresia(socio.id), store.getSocioById(socio.id)]);
        const nivel = (tierBySlug((m && m.tier_slug) || "olimpista") || {}).nombre || "Olimpista";
        const c = await store.cambiarEstadoAtencion(conv.id, { desde: ["ia"], a: "humano", patch: { motivo: mot, resumen: mot + " · " + nivel + " · " + ((full && full.ciudad) || "sin ciudad"), derivada_en: new Date().toISOString() } });
        if (c) alertar("atencion:" + conv.id, "Un hincha pide hablar con una persona", [socio.nombre, conv.canal, mot].filter(Boolean).join(" · "));
        return { resultado: { ok: true, derivado: true }, tarjeta: { tipo: "derivado", titulo: "Te paso con una persona del club" } };
      },
    };
  }
  // Mismo motor para la app y para WhatsApp (GHL): quien llama pone el canal.
  async function procesarMensajeAtencion({ socio, texto, canal = "app" }) {
    const conv = await store.abrirConversacionAtencion({ socioId: socio.id, canal });
    const nuevos = [await store.addMensajeAtencion({ conversacionId: conv.id, de: "hincha", texto })];
    if (conv.estado === "humano") return { conversacion: conv, nuevos, via: "humano" };
    const [historial, config] = await Promise.all([store.listMensajesAtencion(conv.id, { limit: 30 }), store.getAtencionConfig()]);
    const out = await atencionLib.responder({
      historial, config, ejecutores: ejecutoresAtencion({ socio, conv }), llamar: llamarIA(),
      contexto: { nombre: socio.nombre, saludar: canal !== "app", hora: Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "America/Asuncion" })) },
      log: (...a) => log.warn({ detalle: a.map(String).join(" ") }, "atención"),
    });
    nuevos.push(await store.addMensajeAtencion({ conversacionId: conv.id, de: "ia", texto: out.texto, meta: out.proveedor ? { via: out.via, proveedor: out.proveedor } : { via: out.via } }));
    for (const tj of out.tarjetas) nuevos.push(await store.addMensajeAtencion({ conversacionId: conv.id, de: "tarjeta", texto: tj.titulo, meta: tj }));
    return { conversacion: await store.getConversacionAtencion(conv.id), nuevos, via: out.via, derivado: !!out.derivado };
  }

  r.get("/atencion/chat", auth.requireSocio, wrap(async (req, res) => {
    const [ultima] = store.listConversacionesDeSocio ? await store.listConversacionesDeSocio(req.socio.id, 1) : [];
    const reciente = ultima && (ultima.estado !== "resuelta" || Date.now() - new Date(ultima.resuelta_en || ultima.actualizado).getTime() < 10 * 60000);
    const m = await store.getMembresia(req.socio.id);
    const sugerencias = atencionLib.sugerenciasPara({ tier: (m && m.tier_slug) || "olimpista", esSocio: !!req.socio.es_socio_olimpia });
    const mensajes = reciente ? (await store.listMensajesAtencion(ultima.id, { limit: 60 })).map(msgPublico) : [];
    res.json({ conversacion: reciente ? { id: ultima.id, estado: ultima.estado, canal: ultima.canal } : null, mensajes, sugerencias, ia: iaConectada(), nombre: atencionLib.primerNombre(req.socio.nombre) });
  }));
  r.post("/atencion/chat", auth.requireSocio, wrap(async (req, res) => {
    const texto = String((req.body && req.body.texto) || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!texto) throw httpError(400, "Escribí tu consulta");
    if (texto.length > atencionLib.MAX_TEXTO) throw httpError(400, "El mensaje es muy largo (máximo " + atencionLib.MAX_TEXTO + " caracteres)");
    if (!atRafagaOk(req.socio.id)) throw httpError(429, "Vas muy rápido. Esperá un momento y volvé a escribir.");
    const tope = Number(process.env.ATENCION_TOPE_DIARIO) || 40;
    if ((await store.incrementarUsoAtencion(req.socio.id, diaPy())) > tope) throw httpError(429, "Llegaste al máximo de mensajes de hoy. Escribinos mañana.");
    const out = await procesarMensajeAtencion({ socio: req.socio, texto, canal: "app" });
    const m = await store.getMembresia(req.socio.id);
    const sugerencias = out.conversacion.estado === "humano" ? [] : atencionLib.seguimientoPara({ texto, tier: (m && m.tier_slug) || "olimpista", esSocio: !!req.socio.es_socio_olimpia, derivado: out.derivado });
    res.json({ estado: out.conversacion.estado, conversacion_id: out.conversacion.id, mensajes: out.nuevos.map(msgPublico), sugerencias });
  }));

  // "Me sirvió" / "No me sirvió" sobre una respuesta del asistente (valor 1, -1, o 0 para quitarlo): el equipo ve qué respuestas no funcionan.
  r.post("/atencion/mensajes/:id/valorar", auth.requireSocio, wrap(async (req, res) => {
    const valor = req.body && req.body.valor;   // número estricto: null o texto no cuentan como "quitar"
    if (![1, -1, 0].includes(valor)) throw httpError(400, "Valoración inválida");
    if (!store.valorarMensajeAtencion) throw httpError(503, "No disponible");
    const out = await store.valorarMensajeAtencion({ mensajeId: String(req.params.id), socioId: req.socio.id, valor });
    if (!out) throw httpError(404, "Mensaje no encontrado");
    res.json({ ok: true, valoracion: valor });
  }));

  // Admin · Atención
  const AT_VACIO = { hoy: 0, semana: 0, solo_ia: 0, primera_resp_min: null, abiertas_humano: 0, utiles: 0, no_utiles: 0 };
  r.get("/admin/atencion", requireAdmin, wrap(async (req, res) => {
    const estado = ["ia", "humano", "resuelta"].includes(req.query.estado) ? req.query.estado : undefined;
    const ahora = Date.now();
    const [items, ind] = await Promise.all([
      store.listBandejaAtencion({ estado, limit: 100 }),
      store.indicadoresAtencion({ desdeDia: new Date(diaPy() + "T03:00:00.000Z").toISOString(), desde7: new Date(ahora - 7 * 86400000).toISOString() }).catch(() => AT_VACIO),
    ]);
    res.json({
      items,
      indicadores: { hoy: ind.hoy, pct_ia: ind.semana ? Math.round((ind.solo_ia / ind.semana) * 100) : null, primera_resp_min: ind.primera_resp_min, abiertas_humano: ind.abiertas_humano, utiles: ind.utiles || 0, no_utiles: ind.no_utiles || 0 },
    });
  }));
  const configAtencion = async () => {
    const cfg = await store.getAtencionConfig();
    return {
      items: atencionLib.CLAVES.map((k) => ({ clave: k, nombre: atencionLib.HERRAMIENTAS[k].nombre, descripcion: atencionLib.HERRAMIENTAS[k].descripcion, activo: !!cfg[k], disponible: atencionLib.HERRAMIENTAS[k].disponible, motivo_no_disponible: atencionLib.HERRAMIENTAS[k].motivo_no_disponible || null })),
      reglas_fijas: atencionLib.REGLAS_FIJAS, modelo: (atencionLib.proveedores()[0] || { modelo: atencionLib.MODELO_GEMINI() }).modelo, proveedor: (atencionLib.proveedores()[0] || {}).nombre || null, ia_conectada: iaConectada(),
    };
  };
  r.get("/admin/atencion/config", requireAdmin, wrap(async (_req, res) => { res.json(await configAtencion()); }));
  r.put("/admin/atencion/config", requireAdmin, requirePerm("atencion.write"), wrap(async (req, res) => {
    const clave = String((req.body && req.body.clave) || ""), activo = !!(req.body && req.body.activo);
    if (!atencionLib.CLAVES.includes(clave)) throw httpError(404, "Acción desconocida");
    if (activo && !atencionLib.HERRAMIENTAS[clave].disponible) throw httpError(409, "Todavía no está disponible: " + (atencionLib.HERRAMIENTAS[clave].motivo_no_disponible || ""));
    await store.setAtencionConfig(clave, activo);
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "atencion:config", targetId: clave, detalle: activo ? "activada" : "desactivada", por: req.adminUser });
    res.json(await configAtencion());
  }));
  r.get("/admin/atencion/:id", requireAdmin, wrap(async (req, res) => {
    const c = await store.getConversacionAtencion(req.params.id);
    if (!c) throw httpError(404, "Conversación no encontrada");
    const [mensajes, socio, m] = await Promise.all([store.listMensajesAtencion(c.id, { limit: 200 }), c.socio_id ? store.getSocioById(c.socio_id) : null, c.socio_id ? store.getMembresia(c.socio_id) : null]);
    res.json({
      conversacion: c, mensajes: mensajes.map(msgPublico),
      socio: socio ? { id: socio.id, nombre: socio.nombre, apellido: socio.apellido, ciudad: socio.ciudad || "", tier: (m && m.tier_slug) || "olimpista" } : null,
    });
  }));
  r.post("/admin/atencion/:id/responder", requireAdmin, requirePerm("atencion.write"), wrap(async (req, res) => {
    const texto = String((req.body && req.body.texto) || "").replace(/[<>]/g, "").trim();
    if (!texto) throw httpError(400, "Escribí la respuesta");
    if (texto.length > 1000) throw httpError(400, "La respuesta es muy larga (máximo 1000 caracteres)");
    let c = await store.getConversacionAtencion(req.params.id);
    if (!c) throw httpError(404, "Conversación no encontrada");
    if (c.estado === "resuelta") throw httpError(409, "La conversación ya está resuelta");
    const ahora = new Date().toISOString();
    if (c.estado === "ia") { // una persona toma la conversación: la IA calla
      c = (await store.cambiarEstadoAtencion(c.id, { desde: ["ia"], a: "humano", patch: { motivo: c.motivo || "Una persona del club tomó la conversación", derivada_en: ahora } })) || (await store.getConversacionAtencion(c.id));
    }
    await store.updateConversacionAtencion(c.id, { asignado_a: req.adminUser, ...(c.humano_responde_en ? {} : { humano_responde_en: ahora }) });
    const msg = await store.addMensajeAtencion({ conversacionId: c.id, de: "humano", texto, meta: { agente: req.adminUser } });
    let entregado = true;
    if (c.canal === "whatsapp") { // la respuesta sale por el mismo canal: GHL
      entregado = false;
      const url = (process.env.GHL_WHATSAPP_URL || "").trim();
      if (/^https:\/\//i.test(url) && c.socio_id) {
        const s = await store.getSocioById(c.socio_id);
        entregado = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversacion_id: c.id, telefono: (s && (s.whatsapp || s.telefono)) || "", texto }) }).then((x) => x.ok).catch(() => false);
      }
    }
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "atencion:responder", targetId: c.id, por: req.adminUser });
    res.status(201).json({ ok: true, mensaje: msgPublico(msg), entregado });
  }));
  r.post("/admin/atencion/:id/resolver", requireAdmin, requirePerm("atencion.write"), wrap(async (req, res) => {
    const c = await store.cambiarEstadoAtencion(req.params.id, { desde: ["ia", "humano"], a: "resuelta", patch: { resuelta_en: new Date().toISOString() } });
    if (!c) throw httpError(409, "La conversación no existe o ya estaba resuelta");
    await store.addMensajeAtencion({ conversacionId: c.id, de: "sistema", texto: "La conversación se cerró. El asistente vuelve a atenderte." });
    if (store.logAccionAdmin) store.logAccionAdmin({ accion: "atencion:resolver", targetId: c.id, por: req.adminUser });
    res.json({ ok: true, conversacion: c });
  }));

  // ─── Centro de ayuda: tutoriales y preguntas frecuentes por perfil (contenido estático en data/ayuda.json) ───
  // Los perfiles del club (CD, Marketing, Comercial, Operaciones, Atención, Admin) solo se ven con sesión del panel.
  const AYUDA = require("./data/ayuda.json");
  async function esSesionAdmin(req) {
    try {
      const token = req.headers["x-admin-token"] || "";
      if (token && store.getAdminSession && (await store.getAdminSession(token))) return true;
      const key = req.headers["x-admin-key"] || "";
      if (key) { const kb = Buffer.from(key); return ADMIN_KEYS.some((a) => { const ab = Buffer.from(a.key); return ab.length === kb.length && crypto.timingSafeEqual(ab, kb); }); }
    } catch (e) { /* sin sesión */ }
    return false;
  }
  r.get("/ayuda", wrap(async (req, res) => {
    const club = await esSesionAdmin(req);
    const visibles = AYUDA.aud.filter((a) => club || !a.club);
    const pedida = String(req.query.aud || "");
    if (pedida && !AYUDA.aud.some((a) => a.id === pedida)) throw httpError(404, "Perfil de ayuda desconocido");
    if (pedida && !visibles.some((a) => a.id === pedida)) throw httpError(403, "Esta ayuda es del equipo del club: entrá al panel para verla");
    const aud = pedida || visibles[0].id;
    const delPerfil = (x) => x.aud.includes(aud);
    const cat = String(req.query.cat || "todas");
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
    const coincide = (x) => !q || JSON.stringify(x).toLowerCase().includes(q);
    const cuenta = (id) => AYUDA.tuts.filter((x) => x.aud.includes(id)).length + AYUDA.faqs.filter((x) => x.aud.includes(id)).length;
    const base = [...AYUDA.tuts, ...AYUDA.faqs].filter(delPerfil);
    res.setHeader("Cache-Control", "no-store"); // depende de si hay sesión del panel
    res.json({
      aud: visibles.map((a) => ({ id: a.id, label: a.label, grupo: a.grupo, desc: a.desc, tile: a.tile, n: cuenta(a.id) })),
      categorias: Object.entries(AYUDA.cats).filter(([id]) => base.some((x) => x.cat === id)).map(([id, label]) => ({ id, label })),
      tuts: AYUDA.tuts.filter((x) => delPerfil(x) && (cat === "todas" || x.cat === cat) && coincide(x)),
      faqs: AYUDA.faqs.filter((x) => delPerfil(x) && (cat === "todas" || x.cat === cat) && coincide(x)),
    });
  }));

  return r;
}

module.exports = { buildRouter };
