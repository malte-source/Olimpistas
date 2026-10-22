/* tema.js — apariencia de todas las páginas (claro / oscuro / automático). Se carga en el <head>, antes del CSS,
   para que no haya destello. "auto" sigue la configuración del dispositivo y escucha los cambios.
   La preferencia se guarda en localStorage("oli_theme") = "light" | "dark" (sin valor = automático); en la app del
   hincha, common.js además la sincroniza con su cuenta (socios.tema). */
(function () {
  var K = "oli_theme", mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function pref() { var v = ""; try { v = localStorage.getItem(K) || ""; } catch (e) {} return v === "light" || v === "dark" ? v : "auto"; }
  function efectivo() { var p = pref(); return p === "auto" ? (mq && mq.matches ? "light" : "dark") : p; }
  function aplicar() { document.documentElement.setAttribute("data-theme", efectivo()); }
  function avisar() { try { document.dispatchEvent(new CustomEvent("oli-theme")); } catch (e) {} }
  window.OLITheme = {
    pref: pref, efectivo: efectivo, aplicar: aplicar,
    set: function (p) { try { if (p === "light" || p === "dark") localStorage.setItem(K, p); else localStorage.removeItem(K); } catch (e) {} aplicar(); avisar(); },
  };
  aplicar();
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (pref() === "auto") { aplicar(); avisar(); } });
})();
