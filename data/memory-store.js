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

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function nowIso() { return new Date().toISOString(); }

// ─── Datos semilla ──────────────────────────────────────────────────────────

function seed() {
  return {
    socios: [],            // {id, email, password_hash, nombre, telefono, creado}
    sesiones: [],          // {token, socio_id, expira}
    membresias: [],        // {id, socio_id, tier_slug, ciclo, estado, inicio, fin, pago_ref}
    participaciones: [],   // {id, sorteo_id, socio_id, creado}
    reservas: [],          // {id, preventa_id, socio_id, cantidad, creado}
    pedidos: [],           // {id, socio_id, concepto, monto, moneda, estado, ref_externa, creado}
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
        tipo: "video", tier_min: "plata", duracion: "15:04",
        thumb: "/assets/content-2.svg",
        descripcion: "Acceso exclusivo al trabajo del plantel antes del partido clave.",
        publicado: "2026-06-12",
      },
      {
        id: "c3", titulo: "Mano a mano con el capitán",
        tipo: "video", tier_min: "plata", duracion: "22:48",
        thumb: "/assets/content-3.svg",
        descripcion: "Entrevista íntima sobre la temporada y el sueño de la cuarta.",
        publicado: "2026-06-14",
      },
      {
        id: "c4", titulo: "Documental: El Rey de Copas",
        tipo: "documental", tier_min: "oro", duracion: "48:10",
        thumb: "/assets/content-4.svg",
        descripcion: "La historia de las tres Libertadores, sólo para Olimpistas Oro.",
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
        tier_min: "plata", cierra: "2026-07-01", imagen: "/assets/sorteo-2.svg",
      },
      {
        id: "s3", titulo: "Experiencia VIP: día con el equipo",
        descripcion: "Conocé el vestuario, sacate fotos y mirá un entrenamiento en vivo.",
        tier_min: "oro", cierra: "2026-08-01", imagen: "/assets/sorteo-3.svg",
      },
    ],
    preventas: [
      {
        id: "p1", evento: "Olimpia vs Cerro Porteño — Superclásico",
        fecha: "2026-07-20", sede: "Estadio Manuel Ferreira",
        abre: "2026-06-25", tier_min: "plata",
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
    } catch (e) { console.error("[memory-store] persist falló:", e.message); }
  }

  return {
    kind: "memory",

    // ── Socios ──
    async createSocio({ email, passwordHash, nombre, telefono }) {
      const socio = {
        id: uid("soc"), email: email.toLowerCase(), password_hash: passwordHash,
        nombre: nombre || "", telefono: telefono || "", creado: nowIso(),
      };
      db.socios.push(socio); persist();
      return socio;
    },
    async getSocioByEmail(email) {
      return db.socios.find(s => s.email === String(email).toLowerCase()) || null;
    },
    async getSocioById(id) { return db.socios.find(s => s.id === id) || null; },
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

    // ── Membresías ──
    async setMembresia(socioId, m) {
      // Desactiva membresías previas, agrega la nueva activa
      db.membresias.forEach(x => { if (x.socio_id === socioId) x.estado = "reemplazada"; });
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
    async listContenido() { return db.contenido.slice(); },
    async getContenido(id) { return db.contenido.find(c => c.id === id) || null; },

    // ── Sorteos ──
    async listSorteos() { return db.sorteos.slice(); },
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
    async listPreventas() { return db.preventas.slice(); },
    async getPreventa(id) { return db.preventas.find(p => p.id === id) || null; },
    async reservarPreventa(preventaId, socioId, cantidad) {
      const pv = db.preventas.find(p => p.id === preventaId);
      if (!pv) return null;
      if (pv.stock < cantidad) return { error: "sin_stock" };
      pv.stock -= cantidad;
      const r = { id: uid("res"), preventa_id: preventaId, socio_id: socioId, cantidad, creado: nowIso() };
      db.reservas.push(r); persist();
      return r;
    },

    // ── Pedidos de pago (PAGOPAR) ──
    async createPedidoPago({ socioId, concepto, monto, moneda, refExterna }) {
      const ped = {
        id: uid("ped"), socio_id: socioId, concepto, monto, moneda: moneda || "PYG",
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
  };
}

module.exports = { createMemoryStore };
