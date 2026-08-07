"use strict";
require("dotenv").config();

const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
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

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "olimpistas", club: BRAND.club }));

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
  res.type("html").send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${titulo}</title><meta name="description" content="${desc}">
<link rel="canonical" href="${urlPublica}">
<meta property="og:type" content="website"><meta property="og:title" content="${titulo}">
<meta property="og:description" content="${desc}"><meta property="og:image" content="${og}">
<meta property="og:url" content="${urlPublica}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${titulo}"><meta name="twitter:image" content="${og}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><meta name="theme-color" content="#0b0b0f">
<link rel="stylesheet" href="/assets/fonts/fonts.css"><link rel="stylesheet" href="/css/styles.css?v=69">
<style>body{background:var(--negro);min-height:100vh}.sp{max-width:560px;margin:0 auto;padding:26px 20px 60px;text-align:center}
.sp .wm{font-weight:900;letter-spacing:.3em;font-size:13px;color:var(--oro-claro);text-transform:uppercase}
.sp .stripes{height:5px;width:100px;margin:10px auto 22px;border-radius:3px;background:repeating-linear-gradient(90deg,#fff 0 11px,#000 11px 22px);opacity:.85}
.sp-hero{height:200px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:96px;margin-bottom:18px;overflow:hidden;background:linear-gradient(140deg,#2a2418,#c9a227)}
.sp-hero img{width:100%;height:100%;object-fit:cover}
.sp .tag{display:inline-block;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;padding:5px 12px;border-radius:999px;background:rgba(233,69,96,.18);color:#ffb3c1;border:1px solid rgba(233,69,96,.4);margin-bottom:12px}
.sp h1{font-size:26px;margin:0 0 8px;line-height:1.1}.sp p.d{color:var(--gris);font-size:15px;margin:0 0 20px}
.sp-box{background:linear-gradient(135deg,rgba(231,198,75,.14),rgba(201,162,39,.04));border:1px solid var(--oro);border-radius:16px;padding:20px}
.sp-box .l{text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:800;color:var(--oro-claro)}
.sp-box .bid{font-weight:900;font-size:40px;letter-spacing:-1px;margin:4px 0 2px}
.sp-box .meta{font-size:14px;color:var(--gris)}.sp-box .meta b{color:var(--blanco);font-family:ui-monospace,monospace}
.sp-cta{margin-top:18px;width:100%;border:0;font-family:inherit;font-weight:900;font-size:17px;padding:16px;border-radius:13px;cursor:pointer;background:linear-gradient(135deg,var(--oro-claro),var(--oro));color:#1a1500}
.sp-cta.off{background:#2a2a33;color:var(--gris);cursor:default}
.sp .note{font-size:13px;color:#6b7280;margin-top:12px}.sp .home{display:inline-block;margin-top:22px;color:var(--oro);text-decoration:underline;text-underline-offset:3px}</style>
</head><body><div class="sp">
<a href="/"><div class="wm">Olimpistas</div></a><div class="stripes"></div>
<div class="sp-hero">${s.imagen && /^https?:/.test(s.imagen) ? '<img src="' + esc2(s.imagen) + '" alt="">' : (esc2(s.emoji) || "🔨")}</div>
<span class="tag" id="estado">🔴 En vivo</span>
<h1>${esc2(s.titulo)}</h1><p class="d">${esc2(s.descripcion || "")}</p>
<div class="sp-box"><div class="l">Puja actual</div><div class="bid" id="bid">₲ ${Number(s.puja_actual || 0).toLocaleString("es-PY")}</div>
<div class="meta">⏳ Cierra en <b id="cd">—</b> · 👥 <span id="puj">—</span></div>
<button class="sp-cta" id="cta">Pujar</button></div>
<p class="note">Pujar es para Olimpistas ${gate}. Si no tenés cuenta, te registrás gratis en 30s.</p>
<a class="home" href="/">← Volver a Olimpistas.com</a></div>
<script>(function(){var id=${JSON.stringify(id)};
function gs(n){return "₲ "+Number(n||0).toLocaleString("es-PY");}
function cd(t){var ms=new Date(t).getTime()-Date.now();if(ms<=0)return "Cerrada";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;return d>0?d+"d "+h+"h":h>0?h+"h "+m+"m":(m<10?"0":"")+m+":"+(ss<10?"0":"")+ss;}
var $=function(x){return document.getElementById(x);};
async function load(){try{var res=await fetch("/api/subastas/"+id);if(!res.ok)return;var r=await res.json();var su=r.subasta;$("bid").textContent=gs(su.puja_actual);$("cd").textContent=cd(su.termina);$("puj").textContent=r.pujadores+" pujando";if(su.estado==="cerrada"){$("estado").textContent="🏁 Cerrada";$("cta").textContent="Subasta cerrada";$("cta").className="sp-cta off";}}catch(e){}}
load();setInterval(load,5000);
$("cta").addEventListener("click",async function(){if(this.className.indexOf("off")>-1)return;var yo=null;try{var r=await fetch("/api/auth/yo");if(r.ok)yo=await r.json();}catch(e){}if(yo&&yo.socio)location.href="/miembro?sub="+id;else location.href="/?intent=pujar&sub="+encodeURIComponent(id);});
})();</script></body></html>`);
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
