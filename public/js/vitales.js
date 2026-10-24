/* vitales.js — mide la velocidad real que vive cada persona (LCP, INP, CLS, FCP, TTFB) y la manda de forma anónima.
   Solo una de cada cinco visitas; sin cédula, correo ni IP. Se envía al ocultar la página (sendBeacon). */
(function () {
  try {
    if (!("PerformanceObserver" in window) || !navigator.sendBeacon) return;
    if (Math.random() > 0.2) return;
    const m = { lcp: null, inp: null, cls: 0, fcp: null, ttfb: null };
    const obs = (tipo, fn, extra) => { try { const o = new PerformanceObserver((l) => l.getEntries().forEach(fn)); o.observe(Object.assign({ type: tipo, buffered: true }, extra || {})); } catch (e) {} };
    obs("largest-contentful-paint", (e) => { m.lcp = e.startTime; });
    obs("layout-shift", (e) => { if (!e.hadRecentInput) m.cls += e.value; });
    obs("paint", (e) => { if (e.name === "first-contentful-paint") m.fcp = e.startTime; });
    obs("event", (e) => { if (e.interactionId && (m.inp == null || e.duration > m.inp)) m.inp = e.duration; }, { durationThreshold: 40 });   // aproximación de INP: la interacción más lenta
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav) m.ttfb = nav.responseStart;
    const pagina = () => {
      const p = location.pathname;
      if (p === "/" || p === "/en") return "landing";
      const t = p.replace(/^\/miembro\/?/, "").split("/")[0];
      return p.indexOf("/miembro") === 0 ? (["partidos", "carnet", "beneficios", "puntos", "perfil", "descubrir"].includes(t) ? t : "inicio") : "otra";
    };
    const dispositivo = () => (innerWidth < 700 ? "movil" : innerWidth < 1100 ? "tablet" : "escritorio");
    let enviado = false;
    const enviar = () => {
      if (enviado || document.visibilityState !== "hidden") return;
      enviado = true;
      const c = navigator.connection && navigator.connection.effectiveType;
      const cuerpo = JSON.stringify({ p: pagina(), lcp: m.lcp, inp: m.inp, cls: m.cls, fcp: m.fcp, ttfb: m.ttfb, d: dispositivo(), c: c || "" });
      navigator.sendBeacon("/api/vitales", new Blob([cuerpo], { type: "application/json" }));
    };
    document.addEventListener("visibilitychange", enviar);
    addEventListener("pagehide", enviar);
  } catch (e) { /* medir nunca rompe la página */ }
})();
