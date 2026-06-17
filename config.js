"use strict";

/**
 * config.js — Configuración central de Olimpistas (plataforma de socios de Olimpia).
 *
 * Todo lo "editable por negocio" vive acá: branding, tiers de membresía, precios.
 * Las claves de PAGOPAR y la DB se leen de variables de entorno.
 */

const BRAND = {
  nombre:     "Olimpistas",
  club:       "Club Olimpia",
  lema:       "Sé parte de Olimpia",
  bajada:     "Hacete Olimpista y accedé a contenido exclusivo, preventas, descuentos y sorteos",
  estadio:    "Estadio Manuel Ferreira",
  moneda:     "₲",          // Guaraníes
  monedaCod:  "PYG",
  // Olimpia: blanco y negro (franjeado), acentos dorados por el palmarés ("El Rey de Copas")
  colores: {
    primario:   "#000000",
    secundario: "#ffffff",
    acento:     "#c9a227",   // dorado copas
    fondo:      "#0b0b0f",
  },
};

/**
 * Tiers de membresía. Cada uno con precios en guaraníes (enteros, sin decimales).
 * `precioMes` / `precioAnio` en null = no aplica. `precio: 0` = gratis.
 * `slug` se usa como identificador estable en DB y URLs.
 */
const TIERS = [
  {
    slug: "oro",
    nombre: "Olimpista Oro",
    subtitulo: "Estadio Manuel Ferreira",
    precioMes: 49000,
    precioAnio: 490000,
    destacado: true,
    color: "#c9a227",
    beneficios: [
      "La camiseta de cada temporada",
      "Pack de bienvenida Decano",
      "Todos los beneficios de Olimpista Plata",
      "Acceso prioritario a finales y clásicos",
    ],
    cta: "Unite como Oro",
  },
  {
    slug: "plata",
    nombre: "Olimpista Plata",
    subtitulo: "Estadio Manuel Ferreira",
    precioMes: null,
    precioAnio: 250000,
    destacado: false,
    color: "#9aa0a6",
    beneficios: [
      "Acceso completo al contenido de Olimpia Play",
      "15% de descuento en la tienda online",
      "Compra anticipada de entradas",
    ],
    cta: "Unite como Plata",
  },
  {
    slug: "olimpista",
    nombre: "Olimpista",
    subtitulo: "Estadio Manuel Ferreira",
    precioMes: null,
    precioAnio: 0,
    destacado: false,
    color: "#1a1a2e",
    beneficios: [
      "Acceso al contenido gratuito de Olimpia Play",
      "5% de descuento en primera compra en tienda online",
    ],
    cta: "Unite ya",
  },
  {
    slug: "junior",
    nombre: "Olimpista Junior",
    subtitulo: "Para los más chicos",
    precioMes: null,
    precioAnio: 120000,
    destacado: false,
    color: "#e94560",
    beneficios: [
      "Pack de bienvenida y carnet físico",
      "Compra anticipada de entradas",
      "Un regalo sorpresa cada año",
    ],
    cta: "Regala Olimpista Junior",
  },
];

const PAGOPAR = {
  // Integración real la conecta el programador. Estos valores vienen de variables de entorno.
  publicToken:  process.env.PAGOPAR_PUBLIC_TOKEN  || "",
  privateToken: process.env.PAGOPAR_PRIVATE_TOKEN || "",
  // Sandbox por defecto; cambiar a producción con PAGOPAR_ENV=prod
  baseUrl: (process.env.PAGOPAR_ENV === "prod")
    ? "https://www.pagopar.com/api"
    : "https://sandbox.pagopar.com/api",
  habilitado: !!(process.env.PAGOPAR_PUBLIC_TOKEN && process.env.PAGOPAR_PRIVATE_TOKEN),
};

module.exports = {
  BRAND,
  TIERS,
  PAGOPAR,
  PORT: process.env.PORT || 3002,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 días
  tierBySlug: (slug) => TIERS.find(t => t.slug === slug) || null,
};
