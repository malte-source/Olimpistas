"use strict";
require("dotenv").config();

const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { buildRouter } = require("./routes");
const auth = require("./lib/auth");
const log = require("./lib/log");
const { PORT, BRAND } = require("./config");

const app = express();

// Detrás del Load Balancer / Cloud Run: confiar en el primer proxy para leer la
// IP real (x-forwarded-for) — necesario para que el rate-limiting sea por IP.
app.set("trust proxy", 1);

// Cabeceras de seguridad (helmet) + CSP a medida con TODAS las fuentes que usa
// la app (tiles Esri, fuentes Google, banderas flagcdn, Plausible, workers del
// mapa). Defensa en profundidad junto al escape anti-XSS del front/back.
// Meta Pixel: solo se enciende si META_PIXEL_ID es un id numérico válido. Si no, queda apagado
// (no inyecta nada y el CSP no abre dominios de Facebook). Encenderlo = setear la env, sin tocar código.
const PIXEL_ON = /^\d{5,20}$/.test((process.env.META_PIXEL_ID || "").trim());
const GA_ON = /^G-[A-Z0-9]{6,15}$/.test((process.env.GA_ID || "").trim());  // Google Analytics 4
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://plausible.io", ...(PIXEL_ON ? ["https://connect.facebook.net"] : []), ...(GA_ON ? ["https://www.googletagmanager.com"] : [])],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https://flagcdn.com", "https://server.arcgisonline.com", ...(PIXEL_ON ? ["https://www.facebook.com"] : []), ...(GA_ON ? ["https://www.google-analytics.com", "https://*.google-analytics.com"] : [])],
      connectSrc: ["'self'", "https://plausible.io", "https://server.arcgisonline.com", "https://demotiles.maplibre.org", ...(PIXEL_ON ? ["https://www.facebook.com", "https://connect.facebook.net"] : []), ...(GA_ON ? ["https://www.google-analytics.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"] : [])],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // permite cargar tiles/banderas de otros orígenes
}));

// Compresión gzip/brotli para todo lo comprimible (HTML, JS, CSS, JSON, SVG).
// Reduce ~70% el egress —clave en picos de tráfico— y deja el origen liviano
// para cuando entre el CDN. No toca imágenes (webp/png ya comprimidos).
app.use(compression());

app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } })); // 1mb: alcanza para fotos de perfil (data URL). rawBody = para verificar firmas de webhooks (Resend/Svix).
app.use(express.urlencoded({ extended: true, limit: "200kb" })); // por si algún form postea urlencoded (Pagopar usa JSON)

// ── Rate-limiting anti-abuso (login brute-force, registro masivo, spam de emails).
// Por IP (gracias a trust proxy). En multi-instancia es por-instancia, pero corta
// el grueso del abuso sin dependencias externas.
// Lanzamiento: muchos usuarios reales comparten IP (navegador in-app de Instagram +
// CGNAT móvil de Paraguay), así que los límites por-IP son GENEROSOS para no bloquear
// altas legítimas. El techo igual corta floods scripteados (cada alta exige email único).
const limiteLogin = rateLimit({ windowMs: 5 * 60_000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos. Probá de nuevo en unos minutos." } });
const limiteRegistro = rateLimit({ windowMs: 10 * 60_000, max: 5000, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados registros desde esta red. Esperá unos minutos." } });
const limiteVerificar = rateLimit({ windowMs: 5 * 60_000, max: 3000, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiadas consultas. Esperá un momento." } });
app.use("/api/auth/login", limiteLogin);
app.use("/api/auth/recuperar", limiteLogin); // mismo límite que login: evita spam de emails de reset
app.use("/api/auth/registro", limiteRegistro);
app.use("/api/auth/verificar-socio", limiteVerificar);
// Login de admin: ESTRICTO (credencial de máximo valor, son pocos usuarios y no comparten IP como los socios).
const limiteAdminLogin = rateLimit({ windowMs: 15 * 60_000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos. Esperá unos minutos." } });
app.use("/api/admin/login", limiteAdminLogin);
// TODO /api/admin/*: corta el brute-force de la llave break-glass (x-admin-key) contra
// cualquier endpoint (no solo /login). Generoso para uso humano real (pocos admins, no
// comparten IP), estricto contra scripting. En multi-instancia es por-instancia (mejorar
// con store compartido/Cloud Armor si hace falta), pero acota el guessing de la llave.
const limiteAdmin = rateLimit({ windowMs: 15 * 60_000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiadas solicitudes. Esperá unos minutos." } });
app.use("/api/admin", limiteAdmin);
// Pujas: generoso (una subasta caliente puja seguido; IPs compartidas en PY) pero
// corta floods scripteados. Solo el POST de pujar — NO el polling de lectura (GET).
const limitePujar = rateLimit({ windowMs: 5 * 60_000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiadas pujas seguidas. Esperá unos segundos." } });
app.post("/api/subastas/:id/pujar", limitePujar);

// Parser de cookies mínimo (evita dependencia extra).
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

const PUBLIC = path.join(__dirname, "public");

// Cache-busting AUTOMÁTICO de assets estáticos: Cloud Run inyecta K_REVISION (cambia
// una vez por deploy, exacto) — lo usamos para pisar cualquier "?v=N" manual en el HTML
// servido. Así un deploy nuevo siempre invalida el cache de 24h del CDN sin que nadie
// tenga que acordarse de subir un número a mano (la causa de que varios fixes de esta
// semana no se vieran reflejados en producción).
const BUILD_ID = process.env.K_REVISION || String(Date.now());

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "olimpistas", club: BRAND.club, rev: BUILD_ID }));

// API — attachSocio se monta SOLO acá (no global): los estáticos y las páginas no
// necesitan sesión, así se evita una consulta a la DB por cada asset servido en un pico.
app.use("/api", auth.attachSocio, buildRouter());

// Sitemap dinámico (se registra ANTES del static → gana sobre public/sitemap.xml):
// home + /en + legal + páginas públicas de subastas (activas/cerradas).
app.get("/sitemap.xml", async (req, res) => {
  const base = "https://www.olimpistas.com";
  const urls = [
    { loc: base + "/", pri: "1.0", freq: "daily" },
    { loc: base + "/en", pri: "0.9", freq: "daily" },
    { loc: base + "/legal", pri: "0.3", freq: "monthly" },
  ];
  try {
    const subs = await require("./data/store").getStore().listSubastas();
    for (const s of subs || []) if (s.estado === "activa" || s.estado === "cerrada") urls.push({ loc: base + "/subasta/" + (s.slug || s.id), pri: "0.8", freq: "hourly" });
  } catch (e) {}
  res.setHeader("Cache-Control", "public, max-age=600");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u.loc}</loc><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join("\n") + `\n</urlset>`);
});

// Estáticos con cache. Bajo tráfico fuerte, esto deja que un CDN (Cloud CDN /
// Cloudflare) sirva los assets y descargue al origen — clave para picos de 50k+.
const PROD = process.env.NODE_ENV === "production";
app.use(express.static(PUBLIC, {
  index: false, // NO servir index.html en "/" automáticamente → deja que lo haga sendPage (inyecta analytics)
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");                 // el SW debe actualizarse rápido
    } else if (/[\\/](assets|css|js)[\\/]/.test(filePath)) {
      // En prod: cache largo (los assets van versionados con ?v=). En dev: sin cache.
      res.setHeader("Cache-Control", PROD ? "public, max-age=86400" : "no-cache");
    }
  },
}));

// Analítica opcional, configurable por env (sin tocar nada si no está seteada).
// PLAUSIBLE_DOMAIN → Plausible (cookieless). GA_ID → Google Analytics 4. Ahora CONVIVEN:
// si están ambas envs, se inyectan las dos (Plausible simple + GA4 potente).
function snippetAnalytics() {
  let out = "";
  if (process.env.PLAUSIBLE_DOMAIN) {
    out += `<script defer data-domain="${process.env.PLAUSIBLE_DOMAIN}" src="https://plausible.io/js/script.js"></script>`;
  }
  const gaId = (process.env.GA_ID || "").trim();
  if (/^G-[A-Z0-9]{6,15}$/.test(gaId)) {
    const id = gaId;
    return out + `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${id}')</script>`;
  }
  return out;
}
// Meta Pixel (independiente de Plausible/GA): se inyecta solo si META_PIXEL_ID es válido.
// Dispara PageView automático; los eventos de conversión (CompleteRegistration, InitiateCheckout)
// los manda el front con OLI.track(). Purchase real = server-side (Conversions API) más adelante.
function snippetPixel() {
  const id = (process.env.META_PIXEL_ID || "").trim();
  if (!/^\d{5,20}$/.test(id)) return "";
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`;
}
// Verificación de Google Search Console: setear GOOGLE_SITE_VERIFICATION con el token
// (el value del meta que da GSC) y queda verificado. Sin la env no inyecta nada.
function snippetSearchConsole() {
  const t = (process.env.GOOGLE_SITE_VERIFICATION || "").trim();
  return /^[A-Za-z0-9_-]{20,100}$/.test(t) ? `<meta name="google-site-verification" content="${t}" />` : "";
}
const ANALYTICS = snippetAnalytics() + snippetPixel() + snippetSearchConsole();

// HTML: cacheable corto (60s). Inyecta analítica + JSON-LD (solo landing) + el idioma (es/en).
// El hreflang se arma por request (URL absoluta según el host) más abajo — Google ignora hreflang relativo.
// Datos estructurados (schema.org): identidad de marca para rich results / knowledge graph.
const JSONLD = '<script type="application/ld+json">' + JSON.stringify([
  { "@context": "https://schema.org", "@type": "Organization", name: "Olimpistas",
    description: "Comunidad mundial de hinchas del Club Olimpia — El Decano.",
    url: "https://www.olimpistas.com", logo: "https://www.olimpistas.com/assets/apple-touch-icon.png",
    sameAs: ["https://www.instagram.com/olimpistascom"] },
  { "@context": "https://schema.org", "@type": "WebSite", name: "Olimpistas",
    url: "https://www.olimpistas.com", inLanguage: ["es", "en"] },
]) + '</script>';
const _pageCache = {};
const sendPage = (file, lang) => (req, res) => {
  // Canónico: el dominio pelado redirige a www (evita el SW/shell cacheado en el origen
  // sin-www y unifica todo en www.olimpistas.com).
  if ((req.headers.host || "") === "olimpistas.com") {
    return res.redirect(301, "https://www.olimpistas.com" + (req.originalUrl || req.url || "/"));
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  const key = file + "|" + (lang || "es");
  if (!_pageCache[key]) {
    let html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    if (lang === "en") html = html.replace('<html lang="es">', '<html lang="en">');
    const extra = (ANALYTICS || "") + (file === "index.html" ? JSONLD : "");
    html = html.replace("</head>", extra + "\n</head>");
    html = html.replace(/\?v=\d+/g, "?v=" + BUILD_ID); // cache-busting automático (ver BUILD_ID)
    _pageCache[key] = html;
  }
  // OG/Twitter: URL absoluta según el host (WhatsApp/Facebook exigen URL completa para
  // mostrar la imagen). Funciona en cualquier dominio (run.app o www.olimpistas.com).
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const base = proto + "://" + (req.headers.host || "www.olimpistas.com");
  const canonical = base + (req.path === "/" ? "/" : req.path);
  // hreflang ABSOLUTO (Google ignora el relativo): es → /, en → /en, x-default → /.
  const hreflang = `<link rel="alternate" hreflang="es" href="${base}/" />` +
    `<link rel="alternate" hreflang="en" href="${base}/en" />` +
    `<link rel="alternate" hreflang="x-default" href="${base}/" />`;
  const html = _pageCache[key]
    .replace(/content="\/assets\/og\.jpg"/g, `content="${base}/assets/og.jpg"`)
    .replace("</head>", `<meta property="og:url" content="${base}${req.path}" /><link rel="canonical" href="${canonical}" />${hreflang}\n</head>`);
  res.type("html").send(html);
};
app.get("/", sendPage("index.html", "es"));
app.get("/en", sendPage("index.html", "en"));        // landing en inglés (SEO: /en + hreflang)
app.get("/miembro", sendPage("socio.html"));         // app: idioma desde localStorage
// Router real del lado del cliente (tabs/segmentos/detalle de subasta con pushState) —
// F5 en cualquier /miembro/<lo-que-sea> debe servir la misma SPA, no un 404.
app.get("/miembro/*", sendPage("socio.html"));
app.get("/legal", sendPage("legal.html"));
app.get("/reset", sendPage("reset.html"));           // página para crear nueva contraseña
app.get("/admin", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(PUBLIC, "admin.html")); });
app.get("/comercio", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(PUBLIC, "comercio.html")); });
app.get("/socio", (_req, res) => res.redirect(301, "/miembro")); // compat: links viejos

// Verificación pública del carnet (QR). No expone PII (el número no es un lookup
// fiable): muestra una confirmación branded + CTA → convierte el escaneo en captación.
app.get("/c/:numero", (req, res) => {
  const num = String(req.params.numero || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const base = proto + "://" + (req.headers.host || "www.olimpistas.com");
  const ogT = "Soy Olimpista 🤍🖤 — mirá mi carnet del Decano";
  const ogD = "Carnet oficial de la comunidad mundial de Olimpia. Sumate gratis en olimpistas.com.";
  const ogImg = base + "/assets/og.jpg";
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Carnet Olimpista verificado</title><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:title" content="${ogT}">
<meta property="og:description" content="${ogD}"><meta property="og:image" content="${ogImg}">
<meta property="og:url" content="${base}/c/${num}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogT}"><meta name="twitter:image" content="${ogImg}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#fff;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:24px}
.card{max-width:360px;background:#14141b;border:1px solid #2a2a33;border-top:3px solid #c9a227;border-radius:18px;padding:34px 26px}
img{width:150px;max-width:70%;height:auto;margin-bottom:18px}
.ok{display:inline-block;background:linear-gradient(120deg,#f0d873,#c9a227);color:#1a1500;font-weight:800;font-size:12px;letter-spacing:1px;padding:5px 14px;border-radius:999px;margin-bottom:14px}
h1{font-size:22px;margin:6px 0}.num{color:#8a909a;font-size:13px;letter-spacing:1px;margin-bottom:22px}
a{display:inline-block;background:linear-gradient(120deg,#f0d873,#c9a227);color:#1a1500;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:11px}</style></head>
<body><div class="card"><img src="/assets/logo-horizontal.svg" alt="Olimpistas">
<div class="ok">✓ CARNET VERIFICADO</div><h1>Hincha del Decano</h1>
<p class="num">${num}</p>
<p style="color:#c6c6d0;line-height:1.5;font-size:15px">Este es un carnet oficial de la comunidad Olimpistas.</p>
<a href="/">Sumate vos también →</a></div></body></html>`);
});

// Página pública dedicada de una subasta (compartir: OG rico + SEO + funnel enfocado).
// Ver es libre; "Pujar" dispara el gate (registro/login) preservando la intención.
app.get("/subasta/:id", async (req, res) => {
  // Acepta el id interno (sub_xxx) O el slug legible (camiseta-tim-payne-a4c) — se
  // permiten guiones para el slug, a diferencia de antes que solo aceptaba id crudo.
  const id = String(req.params.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  let s = null;
  try { s = await require("./data/store").getStore().getSubasta(id); } catch (e) {}
  if (!s || (s.estado !== "activa" && s.estado !== "cerrada")) return res.redirect(302, "/");
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const base = proto + "://" + (req.headers.host || "www.olimpistas.com");
  const esc2 = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const og = s.imagen && /^https?:/.test(s.imagen) ? s.imagen : base + "/assets/og.jpg";
  const titulo = esc2(s.titulo + " — Subasta · Olimpistas");
  const desc = esc2("Pujá por " + s.titulo + " en Olimpistas.com. Puja actual ₲" + Number(s.puja_actual || 0).toLocaleString("es-PY") + ". Exclusivo para hinchas del Decano.");
  const gate = (s.nivel_min === "premium" || s.nivel_min === "socio") ? "Plus y Socio" : "registrados";
  // Canonical/OG siempre con el link "lindo" (slug), sin importar con cuál se haya
  // entrado — así WhatsApp/redes muestran siempre la misma URL prolija.
  const urlPublica = base + "/subasta/" + esc2(s.slug || s.id);
  res.setHeader("Cache-Control", "public, max-age=30");
  // Íconos de línea inline (mismo trazo que el sistema de íconos del cliente) — esta
  // página se genera server-side, sin JS de OLI.icon() disponible.
  const svgIcon = (body, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${body}</svg>`;
  const icGavel = svgIcon('<path d="M13 10l6.5-6.5 3 3L16 13z"/><path d="M9 13l4 4"/><path d="M11 15l-8 8"/><path d="M3 21h6"/>', 48);
  const icHourglass = svgIcon('<path d="M6 3h12M6 21h12"/><path d="M7 3c0 5 4 6 5 9-1 3-5 4-5 9M17 3c0 5-4 6-5 9 1 3 5 4 5 9"/>', 14);
  const icUsers = svgIcon('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 3-5.5 6-5.5s6 2 6 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.3c2.4.4 4.5 2 4.5 5.7"/>', 14);
  const icShield = svgIcon('<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>', 11);
  res.type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${titulo}</title><meta name="description" content="${desc}">
<link rel="canonical" href="${urlPublica}">
<meta property="og:type" content="website"><meta property="og:title" content="${titulo}">
<meta property="og:description" content="${desc}"><meta property="og:image" content="${og}">
<meta property="og:url" content="${urlPublica}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${titulo}"><meta name="twitter:image" content="${og}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><meta name="theme-color" content="#0b0b0f">
<link rel="stylesheet" href="/assets/fonts/fonts.css"><link rel="stylesheet" href="/css/styles.css?v=${BUILD_ID}">
</head><body>
<header class="nav" data-nav-solid="1">
  <a class="brand" href="/"><img class="brand-h" src="/assets/logo-horizontal.svg?v=${BUILD_ID}" alt="Olimpistas" /></a>
  <div class="nav-right">
    <button class="nav-sw" id="themeSw" type="button">Claro</button>
    <button class="btn btn-ghost" id="accederBtn">Ingresar</button>
  </div>
</header>
<main class="wrap" style="max-width:640px;padding-top:36px;padding-bottom:60px">
  <a class="sub-back" href="/">← Volver a Olimpistas.com</a>
  <div class="sub-hero">
    ${s.imagen && /^https?:/.test(s.imagen) ? '<img src="' + esc2(s.imagen) + '" alt="">' : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(140deg,#2a2418,#c9a227);color:#f5efdd">${icGavel}</div>`}
    <span class="sub-unico">${icShield} Pieza única</span>
  </div>
  <span class="chip on" id="estadoChip">En vivo</span>
  <h1 style="margin:10px 0 6px">${esc2(s.titulo)}</h1>
  <p class="lead" style="margin:0 0 20px">${esc2(s.descripcion || "")}</p>
  <div class="sub-box">
    <div class="sub-lbl">Puja actual</div>
    <div class="sub-amt" id="bid">₲ ${Number(s.puja_actual || 0).toLocaleString("es-PY")}</div>
    <div class="sub-clock"><span>Cierra en</span> <b id="cd">—</b></div>
  </div>
  <p class="sub-meta">${icUsers} <b id="puj">—</b> pujando</p>
  <button class="btn btn-valor btn-block" id="cta" style="margin-top:4px">Pujar →</button>
  <p style="font-size:13px;color:var(--gris);margin-top:14px">Pujar es para Olimpistas ${gate}. Si no tenés cuenta, te registrás gratis en 30s.</p>
</main>
<script src="/js/common.js?v=${BUILD_ID}"></script>
<script>(function(){var id=${JSON.stringify(id)};
OLI.initThemeToggle("themeSw");
OLI.yo().then(function(y){var b=document.getElementById("accederBtn");if(y&&y.socio){b.textContent="Mi cuenta";b.onclick=function(){location.href="/miembro";};}else{b.textContent="Ingresar";b.onclick=function(){location.href="/?intent=pujar&sub="+encodeURIComponent(id);};}}).catch(function(){});
function gs(n){return "₲ "+Number(n||0).toLocaleString("es-PY");}
function cd(t){var ms=new Date(t).getTime()-Date.now();if(ms<=0)return "Cerrada";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;return d>0?d+"d "+h+"h":h>0?h+"h "+m+"m":(m<10?"0":"")+m+":"+(ss<10?"0":"")+ss;}
var $=function(x){return document.getElementById(x);};
async function load(){try{var res=await fetch("/api/subastas/"+id);if(!res.ok)return;var r=await res.json();var su=r.subasta;$("bid").textContent=gs(su.puja_actual);$("cd").textContent=cd(su.termina);$("puj").textContent=r.pujadores;if(su.estado==="cerrada"){$("estadoChip").textContent="Cerrada";$("estadoChip").className="chip";$("cta").textContent="Subasta cerrada";$("cta").disabled=true;$("cta").className="btn btn-ghost btn-block";}}catch(e){}}
load();setInterval(load,5000);
$("cta").addEventListener("click",async function(){if(this.disabled)return;var yo=null;try{var r=await fetch("/api/auth/yo");if(r.ok)yo=await r.json();}catch(e){}if(yo&&yo.socio)location.href="/miembro?sub="+id;else location.href="/?intent=pujar&sub="+encodeURIComponent(id);});
})();</script></body></html>`);
});

// Certificado de Autenticidad del lote ganado — solo lo ve el ganador, y solo una
// vez que el pago quedó confirmado (si no, no hay nada que certificar todavía).
// Pensado para imprimir/guardar como PDF (window.print(), sin librería de PDF en
// el server): cumple la promesa que ya hacen el mail de ganador y las bases legales.
app.get("/subasta/:id/certificado", auth.attachSocio, async (req, res) => {
  const id = String(req.params.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  let s = null;
  try { s = await require("./data/store").getStore().getSubasta(id); } catch (e) {}
  if (!s) return res.redirect(302, "/");
  if (!req.socio || req.socio.id !== s.ganador_id || s.pago_estado !== "pagado") {
    return res.status(403).type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>No disponible — Olimpistas</title>
<meta name="robots" content="noindex"><link rel="stylesheet" href="/css/styles.css?v=${BUILD_ID}"></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px">
<div><p style="color:var(--gris)">Este certificado no está disponible (no ganaste este lote, o el pago todavía no se confirmó).</p>
<a href="/miembro" style="color:var(--oro)">← Volver a mi cuenta</a></div></body></html>`);
  }
  const esc2 = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const codigo = crypto.createHash("sha256").update(s.id + "|" + s.ganador_id).digest("hex").slice(0, 10).toUpperCase();
  const fecha = new Date(s.termina || Date.now()).toLocaleDateString("es-PY", { year: "numeric", month: "long", day: "numeric" });
  const ganador = [req.socio.nombre, req.socio.apellido].filter(Boolean).join(" ") || req.socio.email;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const certUrl = proto + "://" + (req.headers.host || "www.olimpistas.com") + "/subasta/" + encodeURIComponent(s.slug || s.id) + "/certificado";
  // Íconos de línea inline (mismo trazo que el sistema de íconos del cliente) — esta
  // página se genera server-side, sin JS de OLI.icon() disponible.
  const svgIcon = (body, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${body}</svg>`;
  const icTrophy = svgIcon('<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M6 5H4a2 2 0 0 0 2 4M18 5h2a2 2 0 0 1-2 4"/><path d="M10 14v3M14 14v3M8 20h8"/>', 56);
  const icDownload = svgIcon('<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 19h16"/>', 16);
  const icShield = svgIcon('<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>', 13);
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Certificado de Autenticidad — ${esc2(s.titulo)}</title>
<meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/fonts/fonts.css"><link rel="stylesheet" href="/css/styles.css?v=${BUILD_ID}">
<style>
body{background:var(--negro)}
.cert-wrap{max-width:640px;margin:0 auto;padding:40px 20px 60px}
.cert{position:relative;border:1.5px solid var(--oro);border-radius:20px;padding:6px;background:var(--negro-2)}
.cert-inner{border:1px solid rgba(231,198,75,.4);border-radius:15px;padding:38px 34px;text-align:center}
.cert .unico{position:absolute;top:16px;right:16px;display:flex;align-items:center;gap:5px;font-size:10px;font-weight:800;
  text-transform:uppercase;letter-spacing:.05em;color:var(--oro-claro);border:1px solid rgba(231,198,75,.5);border-radius:999px;padding:4px 9px}
.cert .wm{font-weight:900;letter-spacing:.3em;font-size:13px;color:var(--oro-claro);text-transform:uppercase}
.cert .filete{height:2px;width:120px;margin:10px auto 26px;background:linear-gradient(90deg,transparent,var(--oro-claro) 20%,var(--oro-claro) 80%,transparent);opacity:.9}
.cert h1{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:var(--gris);margin:0 0 6px;font-weight:700}
.cert .lote{font-size:24px;font-weight:700;margin:0 0 22px;color:var(--blanco)}
.cert .hero{height:180px;border-radius:14px;overflow:hidden;margin-bottom:24px;display:flex;align-items:center;justify-content:center;color:var(--oro-claro);background:linear-gradient(140deg,#2a2418,#c9a227)}
.cert .hero img{width:100%;height:100%;object-fit:cover}
.cert .row{display:flex;justify-content:space-between;padding:12px 0;border-top:1px solid var(--linea);font-size:14px;text-align:left}
.cert .row .l{color:var(--gris)}.cert .row .v{color:var(--blanco);font-weight:700}
.cert .verif{display:flex;align-items:center;gap:16px;margin-top:24px;padding-top:20px;border-top:1px solid var(--linea);text-align:left}
.cert .verif img{width:64px;height:64px;border-radius:8px;background:#fff;padding:4px;flex:0 0 auto}
.cert .verif .codigo{font-family:ui-monospace,monospace;font-size:12.5px;color:var(--oro-claro);letter-spacing:.06em;word-break:break-all}
.cert .verif .txt{font-size:12px;color:var(--gris);margin-top:4px}
.cert .firmas{display:flex;gap:24px;margin-top:30px}
.cert .firma{flex:1;border-top:1px solid var(--gris);padding-top:8px;font-size:11.5px;color:var(--gris)}
.cert .firma b{display:block;color:var(--blanco);font-size:12.5px;margin-bottom:1px}
.cert .nota{margin-top:22px;font-size:12px;color:var(--gris);line-height:1.5}
.cert-actions{text-align:center;margin-top:22px}
.cert-actions button{display:inline-flex;align-items:center;gap:8px;border:1.5px solid var(--linea);background:transparent;color:var(--blanco);font:inherit;font-weight:700;
  padding:11px 22px;border-radius:11px;cursor:pointer}
.cert-actions button:hover{border-color:var(--oro);color:var(--oro-claro)}
@media print{ body{background:#fff} .cert-actions{display:none} .cert{border-color:#c9a227} }
</style></head><body>
<div class="cert-wrap">
  <div class="cert">
    <div class="cert-inner">
      <span class="unico">${icShield} Pieza única</span>
      <div class="wm">Olimpistas</div><div class="filete"></div>
      <h1>Certificado de Autenticidad</h1>
      <p class="lote">${esc2(s.titulo)}</p>
      <div class="hero">${s.imagen ? '<img src="' + esc2(s.imagen) + '" alt="">' : icTrophy}</div>
      <div class="row"><span class="l">Adjudicado a</span><span class="v">${esc2(ganador)}</span></div>
      <div class="row"><span class="l">Monto ganador</span><span class="v">₲ ${Number(s.puja_actual || 0).toLocaleString("es-PY")}</span></div>
      <div class="row"><span class="l">Fecha</span><span class="v">${esc2(fecha)}</span></div>
      <div class="row"><span class="l">Organiza</span><span class="v">Club Olimpia · Olimpistas</span></div>
      <div class="verif">
        <img id="certQr" alt="QR de verificación" />
        <div><p class="codigo">${codigo}</p><p class="txt">Escaneá para verificar este certificado en olimpistas.com</p></div>
      </div>
      <div class="firmas">
        <div class="firma"><b>Club Olimpia</b>Presidencia</div>
        <div class="firma"><b>Olimpistas.com</b>Una iniciativa de Club Olimpia</div>
      </div>
      <p class="nota">Este certificado acredita la autenticidad y la adjudicación del lote descrito, subastado por Olimpistas en nombre de Club Olimpia.</p>
    </div>
  </div>
  <div class="cert-actions"><button onclick="window.print()">${icDownload} Guardar como PDF</button></div>
</div>
<script src="/assets/vendor/qrcode.js"></script>
<script>
try {
  var qr = qrcode(0, "M");
  qr.addData(${JSON.stringify(certUrl)});
  qr.make();
  document.getElementById("certQr").src = qr.createDataURL(5, 2);
} catch (e) {}
</script>
</body></html>`);
});

// 404 JSON para /api; 404 real (no 200+home) para rutas inexistentes — evita
// contenido duplicado en SEO. Las rutas conocidas se sirven arriba.
app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "No encontrado" });
  res.status(404).type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>No encontrado — Olimpistas</title>
<meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#fff;font-family:Arial,Helvetica,sans-serif;text-align:center;padding:24px}
img{width:160px;max-width:70%;margin-bottom:20px}a{color:#f0d873;font-weight:700}</style></head>
<body><div><img src="/assets/logo-horizontal.svg" alt="Olimpistas"><h1>Página no encontrada</h1>
<p style="color:#c6c6d0">Volvé al <a href="/">inicio</a> y hacete Olimpista.</p></div></body></html>`);
});

if (require.main === module) {
  app.listen(PORT, () => {
    log.info({ port: PORT, club: BRAND.club }, `Olimpistas arriba en http://localhost:${PORT}`);
  });
}

module.exports = app;
