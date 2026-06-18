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
      ob_ir: "Ir a mi cuenta", ob_ver_mapa: "Ver mi bandera en el mapa 🚩",
      ob_cedula: "Cédula", ob_opcional: "(opcional)", ob_cedula_ph: "Si ya sos socio de Olimpia",
      ob_socio_h: "¡Te reconocimos, sos del Decano! 🥇", ob_socio_p: "Como socio de Olimpia, tu carnet ya es Premium. ¡Bienvenido!",
      // ── Área de miembro (contenido dinámico) ──
      m_cargando: "Cargando…",
      m_perfil_h: "Mi perfil", m_perfil_p: "Completá tu perfil y aparecé en el mapa mundial de Olimpistas.",
      m_apellido: "Apellido", m_foto_cambiar: "Cambiar foto", m_whatsapp: "WhatsApp", m_pais: "País", m_ciudad: "Ciudad",
      m_elegi_pais: "Elegí tu país", m_guardar: "Guardar cambios",
      m_casa_h: "🚩 Poné tu bandera en tu casa",
      m_casa_p: "Fijá tu ubicación y sumá tu bandera de Olimpia al globo mundial. ¡Que todos vean que tu casa es olimpista!",
      m_geo: "📍 Usar mi ubicación actual", m_fijado: "Punto fijado ✓", m_sin_fijar: "Sin fijar",
      m_buscando: "Buscando tu ubicación…", m_geo_err: "No se pudo obtener (permiso denegado)",
      m_geo_no: "Tu navegador no permite geolocalización",
      m_casa_toca: "Tocá el globo para fijar tu punto, o usá tu ubicación actual.",
      m_exacto_h: "Mostrar mi bandera en mi casa exacta",
      m_exacto_p: "Si lo dejás sin marcar, aparecés solo a nivel ciudad. Podés cambiarlo cuando quieras.",
      m_perfil_ok: "Perfil actualizado ✓", m_casa_ok: "¡Tu bandera ya está en tu casa! 🚩", m_foto_ok: "Foto actualizada ✓",
      m_prog_h: "Completá tu perfil de Olimpista", m_prog_done: "¡Perfil completo! 🎉",
      m_sos: "Sos", m_miembro_desde: "Miembro desde", m_subi: "Subí de nivel",
      m_editar_ubic: "editar", m_set_ubic: "Agregá tu ciudad y país",
      m_social_pre: "Sos uno de", m_social_in: "Olimpistas en",
      m_media_h: "Olimpia Media+", m_media_p: "Contenido exclusivo para Olimpistas.",
      m_reproducir: "Reproducir", m_solo_premium: "Solo Premium", m_demo: "(demo)",
      m_sorteos_h: "Sorteos", m_sorteos_p: "Participá por premios exclusivos del Decano.",
      m_participar: "Participar", m_ya_participas: "✓ Ya participás", m_participando: "¡Estás participando! 🍀", m_cierra: "Cierra",
      m_preventas_h: "Preventa de entradas", m_preventas_p: "Comprá antes que nadie.",
      m_reservar: "Reservar", m_reserva_ok: "Reserva confirmada ✓", m_en_preventa: "en preventa", m_desde: "Desde",
      m_carnet_h: "Mi carnet digital", m_carnet_p: "Mostralo en el estadio y en la tienda oficial.",
      m_carnet_no: "Carnet no disponible", m_pago_ok: "¡Pago confirmado!", m_anio: "año",
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
      ob_ir: "Go to my account", ob_ver_mapa: "See my flag on the map 🚩",
      ob_cedula: "ID number", ob_opcional: "(optional)", ob_cedula_ph: "If you're already an Olimpia member",
      ob_socio_h: "We recognized you — you're a Decano! 🥇", ob_socio_p: "As an Olimpia member, your card is already Premium. Welcome!",
      // ── Member area (dynamic content) ──
      m_cargando: "Loading…",
      m_perfil_h: "My profile", m_perfil_p: "Complete your profile and appear on the worldwide Olimpistas map.",
      m_apellido: "Last name", m_foto_cambiar: "Change photo", m_whatsapp: "WhatsApp", m_pais: "Country", m_ciudad: "City",
      m_elegi_pais: "Choose your country", m_guardar: "Save changes",
      m_casa_h: "🚩 Put your flag on your house",
      m_casa_p: "Pin your location and add your Olimpia flag to the world globe. Let everyone see your house is olimpista!",
      m_geo: "📍 Use my current location", m_fijado: "Pinned ✓", m_sin_fijar: "Not set",
      m_buscando: "Locating you…", m_geo_err: "Couldn't get it (permission denied)",
      m_geo_no: "Your browser doesn't allow geolocation",
      m_casa_toca: "Tap the globe to pin your spot, or use your current location.",
      m_exacto_h: "Show my flag at my exact house",
      m_exacto_p: "If left unchecked, you appear only at city level. You can change it anytime.",
      m_perfil_ok: "Profile updated ✓", m_casa_ok: "Your flag is now on your house! 🚩", m_foto_ok: "Photo updated ✓",
      m_prog_h: "Complete your Olimpista profile", m_prog_done: "Profile complete! 🎉",
      m_sos: "You're", m_miembro_desde: "Member since", m_subi: "Level up",
      m_editar_ubic: "edit", m_set_ubic: "Add your city and country",
      m_social_pre: "You're one of", m_social_in: "Olimpistas in",
      m_media_h: "Olimpia Media+", m_media_p: "Exclusive content for Olimpistas.",
      m_reproducir: "Play", m_solo_premium: "Premium only", m_demo: "(demo)",
      m_sorteos_h: "Giveaways", m_sorteos_p: "Enter to win exclusive Decano prizes.",
      m_participar: "Enter", m_ya_participas: "✓ You're in", m_participando: "You're entered! 🍀", m_cierra: "Closes",
      m_preventas_h: "Ticket presale", m_preventas_p: "Buy before anyone else.",
      m_reservar: "Reserve", m_reserva_ok: "Reservation confirmed ✓", m_en_preventa: "in presale", m_desde: "From",
      m_carnet_h: "My digital card", m_carnet_p: "Show it at the stadium and the official store.",
      m_carnet_no: "Card unavailable", m_pago_ok: "Payment confirmed!", m_anio: "year",
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
