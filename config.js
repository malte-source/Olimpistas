"use strict";

/**
 * config.js — Configuración central de Olimpistas.
 *
 * ESPÍRITU DEL PRODUCTO: esto NO es una tienda ni la web principal de Olimpia
 * (esas ya existen). Es un EMBUDO de captación global: "Hacete Olimpista gratis".
 * Un gran registro de hinchas que después se nutre para venderles membresías,
 * entradas, experiencias e intangibles. El registro gratis es la acción central;
 * los niveles pagos (Kids y Premium) son upsells.
 *
 * Todo lo "editable por negocio" vive acá: branding, tiers, precios, beneficios y
 * los campos del perfil que alimentan la barra de progreso.
 *
 * ⚠️ PRECIOS Y BENEFICIOS: son una PROPUESTA inicial, a confirmar con Olimpia.
 */

const BRAND = {
  nombre:     "Olimpistas",
  club:       "Club Olimpia",
  lema:       "Hacete Olimpista",
  bajada:     "Sumate gratis a la comunidad mundial de Olimpia. Contenido, sorteos, preventas y beneficios para los hinchas del Decano, estés donde estés.",
  ctaPrincipal: "Hacete Olimpista gratis",
  moneda:     "₲",          // Guaraníes
  monedaCod:  "PYG",
  // Olimpia: blanco y negro (franjeado), acentos dorados ("El Rey de Copas")
  colores: {
    primario:   "#000000",
    secundario: "#ffffff",
    acento:     "#c9a227",
    fondo:      "#0b0b0f",
  },
};

/**
 * Tres niveles. `nivel` define el acceso (0 = gratis, 1 = pago).
 * `precioAnio: 0` = gratis. Precios en guaraníes (enteros). Cobro ANUAL único.
 */
const TIERS = [
  {
    slug: "olimpista",
    nombre: "Olimpista",
    subtitulo: "Gratis, para siempre",
    nivel: 0,
    precioAnio: 0,
    destacado: true,          // es la acción principal del embudo
    color: "#1a1a2e",
    beneficios: [
      "Carnet digital de Olimpista",
      "Contenido y novedades exclusivas del Decano",
      "Participás en sorteos para socios",
      "Enterate primero de preventas y lanzamientos",
    ],
    cta: "Hacete Olimpista gratis",
  },
  {
    slug: "kids",
    nombre: "Olimpista Kids",
    subtitulo: "Para los más chicos",
    nivel: 1,
    precioAnio: 100000,        // ⚠️ A CONFIRMAR
    destacado: false,
    color: "#e94560",
    beneficios: [
      "Todo lo del Olimpista gratis",
      "Pack de bienvenida + carnet Kids",
      "Sorteos exclusivos para chicos",
      "Regalo sorpresa en su cumpleaños",
    ],
    cta: "Sumar a un Kids",
  },
  {
    slug: "premium",
    nombre: "Olimpista Premium",
    subtitulo: "La experiencia completa",
    nivel: 1,
    precioAnio: 250000,        // ⚠️ A CONFIRMAR
    destacado: false,
    color: "#c9a227",
    beneficios: [
      "Todo lo del Olimpista gratis",
      "Contenido premium (Olimpia Play)",
      "Preventa y acceso prioritario a entradas",
      "Descuentos en la tienda oficial de Olimpia",
      "Sorteos premium (experiencias VIP)",
    ],
    cta: "Hacerme Premium",
  },
];

/**
 * Campos del perfil que alimentan la barra de progreso post-registro.
 * El registro inicial pide lo mínimo (nombre, email, contraseña); el resto se
 * completa después, gamificado, para enriquecer la base de datos.
 */
const PERFIL_CAMPOS = [
  { key: "nombre",   label: "Tu nombre",      peso: 1 },
  { key: "whatsapp", label: "Tu WhatsApp",    peso: 1 },
  { key: "foto",     label: "Foto de perfil", peso: 1 },
  { key: "pais",     label: "Tu país",        peso: 1 },
  { key: "ciudad",   label: "Tu ciudad",      peso: 1 },
];

const PAGOPAR = {
  publicToken:  process.env.PAGOPAR_PUBLIC_TOKEN  || "",
  privateToken: process.env.PAGOPAR_PRIVATE_TOKEN || "",
  baseUrl: (process.env.PAGOPAR_ENV === "prod")
    ? "https://www.pagopar.com/api"
    : "https://sandbox.pagopar.com/api",
  habilitado: !!(process.env.PAGOPAR_PUBLIC_TOKEN && process.env.PAGOPAR_PRIVATE_TOKEN),
};

module.exports = {
  BRAND,
  TIERS,
  PERFIL_CAMPOS,
  PAGOPAR,
  PORT: process.env.PORT || 3002,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 días
  tierBySlug: (slug) => TIERS.find(t => t.slug === slug) || null,
};
