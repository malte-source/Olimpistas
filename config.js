"use strict";

/**
 * config.js — Configuración central de Olimpistas.
 *
 * ESPÍRITU DEL PRODUCTO: esto NO es una tienda ni la web principal de Olimpia
 * (esas ya existen). Es un EMBUDO de captación global: "Hacete Olimpista gratis".
 * Un gran registro de hinchas que después se nutre para venderles membresías,
 * entradas, experiencias e intangibles. El registro gratis es la acción central;
 * los niveles pagos (Junior y Plus) son upsells.
 *
 * Todo lo "editable por negocio" vive acá: branding, tiers, precios, beneficios y
 * los campos del perfil que alimentan la barra de progreso.
 *
 * PRECIOS (definidos, Gs/año): Olimpista Plus 180.000 · Olimpista Junior 80.000.
 */

const BRAND = {
  nombre:     "Olimpistas",
  club:       "Club Olimpia",
  lema:       "OLIMPISTAS.COM",
  lema_en:    "OLIMPISTAS.COM",
  bajada:     "Sumate gratis a la comunidad mundial de Olimpia. Contenido, sorteos, preventas y beneficios para los hinchas del Decano, estés donde estés.",
  bajada_en:  "Join Olimpia's worldwide community for free. Exclusive content, giveaways, presales and perks for Decano fans, wherever you are.",
  ctaPrincipal: "Unite gratis",
  ctaPrincipal_en: "Join free",
  moneda:     "₲",          // Guaraníes
  monedaCod:  "PYG",
  usdRate:    process.env.USD_RATE ? Number(process.env.USD_RATE) : 7300, // Gs por USD (editable)
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
 * `precioAnio: 0` = gratis. DOS precios independientes por tier pago: `precioAnio`
 * (Gs) y `precioUSD` (USD). NO se convierten entre sí — cada uno se define a mano.
 * Cobro ANUAL único.
 */
const TIERS = [
  {
    slug: "olimpista",
    nombre: "Olimpista",
    subtitulo: "Gratis, para siempre",
    subtitulo_en: "Free, forever",
    nivel: 0,
    precioAnio: 0,
    destacado: true,          // es la acción principal del embudo
    color: "#1a1a2e",
    beneficios: [
      "Carnet digital de Olimpista",
      "Contenido y novedades del Decano",
      "Participás en sorteos para miembros",
      "Enterate primero de preventas y lanzamientos",
    ],
    beneficios_en: [
      "Digital Olimpista membership card",
      "Decano content and news",
      "Entry to members-only giveaways",
      "Be first to know about presales and launches",
    ],
    cta: "Unite gratis",
    cta_en: "Join free",
  },
  {
    slug: "kids",
    nombre: "Olimpista Junior",
    subtitulo: "Para los más chicos",
    subtitulo_en: "For the little ones",
    nivel: 1,
    precioAnio: 80000,         // precio en Gs/año (Paraguay) — INDEPENDIENTE del USD
    precioUSD: 13.90,          // precio en USD/año (diáspora) — INDEPENDIENTE del Gs (no se convierte)
    linkPagoGs:  process.env.LINK_PAGO_JUNIOR_GS  || "", // link de pago estático (Gs)
    linkPagoUsd: process.env.LINK_PAGO_JUNIOR_USD || "", // link de pago estático (USD)
    destacado: false,
    color: "#e94560",
    beneficios: [
      "Todo lo del Olimpista gratis",
      "Pack de bienvenida + carnet Junior",
      "Sorteos exclusivos para chicos",
      "Regalo sorpresa en su cumpleaños",
    ],
    beneficios_en: [
      "Everything in the free Olimpista",
      "Welcome pack + Junior card",
      "Junior-only giveaways",
      "Surprise birthday gift",
    ],
    cta: "Hacerme Junior",
    cta_en: "Go Junior",
  },
  {
    slug: "premium",
    nombre: "Olimpista Plus",
    subtitulo: "La experiencia completa",
    subtitulo_en: "The full experience",
    nivel: 2,                  // superior a Junior (nivel 1): desbloquea TODO el contenido Plus
    precioAnio: 180000,        // precio en Gs/año (Paraguay) — INDEPENDIENTE del USD
    precioUSD: 28.90,          // precio en USD/año (diáspora) — INDEPENDIENTE del Gs (no se convierte)
    linkPagoGs:  process.env.LINK_PAGO_PLUS_GS  || "", // link de pago estático (Gs)
    linkPagoUsd: process.env.LINK_PAGO_PLUS_USD || "", // link de pago estático (USD)
    destacado: false,
    recomendado: true,         // sello "Recomendado" + botón sólido en la landing (empuja el upsell)
    color: "#c9a227",
    beneficios: [
      "Todo lo del Olimpista gratis",
      "Sorteos Plus (experiencias VIP)",
      "Acceso prioritario a preventas y drops (próximamente)",
      "Contenido exclusivo · Olimpia Media+ (próximamente)",
      "Descuentos en la Red de Beneficios (próximamente)",
    ],
    beneficios_en: [
      "Everything in the free Olimpista",
      "Plus giveaways (VIP experiences)",
      "Priority access to presales and drops (coming soon)",
      "Exclusive content · Olimpia Media+ (coming soon)",
      "Discounts across the Benefits Network (coming soon)",
    ],
    cta: "Hacerme Plus",
    cta_en: "Go Plus",
  },
  {
    slug: "socio",
    nombre: "Olimpista Socio",
    subtitulo: "Socio del Decano",
    subtitulo_en: "Club member",
    nivel: 3,                  // POR ENCIMA de Plus (nivel 2): la cima institucional
    comprable: false,          // NO se vende: se OTORGA a los socios reales del club (no aparece en las cards de precio)
    precioAnio: 0,
    destacado: false,
    color: "#0b0b0f",          // negro institucional (por encima del oro de Plus)
    beneficios: [
      "Todo lo de Olimpista Plus, incluido",
      "Distinción de Socio del Club — el nivel más alto",
      "Reconocimiento y estatus de socio del Decano",
      "El mejor escalón de la Red de Beneficios (próximamente)",
    ],
    beneficios_en: [
      "Everything in Olimpista Plus, included",
      "Club Member distinction — the highest tier",
      "Recognition and status as a Decano club member",
      "The top tier of the Benefits Network (coming soon)",
    ],
    cta: "",                   // sin CTA de compra: se otorga al validar la cédula
    cta_en: "",
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
  { key: "pais_iso", label: "Tu país",        peso: 1 },
  { key: "ciudad",   label: "Tu ciudad",      peso: 1 },
];

const PAGOPAR = {
  publicToken:  process.env.PAGOPAR_PUBLIC_TOKEN  || "",
  privateToken: process.env.PAGOPAR_PRIVATE_TOKEN || "",
  // Host ÚNICO del API: sandbox y producción comparten host (api.pagopar.com); el
  // entorno lo definen las CREDENCIALES, no la URL. Override por env si tu cuenta
  // usa otro host de pruebas.
  apiUrl: process.env.PAGOPAR_API_URL || "https://api.pagopar.com/api",
  // Página pública de checkout a la que se redirige al comprador (se le agrega /{hash}).
  checkoutUrl: process.env.PAGOPAR_CHECKOUT_URL || "https://www.pagopar.com/pagos",
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
