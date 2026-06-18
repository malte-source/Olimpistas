/* i18n.js — diccionario ES/EN + helpers. Se carga antes que el resto.
   Idioma: <html lang> (inyectado por el server según /en) → localStorage → navegador. */
window.OLI_I18N = (function () {
  const DICT = {
    es: {
      nav_login: "Ingresar", nav_join: "Hacete Olimpista", nav_account: "Mi cuenta", nav_back: "Volver",
      hero_pill: "El Rey de Copas · El Decano",
      hero_note: "Gratis y en 30 segundos. Sin tarjeta.",
      hero_vermas: "Ver niveles y beneficios ↓",
      social_pre: "🌎 Ya somos", social_in: "Olimpistas en", pais: "país", paises: "países",
      mundo_eyebrow: "El mundo del Decano", mundo_h2: "Olimpistas en el mundo",
      contador_in: "Olimpistas en", contador_paises: "países",
      globo_note_1: "Girá el globo y tocá una bandera. ¿No estás en el mapa?", globo_note_cta: "Sumate y aparecé.",
      top_title: "Top países", top_empty: "Sé el primero en aparecer en el mapa.",
      benef_eyebrow: "Por qué sumarte", benef_h2: "Una comunidad mundial de Olimpistas",
      benef_lead: "Estés donde estés, sé parte del Decano. Esto es lo que te llevás:",
      why_preventas: "Preventas", why_preventas_d: "Enterate y comprá entradas antes que nadie.",
      why_sorteos: "Sorteos", why_sorteos_d: "Camisetas, experiencias y premios para miembros.",
      why_contenido: "Contenido exclusivo", why_contenido_d: "Detrás de escena, entrevistas y más en Olimpia Media+.",
      why_carnet: "Carnet digital", why_carnet_d: "Tu identidad de Olimpista, siempre con vos.",
      planes_eyebrow: "Niveles", planes_h2: "Elegí tu nivel", planes_lead: "Empezá gratis. Cuando quieras, subí a Kids o Premium.",
      ribbon: "Empezá acá", price_gratis: "Gratis", price_forever: "para siempre", price_year: "por año",
      footer_tienda: "Tienda oficial", footer_web: "Web de Olimpia", footer_terminos: "Términos y condiciones",
      footer_privacidad: "Política de privacidad", footer_sorteos: "Bases de sorteos",
      footer_tagline: "Una iniciativa de Club Olimpia para su comunidad mundial de hinchas.",
      m_title_reg: "Hacete Olimpista", m_title_login: "Ingresar",
      m_sub_reg: "Creá tu cuenta gratis.", m_sub_login: "Ingresá a tu cuenta de Olimpista.",
      m_nombre: "Nombre", m_email: "Email", m_pass: "Contraseña",
      m_submit_reg: "Crear cuenta gratis", m_submit_login: "Ingresar",
      m_switch_reg: "¿Ya sos Olimpista?", m_switch_reg_a: "Ingresá",
      m_switch_login: "¿No tenés cuenta?", m_switch_login_a: "Hacete Olimpista",
      consent_1: "Acepto los", consent_terms: "Términos", consent_and: "y la", consent_privacy: "Política de Privacidad.",
      consent_err: "Tenés que aceptar los Términos y la Política de Privacidad.",
      cookie_txt: "Usamos una cookie esencial para tu sesión. Más info en", cookie_link: "Cookies", cookie_ok: "Entendido",
      proximamente: "Próximamente",
      // Área de miembro (tabs + comunes)
      tab_perfil: "Mi perfil", tab_membresia: "Mi membresía", tab_media: "Olimpia Media+",
      tab_sorteos: "Sorteos", tab_preventas: "Preventas", tab_carnet: "Mi carnet", logout: "Salir",
      // Onboarding (inscripción guiada)
      ob_cuenta_h: "Hacete Olimpista", ob_cuenta_p: "Creá tu cuenta gratis en 30 segundos.",
      ob_crear: "Crear mi cuenta",
      ob_foto_h: "Sumale tu cara", ob_foto_p: "Sacate una selfie o subí una foto para tu carnet.",
      ob_selfie: "Tomar selfie", ob_galeria: "Subir foto", ob_capturar: "Capturar", ob_retomar: "Cambiar foto",
      ob_siguiente: "Siguiente", ob_omitir: "Omitir por ahora",
      ob_ubic_h: "¿De dónde sos?", ob_ubic_p: "Aparecé en el mapa mundial de Olimpistas.",
      ob_pais: "País", ob_ciudad: "Ciudad",
      ob_listo_h: "¡Ya sos Olimpista! 🎉", ob_listo_p: "Este es tu carnet digital. Bienvenido al Decano.",
      ob_ir: "Ir a mi cuenta",
    },
    en: {
      nav_login: "Log in", nav_join: "Become an Olimpista", nav_account: "My account", nav_back: "Back",
      hero_pill: "King of Cups · El Decano",
      hero_note: "Free, in 30 seconds. No card.",
      hero_vermas: "See levels & perks ↓",
      social_pre: "🌎 We're already", social_in: "Olimpistas in", pais: "country", paises: "countries",
      mundo_eyebrow: "The Decano's world", mundo_h2: "Olimpistas around the world",
      contador_in: "Olimpistas in", contador_paises: "countries",
      globo_note_1: "Spin the globe and tap a flag. Not on the map yet?", globo_note_cta: "Join and appear.",
      top_title: "Top countries", top_empty: "Be the first to appear on the map.",
      benef_eyebrow: "Why join", benef_h2: "A worldwide community of Olimpistas",
      benef_lead: "Wherever you are, be part of the Decano. Here's what you get:",
      why_preventas: "Presales", why_preventas_d: "Find out and buy tickets before anyone else.",
      why_sorteos: "Giveaways", why_sorteos_d: "Jerseys, experiences and prizes for members.",
      why_contenido: "Exclusive content", why_contenido_d: "Behind the scenes, interviews and more on Olimpia Media+.",
      why_carnet: "Digital card", why_carnet_d: "Your Olimpista identity, always with you.",
      planes_eyebrow: "Levels", planes_h2: "Choose your level", planes_lead: "Start free. Upgrade to Kids or Premium whenever you want.",
      ribbon: "Start here", price_gratis: "Free", price_forever: "forever", price_year: "per year",
      footer_tienda: "Official store", footer_web: "Olimpia website", footer_terminos: "Terms & conditions",
      footer_privacidad: "Privacy policy", footer_sorteos: "Giveaway rules",
      footer_tagline: "An initiative by Club Olimpia for its worldwide fan community.",
      m_title_reg: "Become an Olimpista", m_title_login: "Log in",
      m_sub_reg: "Create your free account.", m_sub_login: "Log in to your Olimpista account.",
      m_nombre: "Name", m_email: "Email", m_pass: "Password",
      m_submit_reg: "Create free account", m_submit_login: "Log in",
      m_switch_reg: "Already an Olimpista?", m_switch_reg_a: "Log in",
      m_switch_login: "No account yet?", m_switch_login_a: "Become an Olimpista",
      consent_1: "I accept the", consent_terms: "Terms", consent_and: "and the", consent_privacy: "Privacy Policy.",
      consent_err: "You must accept the Terms and the Privacy Policy.",
      cookie_txt: "We use one essential cookie for your session. More info in", cookie_link: "Cookies", cookie_ok: "Got it",
      proximamente: "Coming soon",
      tab_perfil: "My profile", tab_membresia: "My membership", tab_media: "Olimpia Media+",
      tab_sorteos: "Giveaways", tab_preventas: "Presales", tab_carnet: "My card", logout: "Log out",
      // Onboarding
      ob_cuenta_h: "Become an Olimpista", ob_cuenta_p: "Create your free account in 30 seconds.",
      ob_crear: "Create my account",
      ob_foto_h: "Add your face", ob_foto_p: "Take a selfie or upload a photo for your card.",
      ob_selfie: "Take selfie", ob_galeria: "Upload photo", ob_capturar: "Capture", ob_retomar: "Change photo",
      ob_siguiente: "Next", ob_omitir: "Skip for now",
      ob_ubic_h: "Where are you from?", ob_ubic_p: "Appear on the worldwide Olimpistas map.",
      ob_pais: "Country", ob_ciudad: "City",
      ob_listo_h: "You're an Olimpista! 🎉", ob_listo_p: "This is your digital card. Welcome to the Decano.",
      ob_ir: "Go to my account",
    },
  };

  function detect() {
    const p = location.pathname;
    if (p === "/en" || p.indexOf("/en/") === 0) return "en"; // landing inglés (autoritativo, SEO)
    if (p === "/") return "es";                               // landing español (autoritativo, SEO)
    // App / otras páginas: preferencia guardada → navegador → es.
    try { const s = localStorage.getItem("oli_lang"); if (s === "en" || s === "es") return s; } catch (e) {}
    return (navigator.language || "es").toLowerCase().startsWith("en") ? "en" : "es";
  }
  let LANG = detect();

  function t(key) {
    const d = DICT[LANG] || DICT.es;
    return d[key] != null ? d[key] : (DICT.es[key] != null ? DICT.es[key] : key);
  }
  function apply(root) {
    const r = root || document;
    r.querySelectorAll("[data-i18n]").forEach((el) => { const v = t(el.getAttribute("data-i18n")); if (v) el.textContent = v; });
    r.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
  }
  function setLang(l) { try { localStorage.setItem("oli_lang", l); } catch (e) {} }

  return { t, apply, lang: () => LANG, setLang, DICT };
})();
