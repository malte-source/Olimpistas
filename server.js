"use strict";
require("dotenv").config();

const express = require("express");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const { buildRouter } = require("./routes");
const auth = require("./lib/auth");
const { PORT, BRAND } = require("./config");

const app = express();

// Compresión gzip/brotli para todo lo comprimible (HTML, JS, CSS, JSON, SVG).
// Reduce ~70% el egress —clave en picos de tráfico— y deja el origen liviano
// para cuando entre el CDN. No toca imágenes (webp/png ya comprimidos).
app.use(compression());

app.use(express.json({ limit: "1mb" })); // 1mb: alcanza para fotos de perfil (data URL)

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

// Adjunta req.socio si hay sesión (no bloquea).
app.use(auth.attachSocio);

const PUBLIC = path.join(__dirname, "public");

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "olimpistas", club: BRAND.club }));

// API
app.use("/api", buildRouter());

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
// PLAUSIBLE_DOMAIN → Plausible (cookieless, sin banner de consentimiento). GA_ID → Google Analytics 4.
function snippetAnalytics() {
  if (process.env.PLAUSIBLE_DOMAIN) {
    return `<script defer data-domain="${process.env.PLAUSIBLE_DOMAIN}" src="https://plausible.io/js/script.js"></script>`;
  }
  if (process.env.GA_ID) {
    const id = process.env.GA_ID;
    return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${id}')</script>`;
  }
  return "";
}
const ANALYTICS = snippetAnalytics();

// HTML: cacheable corto (60s). Inyecta analítica + hreflang y el idioma (es/en) según la ruta.
const HREFLANG = '<link rel="alternate" hreflang="es" href="/" /><link rel="alternate" hreflang="en" href="/en" /><link rel="alternate" hreflang="x-default" href="/" />';
const _pageCache = {};
const sendPage = (file, lang) => (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  const key = file + "|" + (lang || "es");
  if (!_pageCache[key]) {
    let html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    if (lang === "en") html = html.replace('<html lang="es">', '<html lang="en">');
    html = html.replace("</head>", HREFLANG + (ANALYTICS || "") + "\n</head>");
    _pageCache[key] = html;
  }
  // OG/Twitter: URL absoluta según el host (WhatsApp/Facebook exigen URL completa para
  // mostrar la imagen). Funciona en cualquier dominio (run.app o www.olimpistas.com).
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const base = proto + "://" + (req.headers.host || "www.olimpistas.com");
  const html = _pageCache[key]
    .replace(/content="\/assets\/og\.jpg"/g, `content="${base}/assets/og.jpg"`)
    .replace("</head>", `<meta property="og:url" content="${base}/" />\n</head>`);
  res.type("html").send(html);
};
app.get("/", sendPage("index.html", "es"));
app.get("/en", sendPage("index.html", "en"));        // landing en inglés (SEO: /en + hreflang)
app.get("/miembro", sendPage("socio.html"));         // app: idioma desde localStorage
app.get("/legal", sendPage("legal.html"));
app.get("/socio", (_req, res) => res.redirect(301, "/miembro")); // compat: links viejos

// 404 JSON para /api, fallback a landing para el resto.
app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "No encontrado" });
  res.sendFile(path.join(PUBLIC, "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Olimpistas] ${BRAND.club} → http://localhost:${PORT}`);
    console.log(`[Olimpistas] Área de socios → http://localhost:${PORT}/socio`);
  });
}

module.exports = app;
