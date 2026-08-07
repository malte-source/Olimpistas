"use strict";

/**
 * memory-store.js — Implementación en memoria del store de Olimpistas.
 *
 * Es el backend por defecto cuando NO hay DATABASE_URL: permite ver toda la
 * plataforma funcionando (registro, login, membresías, contenido, sorteos,
 * preventas, carnet) sin provisionar Postgres. Los datos viven en RAM y se
 * pierden al reiniciar (opcionalmente se persisten a un JSON si se pasa filePath).
 *
 * Implementa exactamente la misma interfaz async que pg-store.js, así que el
 * resto de la app no sabe cuál está activo.
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../lib/log");

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

// Link público legible (/subasta/camiseta-tim-payne-a4c en vez de /subasta/sub_b8470b...):
// se genera UNA vez al crear y no cambia aunque se edite el título después (rompería links
// ya compartidos). El sufijo del id garantiza unicidad sin tener que reintentar por colisión.
function slugify(titulo, id) {
  const base = String(titulo || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suf = String(id || "").replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return (base || "subasta") + (suf ? "-" + suf : "");
}

function nowIso() { return new Date().toISOString(); }

// ─── Datos semilla ──────────────────────────────────────────────────────────

function seed() {
  return {
    socios: [],            // {id, email, password_hash, nombre, telefono, creado}
    sesiones: [],          // {token, socio_id, expira}
    admin_usuarios: [],    // {id, usuario, nombre, password_hash, rol, activo, creado, ultimo_acceso}
    admin_sesiones: [],    // {token, admin_id, rol, expira}
    membresias: [],        // {id, socio_id, tier_slug, ciclo, estado, inicio, fin, pago_ref}
    participaciones: [],   // {id, sorteo_id, socio_id, creado}
    reservas: [],          // {id, preventa_id, socio_id, cantidad, creado}
    pedidos: [],           // {id, socio_id, concepto, monto, moneda, estado, ref_externa, creado}
    actualizaciones: [],   // staging de verificación (alta/enriquecimiento/socio_claim)
    email_eventos: [],     // eventos de Resend (entrega/apertura/click/rebote/queja)
    comercios: [],         // Red de Beneficios: comercios adheridos
    beneficios: [],        // beneficios por comercio (con niveles aplicables)
    canjes: [],            // canjes registrados (validaciones)
    comercio_sesiones: [], // sesiones del panel de comercio
    subastas: [],          // lotes en subasta {id, titulo, ..., puja_actual, ganador_id, termina, estado}
    pujas: [],             // pujas {id, subasta_id, socio_id, monto, creado}
    encuestas: [],         // Fan Survey {id, titulo, pregunta, opciones:[], tipo, estado, creado}
    respuestas_encuesta: [], // {id, encuesta_id, socio_id, opcion, texto, creado}
    notificaciones_log: {}, // idempotencia del cron: { "cumple:<socioId>:<YYYY-MM-DD>": ts }
    contenido: [
      {
        id: "c1", titulo: "Resumen Clásico: Olimpia 2 - 1 Cerro",
        tipo: "video", tier_min: "olimpista", duracion: "08:32",
        thumb: "/assets/content-1.svg",
        descripcion: "Los goles y las mejores jugadas del último superclásico en Para Uno.",
        publicado: "2026-06-10",
      },
      {
        id: "c2", titulo: "Entrenamiento a puertas cerradas — semana de Libertadores",
        tipo: "video", tier_min: "premium", duracion: "15:04",
        thumb: "/assets/content-2.svg",
        descripcion: "Acceso exclusivo al trabajo del plantel antes del partido clave.",
        publicado: "2026-06-12",
      },
      {
        id: "c3", titulo: "Mano a mano con el capitán",
        tipo: "video", tier_min: "premium", duracion: "22:48",
        thumb: "/assets/content-3.svg",
        descripcion: "Entrevista íntima sobre la temporada y el sueño de la cuarta.",
        publicado: "2026-06-14",
      },
      {
        id: "c4", titulo: "Documental: El Rey de Copas",
        tipo: "documental", tier_min: "premium", duracion: "48:10",
        thumb: "/assets/content-4.svg",
        descripcion: "La historia de las tres Libertadores, sólo para Olimpistas Premium.",
        publicado: "2026-06-01",
      },
    ],
    sorteos: [
      {
        id: "s1", titulo: "Camiseta firmada por el plantel",
        descripcion: "Participá por una camiseta oficial autografiada por todo el equipo.",
        tier_min: "olimpista", cierra: "2026-07-15", imagen: "/assets/sorteo-1.svg",
      },
      {
        id: "s2", titulo: "2 entradas Palco para el próximo clásico",
        descripcion: "Viví el superclásico desde el palco con todo incluido.",
        tier_min: "premium", cierra: "2026-07-01", imagen: "/assets/sorteo-2.svg",
      },
      {
        id: "s3", titulo: "Experiencia VIP: día con el equipo",
        descripcion: "Conocé el vestuario, sacate fotos y mirá un entrenamiento en vivo.",
        tier_min: "premium", cierra: "2026-08-01", imagen: "/assets/sorteo-3.svg",
      },
    ],
    preventas: [
      {
        id: "p1", evento: "Olimpia vs Cerro Porteño — Superclásico",
        fecha: "2026-07-20", sede: "Estadio Manuel Ferreira",
        abre: "2026-06-25", tier_min: "premium",
        precio_desde: 80000, imagen: "/assets/preventa-1.svg", stock: 1200,
      },
      {
        id: "p2", evento: "Olimpia vs Guaraní — Fecha 12",
        fecha: "2026-07-05", sede: "Estadio Manuel Ferreira",
        abre: "2026-06-20", tier_min: "olimpista",
        precio_desde: 50000, imagen: "/assets/preventa-2.svg", stock: 3000,
      },
    ],
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createMemoryStore({ filePath = null } = {}) {
  let db = seed();

  if (filePath && fs.existsSync(filePath)) {
    try { db = { ...seed(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) }; }
    catch { /* archivo corrupto → arranca limpio */ }
  }

  function persist() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
    } catch (e) { log.error({ err: e.message }, "memory-store persist falló"); }
  }

  return {
    kind: "memory",

    // ── Socios ──
    async createSocio({ email, passwordHash, nombre, apellido, telefono, cedula, fechaNacimiento, referidoPor, idioma }) {
      const id = uid("soc");
      const socio = {
        id, email: email.toLowerCase(), password_hash: passwordHash,
        nombre: nombre || "", apellido: apellido || "", telefono: telefono || "",
        // Campos de enriquecimiento (barra de progreso, se completan después):
        whatsapp: "", foto: "", pais: "", pais_iso: "", ciudad: "",
        lat: null, lng: null,   // ubicación exacta (opcional) para el globo
        email_verificado: false, verif_token: null,
        cedula: cedula || "", fecha_nacimiento: fechaNacimiento || null, es_socio_olimpia: false,
        idioma: idioma === "en" ? "en" : "es",
        ref_codigo: crypto.createHash("md5").update(id).digest("hex").slice(0, 10),
        referido_por: referidoPor || null,
        creado: nowIso(),
      };
      db.socios.push(socio); persist();
      return socio;
    },
    // ── Referidos ──
    async getSocioByRefCodigo(codigo) {
      const c = String(codigo || "").trim().toLowerCase();
      if (!c) return null;
      return db.socios.find((s) => s.ref_codigo === c) || null;
    },
    async contarReferidos(socioId) {
      return db.socios.filter((s) => s.referido_por === socioId).length;
    },
    async topReferidores(limit = 20) {
      const conteo = {};
      for (const s of db.socios) { if (s.referido_por) conteo[s.referido_por] = (conteo[s.referido_por] || 0) + 1; }
      return Object.entries(conteo)
        .map(([id, referidos]) => { const s = db.socios.find((x) => x.id === id) || {}; return { id, nombre: s.nombre, ciudad: s.ciudad, pais_iso: s.pais_iso, referidos }; })
        .sort((a, b) => b.referidos - a.referidos)
        .slice(0, Math.min(Number(limit) || 20, 100));
    },
    async getSocioByCedula(cedula) {
      const ced = String(cedula || "").replace(/\D/g, "");
      if (!ced) return null;
      return db.socios.find((s) => (s.cedula || "").replace(/\D/g, "") === ced && s.cedula) || null;
    },
    // ── Padrón oficial (en memoria, para dev/test) ──
    async buscarPadron({ email, cedula }) {
      const em = (email || "").toLowerCase().trim();
      const ced = (cedula || "").replace(/\D/g, "");
      if (!em && !ced) return null;
      return (db.padron || []).find((p) =>
        (em && (p.email || "").toLowerCase() === em) ||
        (ced && (p.cedula || "").replace(/\D/g, "") === ced)) || null;
    },
    async marcarPadronReclamado(id, socioId) {
      const p = (db.padron || []).find((x) => x.id === id);
      if (!p || p.reclamado) return false; // ya reclamado → no gana (reclamo único)
      p.reclamado = true; p.socio_id = socioId; persist();
      return true;
    },

    // ── Base de Actualización (staging) ──
    async crearActualizacion(a) {
      if (!db.actualizaciones) db.actualizaciones = [];
      const r = {
        id: uid("act"), socio_id: a.socioId || null, tipo: a.tipo,
        nombre: a.nombre || "", apellido: a.apellido || "", email: a.email || "",
        cedula: a.cedula || "", pais: a.pais || "", ciudad: a.ciudad || "",
        fecha_nacimiento: a.fechaNacimiento || null, tiene_selfie: !!a.tieneSelfie,
        tier_pretendido: a.tierPretendido || "", match_padron_id: a.matchPadronId || null,
        estado: a.estado || "pendiente", notas: a.notas || "",
        verificado_por: null, verificado_en: null, creado: nowIso(), actualizado: nowIso(),
      };
      db.actualizaciones.push(r); persist();
      return r;
    },
    async updateActualizacion(id, patch) {
      const r = (db.actualizaciones || []).find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch, { actualizado: nowIso() }); persist();
      return r;
    },
    async listActualizaciones({ estado, tipo, socioId, limit } = {}) {
      let rows = (db.actualizaciones || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
      if (estado) rows = rows.filter((r) => r.estado === estado);
      if (tipo) rows = rows.filter((r) => r.tipo === tipo);
      if (socioId) rows = rows.filter((r) => r.socio_id === socioId);
      return rows.slice(0, Math.min(Number(limit) || 100, 500));
    },
    // Reportes admin (paridad con pg-store; en memoria no hay seeds @demo).
    async estadisticasAdmin() {
      const ss = db.socios || [];
      const embudo = {
        total: ss.length,
        con_foto: ss.filter((s) => s.foto).length,
        valido_socio: ss.filter((s) => s.es_socio_olimpia).length,
        email_verif: ss.filter((s) => s.email_verificado).length,
      };
      const esPago = (ref) => !!(ref && String(ref).trim()) && !/^socio:/.test(ref); // pago/manual, no el grant de socio
      const porTier = {};
      for (const m of db.membresias || []) {
        if (m.estado !== "activa") continue;
        const t = (porTier[m.tier_slug] = porTier[m.tier_slug] || { tier_slug: m.tier_slug, total: 0, pagados: 0 });
        t.total++; if (esPago(m.pago_ref)) t.pagados++;
      }
      embudo.iniciaron_pago = new Set((db.pedidos || []).map((p) => p.socio_id)).size;
      const py = new Date(Date.now() - 3 * 3600000); py.setUTCHours(0, 0, 0, 0);
      const hoyIni = py.getTime() + 3 * 3600000, ayerIni = hoyIni - 24 * 3600000;
      const tms = (s) => new Date(s.creado || 0).getTime();
      const tiempo = {
        hoy: ss.filter((s) => tms(s) >= hoyIni).length,
        ayer: ss.filter((s) => tms(s) >= ayerIni && tms(s) < hoyIni).length,
      };
      return { embudo, membresias: Object.values(porTier), altas: [], tiempo };
    },
    async filtrarSocios(f = {}) {
      const tierDe = (id) => { const m = (db.membresias || []).filter((x) => x.socio_id === id && x.estado === "activa").slice(-1)[0]; return (m && m.tier_slug) || "olimpista"; };
      const term = String(f.q || "").toLowerCase();
      let rows = (db.socios || []).filter((s) => {
        if (f.paisIso && String(s.pais_iso || "").toUpperCase() !== String(f.paisIso).toUpperCase()) return false;
        if (f.validoSocio && !s.es_socio_olimpia) return false;
        if (f.sinFoto && s.foto) return false;
        if (f.tier && tierDe(s.id) !== f.tier) return false;
        if (term && !((s.email || "").toLowerCase().includes(term) || ((s.nombre || "") + " " + (s.apellido || "")).toLowerCase().includes(term) || (s.cedula || "").includes(term))) return false;
        return true;
      }).sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
      return rows.slice(0, Math.min(Number(f.limit) || 500, 5000)).map((s) => ({ id: s.id, nombre: s.nombre, apellido: s.apellido, email: s.email, cedula: s.cedula, pais: s.pais, pais_iso: s.pais_iso, es_socio_olimpia: s.es_socio_olimpia, tiene_foto: !!s.foto, tier_slug: tierDe(s.id), creado: s.creado }));
    },
    async cuadrePagos() {
      const peds = db.pedidos || [];
      const cnt = (st) => peds.filter((p) => p.estado === st).length;
      const esPagoReal = (ref) => !!(ref && String(ref).trim()) && !/^socio:/.test(ref);
      const mems = (db.membresias || []).filter((m) => m.estado === "activa" && esPagoReal(m.pago_ref));
      const acts = (db.actualizaciones || []).filter((a) => a.tipo === "pago_metrepay");
      return {
        pedidos: { pendiente: cnt("pendiente"), pagado: cnt("pagado"), rechazado: cnt("rechazado") },
        membresiasPagas: { premium: mems.filter((m) => m.tier_slug === "premium").length, kids: mems.filter((m) => m.tier_slug === "kids").length },
        metrepay: { activados: acts.filter((a) => a.estado === "validado_auto").length, sin_match: acts.filter((a) => a.estado === "a_revisar").length, total: acts.length },
      };
    },
    async cumplenHoy() {
      const hoy = new Date().toISOString().slice(5, 10); // MM-DD (UTC, aprox)
      return (db.socios || []).filter((s) => s.fecha_nacimiento && String(s.fecha_nacimiento).slice(5, 10) === hoy
        && s.email && !String(s.email).endsWith("@demo.olimpistas.test") && !s.marketing_baja)
        .map((s) => ({ id: s.id, nombre: s.nombre, email: s.email, idioma: s.idioma, pais_iso: s.pais_iso }));
    },
    async membresiasPorVencer(dias) {
      const now = Date.now(), lim = now + (Number(dias) || 7) * 86400000;
      const out = [];
      (db.membresias || []).forEach((m) => {
        if (m.estado !== "activa" || !["premium", "kids"].includes(m.tier_slug)) return;
        if (!m.pago_ref || /^socio:/.test(m.pago_ref)) return;
        const s = (db.socios || []).find((x) => x.id === m.socio_id);
        if (!s || !s.email || String(s.email).endsWith("@demo.olimpistas.test") || s.marketing_baja) return;
        const vence = new Date(m.inicio).getTime() + 365 * 86400000;
        if (vence >= now && vence <= lim) out.push({ id: s.id, nombre: s.nombre, email: s.email, idioma: s.idioma, pais_iso: s.pais_iso, tier_slug: m.tier_slug, dias_rest: Math.round((vence - now) / 86400000) });
      });
      return out;
    },
    // ── Red de Beneficios ──
    async listComercios() { return (db.comercios || []).slice().sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))); },
    async getComercio(id) { return (db.comercios || []).find((c) => c.id === id) || null; },
    async crearComercio(d = {}) { const c = { id: uid("com"), nombre: d.nombre || "", rubro: d.rubro || "", logo: d.logo || "", direccion: d.direccion || "", ciudad: d.ciudad || "", contacto: d.contacto || "", usuario: null, password_hash: null, estado: d.estado || "activo", creado: nowIso() }; (db.comercios = db.comercios || []).push(c); persist(); return c; },
    async updateComercio(id, patch) { const c = (db.comercios || []).find((x) => x.id === id); if (!c) return null; Object.assign(c, patch); persist(); return c; },
    async deleteComercio(id) { db.comercios = (db.comercios || []).filter((c) => c.id !== id); db.beneficios = (db.beneficios || []).filter((b) => b.comercio_id !== id); persist(); return true; },

    async listBeneficios() { const cm = {}; (db.comercios || []).forEach((c) => (cm[c.id] = c)); return (db.beneficios || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))).map((b) => ({ ...b, comercio_nombre: (cm[b.comercio_id] || {}).nombre })); },
    async getBeneficio(id) { return (db.beneficios || []).find((b) => b.id === id) || null; },
    async crearBeneficio(d = {}) { const num = (v) => (v != null && v !== "" ? Number(v) : null); const b = { id: uid("ben"), comercio_id: d.comercio_id, titulo: d.titulo || "", descripcion: d.descripcion || "", tipo: d.tipo || "descuento", valor: d.valor || "", niveles: d.niveles || "todos", pct: num(d.pct), ahorro_estimado: num(d.ahorro_estimado), vigencia_desde: d.vigencia_desde || null, vigencia_hasta: d.vigencia_hasta || null, limite_dias: num(d.limite_dias), activo: d.activo !== false, creado: nowIso() }; (db.beneficios = db.beneficios || []).push(b); persist(); return b; },
    async updateBeneficio(id, patch) { const b = (db.beneficios || []).find((x) => x.id === id); if (!b) return null; Object.assign(b, patch); persist(); return b; },
    async deleteBeneficio(id) { db.beneficios = (db.beneficios || []).filter((b) => b.id !== id); persist(); return true; },

    async beneficiosParaNivel(tier) {
      const hoy = new Date().toISOString().slice(0, 10);
      const ORD = ["olimpista", "kids", "premium", "socio"];
      const cm = {}; (db.comercios || []).forEach((c) => (cm[c.id] = c));
      return (db.beneficios || []).filter((b) => {
        const c = cm[b.comercio_id];
        if (!b.activo || !c || c.estado !== "activo") return false;
        if (b.vigencia_desde && String(b.vigencia_desde).slice(0, 10) > hoy) return false;
        if (b.vigencia_hasta && String(b.vigencia_hasta).slice(0, 10) < hoy) return false;
        return true;
      }).map((b) => {
        const c = cm[b.comercio_id] || {};
        const nivs = b.niveles === "todos" ? "todos" : String(b.niveles).split(",").map((x) => x.trim()).filter(Boolean);
        // ESCALONADO: un tier alto desbloquea los beneficios de niveles inferiores.
        const idxs = nivs === "todos" ? [0] : nivs.map((n) => ORD.indexOf(n)).filter((i) => i >= 0);
        const nivelReq = idxs.length ? Math.min.apply(null, idxs) : 0;
        const desbloqueado = Math.max(0, ORD.indexOf(tier)) >= nivelReq;
        const nivel_min = ORD[nivelReq] || "olimpista";
        return { ...b, comercio_nombre: c.nombre, comercio_rubro: c.rubro, comercio_logo: c.logo, comercio_ciudad: c.ciudad, desbloqueado: desbloqueado, nivel_min: nivel_min };
      });
    },
    async registrarCanje({ beneficioId, socioId, comercioId, validadoPor, monto, ahorro } = {}) { const c = { id: uid("cnj"), beneficio_id: beneficioId, socio_id: socioId || null, comercio_id: comercioId || null, validado_por: validadoPor || "", monto: monto != null ? Math.round(monto) : null, ahorro: ahorro != null ? Math.round(ahorro) : null, creado: nowIso() }; (db.canjes = db.canjes || []).push(c); persist(); return c; },
    async ultimoCanje(socioId, beneficioId) { return (db.canjes || []).filter((c) => c.socio_id === socioId && c.beneficio_id === beneficioId).sort((a, b) => String(b.creado).localeCompare(String(a.creado)))[0] || null; },
    async resumenAhorroSocio(socioId) {
      const mesIni = new Date().toISOString().slice(0, 7); // YYYY-MM
      let mes = 0, total = 0;
      (db.canjes || []).forEach((c) => { if (c.socio_id !== socioId) return; const a = Number(c.ahorro) || 0; total += a; if (String(c.creado).slice(0, 7) === mesIni) mes += a; });
      return { mes, total };
    },
    // ── Auth del panel de comercio ──
    async getComercioByUsuario(usuario) { const u = String(usuario || "").toLowerCase(); return (db.comercios || []).find((c) => (c.usuario || "").toLowerCase() === u) || null; },
    async setComercioAcceso(id, usuario, passwordHash) { const c = (db.comercios || []).find((x) => x.id === id); if (!c) return null; c.usuario = String(usuario || "").toLowerCase(); c.password_hash = passwordHash; persist(); return c; },
    async createComercioSession(comercioId, token, expiraIso) { (db.comercio_sesiones = db.comercio_sesiones || []).push({ token, comercio_id: comercioId, expira: expiraIso }); persist(); return true; },
    async getComercioSession(token) {
      const s = (db.comercio_sesiones || []).find((x) => x.token === token);
      if (!s || new Date(s.expira).getTime() < Date.now()) return null;
      const c = (db.comercios || []).find((x) => x.id === s.comercio_id);
      if (!c || c.estado !== "activo") return null;
      return { token: s.token, expira: s.expira, comercio_id: c.id, nombre: c.nombre, estado: c.estado };
    },
    async beneficiosDeComercio(comercioId) { return (db.beneficios || []).filter((b) => b.comercio_id === comercioId && b.activo).sort((a, b) => String(b.creado).localeCompare(String(a.creado))); },

    // ── Subastas ──
    async listSubastas() {
      return (db.subastas || []).slice().sort((a, b) => String(a.termina).localeCompare(String(b.termina))).map((s) => {
        if (!s.ganador_id) return s;
        const g = (db.socios || []).find((x) => x.id === s.ganador_id);
        return { ...s, ganador_nombre: g ? g.nombre : null };
      });
    },
    // Acepta el id interno O el slug (link público) — así cualquier ruta que reciba
    // "lo que sea que vino en la URL" sigue funcionando sin tener que saber cuál es.
    async getSubasta(idOrSlug) { return (db.subastas || []).find((x) => x.id === idOrSlug || x.slug === idOrSlug) || null; },
    async crearSubasta(d = {}) {
      const id = uid("sub");
      const s = { id, titulo: d.titulo || "", descripcion: d.descripcion || "", imagen: d.imagen || null, emoji: d.emoji || "🔨",
        nivel_min: d.nivel_min || "premium", precio_inicial: Math.round(d.precio_inicial || 0), incremento: Math.round(d.incremento || 50000),
        puja_actual: Math.round(d.precio_inicial || 0), ganador_id: null,
        duracion_horas: d.duracion_horas != null ? Math.round(d.duracion_horas) : 48,
        inicia: d.inicia || nowIso(), termina: d.termina || null, estado: d.estado || "borrador", notificado: false, creado: nowIso(),
        slug: slugify(d.titulo, id) };
      (db.subastas = db.subastas || []).push(s); persist(); return s;
    },
    async updateSubasta(id, patch) { const s = (db.subastas || []).find((x) => x.id === id); if (!s) return null; Object.assign(s, patch); persist(); return s; },
    async deleteSubasta(id) { db.subastas = (db.subastas || []).filter((s) => s.id !== id); db.pujas = (db.pujas || []).filter((p) => p.subasta_id !== id); persist(); return true; },
    async pujar({ subastaId, socioId, monto } = {}) {
      const s = (db.subastas || []).find((x) => x.id === subastaId);
      if (!s) return { ok: false, motivo: "no_existe" };
      if (s.estado !== "activa" || new Date(s.termina).getTime() <= Date.now()) return { ok: false, motivo: "cerrada" };
      const minima = (s.puja_actual || s.precio_inicial || 0) + (s.incremento || 0);
      if (Math.round(monto) < minima) return { ok: false, motivo: "monto_bajo", minima };
      const prevGanador = s.ganador_id && s.ganador_id !== socioId ? s.ganador_id : null;
      (db.pujas = db.pujas || []).push({ id: uid("puj"), subasta_id: subastaId, socio_id: socioId, monto: Math.round(monto), creado: nowIso() });
      s.puja_actual = Math.round(monto); s.ganador_id = socioId;
      const ANTISNIPE = 3 * 60 * 1000;
      let extendida = false;
      if (new Date(s.termina).getTime() - Date.now() < ANTISNIPE) { s.termina = new Date(Date.now() + ANTISNIPE).toISOString(); extendida = true; }
      persist();
      return { ok: true, subasta: s, prevGanador, extendida };
    },
    async pujasDeSubasta(subastaId, limit = 8) {
      return (db.pujas || []).filter((p) => p.subasta_id === subastaId)
        .sort((a, b) => (b.monto - a.monto) || String(b.creado).localeCompare(String(a.creado))).slice(0, limit)
        .map((p) => { const s = (db.socios || []).find((x) => x.id === p.socio_id) || {}; return { ...p, nombre: s.nombre || "Olimpista" }; });
    },
    async miPujaMax(subastaId, socioId) {
      const ms = (db.pujas || []).filter((p) => p.subasta_id === subastaId && p.socio_id === socioId).map((p) => p.monto);
      return ms.length ? Math.max.apply(null, ms) : 0;
    },
    async contarPujadores(subastaId) { return new Set((db.pujas || []).filter((p) => p.subasta_id === subastaId).map((p) => p.socio_id)).size; },
    async cerrarSubastasVencidas() {
      const now = Date.now(), cerradas = [];
      (db.subastas || []).forEach((s) => { if (s.estado === "activa" && new Date(s.termina).getTime() <= now) { s.estado = "cerrada"; cerradas.push(s); } });
      if (cerradas.length) persist(); return cerradas;
    },
    async abrirProgramadas() {
      const now = Date.now(), abiertas = [];
      (db.subastas || []).forEach((s) => {
        if (s.estado === "programada" && s.inicia && new Date(s.inicia).getTime() <= now) {
          s.estado = "activa";
          if (!s.termina) s.termina = new Date(new Date(s.inicia).getTime() + (Number(s.duracion_horas) || 48) * 3600000).toISOString();
          abiertas.push(s);
        }
      });
      if (abiertas.length) persist(); return abiertas;
    },
    async marcarSubastaNotificada(id) { const s = (db.subastas || []).find((x) => x.id === id); if (s) { s.notificado = true; persist(); } return true; },
    async subastasSinNotificar() { return (db.subastas || []).filter((s) => s.estado === "cerrada" && s.ganador_id && !s.notificado); },

    // ── Encuestas (Fan Survey) ──
    async listEncuestas() { return (db.encuestas || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))); },
    async encuestasActivas() { return (db.encuestas || []).filter((e) => e.estado === "activa"); },
    async getEncuesta(id) { return (db.encuestas || []).find((x) => x.id === id) || null; },
    async crearEncuesta(d = {}) {
      const e = { id: uid("enc"), titulo: d.titulo || "", pregunta: d.pregunta || "",
        opciones: Array.isArray(d.opciones) ? d.opciones : (typeof d.opciones === "string" && d.opciones.trim() ? d.opciones.split("|").map((s) => s.trim()).filter(Boolean) : []),
        tipo: d.tipo || "opcion", nivel_min: d.nivel_min || "olimpista", estado: d.estado || "borrador", creado: nowIso() };
      (db.encuestas = db.encuestas || []).push(e); persist(); return e;
    },
    async updateEncuesta(id, patch) {
      const e = (db.encuestas || []).find((x) => x.id === id); if (!e) return null;
      if (typeof patch.opciones === "string") patch.opciones = patch.opciones.split("|").map((s) => s.trim()).filter(Boolean);
      Object.assign(e, patch); persist(); return e;
    },
    async deleteEncuesta(id) {
      db.encuestas = (db.encuestas || []).filter((e) => e.id !== id);
      db.respuestas_encuesta = (db.respuestas_encuesta || []).filter((r) => r.encuesta_id !== id);
      persist(); return true;
    },
    async miRespuestaEncuesta(encuestaId, socioId) { return (db.respuestas_encuesta || []).find((r) => r.encuesta_id === encuestaId && r.socio_id === socioId) || null; },
    async responderEncuesta({ encuestaId, socioId, opcion, texto } = {}) {
      const e = (db.encuestas || []).find((x) => x.id === encuestaId);
      if (!e || e.estado !== "activa") return { ok: false, motivo: "cerrada" };
      let r = (db.respuestas_encuesta || []).find((x) => x.encuesta_id === encuestaId && x.socio_id === socioId);
      if (r) { if (opcion != null) r.opcion = opcion; if (texto != null) r.texto = texto; r.creado = nowIso(); }
      else { r = { id: uid("resp"), encuesta_id: encuestaId, socio_id: socioId, opcion: opcion != null ? opcion : null, texto: texto != null ? texto : null, creado: nowIso() }; (db.respuestas_encuesta = db.respuestas_encuesta || []).push(r); }
      persist(); return { ok: true, respuesta: r };
    },
    async resultadosEncuesta(encuestaId) {
      const e = (db.encuestas || []).find((x) => x.id === encuestaId); if (!e) return null;
      const rs = (db.respuestas_encuesta || []).filter((r) => r.encuesta_id === encuestaId);
      return { id: e.id, titulo: e.titulo, pregunta: e.pregunta, tipo: e.tipo, total: rs.length,
        conteo: e.tipo === "texto" ? [] : (e.opciones || []).map((op, i) => ({ opcion: op, i, n: rs.filter((r) => Number(r.opcion) === i).length })),
        textos: e.tipo === "texto" ? rs.map((r) => r.texto).filter(Boolean).slice(-200).reverse() : [] };
    },

    async registrarEmailEvento({ tipo, email, messageId, asunto } = {}) {
      (db.email_eventos = db.email_eventos || []).push({ id: uid("eev"), tipo: tipo || "", email: (email || "").toLowerCase(), message_id: messageId || "", asunto: asunto || "", creado: nowIso() });
      persist(); return { id: "ok" };
    },
    async marcarBajaPorEmail(email) {
      const e = String(email || "").toLowerCase(); let n = 0;
      (db.socios || []).forEach((s) => { if ((s.email || "").toLowerCase() === e && !s.marketing_baja) { s.marketing_baja = true; s.marketing_baja_en = nowIso(); n++; } });
      if (n) persist(); return n;
    },
    async metricasEmail(dias = 30) {
      const evs = db.email_eventos || [];
      const desde = new Date(Date.now() - dias * 86400000).toISOString();
      const cnt = (arr) => { const o = {}; arr.forEach((e) => (o[e.tipo] = (o[e.tipo] || 0) + 1)); return o; };
      return { dias, ventana: cnt(evs.filter((e) => e.creado >= desde)), total: cnt(evs) };
    },
    async pagosRecibidos() {
      const esReal = (p) => { const s = db.socios.find((x) => x.id === p.socio_id); return s && !String(s.email || "").endsWith("@demo.olimpistas.test"); };
      const pagados = (db.pedidos || []).filter((p) => p.estado === "pagado" && esReal(p));
      const pyg = pagados.filter((p) => !p.moneda || p.moneda === "PYG");
      const now = Date.now();
      const desde = (dias) => new Date(now - dias * 86400000).toISOString();
      const sum = (arr) => arr.reduce((a, p) => a + (Number(p.monto) || 0), 0);
      const totales = {
        total: sum(pyg),
        hoy: sum(pyg.filter((p) => p.creado >= desde(1))),
        d7: sum(pyg.filter((p) => p.creado >= desde(7))),
        d30: sum(pyg.filter((p) => p.creado >= desde(30))),
        n: pagados.length,
      };
      const byTipo = {};
      pyg.forEach((p) => {
        const tipo = p.reserva_id ? "entrada" : (p.tier_slug === "premium" ? "plus" : p.tier_slug === "kids" ? "junior" : (p.tier_slug || "otro"));
        (byTipo[tipo] = byTipo[tipo] || { tipo, n: 0, monto: 0 });
        byTipo[tipo].n++; byTipo[tipo].monto += Number(p.monto) || 0;
      });
      const ultimos = pagados.slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, 200).map((p) => {
        const s = db.socios.find((x) => x.id === p.socio_id) || {};
        return { ...p, nombre: s.nombre, apellido: s.apellido, email: s.email };
      });
      return { totales, porConcepto: Object.values(byTipo).sort((a, b) => b.monto - a.monto), ultimos };
    },
    async logAccionAdmin({ accion, targetId, detalle, por } = {}) {
      (db.acciones = db.acciones || []).push({ id: "acc_" + Date.now() + "_" + (db.acciones ? db.acciones.length : 0), accion, target_id: targetId || null, detalle: detalle || "", por: por || "admin", creado: new Date().toISOString() });
    },
    async listAccionesAdmin({ limit } = {}) {
      return (db.acciones || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, Math.min(Number(limit) || 100, 500));
    },
    async getSocioByEmail(email) {
      return db.socios.find(s => s.email === String(email).toLowerCase()) || null;
    },
    async getSocioById(id) { return db.socios.find(s => s.id === id) || null; },
    async getSocioByVerifToken(token) { return db.socios.find(s => s.verif_token === token) || null; },
    async getSocioByResetToken(token) { return token ? (db.socios.find(s => s.reset_token === token) || null) : null; },

    // ── Estadísticas (contador + globo) ──
    // (en memoria no hay seeds @demo, así que cuenta a todos; demoAgregado vacío)
    async contarTotal() { return db.socios.length; },
    async demoAgregado() { return []; },
    async contarPorPais() {
      const m = {};
      for (const s of db.socios) if (s.pais_iso) m[s.pais_iso] = (m[s.pais_iso] || 0) + 1;
      return Object.entries(m).map(([pais_iso, count]) => ({ pais_iso, count }));
    },
    // Agregado por ciudad: cada punto del globo (bandera) con ciudad + país.
    async contarPorCiudad() {
      const g = {};
      for (const s of db.socios) {
        if (!s.pais_iso) continue;
        const ciudad = (s.ciudad || "").trim();
        const k = s.pais_iso + "|" + ciudad.toLowerCase();
        const row = g[k] || (g[k] = { pais_iso: s.pais_iso, ciudad, count: 0, latSum: 0, lngSum: 0, n: 0 });
        row.count++;
        if (s.lat != null && s.lng != null) { row.latSum += s.lat; row.lngSum += s.lng; row.n++; }
      }
      return Object.values(g).map((r) => ({
        pais_iso: r.pais_iso, ciudad: r.ciudad, count: r.count,
        lat: r.n ? r.latSum / r.n : null, lng: r.n ? r.lngSum / r.n : null,
      }));
    },
    async flagsEnBBox({ minLng, minLat, maxLng, maxLat, limit = 600 }) {
      const out = [];
      for (const s of db.socios) {
        if (!s.mostrar_exacto || s.lat == null || s.lng == null) continue;
        if (s.lng < minLng || s.lng > maxLng || s.lat < minLat || s.lat > maxLat) continue;
        out.push({ id: s.id, nombre: s.nombre || "", ciudad: s.ciudad, lat: s.lat, lng: s.lng });
        if (out.length >= Math.min(Number(limit) || 600, 1500)) break;
      }
      return out;
    },
    async updateSocio(id, patch) {
      const s = db.socios.find(x => x.id === id);
      if (!s) return null;
      Object.assign(s, patch); persist();
      return s;
    },

    // ── Sesiones ──
    async createSession(socioId, token, expiraIso) {
      const sess = { token, socio_id: socioId, expira: expiraIso };
      db.sesiones.push(sess); persist();
      return sess;
    },
    async getSession(token) {
      const sess = db.sesiones.find(s => s.token === token);
      if (!sess) return null;
      if (new Date(sess.expira).getTime() < Date.now()) {
        db.sesiones = db.sesiones.filter(s => s.token !== token); persist();
        return null;
      }
      const socio = db.socios.find(s => s.id === sess.socio_id) || null;
      return socio ? { session: sess, socio } : null;
    },
    async deleteSession(token) {
      db.sesiones = db.sesiones.filter(s => s.token !== token); persist();
    },
    async borrarSesionesDeSocio(socioId) { const n = db.sesiones.length; db.sesiones = db.sesiones.filter((s) => s.socio_id !== socioId); if (db.sesiones.length !== n) persist(); return true; },
    async purgarSesionesVencidas() { const n = db.sesiones.length; db.sesiones = db.sesiones.filter((s) => new Date(s.expira).getTime() > Date.now()); if (db.sesiones.length !== n) persist(); return n - db.sesiones.length; },
    async reservarNotificacion(clave) { db.notificaciones_log = db.notificaciones_log || {}; if (db.notificaciones_log[clave]) return false; db.notificaciones_log[clave] = nowIso(); persist(); return true; },

    // ── Membresías ──
    async setMembresia(socioId, m) {
      // Desactiva membresías previas, agrega la nueva activa
      db.membresias.forEach(x => { if (x.socio_id === socioId && x.estado === "activa") x.estado = "reemplazada"; });
      const mem = {
        id: uid("mem"), socio_id: socioId, tier_slug: m.tierSlug,
        ciclo: m.ciclo || "anio", estado: m.estado || "activa",
        inicio: m.inicio || nowIso(), fin: m.fin || null, pago_ref: m.pagoRef || null,
      };
      db.membresias.push(mem); persist();
      return mem;
    },
    async getMembresia(socioId) {
      return db.membresias.filter(m => m.socio_id === socioId && m.estado === "activa").slice(-1)[0] || null;
    },

    // ── Contenido ──
    async listContenido() { return db.contenido.slice().sort((a, b) => String(b.publicado || "").localeCompare(String(a.publicado || ""))); },
    async getContenido(id) { return db.contenido.find(c => c.id === id) || null; },

    // ── Sorteos ──
    async listSorteos() { return db.sorteos.slice().sort((a, b) => String(a.cierra || "").localeCompare(String(b.cierra || ""))); },
    async getSorteo(id) { return db.sorteos.find(s => s.id === id) || null; },
    async participarSorteo(sorteoId, socioId) {
      const ya = db.participaciones.find(p => p.sorteo_id === sorteoId && p.socio_id === socioId);
      if (ya) return ya;
      const p = { id: uid("par"), sorteo_id: sorteoId, socio_id: socioId, creado: nowIso() };
      db.participaciones.push(p); persist();
      return p;
    },
    async listParticipaciones(socioId) {
      return db.participaciones.filter(p => p.socio_id === socioId);
    },

    // ── Preventas ──
    async listPreventas() { return db.preventas.slice().sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || ""))); },
    // ── CRUD admin (memoria) ──
    async crearSorteo(d = {}) { const s = { id: "sor_" + Date.now() + db.sorteos.length, titulo: d.titulo || "", descripcion: d.descripcion || null, tier_min: d.tier_min || "olimpista", cierra: d.cierra || null, imagen: d.imagen || null }; db.sorteos.push(s); persist(); return s; },
    async updateSorteo(id, patch) { const s = db.sorteos.find((x) => x.id === id); if (!s) return null; Object.assign(s, patch); persist(); return s; },
    async deleteSorteo(id) { const n = db.sorteos.length; db.sorteos = db.sorteos.filter((x) => x.id !== id); persist(); return db.sorteos.length < n; },
    async listParticipantesSorteo(id) { return (db.participaciones || []).filter((p) => p.sorteo_id === id).map((p) => { const s = db.socios.find((x) => x.id === p.socio_id) || {}; return { id: s.id, nombre: s.nombre, apellido: s.apellido, email: s.email }; }); },
    async crearPreventa(d = {}) { const p = { id: "pre_" + Date.now() + db.preventas.length, evento: d.evento || "", fecha: d.fecha || null, sede: d.sede || null, abre: d.abre || null, tier_min: d.tier_min || "olimpista", precio_desde: d.precio_desde != null ? Number(d.precio_desde) : null, imagen: d.imagen || null, stock: d.stock != null ? Number(d.stock) : 0 }; db.preventas.push(p); persist(); return p; },
    async updatePreventa(id, patch) { const p = db.preventas.find((x) => x.id === id); if (!p) return null; Object.assign(p, patch); persist(); return p; },
    async deletePreventa(id) { const n = db.preventas.length; db.preventas = db.preventas.filter((x) => x.id !== id); persist(); return db.preventas.length < n; },
    async crearContenido(d = {}) { const c = { id: "con_" + Date.now() + db.contenido.length, titulo: d.titulo || "", tipo: d.tipo || "video", tier_min: d.tier_min || "olimpista", duracion: d.duracion || null, thumb: d.thumb || null, descripcion: d.descripcion || null, publicado: d.publicado || null }; db.contenido.push(c); persist(); return c; },
    async updateContenido(id, patch) { const c = db.contenido.find((x) => x.id === id); if (!c) return null; Object.assign(c, patch); persist(); return c; },
    async deleteContenido(id) { const n = db.contenido.length; db.contenido = db.contenido.filter((x) => x.id !== id); persist(); return db.contenido.length < n; },
    async buscarPadronLista(q, limit) {
      const term = String(q || "").toLowerCase();
      return (db.padron || []).filter((p) => !term || ((p.nombre || "") + " " + (p.apellido || "")).toLowerCase().includes(term) || (p.email || "").toLowerCase().includes(term) || (p.cedula || "").includes(term) || (p.nro_socio || "").includes(term)).sort((a, b) => String(a.apellido || "~").localeCompare(String(b.apellido || "~"))).slice(0, Math.min(Number(limit) || 100, 500));
    },
    async statsPadron() { const p = db.padron || []; return { total: p.length, reclamados: p.filter((x) => x.reclamado).length }; },
    async listSociosConFoto({ limit } = {}) {
      return (db.socios || []).filter((s) => s.foto).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, Math.min(Number(limit) || 80, 300)).map((s) => ({ id: s.id, nombre: s.nombre, apellido: s.apellido, email: s.email, pais_iso: s.pais_iso, ciudad: s.ciudad }));
    },
    // ── Campañas (memoria) ──
    async crearCampana({ nombre, tipo } = {}) { db.campanas = db.campanas || []; const c = { id: "cmp_" + Date.now() + "_" + db.campanas.length, nombre: nombre || "Campaña", tipo: tipo || "", total_enviados: 0, creada: new Date().toISOString() }; db.campanas.push(c); persist(); return c; },
    async crearEnviosCampana(campanaId, socios) { db.campana_envios = db.campana_envios || []; socios.forEach((s, i) => db.campana_envios.push({ id: "env_" + Date.now() + "_" + i, campana_id: campanaId, socio_id: s.id, email: s.email || "", tier_pretendido: s.tier_slug || "", estado_inicial: s.estado_inicial || "olimpista", enviado_ok: false, convertido: false, convertido_en: null, creado: new Date().toISOString() })); const c = (db.campanas || []).find((x) => x.id === campanaId); if (c) c.total_enviados = socios.length; persist(); return socios.length; },
    async listCampanas() { return (db.campanas || []).slice().sort((a, b) => String(b.creada).localeCompare(String(a.creada))).map((c) => { const es = (db.campana_envios || []).filter((e) => e.campana_id === c.id); return Object.assign({}, c, { envios: es.length, enviados_ok: es.filter((e) => e.enviado_ok).length, convertidos: es.filter((e) => e.convertido).length }); }); },
    async listEnviosCampana(campanaId, soloPendientes) { return (db.campana_envios || []).filter((e) => e.campana_id === campanaId && (!soloPendientes || !e.enviado_ok)); },
    async marcarEnviado(envioId) { const e = (db.campana_envios || []).find((x) => x.id === envioId); if (e) { e.enviado_ok = true; persist(); } },
    async recalcularConversion(campanaId) {
      const es = (db.campana_envios || []).filter((e) => e.campana_id === campanaId); let conv = 0;
      es.forEach((e) => {
        if (e.convertido) { conv++; return; }
        const m = (db.membresias || []).filter((x) => x.socio_id === e.socio_id && x.estado === "activa").slice(-1)[0];
        const pago = m && (m.tier_slug === "premium" || m.tier_slug === "kids") && m.pago_ref && !/^socio:/.test(m.pago_ref);
        if (pago && e.estado_inicial !== "premium" && e.estado_inicial !== "kids") { e.convertido = true; e.convertido_en = new Date().toISOString(); conv++; }
      });
      persist(); return { enviados: es.length, convertidos: conv };
    },
    async getPreventa(id) { return db.preventas.find(p => p.id === id) || null; },
    async reservarPreventa(preventaId, socioId, cantidad) {
      const pv = db.preventas.find(p => p.id === preventaId);
      if (!pv) return null;
      if (pv.stock < cantidad) return { error: "sin_stock" };
      pv.stock -= cantidad;
      const r = { id: uid("res"), preventa_id: preventaId, socio_id: socioId, cantidad, estado: "pendiente_pago", creado: nowIso() };
      db.reservas.push(r); persist();
      return r;
    },
    async getReserva(id) { return (db.reservas || []).find(r => r.id === id) || null; },
    async confirmarReserva(id) {
      const r = (db.reservas || []).find(x => x.id === id);
      if (!r) return null;
      r.estado = "pagada"; persist();
      return r;
    },
    async cancelarReservaYreponer(id) {
      const r = (db.reservas || []).find(x => x.id === id);
      if (!r || r.estado === "cancelada") return r || null;
      r.estado = "cancelada";
      const pv = db.preventas.find(p => p.id === r.preventa_id);
      if (pv) pv.stock += r.cantidad;
      persist();
      return r;
    },

    // ── Pedidos de pago (PAGOPAR) ──
    async createPedidoPago({ socioId, concepto, monto, moneda, refExterna, tierSlug, ciclo, reservaId, subastaId }) {
      const ped = {
        id: uid("ped"), socio_id: socioId, concepto, monto, moneda: moneda || "PYG",
        tier_slug: tierSlug || null, reserva_id: reservaId || null, subasta_id: subastaId || null, ciclo: ciclo || "anio",
        estado: "pendiente", ref_externa: refExterna || null, creado: nowIso(),
      };
      db.pedidos.push(ped); persist();
      return ped;
    },
    async updatePedidoPago(id, patch) {
      const p = db.pedidos.find(x => x.id === id);
      if (!p) return null;
      Object.assign(p, patch); persist();
      return p;
    },
    async getPedidoPago(id) { return db.pedidos.find(p => p.id === id) || null; },
    async getPedidoByRefExterna(ref) {
      if (!ref) return null;
      return (db.pedidos || []).filter((p) => p.ref_externa === ref).sort((a, b) => String(b.creado).localeCompare(String(a.creado)))[0] || null;
    },
    async getPedidoPorSubasta(subastaId) {
      return (db.pedidos || []).filter((p) => p.subasta_id === subastaId).sort((a, b) => String(b.creado).localeCompare(String(a.creado)))[0] || null;
    },
    async marcarSubastaPagada(id) {
      const s = (db.subastas || []).find((x) => x.id === id);
      if (s) { s.pago_estado = "pagado"; persist(); }
      return true;
    },

    // ── Admin ──
    async listPedidos({ estado, socioId, limit } = {}) {
      let rows = (db.pedidos || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
      if (estado) rows = rows.filter((p) => p.estado === estado);
      if (socioId) rows = rows.filter((p) => p.socio_id === socioId);
      return rows.slice(0, Math.min(Number(limit) || 100, 500)).map((p) => {
        const s = db.socios.find((x) => x.id === p.socio_id) || {};
        return { ...p, email: s.email, nombre: s.nombre, apellido: s.apellido };
      });
    },
    async listMembresias(socioId) {
      return (db.membresias || []).filter((m) => m.socio_id === socioId).slice().sort((a, b) => String(b.inicio).localeCompare(String(a.inicio)));
    },
    async abandonosPago() {
      const activos = new Set((db.membresias || []).filter((m) => m.estado === "activa" && (m.tier_slug === "premium" || m.tier_slug === "kids")).map((m) => m.socio_id));
      const vistos = new Set(), out = [];
      for (const p of (db.pedidos || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado)))) {
        if (p.estado !== "pendiente" || vistos.has(p.socio_id) || activos.has(p.socio_id)) continue;
        const s = db.socios.find((x) => x.id === p.socio_id); if (!s) continue;
        vistos.add(p.socio_id);
        out.push({ id: s.id, nombre: s.nombre, apellido: s.apellido, email: s.email, pais_iso: s.pais_iso, tier_slug: p.tier_slug, creado: p.creado });
      }
      return out;
    },
    async buscarSocios(q, limit) {
      const term = String(q || "").toLowerCase();
      return (db.socios || [])
        .filter((s) => [s.email, s.nombre, s.apellido, s.cedula].some((v) => String(v || "").toLowerCase().includes(term)))
        .slice(0, Math.min(Number(limit) || 50, 200))
        .map((s) => ({ id: s.id, email: s.email, nombre: s.nombre, apellido: s.apellido, cedula: s.cedula, pais: s.pais, ciudad: s.ciudad, es_socio_olimpia: s.es_socio_olimpia, creado: s.creado }));
    },

    // ── Admin: usuarios + sesiones (cuentas reales del panel) ──
    async createAdminUsuario({ usuario, nombre, passwordHash, rol }) {
      const u = { id: uid("adm"), usuario: String(usuario || "").toLowerCase().trim(), nombre: nombre || "", password_hash: passwordHash, rol: rol || "lectura", activo: true, creado: nowIso(), ultimo_acceso: null };
      db.admin_usuarios.push(u); persist(); return u;
    },
    async getAdminUsuarioByUsuario(usuario) {
      const t = String(usuario || "").toLowerCase().trim();
      return db.admin_usuarios.find((u) => u.usuario === t) || null;
    },
    async getAdminUsuarioById(id) { return db.admin_usuarios.find((u) => u.id === id) || null; },
    async listAdminUsuarios() {
      return db.admin_usuarios.slice().sort((a, b) => String(a.creado).localeCompare(String(b.creado)))
        .map(({ password_hash, ...rest }) => rest);
    },
    async updateAdminUsuario(id, patch) {
      const u = db.admin_usuarios.find((x) => x.id === id); if (!u) return null;
      ["nombre", "rol", "activo", "password_hash", "ultimo_acceso"].forEach((k) => { if (patch[k] !== undefined) u[k] = patch[k]; });
      persist(); return u;
    },
    async deleteAdminUsuario(id) {
      const n = db.admin_usuarios.length;
      db.admin_usuarios = db.admin_usuarios.filter((u) => u.id !== id);
      db.admin_sesiones = db.admin_sesiones.filter((s) => s.admin_id !== id);
      persist(); return db.admin_usuarios.length < n;
    },
    async contarAdminPorRol(rol) { return db.admin_usuarios.filter((u) => u.rol === rol && u.activo).length; },
    async createAdminSession(adminId, rol, token, expiraIso) {
      const s = { token, admin_id: adminId, rol, expira: expiraIso }; db.admin_sesiones.push(s); persist(); return s;
    },
    async getAdminSession(token) {
      const s = db.admin_sesiones.find((x) => x.token === token);
      if (!s) return null;
      if (new Date(s.expira).getTime() < Date.now()) { db.admin_sesiones = db.admin_sesiones.filter((x) => x.token !== token); persist(); return null; }
      const u = db.admin_usuarios.find((x) => x.id === s.admin_id);
      if (!u || !u.activo) return null;
      return { token: s.token, expira: s.expira, admin_id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: u.activo };
    },
    async deleteAdminSession(token) { db.admin_sesiones = db.admin_sesiones.filter((s) => s.token !== token); persist(); },
    async deleteAdminSessionsByUser(adminId) { db.admin_sesiones = db.admin_sesiones.filter((s) => s.admin_id !== adminId); persist(); },
    async purgarAdminSesionesVencidas() { var n = Date.now(); db.admin_sesiones = db.admin_sesiones.filter((s) => new Date(s.expira).getTime() > n); persist(); },
  };
}

module.exports = { createMemoryStore };
