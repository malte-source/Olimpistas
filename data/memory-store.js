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
        id, email: email.toLowerCase(), password_hash: passwordHash, ultima_actividad: new Date().toISOString(), gasto_total: 0, plan_club: "",
        nombre: nombre || "", apellido: apellido || "", telefono: telefono || "",
        // Campos de enriquecimiento (barra de progreso, se completan después):
        whatsapp: "", foto: "", pais: "", pais_iso: "", ciudad: "",
        lat: null, lng: null,   // ubicación exacta (opcional) para el globo
        email_verificado: false, verif_token: null,
        cedula: cedula || "", fecha_nacimiento: fechaNacimiento || null, es_socio_olimpia: false,
        idioma: idioma === "en" ? "en" : "es",
        avisos_subastas: true, avisos_sorteos: true, avisos_contenido: true,
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
        if (f.canjes !== undefined && f.canjes !== null && (db.canjes || []).some((c) => c.socio_id === s.id) !== f.canjes) return false;
        if (f.pujas !== undefined && f.pujas !== null && (db.pujas || []).some((p) => p.socio_id === s.id) !== f.pujas) return false;
        if (f.gasto !== undefined && f.gasto !== null && ((s.gasto_total || 0) > 0) !== f.gasto) return false;
        if (f.ciudad && String(s.ciudad || "").toLowerCase() !== String(f.ciudad).toLowerCase()) return false;
        if (f.excluirId && s.id === f.excluirId) return false;
        if (f.tier && tierDe(s.id) !== f.tier) return false;
        if (term && !((s.email || "").toLowerCase().includes(term) || ((s.nombre || "") + " " + (s.apellido || "")).toLowerCase().includes(term) || (s.cedula || "").includes(term))) return false;
        return true;
      }).sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
      return rows.slice(0, Math.min(Number(f.limit) || 500, 5000)).map((s) => ({ id: s.id, nombre: s.nombre, apellido: s.apellido, email: s.email, cedula: s.cedula, pais: s.pais, pais_iso: s.pais_iso, ciudad: s.ciudad, es_socio_olimpia: s.es_socio_olimpia, gasto_total: s.gasto_total || 0, ultima_actividad: s.ultima_actividad || null, tiene_foto: !!s.foto, tier_slug: tierDe(s.id), creado: s.creado }));
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
    async crearBeneficio(d = {}) { const num = (v) => (v != null && v !== "" ? Number(v) : null); const b = { id: uid("ben"), comercio_id: d.comercio_id, titulo: d.titulo || "", descripcion: d.descripcion || "", tipo: d.tipo || "descuento", valor: d.valor || "", niveles: d.niveles || "todos", pct: num(d.pct), ahorro_estimado: num(d.ahorro_estimado), vigencia_desde: d.vigencia_desde || null, vigencia_hasta: d.vigencia_hasta || null, limite_dias: num(d.limite_dias), activo: d.activo !== false, estado: "aprobado", origen: "club", stock: null, motivo_rechazo: null, creado: nowIso() }; (db.beneficios = db.beneficios || []).push(b); persist(); return b; },
    async updateBeneficio(id, patch) { const b = (db.beneficios || []).find((x) => x.id === id); if (!b) return null; Object.assign(b, patch); persist(); return b; },
    async deleteBeneficio(id) { db.beneficios = (db.beneficios || []).filter((b) => b.id !== id); persist(); return true; },

    async beneficiosParaNivel(tier) {
      const hoy = new Date().toISOString().slice(0, 10);
      const ORD = ["olimpista", "kids", "premium", "socio"];
      const cm = {}; (db.comercios || []).forEach((c) => (cm[c.id] = c));
      return (db.beneficios || []).filter((b) => {
        const c = cm[b.comercio_id];
        if (!b.activo || (b.estado || "aprobado") !== "aprobado" || !c || c.estado !== "activo") return false;
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
    // ── Carnet con QR rotativo y comercio autogestionado (mismo contrato que pg-store) ──
    async asegurarCarnetSecreto(socioId) {
      const s = (db.socios || []).find((x) => x.id === socioId); if (!s) return null;
      if (!s.carnet_secreto) { s.carnet_secreto = require("crypto").randomBytes(32).toString("hex"); persist(); }
      return s.carnet_secreto;
    },
    async getCarnetSecreto(socioId) { const s = (db.socios || []).find((x) => x.id === socioId); return s ? s.carnet_secreto || null : null; },
    async canjearBeneficio({ beneficioId, socioId, comercioId, validadoPor, monto, ahorro, tierSlug, ventana }) {
      const b = (db.beneficios || []).find((x) => x.id === beneficioId);
      const estado = b ? b.estado || "aprobado" : null;
      if (!b || b.activo === false || estado !== "aprobado" || b.comercio_id !== comercioId) return { ok: false, motivo: "beneficio_invalido" };
      const stock = b.stock == null ? null : b.stock;
      if (stock !== null && stock <= 0) return { ok: false, motivo: "agotado" };
      if (b.limite_dias) {
        const u = (db.canjes || []).filter((c) => c.socio_id === socioId && c.beneficio_id === beneficioId).sort((x, y) => String(y.creado).localeCompare(String(x.creado)))[0];
        if (u && (Date.now() - new Date(u.creado).getTime()) / 86400000 < Number(b.limite_dias)) return { ok: false, motivo: "limite" };
      }
      if (ventana != null) {
        db.carnet_usos = db.carnet_usos || [];
        if (db.carnet_usos.some((x) => x.socio_id === socioId && x.ventana === ventana)) return { ok: false, motivo: "qr_usado" };
        db.carnet_usos.push({ socio_id: socioId, ventana, comercio_id: comercioId, creado: nowIso() });
      }
      if (stock !== null) b.stock = stock - 1;
      const c = { id: uid("cnj"), beneficio_id: beneficioId, socio_id: socioId, comercio_id: comercioId, validado_por: validadoPor || "", monto: monto != null ? Math.round(monto) : null, ahorro: ahorro != null ? Math.round(ahorro) : null, tier_slug: tierSlug || null, creado: nowIso() };
      (db.canjes = db.canjes || []).push(c); persist();
      return { ok: true, canje: c, stock: stock === null ? null : stock - 1 };
    },
    async crearBeneficioComercio({ comercioId, titulo, descripcion, valor, niveles, pct, ahorro_estimado, stock, vigencia_hasta }) {
      const b = { id: uid("ben"), comercio_id: comercioId, titulo, descripcion: descripcion || "", tipo: "descuento", valor: valor || "", niveles: niveles || "todos",
        pct: pct == null ? null : pct, ahorro_estimado: ahorro_estimado == null ? null : ahorro_estimado, vigencia_desde: null, vigencia_hasta: vigencia_hasta || null,
        limite_dias: null, activo: true, estado: "borrador", origen: "comercio", stock: stock == null ? null : stock, motivo_rechazo: null, creado: nowIso() };
      (db.beneficios = db.beneficios || []).push(b); persist(); return b;
    },
    async updateBeneficioComercio(id, comercioId, patch) {
      const b = (db.beneficios || []).find((x) => x.id === id && x.comercio_id === comercioId); if (!b) return null;
      Object.assign(b, patch); persist(); return b;
    },
    async ofertasDeComercio(comercioId) {
      return (db.beneficios || []).filter((b) => b.comercio_id === comercioId).sort((a, b) => String(b.creado).localeCompare(String(a.creado))).map((b) => ({ estado: "aprobado", origen: "club", stock: null, motivo_rechazo: null, ...b }));
    },
    async resolverOferta(id, { estado, motivo }) {
      const b = (db.beneficios || []).find((x) => x.id === id); if (!b) return null;
      b.estado = estado; b.motivo_rechazo = estado === "rechazado" ? (motivo || "") : null;
      if (estado === "aprobado") b.activo = true;
      persist(); return b;
    },
    async estadisticasComercio({ comercioId, desde, hasta }) {
      const d = new Date(desde).getTime(), h = new Date(hasta).getTime();
      const filas = (db.canjes || []).filter((c) => c.comercio_id === comercioId && new Date(c.creado).getTime() >= d && new Date(c.creado).getTime() < h);
      const conMonto = filas.filter((c) => c.monto != null);
      const ventas = filas.reduce((a, c) => a + (c.monto || 0), 0);
      const mix = new Map(); filas.forEach((c) => mix.set(c.tier_slug || "sin_dato", (mix.get(c.tier_slug || "sin_dato") || 0) + 1));
      return { canjes: filas.length, ahorro: filas.reduce((a, c) => a + (c.ahorro || 0), 0), ventas, ticket_promedio: conMonto.length ? Math.round(ventas / conMonto.length) : 0,
        mix: [...mix.entries()].map(([nivel, canjes]) => ({ nivel, canjes })).sort((a, b) => b.canjes - a.canjes) };
    },
    async canjesDeComercio({ comercioId, desde, hasta, limit = 5000 }) {
      const d = new Date(desde).getTime(), h = new Date(hasta).getTime();
      return (db.canjes || []).filter((c) => c.comercio_id === comercioId && new Date(c.creado).getTime() >= d && new Date(c.creado).getTime() < h)
        .sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit)
        .map((c) => { const b = (db.beneficios || []).find((x) => x.id === c.beneficio_id) || {}; return { creado: c.creado, beneficio: b.titulo || null, nivel: c.tier_slug || "", monto: c.monto, ahorro: c.ahorro }; });
    },
    async estadisticasPorComercio({ desde, hasta }) {
      const d = new Date(desde).getTime(), h = new Date(hasta).getTime(), por = new Map();
      for (const c of (db.canjes || [])) {
        const t = new Date(c.creado).getTime(); if (t < d || t >= h) continue;
        const co = (db.comercios || []).find((x) => x.id === c.comercio_id); if (!co) continue;
        const k = co.nombre + "|" + (co.ciudad || "") + "|" + (c.tier_slug || "sin_dato");
        const e = por.get(k) || { comercio: co.nombre, ciudad: co.ciudad || "", nivel: c.tier_slug || "sin_dato", canjes: 0, ahorro: 0, ventas: 0 };
        e.canjes++; e.ahorro += c.ahorro || 0; e.ventas += c.monto || 0; por.set(k, e);
      }
      return [...por.values()].sort((a, b) => a.comercio.localeCompare(b.comercio) || a.nivel.localeCompare(b.nivel));
    },
    // ── Billetera de ahorro, Ficha 360 y segmentos (mismo contrato que pg-store) ──
    async resumenAhorroSocio(socioId) {
      // Mes y año calendario en hora de Paraguay (UTC-3 fijo desde 2024).
      const L = new Date(Date.now() - 3 * 3600000), ym = L.toISOString().slice(0, 7), y = L.toISOString().slice(0, 4);
      let mes = 0, anio = 0, total = 0, canjesMes = 0;
      (db.canjes || []).forEach((c) => {
        if (c.socio_id !== socioId) return;
        const a = Number(c.ahorro) || 0, cl = new Date(new Date(c.creado).getTime() - 3 * 3600000).toISOString();
        total += a;
        if (cl.slice(0, 4) === y) anio += a;
        if (cl.slice(0, 7) === ym) { mes += a; canjesMes++; }
      });
      return { mes, anio, total, canjes_mes: canjesMes };
    },
    async tocarActividad(socioId) { const s = (db.socios || []).find((x) => x.id === socioId); if (s) { s.ultima_actividad = nowIso(); persist(); } return true; },
    async canjesDeSocio(socioId, limit = 20) {
      return (db.canjes || []).filter((c) => c.socio_id === socioId).sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit).map((c) => {
        const b = (db.beneficios || []).find((x) => x.id === c.beneficio_id) || {}, co = (db.comercios || []).find((x) => x.id === c.comercio_id) || {};
        return { id: c.id, creado: c.creado, monto: c.monto, ahorro: c.ahorro, beneficio: b.titulo || null, comercio: co.nombre || null };
      });
    },
    async pujasDeSocio(socioId, limit = 20) {
      const por = new Map();
      for (const p of (db.pujas || [])) {
        if (p.socio_id !== socioId) continue;
        const e = por.get(p.subasta_id) || { mejor_oferta: 0, pujas: 0, ultima: "" };
        e.mejor_oferta = Math.max(e.mejor_oferta, p.monto); e.pujas++; if (String(p.creado) > String(e.ultima)) e.ultima = p.creado;
        por.set(p.subasta_id, e);
      }
      return [...por.entries()].map(([id, e]) => {
        const s = (db.subastas || []).find((x) => x.id === id) || {};
        return { subasta_id: id, titulo: s.titulo, estado: s.estado, puja_actual: s.puja_actual, ganador_id: s.ganador_id || null, adjudicado_a: s.adjudicado_a || null, pago_estado: s.pago_estado || null, ...e };
      }).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima))).slice(0, limit);
    },
    async crearSegmento({ nombre, filtros, por }) {
      const s = { id: uid("seg"), nombre, filtros: filtros || {}, creado_por: por || "admin", creado: nowIso() };
      (db.segmentos = db.segmentos || []).push(s); persist(); return s;
    },
    async listSegmentos() { return (db.segmentos || []).slice().sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, 200); },
    async deleteSegmento(id) { db.segmentos = (db.segmentos || []).filter((s) => s.id !== id); persist(); return true; },
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
    async beneficiosDeComercio(comercioId) { return (db.beneficios || []).filter((b) => b.comercio_id === comercioId && b.activo && (b.estado || "aprobado") === "aprobado").sort((a, b) => String(b.creado).localeCompare(String(a.creado))); },

    // ── Subastas ──
    async listSubastas() {
      return (db.subastas || []).slice().sort((a, b) => String(a.termina).localeCompare(String(b.termina))).map((s) => {
        if (!s.ganador_id) return s;
        const g = (db.socios || []).find((x) => x.id === s.ganador_id);
        return { ...s, ganador_nombre: g ? g.nombre : null };
      });
    },
    // Mismo contrato que pg-store.listSubastasPublicas: sin la foto, con tiene_imagen + imagen_v.
    async listSubastasPublicas() {
      const crypto = require("crypto");
      return (await this.listSubastas()).map((s) => {
        const { imagen, ...resto } = s;
        return { ...resto, tiene_imagen: !!imagen, imagen_v: crypto.createHash("md5").update(imagen || "").digest("hex").slice(0, 10) };
      });
    },
    async imagenSubasta(idOrSlug) {
      const s = (db.subastas || []).find((x) => x.id === idOrSlug || x.slug === idOrSlug);
      return s ? { id: s.id, imagen: s.imagen || null } : null;
    },
    // Acepta el id interno O el slug (link público) — así cualquier ruta que reciba
    // "lo que sea que vino en la URL" sigue funcionando sin tener que saber cuál es.
    async getSubasta(idOrSlug) {
      const s = (db.subastas || []).find((x) => x.id === idOrSlug || x.slug === idOrSlug);
      if (!s || !s.ganador_id) return s || null;
      const g = (db.socios || []).find((x) => x.id === s.ganador_id);
      return { ...s, ganador_nombre: g ? g.nombre : null };
    },
    async crearSubasta(d = {}) {
      const id = uid("sub");
      const s = { id, titulo: d.titulo || "", descripcion: d.descripcion || "", imagen: d.imagen || null, emoji: d.emoji || "🔨",
        nivel_min: d.nivel_min || "premium", precio_inicial: Math.round(d.precio_inicial || 0), incremento: Math.round(d.incremento || 50000),
        puja_actual: Math.round(d.precio_inicial || 0), ganador_id: null,
        duracion_horas: d.duracion_horas != null ? Math.round(d.duracion_horas) : 48,
        inicia: d.inicia || nowIso(), termina: d.termina || null, estado: d.estado || "borrador", notificado: false, creado: nowIso(),
        pago_estado: null, pausada_en: null, pago_vence: null, adjudicado_a: null, ronda: 1, // mismas columnas que la tabla (contrato con pg-store)
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
        .map((p) => { const s = (db.socios || []).find((x) => x.id === p.socio_id) || {}; return { ...p, nombre: s.nombre || "Olimpista", pais_iso: s.pais_iso || null }; });
    },
    async miPujaMax(subastaId, socioId) {
      const ms = (db.pujas || []).filter((p) => p.subasta_id === subastaId && p.socio_id === socioId).map((p) => p.monto);
      return ms.length ? Math.max.apply(null, ms) : 0;
    },
    async contarPujadores(subastaId) { return new Set((db.pujas || []).filter((p) => p.subasta_id === subastaId).map((p) => p.socio_id)).size; },
    // ── Plazo de pago, ronda 2 y decisiones del club (mismo contrato que pg-store) ──
    async cerrarSubastasVencidas({ plazoHoras = 72 } = {}) {
      const now = Date.now(), cerradas = [];
      (db.subastas || []).forEach((s) => {
        if (s.estado === "activa" && new Date(s.termina).getTime() <= now) {
          s.estado = "cerrada"; s.adjudicado_a = s.ganador_id || null; s.ronda = 1;
          s.pago_vence = s.ganador_id ? new Date(now + plazoHoras * 3600000).toISOString() : null;
          cerradas.push(s);
        }
      });
      if (cerradas.length) persist(); return cerradas;
    },
    async cerrarSubasta(id, { plazoHoras = 72 } = {}) {
      const s = (db.subastas || []).find((x) => x.id === id);
      if (!s || s.estado === "cerrada") return null;
      s.estado = "cerrada"; s.termina = nowIso(); s.adjudicado_a = s.ganador_id || null; s.ronda = 1;
      s.pago_vence = s.ganador_id ? new Date(Date.now() + plazoHoras * 3600000).toISOString() : null;
      persist(); return s;
    },
    async subastasPlazoVencido() {
      const now = Date.now();
      return (db.subastas || []).filter((s) => s.estado === "cerrada" && s.pago_vence && new Date(s.pago_vence).getTime() < now && s.pago_estado !== "pagado")
        .sort((a, b) => String(a.pago_vence).localeCompare(String(b.pago_vence))).slice(0, 50);
    },
    async subastasPagoPorVencer({ horas = 24 } = {}) {
      const now = Date.now(), tope = now + horas * 3600000;
      return (db.subastas || []).filter((s) => s.estado === "cerrada" && s.pago_vence && new Date(s.pago_vence).getTime() > now && new Date(s.pago_vence).getTime() <= tope && s.pago_estado !== "pagado");
    },
    async vencerPlazoSubasta(id, { plazoRonda2Horas = 48, bloqueoDias = 90, forzar = false } = {}) {
      const s = (db.subastas || []).find((x) => x.id === id);
      if (!s || s.estado !== "cerrada" || s.pago_estado === "pagado" || !s.adjudicado_a) return null;
      const vencido = !!(s.pago_vence && new Date(s.pago_vence).getTime() < Date.now());
      if (!forzar && !vencido) return null;
      if (forzar && (s.ronda || 1) >= 2) return null;
      const anterior = s.adjudicado_a;
      (db.pedidos || []).forEach((p) => { if (p.subasta_id === id && p.estado === "pendiente") p.estado = "cancelado"; });
      let bloqueadoHasta = null;
      if ((s.ronda || 1) === 1) {
        const ant = (db.socios || []).find((x) => x.id === anterior);
        if (ant) { bloqueadoHasta = new Date(Date.now() + bloqueoDias * 86400000).toISOString(); ant.subastas_bloqueo_hasta = bloqueadoHasta; }
        const mejores = new Map();
        for (const p of (db.pujas || [])) {
          if (p.subasta_id !== id || p.socio_id === anterior || String(p.creado) < String(new Date(s.inicia).toISOString())) continue;
          const so = (db.socios || []).find((x) => x.id === p.socio_id);
          if (so && so.subastas_bloqueo_hasta && new Date(so.subastas_bloqueo_hasta).getTime() > Date.now()) continue;
          mejores.set(p.socio_id, Math.max(mejores.get(p.socio_id) || 0, p.monto));
        }
        const seg = [...mejores.entries()].sort((a, b) => b[1] - a[1])[0];
        if (seg) {
          Object.assign(s, { ganador_id: seg[0], adjudicado_a: seg[0], puja_actual: seg[1], ronda: 2, notificado: true,
            pago_vence: new Date(Date.now() + plazoRonda2Horas * 3600000).toISOString() });
          persist();
          return { accion: "ronda2", anterior, bloqueadoHasta, subasta: s, segundo: seg[0], monto: seg[1] };
        }
      }
      Object.assign(s, { estado: "borrador", ganador_id: null, adjudicado_a: null, ronda: 1, pago_vence: null, pago_estado: null, termina: null, puja_actual: s.precio_inicial, notificado: false });
      persist();
      return { accion: "borrador", anterior, bloqueadoHasta, subasta: s };
    },
    async extenderPlazoSubasta(id, horas) {
      const s = (db.subastas || []).find((x) => x.id === id);
      if (!s || s.estado !== "cerrada" || !s.adjudicado_a || s.pago_estado === "pagado") return null;
      const base = Math.max(Date.now(), s.pago_vence ? new Date(s.pago_vence).getTime() : 0);
      s.pago_vence = new Date(base + horas * 3600000).toISOString(); persist(); return s;
    },
    async listDecisiones() { return (db.decisiones || []).slice(); },
    async setDecision(clave, valor, por) {
      db.decisiones = db.decisiones || [];
      let d = db.decisiones.find((x) => x.clave === clave);
      if (!d) { d = { clave }; db.decisiones.push(d); }
      Object.assign(d, { valor, decidido_por: por, decidido_en: nowIso() });
      persist(); return d;
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

    // ── Peñas oficiales (mismo contrato que pg-store) ──
    async crearPena({ nombre, ciudad, pais_iso, presidente, contacto }) {
      const base = String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "pena";
      db.penas = db.penas || [];
      let slug = base, i = 1;
      while (db.penas.some((p) => p.slug === slug)) slug = base + "-" + (++i);
      const p = { id: uid("pen"), slug, nombre, ciudad: ciudad || "", pais_iso: pais_iso || "PY", presidente: presidente || "", contacto: contacto || "",
        comision_pct: 10, saldo: 0, estado: "pendiente", creado: nowIso() };
      db.penas.push(p); persist(); return p;
    },
    async getPena(id) { return (db.penas || []).find((p) => p.id === id) || null; },
    async getPenaPorSlug(slug) { const s = String(slug || "").toLowerCase(); return (db.penas || []).find((p) => p.slug === s) || null; },
    async updatePena(id, patch) { const p = (db.penas || []).find((x) => x.id === id); if (!p) return null; Object.assign(p, patch); persist(); return p; },
    async listPenas({ estado, id } = {}) {
      const tier = (sid) => { const m = (db.membresias || []).filter((x) => x.socio_id === sid && x.estado === "activa").slice(-1)[0]; return m ? m.tier_slug : "olimpista"; };
      return (db.penas || []).filter((p) => (!estado || p.estado === estado) && (!id || p.id === id)).map((p) => {
        const mios = (db.socios || []).filter((s) => s.pena_id === p.id);
        const pend = (db.pena_movimientos || []).filter((m) => m.pena_id === p.id && m.motivo === "canje" && m.estado === "pendiente").reduce((a, m) => a - m.monto, 0);
        return { ...p, altas: mios.length, socios: mios.filter((s) => s.es_socio_olimpia).length, plus: mios.filter((s) => ["premium", "kids"].includes(tier(s.id))).length, canje_pendiente: pend };
      }).sort((a, b) => (b.altas - a.altas) || String(a.creado).localeCompare(String(b.creado)));
    },
    async ultimasAltasPena(penaId, limit = 8) {
      const tier = (sid) => { const m = (db.membresias || []).filter((x) => x.socio_id === sid && x.estado === "activa").slice(-1)[0]; return m ? m.tier_slug : "olimpista"; };
      return (db.socios || []).filter((s) => s.pena_id === penaId).sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit)
        .map((s) => ({ id: s.id, nombre: s.nombre, apellido: s.apellido, ciudad: s.ciudad, creado: s.creado, tier_slug: tier(s.id) }));
    },
    async crearPenaUsuario({ penaId, usuario, passwordHash, setupToken, setupExp }) {
      db.pena_usuarios = db.pena_usuarios || [];
      const u = { id: uid("peu"), pena_id: penaId, usuario: String(usuario).toLowerCase(), password_hash: passwordHash, setup_token: setupToken || null, setup_exp: setupExp || null, creado: nowIso() };
      db.pena_usuarios.push(u); persist(); return u;
    },
    async getPenaUsuarioPorUsuario(usuario) { const s = String(usuario || "").toLowerCase(); return (db.pena_usuarios || []).find((u) => u.usuario === s) || null; },
    async getPenaUsuarioDePena(penaId) { return (db.pena_usuarios || []).find((u) => u.pena_id === penaId) || null; },
    async getPenaUsuarioPorSetupToken(token) {
      if (!token) return null;
      return (db.pena_usuarios || []).find((u) => u.setup_token === token && u.setup_exp && new Date(u.setup_exp).getTime() > Date.now()) || null;
    },
    async updatePenaUsuario(id, patch) { const u = (db.pena_usuarios || []).find((x) => x.id === id); if (!u) return null; Object.assign(u, patch); persist(); return u; },
    async crearPenaSesion(penaId, token, expira) {
      db.pena_sesiones = (db.pena_sesiones || []).filter((s) => new Date(s.expira).getTime() > Date.now());
      db.pena_sesiones.push({ token, pena_id: penaId, expira }); persist(); return true;
    },
    async getPenaSesion(token) {
      const s = (db.pena_sesiones || []).find((x) => x.token === token && new Date(x.expira).getTime() > Date.now());
      const p = s && (db.penas || []).find((x) => x.id === s.pena_id);
      return s && p ? { token: s.token, pena_id: s.pena_id, expira: s.expira, nombre: p.nombre, slug: p.slug, estado: p.estado } : null;
    },
    async borrarPenaSesion(token) { db.pena_sesiones = (db.pena_sesiones || []).filter((s) => s.token !== token); persist(); return true; },
    async borrarSesionesDePena(penaId) { db.pena_sesiones = (db.pena_sesiones || []).filter((s) => s.pena_id !== penaId); persist(); return true; },
    async acreditarPena({ penaId, pedidoId, monto, detalle }) {
      db.pena_movimientos = db.pena_movimientos || [];
      if (db.pena_movimientos.some((m) => m.pedido_id === pedidoId)) return null;
      const p = (db.penas || []).find((x) => x.id === penaId); if (!p) return null;
      const m = { id: uid("pmv"), pena_id: penaId, pedido_id: pedidoId, monto, motivo: "ingreso", detalle: detalle || "", estado: "aplicado", creado: nowIso() };
      db.pena_movimientos.push(m); p.saldo += monto; persist(); return m;
    },
    async revertirIngresoPena(pedidoId) {
      const m = (db.pena_movimientos || []).find((x) => x.pedido_id === pedidoId && x.motivo === "ingreso" && x.estado === "aplicado");
      if (!m) return null;
      m.estado = "revertido";
      const p = (db.penas || []).find((x) => x.id === m.pena_id); if (p) p.saldo -= m.monto;
      persist(); return m;
    },
    async pedirCanjePena({ penaId, monto, detalle }) {
      const p = (db.penas || []).find((x) => x.id === penaId); if (!p) return null;
      const pendiente = (db.pena_movimientos || []).filter((m) => m.pena_id === penaId && m.motivo === "canje" && m.estado === "pendiente").reduce((a, m) => a - m.monto, 0);
      if (monto > p.saldo - pendiente) return { ok: false, disponible: Math.max(0, p.saldo - pendiente) };
      const m = { id: uid("pmv"), pena_id: penaId, pedido_id: null, monto: -monto, motivo: "canje", detalle: detalle || "", estado: "pendiente", creado: nowIso() };
      (db.pena_movimientos = db.pena_movimientos || []).push(m); persist();
      return { ok: true, movimiento: m };
    },
    async resolverCanjePena(movId, { aprobar }) {
      const m = (db.pena_movimientos || []).find((x) => x.id === movId && x.motivo === "canje");
      if (!m) return { ok: false, motivo: "no_existe" };
      if (m.estado !== "pendiente") return { ok: false, motivo: "ya_resuelto", estado: m.estado };
      const p = (db.penas || []).find((x) => x.id === m.pena_id);
      if (aprobar) {
        if (!p || p.saldo + m.monto < 0) return { ok: false, motivo: "saldo" };
        p.saldo += m.monto;
      }
      m.estado = aprobar ? "aplicado" : "rechazado"; persist();
      return { ok: true, movimiento: m };
    },
    async movimientosPena(penaId, limit = 30) {
      return (db.pena_movimientos || []).filter((m) => m.pena_id === penaId).sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit);
    },
    async canjesPendientesPena() {
      return (db.pena_movimientos || []).filter((m) => m.motivo === "canje" && m.estado === "pendiente").sort((a, b) => String(a.creado).localeCompare(String(b.creado)))
        .map((m) => { const p = (db.penas || []).find((x) => x.id === m.pena_id) || {}; return { ...m, pena: p.nombre, saldo: p.saldo }; });
    },
    // ── Motor de puntos (mismo contrato que pg-store) ──
    async listReglas() {
      if (!db.puntos_reglas) db.puntos_reglas = [["referido", 300], ["mision", 50], ["estadio", 150], ["liberar", 200], ["cuota", 100], ["debito", 500], ["perfil", 100]].map(([clave, puntos]) => ({ clave, puntos, activa: true }));
      return db.puntos_reglas.slice().sort((a, b) => a.clave.localeCompare(b.clave));
    },
    async setRegla(clave, patch) { await this.listReglas(); const r = db.puntos_reglas.find((x) => x.clave === clave); if (!r) return null; Object.assign(r, patch); persist(); return r; },
    async sumarPuntos({ socioId, motivo, refId, puntos, detalle }) {
      db.puntos_mov = db.puntos_mov || [];
      if (db.puntos_mov.some((m) => m.socio_id === socioId && m.motivo === motivo && m.ref_id === (refId || ""))) return null;
      const m = { id: uid("pmo"), socio_id: socioId, puntos, motivo, ref_id: refId || "", detalle: detalle || "", vence: null, creado: nowIso() };
      db.puntos_mov.push(m); persist(); return m;
    },
    async saldoPuntos(socioId) { return (db.puntos_mov || []).filter((m) => m.socio_id === socioId).reduce((a, m) => a + m.puntos, 0); },
    async movimientosPuntos(socioId, limit = 20) {
      return (db.puntos_mov || []).filter((m) => m.socio_id === socioId && m.puntos !== 0).sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit)
        .map((m) => ({ id: m.id, puntos: m.puntos, motivo: m.motivo, ref_id: m.ref_id, detalle: m.detalle, creado: m.creado }));
    },
    async resumenPuntos() {
      const por = new Map();
      for (const m of (db.puntos_mov || [])) por.set(m.socio_id, (por.get(m.socio_id) || 0) + m.puntos);
      const saldos = [...por.values()].filter((s) => s > 0);
      return { pasivo: saldos.reduce((a, s) => a + s, 0), socios_con_saldo: saldos.length, canjes_pendientes: (db.canjes_premio || []).filter((c) => c.estado === "pendiente").length };
    },
    async listPremios({ soloActivos = true } = {}) {
      return (db.premios || []).filter((p) => !soloActivos || p.activo).sort((a, b) => (a.costo - b.costo) || String(a.creado).localeCompare(String(b.creado)));
    },
    async getPremio(id) { return (db.premios || []).find((p) => p.id === id) || null; },
    async crearPremio(d) {
      const p = { id: uid("pre"), titulo: d.titulo, descripcion: d.descripcion || "", imagen: d.imagen || null, escalon: d.escalon || "bronce", costo: Math.round(d.costo),
        stock: d.stock == null ? null : Math.round(d.stock), nivel_min: d.nivel_min || "olimpista", activo: d.activo !== false, creado: nowIso() };
      (db.premios = db.premios || []).push(p); persist(); return p;
    },
    async updatePremio(id, patch) { const p = (db.premios || []).find((x) => x.id === id); if (!p) return null; Object.assign(p, patch); persist(); return p; },
    async canjearPremio({ socioId, premioId }) {
      if (!(db.socios || []).some((s) => s.id === socioId)) return { ok: false, motivo: "no_existe" };
      const p = (db.premios || []).find((x) => x.id === premioId);
      if (!p || !p.activo) return { ok: false, motivo: "no_existe" };
      const saldo = await this.saldoPuntos(socioId);
      if (saldo < p.costo) return { ok: false, motivo: "saldo", saldo, costo: p.costo };
      if (p.stock !== null && p.stock <= 0) return { ok: false, motivo: "stock" };
      if (p.stock !== null) p.stock -= 1;
      const c = { id: uid("cjp"), socio_id: socioId, premio_id: premioId, costo: p.costo, estado: "pendiente", creado: nowIso(), resuelto: null };
      (db.canjes_premio = db.canjes_premio || []).push(c);
      (db.puntos_mov = db.puntos_mov || []).push({ id: uid("pmo"), socio_id: socioId, puntos: -p.costo, motivo: "canje", ref_id: c.id, detalle: "Canje · " + p.titulo, vence: null, creado: nowIso() });
      persist();
      return { ok: true, canje: { ...c }, premio: p, saldo: saldo - p.costo };
    },
    async listCanjesPremio({ estado, socioId, limit = 100 } = {}) {
      return (db.canjes_premio || []).filter((c) => (!estado || c.estado === estado) && (!socioId || c.socio_id === socioId))
        .sort((a, b) => String(b.creado).localeCompare(String(a.creado))).slice(0, limit).map((c) => {
          const p = (db.premios || []).find((x) => x.id === c.premio_id) || {}, s = (db.socios || []).find((x) => x.id === c.socio_id) || {};
          return { ...c, premio: p.titulo, escalon: p.escalon, nombre: s.nombre, apellido: s.apellido, email: s.email };
        });
    },
    async resolverCanjePremio(id, { estado }) {
      const c = (db.canjes_premio || []).find((x) => x.id === id);
      if (!c) return { ok: false, motivo: "no_existe" };
      if (c.estado !== "pendiente") return { ok: false, motivo: "ya_resuelto", estado: c.estado };
      c.estado = estado; c.resuelto = nowIso();
      const p = (db.premios || []).find((x) => x.id === c.premio_id);
      if (estado === "cancelado") {
        const ya = (db.puntos_mov || []).some((m) => m.socio_id === c.socio_id && m.motivo === "reintegro" && m.ref_id === c.id);
        if (!ya) (db.puntos_mov = db.puntos_mov || []).push({ id: uid("pmo"), socio_id: c.socio_id, puntos: c.costo, motivo: "reintegro", ref_id: c.id, detalle: "Canje cancelado · " + (p ? p.titulo : ""), vence: null, creado: nowIso() });
        if (p && p.stock !== null) p.stock += 1;
      }
      persist();
      return { ok: true, canje: { ...c }, premio: p };
    },
    async crearMision({ semana, pregunta, opciones, correcta }) {
      db.misiones = db.misiones || [];
      if (db.misiones.some((m) => m.semana === semana)) { const e = new Error("semana repetida"); e.code = "23505"; throw e; }
      const m = { id: uid("mis"), semana, pregunta, opciones, correcta, activa: true, creado: nowIso() };
      db.misiones.push(m); persist(); return m;
    },
    async listMisiones(limit = 30) { return (db.misiones || []).slice().sort((a, b) => b.semana.localeCompare(a.semana)).slice(0, limit); },
    async getMision(id) { return (db.misiones || []).find((m) => m.id === id) || null; },
    async getMisionDeSemana(semana) { return (db.misiones || []).find((m) => m.semana === semana && m.activa) || null; },
    async updateMision(id, patch) { const m = (db.misiones || []).find((x) => x.id === id); if (!m) return null; Object.assign(m, patch); persist(); return m; },
    async responderMision({ misionId, socioId, opcion, correcta }) {
      db.mision_respuestas = db.mision_respuestas || [];
      if (db.mision_respuestas.some((r) => r.mision_id === misionId && r.socio_id === socioId)) return null;
      const r = { mision_id: misionId, socio_id: socioId, opcion, correcta, creado: nowIso() };
      db.mision_respuestas.push(r); persist(); return r;
    },
    async respuestaMision(misionId, socioId) { return (db.mision_respuestas || []).find((r) => r.mision_id === misionId && r.socio_id === socioId) || null; },
    async puntosInactivos({ desde, hasta, limit = 500 }) {
      const d = new Date(desde).getTime(), h = new Date(hasta).getTime();
      return (db.socios || []).filter((s) => s.ultima_actividad && new Date(s.ultima_actividad).getTime() >= d && new Date(s.ultima_actividad).getTime() < h)
        .map((s) => ({ id: s.id, email: s.email, nombre: s.nombre, idioma: s.idioma, ultima_actividad: s.ultima_actividad, saldo: (db.puntos_mov || []).filter((m) => m.socio_id === s.id).reduce((a, m) => a + m.puntos, 0) }))
        .filter((s) => s.saldo > 0).sort((a, b) => String(a.ultima_actividad).localeCompare(String(b.ultima_actividad))).slice(0, limit);
    },
    async vencerPuntosSocio(socioId, refId) {
      const saldo = await this.saldoPuntos(socioId);
      if (saldo <= 0) return null;
      return this.sumarPuntos({ socioId, motivo: "vencimiento", refId, puntos: -saldo, detalle: "Puntos vencidos por inactividad" });
    },
    async sociosParaCuota({ mes, limit = 200 }) {
      return (db.socios || []).filter((s) => s.es_socio_olimpia && s.cedula && !(db.puntos_mov || []).some((m) => m.socio_id === s.id && m.motivo === "cuota" && m.ref_id === mes))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map((s) => ({ id: s.id, cedula: s.cedula }));
    },
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
    async listSorteos() {
      return db.sorteos.slice().sort((a, b) => String(a.cierra || "").localeCompare(String(b.cierra || ""))).map((s) => {
        if (!s.ganador_id) return s;
        const g = (db.socios || []).find((x) => x.id === s.ganador_id);
        return { ...s, ganador_nombre: g ? g.nombre : null };
      });
    },
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
    async crearSorteo(d = {}) { const s = { id: "sor_" + Date.now() + db.sorteos.length, titulo: d.titulo || "", descripcion: d.descripcion || null, tier_min: d.tier_min || "olimpista", cierra: d.cierra || null, imagen: d.imagen || null, ganador_id: null }; db.sorteos.push(s); persist(); return s; },
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
    // ── Cobro y entrega, como dos hechos atómicos (mismo contrato que pg-store) ──
    async reclamarCumplimiento(id) {
      const p = db.pedidos.find((x) => x.id === id);
      if (!p || p.cumplido_en) return null;
      const dosMin = 2 * 60 * 1000;
      if (p.cumplimiento_desde && Date.now() - new Date(p.cumplimiento_desde).getTime() < dosMin) return null;
      p.estado = "pagado"; p.pagado_en = p.pagado_en || nowIso(); p.cumplimiento_desde = nowIso();
      persist();
      return { ...p };
    },
    async marcarCumplido(id) {
      const p = db.pedidos.find((x) => x.id === id);
      if (!p || p.cumplido_en) return null;
      p.cumplido_en = nowIso(); p.cumplimiento_desde = null;
      const so = (db.socios || []).find((x) => x.id === p.socio_id);
      if (so) { so.gasto_total = (so.gasto_total || 0) + (p.monto || 0); so.ultima_actividad = nowIso(); }
      persist();
      return { ...p };
    },
    async liberarCumplimiento(id) {
      const p = db.pedidos.find((x) => x.id === id);
      if (p && !p.cumplido_en) { p.cumplimiento_desde = null; persist(); }
      return true;
    },
    async marcarReversado(id) {
      const p = db.pedidos.find((x) => x.id === id);
      if (!p || p.estado !== "pagado") return null;
      p.estado = "reversado";
      const so = (db.socios || []).find((x) => x.id === p.socio_id);
      if (so && p.cumplido_en) so.gasto_total = Math.max(0, (so.gasto_total || 0) - (p.monto || 0));
      persist();
      return { ...p };
    },
    async pedidosParaConciliar({ pendienteMin = 10, maxDias = 7, sinEntregarMin = 5, limit = 50 } = {}) {
      const ahora = Date.now(), min = 60 * 1000, dia = 24 * 60 * min;
      const edad = (p) => ahora - new Date(p.creado).getTime();
      const abiertos = (db.pedidos || []).filter((p) => p.estado === "pendiente" && p.ref_externa && edad(p) > pendienteMin * min && edad(p) < maxDias * dia).slice(0, limit);
      const sinEntregar = (db.pedidos || []).filter((p) => p.estado === "pagado" && !p.cumplido_en
        && ahora - new Date(p.pagado_en || p.creado).getTime() > sinEntregarMin * min
        && (!p.cumplimiento_desde || ahora - new Date(p.cumplimiento_desde).getTime() > 2 * min)).slice(0, limit);
      return { abiertos, sinEntregar };
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
