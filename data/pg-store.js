"use strict";

/**
 * pg-store.js — Implementación Postgres del store de Olimpistas.
 *
 * Misma interfaz async que memory-store.js. Se activa cuando hay DATABASE_URL.
 * Usa el driver `postgres` (ya presente en el repo). Aplicá data/schema.sql antes.
 */

const crypto = require("crypto");
const postgres = require("postgres");

const SEED_DOMAIN = "demo.olimpistas.test"; // filas de demo (no cuentan como miembros reales)

function uid(prefix) { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }

// Link público legible (/subasta/camiseta-tim-payne-a4c en vez de /subasta/sub_b8470b...):
// se genera UNA vez al crear y no cambia aunque se edite el título después (rompería links
// ya compartidos). El sufijo del id garantiza unicidad sin tener que reintentar por colisión.
function slugify(titulo, id) {
  const base = String(titulo || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suf = String(id || "").replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return (base || "subasta") + (suf ? "-" + suf : "");
}

// Encuestas: `opciones` se guarda como TEXT (JSON) → normaliza a array al leer.
function _enc(row) {
  if (!row) return row;
  let ops = [];
  try { ops = typeof row.opciones === "string" ? JSON.parse(row.opciones || "[]") : (row.opciones || []); } catch (e) { ops = []; }
  return { ...row, opciones: Array.isArray(ops) ? ops : [] };
}

function createPgStore({ databaseUrl, debug }) {
  // prepare:false → requerido por el pooler de Supabase en modo transacción (PgBouncer).
  // ssl:'require'  → Supabase exige TLS.
  // connect_timeout:10 → si el pooler está saturado, falla rápido en vez de colgar el request.
  //
  // PRESUPUESTO DE CONEXIONES (importante al tocar la escala): el techo real es
  // `pool × max-instances`, y tiene que quedar por debajo del "max client connections"
  // del pooler de Supabase — sostenido en ~300 desde el upgrade a MEDIUM.
  //
  // OJO (aprendido el 2026-08-09): bajar el pool para "hacer lugar" a más max-instances
  // fue un error — Cloud Run autoescala por concurrencia real, no por el techo, así que
  // en tráfico normal siguen sirviendo un puñado de instancias (~11 ese día, con
  // max-instances=100). Bajar el pool ahí SÍ achica la capacidad real de cada una de esas
  // pocas instancias, sin beneficio, porque el escenario de escalar al máximo nunca pasó.
  // Regla: el pool se mueve para PROTEGER el presupuesto cuando max-instances sube en
  // serio (viral confirmado, no "por las dudas"); si no, se deja en 6 con max-instances=50.
  const DB_POOL_MAX = Number(process.env.DB_POOL_MAX || 6);
  // max_lifetime (caída puntual del 2026-08-27, ECONNRESET aislado en /api/flags): sin
  // esto, una conexión que se usa seguido (nunca queda inactiva lo bastante para que la
  // cierre idle_timeout) puede vivir horas — y el pooler de Supabase la puede cortar por
  // su cuenta en cualquier momento, sin avisarle al cliente. El primer intento de
  // reutilizarla después sale ECONNRESET. 1800s (30min) recicla la conexión DESDE el
  // cliente antes de que el servidor tenga chance de hacerlo por su cuenta.
  const DB_MAX_LIFETIME = Number(process.env.DB_MAX_LIFETIME || 1800);
  const sqlRaw = postgres(databaseUrl, { max: DB_POOL_MAX, idle_timeout: 20, max_lifetime: DB_MAX_LIFETIME, connect_timeout: 10, prepare: false, ssl: process.env.DB_SSL === "disable" ? false : "require", ...(debug ? { debug } : {}) });

  // ── Plazo máximo por consulta (caída del 2026-08-09) ───────────────────────
  // `connect_timeout` sólo cubre el momento de conectar: una vez conectada, una consulta
  // no tenía límite. Si el socket muere sin avisar (medio abierto), la consulta queda
  // colgada para siempre y se lleva una de las 6 conexiones del pool. A la sexta, la
  // instancia deja de responder TODO lo que toque la base (los 504 de esa noche).
  // El pooler de Supabase IGNORA `statement_timeout` como parámetro de arranque (probado:
  // informa "2min", el default del server), así que el corte tiene que ser del lado del
  // cliente. `query.cancel()` devuelve la conexión al pool — sin eso el plazo no arregla
  // nada, porque la conexión seguiría ocupada.
  // 8s (no 15s): bajo ráfaga de polling con el pool ocupado, cada conexión trabada
  // tarda esto en soltarse — más corto = la cola se drena más rápido cuando hay
  // contención real (caída del 2026-08-09 09:30-13:51: no fue una conexión colgada
  // para siempre, fue degradación en cascada por conexiones tardando su plazo entero).
  const DB_TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 8000);
  const esPlantilla = (a) => Array.isArray(a) && Object.prototype.hasOwnProperty.call(a, "raw");
  // BUG del primer intento (2026-08-09, tarde): envolver con Promise.race devuelve una
  // promesa NUEVA. postgres.js reconoce los fragmentos SQL anidados (`sql\`...${sql\`WHERE
  // x=${y}\`}\``, usados en varias partes de este archivo) chequeando `instanceof Query`
  // (ver node_modules/postgres/cjs/src/types.js) — una promesa distinta ya no pasa ese
  // chequeo, y el fragmento se pierde: el SQL final queda mal armado ("syntax error at or
  // near WHERE"). Arreglo: cancelar en segundo plano SIN reemplazar el objeto — `query` es
  // la MISMA instancia de Query siempre (se la devuelve tal cual), así que sigue sirviendo
  // como fragmento cuando así se usa. Si nunca se ejecuta sola (porque era un fragmento),
  // cancelarla no hace nada dañino: `cancel()` es un no-op una vez que el canceller ya se
  // usó o nunca se necesitó.
  //
  // BUG (2026-10-21, hallado al probar peñas en staging): este envoltorio hacía `query.then(...)` sobre CADA
  // plantilla, y en postgres.js `.then` EJECUTA la consulta. Con los fragmentos anidados (`${where}`) eso
  // mandaba cada fragmento como una consulta suelta: `WHERE p.estado = $1` (error de sintaxis, inofensivo) o
  // un fragmento VACÍO (`sql\`\``) que dejaba colgada la conexión en el pooler de Supabase y, una tras otra, agotaba
  // el pool. En producción no se notaba: los fragmentos con filtro fallaban al instante por sintaxis y casi ninguna
  // consulta quedaba con un fragmento vacío como único filtro. Ahora el plazo se arma recién cuando alguien ESPERA la consulta (await / .then / .catch /
  // .finally): un fragmento nunca se espera, así que nunca se ejecuta.
  function conPlazo(query) {
    const thenOriginal = query.then;
    query.then = function (alExito, alError) {
      const t = setTimeout(() => { try { query.cancel(); } catch (e) { /* la conexión ya no existe */ } }, DB_TIMEOUT_MS);
      const p = thenOriginal.call(query);
      p.then(() => clearTimeout(t), () => clearTimeout(t));
      return p.then(alExito, alError);
    };
    return query;
  }
  const sql = new Proxy(sqlRaw, {
    apply(target, thisArg, args) {
      const out = Reflect.apply(target, thisArg, args);
      // Sólo las consultas de verdad (plantilla etiquetada) llevan plazo. `sql(obj, ...cols)`
      // arma fragmentos de INSERT/UPDATE, no es una consulta y no se toca.
      if (esPlantilla(args[0]) && out && typeof out.then === "function" && typeof out.cancel === "function") {
        return conPlazo(out);
      }
      return out;
    },
    // begin/end/unsafe se atan al objeto real: si los llamáramos con el proxy como `this`,
    // postgres.js podría no encontrar su estado interno. Dentro de una transacción se usa
    // el `tx` propio (sin plazo), que es lo correcto: cancelar a la mitad la dejaría abierta.
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  // Cache en memoria para listas públicas que cambian poco (sorteos/contenido/preventas):
  // bajo carga de lanzamiento le sacan presión al pool del DB. TTL corto + bust en escritura.
  const _cache = {};
  const cacheado = async (clave, ttl, fn) => {
    const c = _cache[clave];
    if (c && Date.now() - c.t < ttl) return c.v;
    const v = await fn(); _cache[clave] = { v, t: Date.now() }; return v;
  };
  const cacheBust = (clave) => { delete _cache[clave]; };

  return {
    kind: "postgres",
    _sql: sql,

    // ── Socios ──
    async createSocio({ email, passwordHash, nombre, apellido, telefono, cedula, fechaNacimiento, referidoPor, idioma }) {
      const id = uid("soc");
      // Alta core con las columnas de siempre (NUNCA falla por la migración de referidos).
      const [s] = await sql`
        INSERT INTO socios (id, email, password_hash, nombre, apellido, telefono, cedula, fecha_nacimiento)
        VALUES (${id}, ${email.toLowerCase()}, ${passwordHash}, ${nombre || ""}, ${apellido || ""}, ${telefono || ""}, ${cedula || ""}, ${fechaNacimiento || null})
        RETURNING *`;
      // Referidos: best-effort. Si las columnas ref_codigo/referido_por aún no existen
      // (migración no corrida), el alta NO se rompe; la atribución se activa sola al migrar.
      try {
        const refCodigo = crypto.createHash("md5").update(id).digest("hex").slice(0, 10); // 10 hex → colisión despreciable
        const [s2] = await sql`UPDATE socios SET ref_codigo = ${refCodigo}, referido_por = ${referidoPor || null}, idioma = ${idioma === "en" ? "en" : "es"} WHERE id = ${id} RETURNING *`;
        if (s2) return s2;
      } catch (e) { /* columnas aún no existen → seguimos con defaults */ }
      return s;
    },
    // ── Referidos ──
    async getSocioByRefCodigo(codigo) {
      const c = String(codigo || "").trim().toLowerCase();
      if (!c) return null;
      const [s] = await sql`SELECT * FROM socios WHERE ref_codigo = ${c} LIMIT 1`;
      return s || null;
    },
    async contarReferidos(socioId) {
      const [r] = await sql`SELECT count(*)::int AS n FROM socios WHERE referido_por = ${socioId}`;
      return r ? r.n : 0;
    },
    async topReferidores(limit = 20) {
      return await sql`
        SELECT s.id, s.nombre, s.ciudad, s.pais_iso, count(r.id)::int AS referidos
        FROM socios s JOIN socios r ON r.referido_por = s.id
        WHERE s.email NOT LIKE ${"%@" + SEED_DOMAIN}
        GROUP BY s.id, s.nombre, s.ciudad, s.pais_iso
        ORDER BY referidos DESC LIMIT ${Math.min(Number(limit) || 20, 100)}`;
    },
    // Cédula ÚNICA: ¿ya hay una cuenta con esta cédula? (compara solo dígitos).
    async getSocioByCedula(cedula) {
      const ced = String(cedula || "").replace(/\D/g, "");
      if (!ced) return null;
      // Expresión '[^0-9]' (no '\D') para que MATCHEE el índice funcional idx_socios_cedula_norm
      // y evite el seq scan; además '\D' dentro del tagged template no era fiable.
      const [s] = await sql`SELECT * FROM socios WHERE cedula <> '' AND regexp_replace(cedula, '[^0-9]', '', 'g') = ${ced} LIMIT 1`;
      return s || null;
    },
    // ── Padrón oficial de Olimpia (reconocer socios → Premium) ──
    async buscarPadron({ email, cedula }) {
      const em = (email || "").toLowerCase().trim();
      const ced = (cedula || "").replace(/\D/g, "");
      if (!em && !ced) return null;
      const [r] = await sql`
        SELECT * FROM padron_olimpia
        WHERE (${em} <> '' AND lower(email) = ${em})
           OR (${ced} <> '' AND regexp_replace(cedula, '\D', '', 'g') = ${ced})
        LIMIT 1`;
      return r || null;
    },
    async marcarPadronReclamado(id, socioId) {
      // Condicional: solo actualiza si AÚN no está reclamado → reclamo atómico (anti doble-reclamo).
      const r = await sql`UPDATE padron_olimpia SET reclamado = true, socio_id = ${socioId} WHERE id = ${id} AND reclamado = false`;
      return r.count > 0;
    },

    // ── Base de Actualización (staging de verificación) ──
    async crearActualizacion(a) {
      const id = uid("act");
      const [r] = await sql`
        INSERT INTO actualizaciones (id, socio_id, tipo, nombre, apellido, email, cedula, pais, ciudad, fecha_nacimiento, tiene_selfie, tier_pretendido, match_padron_id, estado, notas)
        VALUES (${id}, ${a.socioId || null}, ${a.tipo}, ${a.nombre || ""}, ${a.apellido || ""}, ${a.email || ""}, ${a.cedula || ""}, ${a.pais || ""}, ${a.ciudad || ""}, ${a.fechaNacimiento || null}, ${!!a.tieneSelfie}, ${a.tierPretendido || ""}, ${a.matchPadronId || null}, ${a.estado || "pendiente"}, ${a.notas || ""})
        RETURNING *`;
      return r;
    },
    async updateActualizacion(id, patch) {
      const [r] = await sql`UPDATE actualizaciones SET ${sql({ ...patch, actualizado: new Date().toISOString() })} WHERE id = ${id} RETURNING *`;
      return r || null;
    },
    async listActualizaciones({ estado, tipo, socioId, limit } = {}) {
      const lim = Math.min(Number(limit) || 100, 500);
      const conds = [];
      if (estado) conds.push(sql`estado = ${estado}`);
      if (tipo) conds.push(sql`tipo = ${tipo}`);
      if (socioId) conds.push(sql`socio_id = ${socioId}`);
      const where = conds.length
        ? sql`WHERE ${conds.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))}`
        : sql``;
      return sql`SELECT * FROM actualizaciones ${where} ORDER BY creado DESC LIMIT ${lim}`;
    },

    // Reportes del panel admin: embudo, membresías (pagas vs gratis) y altas por día.
    async estadisticasAdmin() {
      const dom = "%@" + SEED_DOMAIN;
      const [embudo] = await sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE foto <> '')::int        AS con_foto,
               COUNT(*) FILTER (WHERE es_socio_olimpia)::int  AS valido_socio,
               COUNT(*) FILTER (WHERE email_verificado)::int  AS email_verif
        FROM socios WHERE email NOT LIKE ${dom}`;
      const membresias = await sql`
        SELECT m.tier_slug,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE m.pago_ref IS NOT NULL AND m.pago_ref <> '' AND m.pago_ref NOT LIKE 'socio:%')::int AS pagados
        FROM membresias m JOIN socios s ON s.id = m.socio_id
        WHERE m.estado = 'activa' AND s.email NOT LIKE ${dom}
        GROUP BY m.tier_slug`;
      const altas = await sql`
        SELECT to_char(date_trunc('day', creado), 'YYYY-MM-DD') AS dia, COUNT(*)::int AS n
        FROM socios WHERE email NOT LIKE ${dom} AND creado >= now() - interval '7 days'
        GROUP BY 1 ORDER BY 1 DESC`;
      // Paso "inició pago" del embudo (socios con al menos un pedido).
      const [ini] = await sql`SELECT COUNT(DISTINCT p.socio_id)::int AS n
        FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id WHERE s.email NOT LIKE ${dom}`;
      embudo.iniciaron_pago = ini.n;
      // Hoy vs ayer (día de Paraguay, calculado en JS para evitar dependencias de TZ del DB).
      const py = new Date(Date.now() - 3 * 3600000); py.setUTCHours(0, 0, 0, 0);
      const hoyIni = new Date(py.getTime() + 3 * 3600000).toISOString();
      const ayerIni = new Date(py.getTime() + 3 * 3600000 - 24 * 3600000).toISOString();
      const [t] = await sql`SELECT
        COUNT(*) FILTER (WHERE creado >= ${hoyIni})::int AS hoy,
        COUNT(*) FILTER (WHERE creado >= ${ayerIni} AND creado < ${hoyIni})::int AS ayer
        FROM socios WHERE email NOT LIKE ${dom}`;
      return { embudo, membresias, altas, tiempo: t };
    },
    // Filtro de socios por segmento (tier actual, país, validó socio, sin foto, texto).
    async filtrarSocios(f = {}) {
      const dom = "%@" + SEED_DOMAIN;
      const lim = Math.min(Number(f.limit) || 500, 5000);
      const conds = [sql`s.email NOT LIKE ${dom}`];
      if (f.paisIso) conds.push(sql`s.pais_iso = ${String(f.paisIso).toUpperCase()}`);
      if (f.validoSocio) conds.push(sql`s.es_socio_olimpia = true`);
      if (f.sinFoto) conds.push(sql`(s.foto IS NULL OR s.foto = '')`);
      if (f.canjes === true) conds.push(sql`EXISTS (SELECT 1 FROM canjes c WHERE c.socio_id = s.id)`);
      if (f.canjes === false) conds.push(sql`NOT EXISTS (SELECT 1 FROM canjes c WHERE c.socio_id = s.id)`);
      if (f.pujas === true) conds.push(sql`EXISTS (SELECT 1 FROM pujas p WHERE p.socio_id = s.id)`);
      if (f.pujas === false) conds.push(sql`NOT EXISTS (SELECT 1 FROM pujas p WHERE p.socio_id = s.id)`);
      if (f.gasto === true) conds.push(sql`s.gasto_total > 0`);
      if (f.gasto === false) conds.push(sql`s.gasto_total = 0`);
      if (f.ciudad) conds.push(sql`lower(s.ciudad) = ${String(f.ciudad).toLowerCase()}`);
      if (f.excluirId) conds.push(sql`s.id <> ${f.excluirId}`);
      if (f.tier) conds.push(sql`coalesce(m.tier_slug, 'olimpista') = ${f.tier}`);
      if (f.q) { const term = "%" + String(f.q).toLowerCase() + "%"; conds.push(sql`(lower(s.email) LIKE ${term} OR lower(coalesce(s.nombre,'')) LIKE ${term} OR lower(coalesce(s.apellido,'')) LIKE ${term} OR coalesce(s.cedula,'') LIKE ${term})`); }
      const where = conds.reduce((a, c, i) => (i === 0 ? c : sql`${a} AND ${c}`));
      return sql`
        SELECT s.id, s.nombre, s.apellido, s.email, s.cedula, s.pais, s.pais_iso, s.ciudad, s.es_socio_olimpia, s.gasto_total, s.ultima_actividad,
               (s.foto IS NOT NULL AND s.foto <> '') AS tiene_foto, coalesce(m.tier_slug,'olimpista') AS tier_slug, s.creado
        FROM socios s
        LEFT JOIN LATERAL (SELECT tier_slug FROM membresias WHERE socio_id = s.id AND estado = 'activa' ORDER BY inicio DESC LIMIT 1) m ON true
        WHERE ${where} ORDER BY s.creado DESC LIMIT ${lim}`;
    },

    // Cuadre de pagos: pedidos por estado, membresías pagas y conciliación Metrepay.
    async cuadrePagos() {
      const dom = "%@" + SEED_DOMAIN;
      const [ped] = await sql`SELECT
        COUNT(*) FILTER (WHERE estado='pendiente')::int AS pendiente,
        COUNT(*) FILTER (WHERE estado='pagado')::int    AS pagado,
        COUNT(*) FILTER (WHERE estado='rechazado')::int AS rechazado
        FROM pedidos_pago`;
      const [mem] = await sql`SELECT
        COUNT(*) FILTER (WHERE m.tier_slug='premium')::int AS premium,
        COUNT(*) FILTER (WHERE m.tier_slug='kids')::int    AS kids
        FROM membresias m JOIN socios s ON s.id = m.socio_id
        WHERE m.estado='activa' AND s.email NOT LIKE ${dom}
          AND m.pago_ref IS NOT NULL AND m.pago_ref <> '' AND m.pago_ref NOT LIKE 'socio:%'`;
      const [mp] = await sql`SELECT
        COUNT(*) FILTER (WHERE estado='validado_auto')::int AS activados,
        COUNT(*) FILTER (WHERE estado='a_revisar')::int     AS sin_match,
        COUNT(*)::int AS total
        FROM actualizaciones WHERE tipo='pago_metrepay'`;
      return { pedidos: ped, membresiasPagas: mem, metrepay: mp };
    },
    // Pagos ACREDITADOS (pedidos_pago pagados): totales por período, por concepto y últimos.
    async pagosRecibidos() {
      const dom = "%@" + SEED_DOMAIN;
      const pyg = sql`(p.moneda = 'PYG' OR p.moneda IS NULL)`;
      const [tot] = await sql`
        SELECT
          coalesce(SUM(p.monto),0)::bigint AS total,
          coalesce(SUM(p.monto) FILTER (WHERE p.creado >= now() - interval '1 day'),0)::bigint  AS hoy,
          coalesce(SUM(p.monto) FILTER (WHERE p.creado >= now() - interval '7 days'),0)::bigint  AS d7,
          coalesce(SUM(p.monto) FILTER (WHERE p.creado >= now() - interval '30 days'),0)::bigint AS d30,
          COUNT(*)::int AS n
        FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id
        WHERE p.estado = 'pagado' AND s.email NOT LIKE ${dom} AND ${pyg}`;
      const porConcepto = await sql`
        SELECT
          CASE WHEN p.reserva_id IS NOT NULL THEN 'entrada'
               WHEN p.tier_slug = 'premium' THEN 'plus'
               WHEN p.tier_slug = 'kids' THEN 'junior'
               ELSE coalesce(p.tier_slug, 'otro') END AS tipo,
          COUNT(*)::int AS n, coalesce(SUM(p.monto),0)::bigint AS monto
        FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id
        WHERE p.estado = 'pagado' AND s.email NOT LIKE ${dom} AND ${pyg}
        GROUP BY 1 ORDER BY monto DESC`;
      const ultimos = await sql`
        SELECT p.id, p.concepto, p.monto, p.moneda, p.tier_slug, p.reserva_id, p.ref_externa, p.creado,
               s.nombre, s.apellido, s.email
        FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id
        WHERE p.estado = 'pagado' AND s.email NOT LIKE ${dom}
        ORDER BY p.creado DESC LIMIT 200`;
      return {
        totales: { total: Number(tot.total), hoy: Number(tot.hoy), d7: Number(tot.d7), d30: Number(tot.d30), n: tot.n },
        porConcepto: porConcepto.map((c) => ({ ...c, monto: Number(c.monto) })),
        ultimos,
      };
    },
    // ── Eventos de email (Resend) ──
    async registrarEmailEvento({ tipo, email, messageId, asunto } = {}) {
      const id = uid("eev");
      await sql`INSERT INTO email_eventos (id, tipo, email, message_id, asunto)
                VALUES (${id}, ${tipo || ""}, ${(email || "").toLowerCase()}, ${messageId || ""}, ${asunto || ""})`;
      return { id };
    },
    async marcarBajaPorEmail(email) {
      if (!email) return 0;
      const rows = await sql`UPDATE socios SET marketing_baja = true, marketing_baja_en = now()
                             WHERE lower(email) = ${String(email).toLowerCase()} AND coalesce(marketing_baja, false) = false RETURNING id`;
      return rows.length;
    },
    async metricasEmail(dias = 30) {
      const map = (arr) => { const o = {}; arr.forEach((r) => (o[r.tipo] = r.n)); return o; };
      const ventana = await sql`SELECT tipo, COUNT(*)::int AS n FROM email_eventos WHERE creado >= now() - make_interval(days => ${dias}) GROUP BY tipo`;
      const total = await sql`SELECT tipo, COUNT(*)::int AS n FROM email_eventos GROUP BY tipo`;
      return { dias, ventana: map(ventana), total: map(total) };
    },
    // ── Cron / ciclo de vida ──
    async cumplenHoy() {
      const dom = "%@" + SEED_DOMAIN;
      return sql`SELECT id, nombre, email, idioma, pais_iso FROM socios
        WHERE fecha_nacimiento IS NOT NULL AND to_char(fecha_nacimiento,'MM-DD') = to_char(now(),'MM-DD')
          AND email <> '' AND email NOT LIKE ${dom} AND coalesce(marketing_baja,false) = false`;
    },
    async membresiasPorVencer(dias) {
      const dom = "%@" + SEED_DOMAIN;
      return sql`SELECT s.id, s.nombre, s.email, s.idioma, s.pais_iso, m.tier_slug,
        ((m.inicio + interval '1 year')::date - now()::date) AS dias_rest
        FROM membresias m JOIN socios s ON s.id = m.socio_id
        WHERE m.estado='activa' AND m.tier_slug IN ('premium','kids')
          AND m.pago_ref IS NOT NULL AND m.pago_ref <> '' AND m.pago_ref NOT LIKE 'socio:%'
          AND s.email <> '' AND s.email NOT LIKE ${dom} AND coalesce(s.marketing_baja,false) = false
          AND (m.inicio + interval '1 year')::date BETWEEN now()::date AND (now()::date + ${dias})`;
    },
    // ── Red de Beneficios ──
    async listComercios() { return sql`SELECT * FROM comercios ORDER BY nombre`; },
    async getComercio(id) { const [c] = await sql`SELECT * FROM comercios WHERE id = ${id} LIMIT 1`; return c || null; },
    async crearComercio(d = {}) {
      const id = uid("com");
      const [c] = await sql`INSERT INTO comercios (id, nombre, rubro, logo, direccion, ciudad, contacto, estado)
        VALUES (${id}, ${d.nombre || ""}, ${d.rubro || ""}, ${d.logo || ""}, ${d.direccion || ""}, ${d.ciudad || ""}, ${d.contacto || ""}, ${d.estado || "activo"}) RETURNING *`;
      return c;
    },
    async updateComercio(id, patch) { const [c] = await sql`UPDATE comercios SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return c || null; },
    async deleteComercio(id) { await sql`DELETE FROM comercios WHERE id = ${id}`; return true; },

    async listBeneficios() { return sql`SELECT b.*, c.nombre AS comercio_nombre FROM beneficios b JOIN comercios c ON c.id = b.comercio_id ORDER BY b.creado DESC`; },
    async getBeneficio(id) { const [b] = await sql`SELECT * FROM beneficios WHERE id = ${id} LIMIT 1`; return b || null; },
    async crearBeneficio(d = {}) {
      const id = uid("ben");
      const [b] = await sql`INSERT INTO beneficios (id, comercio_id, titulo, descripcion, tipo, valor, niveles, pct, ahorro_estimado, vigencia_desde, vigencia_hasta, limite_dias, activo)
        VALUES (${id}, ${d.comercio_id}, ${d.titulo || ""}, ${d.descripcion || ""}, ${d.tipo || "descuento"}, ${d.valor || ""}, ${d.niveles || "todos"}, ${d.pct != null && d.pct !== "" ? Number(d.pct) : null}, ${d.ahorro_estimado != null && d.ahorro_estimado !== "" ? Number(d.ahorro_estimado) : null}, ${d.vigencia_desde || null}, ${d.vigencia_hasta || null}, ${d.limite_dias != null && d.limite_dias !== "" ? Number(d.limite_dias) : null}, ${d.activo !== false}) RETURNING *`;
      return b;
    },
    async updateBeneficio(id, patch) { const [b] = await sql`UPDATE beneficios SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return b || null; },
    async deleteBeneficio(id) { await sql`DELETE FROM beneficios WHERE id = ${id}`; return true; },

    // Beneficios visibles para un nivel (socio): activos, vigentes, aplicables al tier.
    // Devuelve TODOS los beneficios activos/vigentes con flag desbloqueado + nivel_min (para
    // mostrarle al socio lo suyo Y lo bloqueado como gancho de upsell).
    async beneficiosParaNivel(tier) {
      const rows = await sql`SELECT b.*, c.nombre AS comercio_nombre, c.rubro AS comercio_rubro, c.logo AS comercio_logo, c.ciudad AS comercio_ciudad
        FROM beneficios b JOIN comercios c ON c.id = b.comercio_id
        WHERE b.activo = true AND c.estado = 'activo'
          AND (b.vigencia_desde IS NULL OR b.vigencia_desde <= now()::date)
          AND (b.vigencia_hasta IS NULL OR b.vigencia_hasta >= now()::date)
        ORDER BY c.nombre`;
      const ORD = ["olimpista", "kids", "premium", "socio"];
      const nivelTier = Math.max(0, ORD.indexOf(tier)); // nivel del socio (escalonado)
      return rows.map((b) => {
        const nivs = b.niveles === "todos" ? "todos" : String(b.niveles).split(",").map((x) => x.trim()).filter(Boolean);
        // ESCALONADO: un tier alto desbloquea los beneficios de niveles inferiores.
        const idxs = nivs === "todos" ? [0] : nivs.map((n) => ORD.indexOf(n)).filter((i) => i >= 0);
        const nivelReq = idxs.length ? Math.min.apply(null, idxs) : 0;
        const desbloqueado = nivelTier >= nivelReq;
        const nivel_min = ORD[nivelReq] || "olimpista";
        return { ...b, desbloqueado, nivel_min };
      });
    },
    async registrarCanje({ beneficioId, socioId, comercioId, validadoPor, monto, ahorro } = {}) {
      const id = uid("cnj");
      const [c] = await sql`INSERT INTO canjes (id, beneficio_id, socio_id, comercio_id, validado_por, monto, ahorro)
        VALUES (${id}, ${beneficioId}, ${socioId || null}, ${comercioId || null}, ${validadoPor || ""}, ${monto != null ? Math.round(monto) : null}, ${ahorro != null ? Math.round(ahorro) : null}) RETURNING *`;
      return c;
    },
    async ultimoCanje(socioId, beneficioId) { const [c] = await sql`SELECT * FROM canjes WHERE socio_id = ${socioId} AND beneficio_id = ${beneficioId} ORDER BY creado DESC LIMIT 1`; return c || null; },
    // ── Billetera de ahorro, Ficha 360 y segmentos (migración 0004) ──
    // Mes y año CALENDARIO en hora de Paraguay (antes se usaba el mes UTC: lo gastado entre las
    // 21:00 y la medianoche del último día del mes contaba en el mes siguiente).
    async resumenAhorroSocio(socioId) {
      const [r] = await sql`SELECT
        coalesce(SUM(ahorro), 0)::bigint AS total,
        coalesce(SUM(ahorro) FILTER (WHERE creado >= date_trunc('month', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'), 0)::bigint AS mes,
        coalesce(SUM(ahorro) FILTER (WHERE creado >= date_trunc('year', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'), 0)::bigint AS anio,
        (COUNT(*) FILTER (WHERE creado >= date_trunc('month', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion'))::int AS canjes_mes
        FROM canjes WHERE socio_id = ${socioId}`;
      return { mes: Number(r.mes), anio: Number(r.anio), total: Number(r.total), canjes_mes: r.canjes_mes };
    },
    // Última actividad (el llamador ya limita la frecuencia: a lo sumo 1 vez por hora y socio).
    async tocarActividad(socioId) { await sql`UPDATE socios SET ultima_actividad = now() WHERE id = ${socioId}`; return true; },
    async canjesDeSocio(socioId, limit = 20) {
      return sql`SELECT c.id, c.creado, c.monto, c.ahorro, b.titulo AS beneficio, co.nombre AS comercio
        FROM canjes c LEFT JOIN beneficios b ON b.id = c.beneficio_id LEFT JOIN comercios co ON co.id = c.comercio_id
        WHERE c.socio_id = ${socioId} ORDER BY c.creado DESC LIMIT ${limit}`;
    },
    // Una fila por lote en el que pujó: su mejor oferta, cuándo fue la última y cómo terminó.
    async pujasDeSocio(socioId, limit = 20) {
      return sql`SELECT s.id AS subasta_id, s.titulo, s.estado, s.puja_actual, s.ganador_id, s.adjudicado_a, s.pago_estado,
          MAX(p.monto)::int AS mejor_oferta, COUNT(*)::int AS pujas, MAX(p.creado) AS ultima
        FROM pujas p JOIN subastas s ON s.id = p.subasta_id WHERE p.socio_id = ${socioId}
        GROUP BY s.id ORDER BY MAX(p.creado) DESC LIMIT ${limit}`;
    },
    async crearSegmento({ nombre, filtros, por }) {
      const id = uid("seg");
      const [s] = await sql`INSERT INTO segmentos_guardados (id, nombre, filtros, creado_por) VALUES (${id}, ${nombre}, ${JSON.stringify(filtros || {})}, ${por || "admin"}) RETURNING *`;
      return { ...s, filtros: filtros || {} };
    },
    async listSegmentos() {
      const filas = await sql`SELECT * FROM segmentos_guardados ORDER BY creado DESC LIMIT 200`;
      return filas.map((s) => { let f = {}; try { f = JSON.parse(s.filtros || "{}"); } catch (e) {} return { ...s, filtros: f }; });
    },
    async deleteSegmento(id) { await sql`DELETE FROM segmentos_guardados WHERE id = ${id}`; return true; },
    // Auditoría del panel.
    async logAccionAdmin({ accion, targetId, detalle, por } = {}) {
      try {
        await sql`INSERT INTO acciones_admin (id, accion, target_id, detalle, por)
          VALUES (${uid("acc")}, ${accion}, ${targetId || null}, ${detalle || ""}, ${por || "admin"})`;
      } catch (e) { /* el log nunca rompe la acción */ }
    },
    async listAccionesAdmin({ limit } = {}) {
      const lim = Math.min(Number(limit) || 100, 500);
      return sql`SELECT * FROM acciones_admin ORDER BY creado DESC LIMIT ${lim}`;
    },
    async getSocioByEmail(email) {
      const [s] = await sql`SELECT * FROM socios WHERE email = ${String(email).toLowerCase()} LIMIT 1`;
      return s || null;
    },
    async getSocioById(id) {
      const [s] = await sql`SELECT * FROM socios WHERE id = ${id} LIMIT 1`;
      return s || null;
    },
    async getSocioByVerifToken(token) {
      const [s] = await sql`SELECT * FROM socios WHERE verif_token = ${token} LIMIT 1`;
      return s || null;
    },
    async getSocioByResetToken(token) {
      if (!token) return null;
      const [s] = await sql`SELECT * FROM socios WHERE reset_token = ${token} LIMIT 1`;
      return s || null;
    },

    // ── Estadísticas (contador + globo) ──
    // Conteos de miembros REALES (excluye las filas de demo @demo.olimpistas.test).
    async contarTotal() {
      const [r] = await sql`SELECT COUNT(*)::int AS n FROM socios WHERE email NOT LIKE ${"%@" + SEED_DOMAIN}`;
      return r.n;
    },
    async contarPorPais() {
      return sql`
        SELECT pais_iso, COUNT(*)::int AS count FROM socios
        WHERE pais_iso IS NOT NULL AND pais_iso <> '' AND email NOT LIKE ${"%@" + SEED_DOMAIN}
        GROUP BY pais_iso`;
    },
    async contarPorCiudad() {
      return sql`
        SELECT pais_iso, COALESCE(ciudad, '') AS ciudad, COUNT(*)::int AS count,
               AVG(lat) AS lat, AVG(lng) AS lng
        FROM socios WHERE pais_iso IS NOT NULL AND pais_iso <> '' AND email NOT LIKE ${"%@" + SEED_DOMAIN}
        GROUP BY pais_iso, COALESCE(ciudad, '')
        ORDER BY count DESC LIMIT 600`;
    },
    // Agregado de demo (distribución mundial): ~100 ciudades. Tabla opcional.
    async demoAgregado() {
      try {
        return await sql`SELECT pais_iso, ciudad, lat, lng, count FROM demo_agregado`;
      } catch (e) { return []; } // si la tabla no existe aún
    },
    // Banderas individuales ("casa") dentro del recuadro visible: solo miembros que
    // optaron por mostrar su punto exacto. Para el zoom alto del globo público.
    async flagsEnBBox({ minLng, minLat, maxLng, maxLat, limit = 600 }) {
      return sql`
        SELECT id, nombre, ciudad, lat, lng FROM socios
        WHERE mostrar_exacto = true AND lat IS NOT NULL AND lng IS NOT NULL
          AND lng BETWEEN ${minLng} AND ${maxLng}
          AND lat BETWEEN ${minLat} AND ${maxLat}
        LIMIT ${Math.min(Number(limit) || 600, 1500)}`;
    },
    async updateSocio(id, patch) {
      const [s] = await sql`UPDATE socios SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
      return s || null;
    },

    // ── Sesiones ──
    async createSession(socioId, token, expiraIso) {
      const [s] = await sql`
        INSERT INTO sesiones (token, socio_id, expira)
        VALUES (${token}, ${socioId}, ${expiraIso}) RETURNING *`;
      return s;
    },
    async getSession(token) {
      const [row] = await sql`
        SELECT s.token, s.socio_id, s.expira, so.*
        FROM sesiones s JOIN socios so ON so.id = s.socio_id
        WHERE s.token = ${token} AND s.expira > now() LIMIT 1`;
      if (!row) return null;
      const { token: t, socio_id, expira, ...socio } = row;
      return { session: { token: t, socio_id, expira }, socio };
    },
    async deleteSession(token) {
      await sql`DELETE FROM sesiones WHERE token = ${token}`;
    },
    // Cierra TODAS las sesiones de un socio (p. ej. al resetear la contraseña).
    async borrarSesionesDeSocio(socioId) { await sql`DELETE FROM sesiones WHERE socio_id = ${socioId}`; return true; },
    // Purga sesiones vencidas (se llama desde el cron; evita bloat de la tabla).
    async purgarSesionesVencidas() { const r = await sql`DELETE FROM sesiones WHERE expira < now()`; return r.count || 0; },
    // Idempotencia de notificaciones: true = primera vez (reservado) / false = ya enviada.
    // Atómico e inmune a doble corrida del cron y a concurrencia entre instancias.
    async reservarNotificacion(clave) {
      const r = await sql`INSERT INTO notificaciones_log (clave) VALUES (${clave}) ON CONFLICT (clave) DO NOTHING RETURNING clave`;
      return r.length > 0;
    },

    // ── Membresías ──
    async setMembresia(socioId, m) {
      return sql.begin(async (tx) => {
        await tx`UPDATE membresias SET estado = 'reemplazada' WHERE socio_id = ${socioId} AND estado = 'activa'`;
        const id = uid("mem");
        const [mem] = await tx`
          INSERT INTO membresias (id, socio_id, tier_slug, ciclo, estado, fin, pago_ref)
          VALUES (${id}, ${socioId}, ${m.tierSlug}, ${m.ciclo || "anio"}, ${m.estado || "activa"},
                  ${m.fin || null}, ${m.pagoRef || null})
          RETURNING *`;
        return mem;
      });
    },
    async getMembresia(socioId) {
      const [m] = await sql`
        SELECT * FROM membresias WHERE socio_id = ${socioId} AND estado = 'activa'
        ORDER BY inicio DESC LIMIT 1`;
      return m || null;
    },

    // ── Contenido ──
    async listContenido() { return cacheado("contenido", 30000, () => sql`SELECT * FROM contenido ORDER BY publicado DESC`); },
    async getContenido(id) {
      const [c] = await sql`SELECT * FROM contenido WHERE id = ${id} LIMIT 1`;
      return c || null;
    },

    // ── CRUD admin: sorteos / preventas / contenido ──
    async crearSorteo(d = {}) { const [s] = await sql`INSERT INTO sorteos ${sql({ id: uid("sor"), titulo: d.titulo || "", descripcion: d.descripcion || null, tier_min: d.tier_min || "olimpista", cierra: d.cierra || null, imagen: d.imagen || null })} RETURNING *`; return s; },
    async updateSorteo(id, patch) { const [s] = await sql`UPDATE sorteos SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return s || null; },
    async deleteSorteo(id) { const r = await sql`DELETE FROM sorteos WHERE id = ${id}`; return r.count > 0; },
    async listParticipantesSorteo(id) { return sql`SELECT s.id, s.nombre, s.apellido, s.email FROM participaciones p JOIN socios s ON s.id = p.socio_id WHERE p.sorteo_id = ${id} ORDER BY p.creado ASC`; },
    async crearPreventa(d = {}) { const [p] = await sql`INSERT INTO preventas ${sql({ id: uid("pre"), evento: d.evento || "", fecha: d.fecha || null, sede: d.sede || null, abre: d.abre || null, tier_min: d.tier_min || "olimpista", precio_desde: d.precio_desde != null ? Number(d.precio_desde) : null, imagen: d.imagen || null, stock: d.stock != null ? Number(d.stock) : 0 })} RETURNING *`; return p; },
    async updatePreventa(id, patch) { const [p] = await sql`UPDATE preventas SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return p || null; },
    async deletePreventa(id) { const r = await sql`DELETE FROM preventas WHERE id = ${id}`; return r.count > 0; },
    async crearContenido(d = {}) { const [c] = await sql`INSERT INTO contenido ${sql({ id: uid("con"), titulo: d.titulo || "", tipo: d.tipo || "video", tier_min: d.tier_min || "olimpista", duracion: d.duracion || null, thumb: d.thumb || null, descripcion: d.descripcion || null, publicado: d.publicado || null })} RETURNING *`; return c; },
    async updateContenido(id, patch) { const [c] = await sql`UPDATE contenido SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return c || null; },
    async deleteContenido(id) { const r = await sql`DELETE FROM contenido WHERE id = ${id}`; return r.count > 0; },

    // ── Padrón explorer + moderación de selfies ──
    async buscarPadronLista(q, limit) {
      const lim = Math.min(Number(limit) || 100, 500);
      const term = "%" + String(q || "").toLowerCase() + "%";
      return sql`SELECT id, cedula, email, nombre, apellido, telefono, nro_socio, reclamado
        FROM padron_olimpia
        WHERE lower(coalesce(nombre,'') || ' ' || coalesce(apellido,'')) LIKE ${term}
           OR lower(coalesce(email,'')) LIKE ${term} OR coalesce(cedula,'') LIKE ${term} OR coalesce(nro_socio,'') LIKE ${term}
        ORDER BY apellido ASC NULLS LAST LIMIT ${lim}`;
    },
    async statsPadron() {
      const [r] = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE reclamado)::int AS reclamados FROM padron_olimpia`;
      return r;
    },
    async listSociosConFoto({ limit } = {}) {
      const dom = "%@" + SEED_DOMAIN;
      const lim = Math.min(Number(limit) || 80, 300);
      return sql`SELECT id, nombre, apellido, email, pais_iso, ciudad FROM socios
        WHERE foto IS NOT NULL AND foto <> '' AND email NOT LIKE ${dom} ORDER BY creado DESC LIMIT ${lim}`;
    },

    // ── Campañas + tasa de conversión ──
    async crearCampana({ nombre, tipo } = {}) {
      const [c] = await sql`INSERT INTO campanas (id, nombre, tipo) VALUES (${uid("cmp")}, ${nombre || "Campaña"}, ${tipo || ""}) RETURNING *`;
      return c;
    },
    async crearEnviosCampana(campanaId, socios) {
      for (const s of socios) {
        await sql`INSERT INTO campana_envios (id, campana_id, socio_id, email, tier_pretendido, estado_inicial)
          VALUES (${uid("env")}, ${campanaId}, ${s.id}, ${s.email || ""}, ${s.tier_slug || ""}, ${s.estado_inicial || "olimpista"})`;
      }
      await sql`UPDATE campanas SET total_enviados = ${socios.length} WHERE id = ${campanaId}`;
      return socios.length;
    },
    async listCampanas() {
      return sql`SELECT c.*,
        (SELECT COUNT(*) FROM campana_envios e WHERE e.campana_id = c.id)::int AS envios,
        (SELECT COUNT(*) FROM campana_envios e WHERE e.campana_id = c.id AND e.enviado_ok)::int AS enviados_ok,
        (SELECT COUNT(*) FROM campana_envios e WHERE e.campana_id = c.id AND e.convertido)::int AS convertidos
        FROM campanas c ORDER BY c.creada DESC`;
    },
    async listEnviosCampana(campanaId, soloPendientes) {
      return soloPendientes
        ? sql`SELECT * FROM campana_envios WHERE campana_id = ${campanaId} AND enviado_ok = false ORDER BY creado ASC`
        : sql`SELECT * FROM campana_envios WHERE campana_id = ${campanaId} ORDER BY creado ASC`;
    },
    async marcarEnviado(envioId) { await sql`UPDATE campana_envios SET enviado_ok = true WHERE id = ${envioId}`; },
    async recalcularConversion(campanaId) {
      await sql`UPDATE campana_envios e SET convertido = true, convertido_en = now()
        FROM membresias m
        WHERE e.campana_id = ${campanaId} AND e.convertido = false
          AND m.socio_id = e.socio_id AND m.estado = 'activa' AND m.tier_slug IN ('premium','kids')
          AND m.pago_ref IS NOT NULL AND m.pago_ref NOT LIKE 'socio:%'
          AND e.estado_inicial NOT IN ('premium','kids')`;
      const [r] = await sql`SELECT COUNT(*)::int AS enviados, COUNT(*) FILTER (WHERE convertido)::int AS convertidos FROM campana_envios WHERE campana_id = ${campanaId}`;
      return r;
    },

    // ── Sorteos ──
    async listSorteos() { return cacheado("sorteos", 30000, () => sql`
      SELECT sor.*, soc.nombre AS ganador_nombre FROM sorteos sor
      LEFT JOIN socios soc ON soc.id = sor.ganador_id ORDER BY sor.cierra ASC`); },
    async getSorteo(id) {
      const [s] = await sql`SELECT * FROM sorteos WHERE id = ${id} LIMIT 1`;
      return s || null;
    },
    async participarSorteo(sorteoId, socioId) {
      const id = uid("par");
      const [p] = await sql`
        INSERT INTO participaciones (id, sorteo_id, socio_id)
        VALUES (${id}, ${sorteoId}, ${socioId})
        ON CONFLICT (sorteo_id, socio_id) DO UPDATE SET sorteo_id = EXCLUDED.sorteo_id
        RETURNING *`;
      return p;
    },
    async listParticipaciones(socioId) {
      return sql`SELECT * FROM participaciones WHERE socio_id = ${socioId}`;
    },

    // ── Preventas ──
    async listPreventas() { return cacheado("preventas", 30000, () => sql`SELECT * FROM preventas ORDER BY fecha ASC`); },
    async getPreventa(id) {
      const [p] = await sql`SELECT * FROM preventas WHERE id = ${id} LIMIT 1`;
      return p || null;
    },
    async reservarPreventa(preventaId, socioId, cantidad) {
      return sql.begin(async (tx) => {
        const [pv] = await tx`SELECT * FROM preventas WHERE id = ${preventaId} FOR UPDATE`;
        if (!pv) return null;
        if (pv.stock < cantidad) return { error: "sin_stock" };
        await tx`UPDATE preventas SET stock = stock - ${cantidad} WHERE id = ${preventaId}`;
        const id = uid("res");
        const [r] = await tx`
          INSERT INTO reservas (id, preventa_id, socio_id, cantidad)
          VALUES (${id}, ${preventaId}, ${socioId}, ${cantidad}) RETURNING *`;
        return r;
      });
    },
    async getReserva(id) {
      const [r] = await sql`SELECT * FROM reservas WHERE id = ${id} LIMIT 1`;
      return r || null;
    },
    async confirmarReserva(id) {
      const [r] = await sql`UPDATE reservas SET estado = 'pagada' WHERE id = ${id} RETURNING *`;
      return r || null;
    },
    // Reversión: cancela la reserva y repone el stock (transacción).
    async cancelarReservaYreponer(id) {
      return sql.begin(async (tx) => {
        const [r] = await tx`SELECT * FROM reservas WHERE id = ${id} FOR UPDATE`;
        if (!r || r.estado === "cancelada") return r || null;
        await tx`UPDATE reservas SET estado = 'cancelada' WHERE id = ${id}`;
        await tx`UPDATE preventas SET stock = stock + ${r.cantidad} WHERE id = ${r.preventa_id}`;
        return { ...r, estado: "cancelada" };
      });
    },

    // ── Pedidos de pago ──
    async createPedidoPago({ socioId, concepto, monto, moneda, refExterna, tierSlug, ciclo, reservaId, subastaId }) {
      const id = uid("ped");
      const [p] = await sql`
        INSERT INTO pedidos_pago (id, socio_id, concepto, monto, moneda, ref_externa, tier_slug, reserva_id, subasta_id, ciclo)
        VALUES (${id}, ${socioId}, ${concepto}, ${monto}, ${moneda || "PYG"}, ${refExterna || null},
                ${tierSlug || null}, ${reservaId || null}, ${subastaId || null}, ${ciclo || "anio"})
        RETURNING *`;
      return p;
    },
    async updatePedidoPago(id, patch) {
      const [p] = await sql`UPDATE pedidos_pago SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
      return p || null;
    },
    async getPedidoPorSubasta(subastaId) {
      const [p] = await sql`SELECT * FROM pedidos_pago WHERE subasta_id = ${subastaId} ORDER BY creado DESC LIMIT 1`;
      return p || null;
    },
    async marcarSubastaPagada(id) { await sql`UPDATE subastas SET pago_estado = 'pagado' WHERE id = ${id}`; return true; },
    // ── Admin ──
    async listPedidos({ estado, socioId, limit } = {}) {
      const lim = Math.min(Number(limit) || 100, 500);
      const conds = [];
      if (estado) conds.push(sql`p.estado = ${estado}`);
      if (socioId) conds.push(sql`p.socio_id = ${socioId}`);
      const where = conds.length ? sql`WHERE ${conds.reduce((a, c, i) => (i === 0 ? c : sql`${a} AND ${c}`))}` : sql``;
      return sql`SELECT p.*, s.email, s.nombre, s.apellido FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id ${where} ORDER BY p.creado DESC LIMIT ${lim}`;
    },
    async listMembresias(socioId) {
      return sql`SELECT * FROM membresias WHERE socio_id = ${socioId} ORDER BY inicio DESC`;
    },
    // Socios que iniciaron el pago (pedido pendiente) y NO lo completaron (siguen sin Plus/Junior).
    async abandonosPago() {
      const dom = "%@" + SEED_DOMAIN;
      return sql`
        SELECT DISTINCT ON (s.id) s.id, s.nombre, s.apellido, s.email, s.pais_iso, p.tier_slug, p.creado
        FROM pedidos_pago p JOIN socios s ON s.id = p.socio_id
        WHERE p.estado = 'pendiente' AND s.email NOT LIKE ${dom}
          AND NOT EXISTS (SELECT 1 FROM membresias m WHERE m.socio_id = s.id AND m.estado = 'activa' AND m.tier_slug IN ('premium','kids'))
        ORDER BY s.id, p.creado DESC`;
    },
    async buscarSocios(q, limit) {
      const term = "%" + String(q || "").toLowerCase() + "%";
      const lim = Math.min(Number(limit) || 50, 200);
      return await sql`
        SELECT id, email, nombre, apellido, cedula, pais, ciudad, es_socio_olimpia, creado
        FROM socios
        WHERE email NOT LIKE ${"%@" + SEED_DOMAIN}
          AND (lower(email) LIKE ${term} OR lower(coalesce(nombre,'')) LIKE ${term} OR lower(coalesce(apellido,'')) LIKE ${term} OR coalesce(cedula,'') LIKE ${term})
        ORDER BY creado DESC LIMIT ${lim}`;
    },
    async getPedidoPago(id) {
      const [p] = await sql`SELECT * FROM pedidos_pago WHERE id = ${id} LIMIT 1`;
      return p || null;
    },
    // ── Cobro y entrega, como dos hechos atómicos (migración 0002) ──
    // Reclama la entrega de un pedido cuyo pago se acreditó: en UN solo UPDATE lo marca pagado
    // (si no lo estaba) y toma un candado de 2 minutos. Devuelve la fila solo a quien lo ganó;
    // si otro webhook ya lo está entregando, o ya se entregó, devuelve null. Así dos webhooks
    // simultáneos (o el reintento de Pagopar) nunca entregan dos veces, y un pedido pagado
    // cuya entrega falló sigue "reclamable" hasta que alguien la complete.
    async reclamarCumplimiento(id) {
      const [p] = await sql`UPDATE pedidos_pago
        SET estado = 'pagado', pagado_en = COALESCE(pagado_en, now()), cumplimiento_desde = now()
        WHERE id = ${id} AND cumplido_en IS NULL
          AND (cumplimiento_desde IS NULL OR cumplimiento_desde < now() - interval '2 minutes')
        RETURNING *`;
      return p || null;
    },
    async marcarCumplido(id) {
      return sql.begin(async (tx) => {
        const [p] = await tx`UPDATE pedidos_pago SET cumplido_en = now(), cumplimiento_desde = NULL WHERE id = ${id} AND cumplido_en IS NULL RETURNING *`;
        if (!p) return null;
        // El gasto del socio suma UNA vez por pedido (el UPDATE de arriba solo lo gana una llamada).
        if (p.socio_id) await tx`UPDATE socios SET gasto_total = gasto_total + ${p.monto}, ultima_actividad = now() WHERE id = ${p.socio_id}`;
        return p;
      });
    },
    async liberarCumplimiento(id) {
      await sql`UPDATE pedidos_pago SET cumplimiento_desde = NULL WHERE id = ${id} AND cumplido_en IS NULL`;
      return true;
    },
    // pagado → reversado, atómico. Devuelve la fila solo si este llamado hizo la transición.
    async marcarReversado(id) {
      return sql.begin(async (tx) => {
        const [p] = await tx`UPDATE pedidos_pago SET estado = 'reversado' WHERE id = ${id} AND estado = 'pagado' RETURNING *`;
        if (!p) return null;
        if (p.socio_id && p.cumplido_en) await tx`UPDATE socios SET gasto_total = GREATEST(0, gasto_total - ${p.monto}) WHERE id = ${p.socio_id}`;
        return p;
      });
    },
    // Para la conciliación: pedidos con hash de Pagopar que siguen pendientes (el webhook pudo
    // perderse) y pedidos pagados cuya entrega quedó a medias.
    async pedidosParaConciliar({ pendienteMin = 10, maxDias = 7, sinEntregarMin = 5, limit = 50 } = {}) {
      const abiertos = await sql`SELECT * FROM pedidos_pago
        WHERE estado = 'pendiente' AND ref_externa IS NOT NULL
          AND creado < now() - make_interval(mins => ${pendienteMin}) AND creado > now() - make_interval(days => ${maxDias})
        ORDER BY creado LIMIT ${limit}`;
      const sinEntregar = await sql`SELECT * FROM pedidos_pago
        WHERE estado = 'pagado' AND cumplido_en IS NULL
          AND COALESCE(pagado_en, creado) < now() - make_interval(mins => ${sinEntregarMin})
          AND (cumplimiento_desde IS NULL OR cumplimiento_desde < now() - interval '2 minutes')
        ORDER BY creado LIMIT ${limit}`;
      return { abiertos, sinEntregar };
    },

    // Busca un pedido por su hash de PAGOPAR (guardado en ref_externa). Usado por el webhook.
    async getPedidoByRefExterna(ref) {
      if (!ref) return null;
      const [p] = await sql`SELECT * FROM pedidos_pago WHERE ref_externa = ${ref} ORDER BY creado DESC LIMIT 1`;
      return p || null;
    },

    // ── Admin: usuarios + sesiones (cuentas reales del panel) ──
    async createAdminUsuario({ usuario, nombre, passwordHash, rol }) {
      const id = uid("adm");
      const [u] = await sql`INSERT INTO admin_usuarios (id, usuario, nombre, password_hash, rol)
        VALUES (${id}, ${String(usuario || "").toLowerCase().trim()}, ${nombre || ""}, ${passwordHash}, ${rol || "lectura"}) RETURNING *`;
      return u;
    },
    async getAdminUsuarioByUsuario(usuario) {
      const [u] = await sql`SELECT * FROM admin_usuarios WHERE usuario = ${String(usuario || "").toLowerCase().trim()} LIMIT 1`;
      return u || null;
    },
    async getAdminUsuarioById(id) {
      const [u] = await sql`SELECT * FROM admin_usuarios WHERE id = ${id} LIMIT 1`;
      return u || null;
    },
    async listAdminUsuarios() {
      return await sql`SELECT id, usuario, nombre, rol, activo, creado, ultimo_acceso FROM admin_usuarios ORDER BY creado ASC`;
    },
    async updateAdminUsuario(id, patch) {
      const allow = {};
      ["nombre", "rol", "activo", "password_hash", "ultimo_acceso"].forEach((k) => { if (patch[k] !== undefined) allow[k] = patch[k]; });
      if (!Object.keys(allow).length) return await this.getAdminUsuarioById(id);
      const [u] = await sql`UPDATE admin_usuarios SET ${sql(allow)} WHERE id = ${id} RETURNING *`;
      return u || null;
    },
    async deleteAdminUsuario(id) {
      await sql`DELETE FROM admin_sesiones WHERE admin_id = ${id}`;
      const res = await sql`DELETE FROM admin_usuarios WHERE id = ${id}`;
      return res.count > 0;
    },
    async contarAdminPorRol(rol) {
      const [r] = await sql`SELECT count(*)::int AS n FROM admin_usuarios WHERE rol = ${rol} AND activo = true`;
      return r ? r.n : 0;
    },
    async createAdminSession(adminId, rol, token, expiraIso) {
      const [s] = await sql`INSERT INTO admin_sesiones (token, admin_id, rol, expira)
        VALUES (${token}, ${adminId}, ${rol}, ${expiraIso}) RETURNING *`;
      return s;
    },
    async getAdminSession(token) {
      const [row] = await sql`
        SELECT s.token, s.expira, u.id AS admin_id, u.usuario, u.nombre, u.rol, u.activo
        FROM admin_sesiones s JOIN admin_usuarios u ON u.id = s.admin_id
        WHERE s.token = ${token} AND s.expira > now() AND u.activo = true LIMIT 1`;
      return row || null;
    },
    async deleteAdminSession(token) { await sql`DELETE FROM admin_sesiones WHERE token = ${token}`; },
    async deleteAdminSessionsByUser(adminId) { await sql`DELETE FROM admin_sesiones WHERE admin_id = ${adminId}`; },
    async purgarAdminSesionesVencidas() { await sql`DELETE FROM admin_sesiones WHERE expira < now()`; },

    // ── Auth del panel de comercio (Red de Beneficios) ──
    async getComercioByUsuario(usuario) { const [c] = await sql`SELECT * FROM comercios WHERE usuario = ${String(usuario || "").toLowerCase()} LIMIT 1`; return c || null; },
    async setComercioAcceso(id, usuario, passwordHash) { const [c] = await sql`UPDATE comercios SET usuario = ${String(usuario || "").toLowerCase()}, password_hash = ${passwordHash} WHERE id = ${id} RETURNING *`; return c || null; },
    async createComercioSession(comercioId, token, expiraIso) { await sql`INSERT INTO comercio_sesiones (token, comercio_id, expira) VALUES (${token}, ${comercioId}, ${expiraIso})`; return true; },
    async getComercioSession(token) {
      const [row] = await sql`SELECT s.token, s.expira, c.id AS comercio_id, c.nombre, c.estado
        FROM comercio_sesiones s JOIN comercios c ON c.id = s.comercio_id
        WHERE s.token = ${token} AND s.expira > now() AND c.estado = 'activo' LIMIT 1`;
      return row || null;
    },
    async beneficiosDeComercio(comercioId) { return sql`SELECT * FROM beneficios WHERE comercio_id = ${comercioId} AND activo = true ORDER BY creado DESC`; },

    // ── Subastas ── (sin cache: la puja actual tiene que estar fresca para el vivo)
    // LEFT JOIN trae el nombre del ganador en la misma consulta (para el historial de
    // subastas cerradas) — evita un N+1 de getSocioById por cada lote ya cerrado.
    async listSubastas() {
      return sql`SELECT sub.*, soc.nombre AS ganador_nombre FROM subastas sub
        LEFT JOIN socios soc ON soc.id = sub.ganador_id ORDER BY sub.termina ASC`;
    },
    // Listado PÚBLICO de subastas SIN la foto. La foto vive en la columna `imagen` como data URL
    // base64 (116–156 KB por lote): meterla en cada listado hacía pesar /api/subastas 297 KB
    // comprimidos en CADA visita a la home (67 % de la carga) y la bajaba de la DB en cada
    // refresco de caché. Acá se trae solo un hash corto (`imagen_v`) para versionar la URL de la
    // foto, que se sirve aparte (GET /api/subastas/:id/imagen) con caché inmutable.
    async listSubastasPublicas() {
      return sql`SELECT sub.id, sub.slug, sub.titulo, sub.descripcion, sub.emoji, sub.nivel_min,
          sub.precio_inicial, sub.incremento, sub.puja_actual, sub.ganador_id, sub.inicia, sub.termina,
          sub.estado, sub.notificado, sub.creado, sub.duracion_horas, sub.pausada_en, sub.pago_estado,
          sub.pago_vence, sub.adjudicado_a, sub.ronda,
          (sub.imagen IS NOT NULL AND sub.imagen <> '') AS tiene_imagen,
          left(md5(coalesce(sub.imagen, '')), 10) AS imagen_v,
          soc.nombre AS ganador_nombre
        FROM subastas sub LEFT JOIN socios soc ON soc.id = sub.ganador_id ORDER BY sub.termina ASC`;
    },
    // Solo la foto de un lote (para el endpoint de imagen cacheable).
    async imagenSubasta(idOrSlug) {
      const [r] = await sql`SELECT id, imagen FROM subastas WHERE id = ${idOrSlug} OR slug = ${idOrSlug} LIMIT 1`;
      return r || null;
    },
    // Acepta el id interno O el slug (link público) — así cualquier ruta que reciba
    // "lo que sea que vino en la URL" sigue funcionando sin tener que saber cuál es.
    // Mismo LEFT JOIN que listSubastas (nombre del ganador) — la página pública de una
    // subasta cerrada lo necesita para mostrarse como histórico ("Ganó fulano, ₲X"),
    // no solo "Cerrada" a secas.
    async getSubasta(idOrSlug) {
      const [s] = await sql`SELECT sub.*, soc.nombre AS ganador_nombre FROM subastas sub
        LEFT JOIN socios soc ON soc.id = sub.ganador_id WHERE sub.id = ${idOrSlug} OR sub.slug = ${idOrSlug} LIMIT 1`;
      return s || null;
    },
    async crearSubasta(d = {}) {
      const id = uid("sub");
      const [s] = await sql`INSERT INTO subastas ${sql({
        id, titulo: d.titulo || "", descripcion: d.descripcion || null, imagen: d.imagen || null, emoji: d.emoji || "🔨",
        nivel_min: d.nivel_min || "premium", precio_inicial: Math.round(d.precio_inicial || 0), incremento: Math.round(d.incremento || 50000),
        puja_actual: Math.round(d.precio_inicial || 0), duracion_horas: d.duracion_horas != null ? Math.round(d.duracion_horas) : 48,
        inicia: d.inicia || new Date().toISOString(), termina: d.termina || null, estado: d.estado || "borrador",
        slug: slugify(d.titulo, id),
      })} RETURNING *`;
      return s;
    },
    async updateSubasta(id, patch) { const [s] = await sql`UPDATE subastas SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return s || null; },
    async deleteSubasta(id) { await sql`DELETE FROM subastas WHERE id = ${id}`; return true; },
    async pujar({ subastaId, socioId, monto } = {}) {
      monto = Math.round(monto);
      const [before] = await sql`SELECT ganador_id, termina FROM subastas WHERE id = ${subastaId} LIMIT 1`;
      const prevGanador = before && before.ganador_id && before.ganador_id !== socioId ? before.ganador_id : null;
      const extendida = !!(before && new Date(before.termina).getTime() - Date.now() < 3 * 60 * 1000);
      // Update atómico: solo prospera si sigue activa, no venció y el monto supera puja_actual+incremento.
      // Anti-sniping: si faltan <3min, extiende `termina` a now()+3min en el mismo update.
      const [s] = await sql`
        UPDATE subastas
           SET puja_actual = ${monto}, ganador_id = ${socioId},
               termina = CASE WHEN termina - now() < interval '3 minutes' THEN now() + interval '3 minutes' ELSE termina END
         WHERE id = ${subastaId} AND estado = 'activa' AND termina > now() AND ${monto} >= puja_actual + incremento
         RETURNING *`;
      if (!s) {
        const [cur] = await sql`SELECT estado, termina, puja_actual, incremento FROM subastas WHERE id = ${subastaId} LIMIT 1`;
        if (!cur) return { ok: false, motivo: "no_existe" };
        if (cur.estado !== "activa" || new Date(cur.termina).getTime() <= Date.now()) return { ok: false, motivo: "cerrada" };
        return { ok: false, motivo: "monto_bajo", minima: cur.puja_actual + cur.incremento };
      }
      await sql`INSERT INTO pujas (id, subasta_id, socio_id, monto) VALUES (${uid("puj")}, ${subastaId}, ${socioId}, ${monto})`;
      return { ok: true, subasta: s, prevGanador, extendida };
    },
    async pujasDeSubasta(subastaId, limit = 8) {
      return sql`SELECT p.*, s.nombre, s.pais_iso FROM pujas p LEFT JOIN socios s ON s.id = p.socio_id
                 WHERE p.subasta_id = ${subastaId} ORDER BY p.monto DESC, p.creado DESC LIMIT ${limit}`;
    },
    async miPujaMax(subastaId, socioId) { const [r] = await sql`SELECT COALESCE(MAX(monto),0)::int AS m FROM pujas WHERE subasta_id = ${subastaId} AND socio_id = ${socioId}`; return r ? r.m : 0; },
    async contarPujadores(subastaId) { const [r] = await sql`SELECT COUNT(DISTINCT socio_id)::int AS n FROM pujas WHERE subasta_id = ${subastaId}`; return r ? r.n : 0; },
    // ── Plazo de pago, ronda 2 y decisiones del club (migración 0003) ──
    // Al cerrar queda adjudicado al líder y empieza a correr su plazo de pago (sin ganador → sin plazo).
    async cerrarSubastasVencidas({ plazoHoras = 72 } = {}) {
      return sql`UPDATE subastas SET estado = 'cerrada', adjudicado_a = ganador_id, ronda = 1,
          pago_vence = CASE WHEN ganador_id IS NOT NULL THEN now() + make_interval(hours => ${plazoHoras}) END
        WHERE estado = 'activa' AND termina <= now() RETURNING *`;
    },
    // Cierre manual desde el admin. Devuelve null si el lote ya estaba cerrado (no reinicia el plazo).
    async cerrarSubasta(id, { plazoHoras = 72 } = {}) {
      const [s] = await sql`UPDATE subastas SET estado = 'cerrada', termina = now(), adjudicado_a = ganador_id, ronda = 1,
          pago_vence = CASE WHEN ganador_id IS NOT NULL THEN now() + make_interval(hours => ${plazoHoras}) END
        WHERE id = ${id} AND estado <> 'cerrada' RETURNING *`;
      return s || null;
    },
    async subastasPlazoVencido() {
      return sql`SELECT * FROM subastas WHERE estado = 'cerrada' AND pago_vence IS NOT NULL AND pago_vence < now()
        AND pago_estado IS DISTINCT FROM 'pagado' ORDER BY pago_vence LIMIT 50`;
    },
    async subastasPagoPorVencer({ horas = 24 } = {}) {
      return sql`SELECT * FROM subastas WHERE estado = 'cerrada' AND pago_vence IS NOT NULL AND pago_vence > now()
        AND pago_vence <= now() + make_interval(hours => ${horas}) AND pago_estado IS DISTINCT FROM 'pagado'`;
    },
    // Vence el plazo de pago (o el admin fuerza el paso al segundo postor), TODO en una transacción
    // con el lote bloqueado: cancela el pedido abierto, suspende al que no pagó (solo en ronda 1) y
    // adjudica al segundo postor a SU última oferta, o devuelve el lote a borrador si no hay otro.
    // Devuelve null si no corresponde (ya pagado, no venció, otra instancia ya lo resolvió).
    async vencerPlazoSubasta(id, { plazoRonda2Horas = 48, bloqueoDias = 90, forzar = false } = {}) {
      return sql.begin(async (tx) => {
        const [s] = await tx`SELECT *, (pago_vence IS NOT NULL AND pago_vence < now()) AS vencido FROM subastas WHERE id = ${id} FOR UPDATE`;
        if (!s || s.estado !== "cerrada" || s.pago_estado === "pagado" || !s.adjudicado_a) return null;
        if (!forzar && !s.vencido) return null;
        if (forzar && s.ronda >= 2) return null;
        const anterior = s.adjudicado_a;
        await tx`UPDATE pedidos_pago SET estado = 'cancelado' WHERE subasta_id = ${id} AND estado = 'pendiente'`;
        let bloqueadoHasta = null;
        if (s.ronda === 1) {
          const [b] = await tx`UPDATE socios SET subastas_bloqueo_hasta = now() + make_interval(days => ${bloqueoDias}) WHERE id = ${anterior} RETURNING subastas_bloqueo_hasta`;
          bloqueadoHasta = b ? b.subastas_bloqueo_hasta : null;
          const [seg] = await tx`SELECT p.socio_id, MAX(p.monto)::int AS monto FROM pujas p JOIN socios so ON so.id = p.socio_id
            WHERE p.subasta_id = ${id} AND p.socio_id <> ${anterior} AND p.creado >= ${s.inicia}
              AND (so.subastas_bloqueo_hasta IS NULL OR so.subastas_bloqueo_hasta < now())
            GROUP BY p.socio_id ORDER BY monto DESC LIMIT 1`;
          if (seg) {
            const [n] = await tx`UPDATE subastas SET ganador_id = ${seg.socio_id}, adjudicado_a = ${seg.socio_id}, puja_actual = ${seg.monto},
                ronda = 2, pago_vence = now() + make_interval(hours => ${plazoRonda2Horas}), notificado = true WHERE id = ${id} RETURNING *`;
            return { accion: "ronda2", anterior, bloqueadoHasta, subasta: n, segundo: seg.socio_id, monto: seg.monto };
          }
        }
        const [n] = await tx`UPDATE subastas SET estado = 'borrador', ganador_id = NULL, adjudicado_a = NULL, ronda = 1, pago_vence = NULL,
            pago_estado = NULL, termina = NULL, puja_actual = precio_inicial, notificado = false WHERE id = ${id} RETURNING *`;
        return { accion: "borrador", anterior, bloqueadoHasta, subasta: n };
      });
    },
    // pago_vence += horas (si ya venció o no tenía plazo, cuenta desde ahora).
    async extenderPlazoSubasta(id, horas) {
      const [s] = await sql`UPDATE subastas SET pago_vence = GREATEST(pago_vence, now()) + make_interval(hours => ${horas})
        WHERE id = ${id} AND estado = 'cerrada' AND adjudicado_a IS NOT NULL AND pago_estado IS DISTINCT FROM 'pagado' RETURNING *`;
      return s || null;
    },
    async listDecisiones() { return sql`SELECT clave, valor, decidido_por, decidido_en FROM decisiones_club`; },
    async setDecision(clave, valor, por) {
      const [d] = await sql`INSERT INTO decisiones_club (clave, valor, decidido_por) VALUES (${clave}, ${valor}, ${por})
        ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, decidido_por = EXCLUDED.decidido_por, decidido_en = now() RETURNING *`;
      return d;
    },
    async abrirProgramadas() { return sql`UPDATE subastas SET estado = 'activa', termina = COALESCE(termina, inicia + make_interval(hours => COALESCE(duracion_horas, 48))) WHERE estado = 'programada' AND inicia IS NOT NULL AND inicia <= now() RETURNING *`; },
    async marcarSubastaNotificada(id) { await sql`UPDATE subastas SET notificado = true WHERE id = ${id}`; return true; },
    async subastasSinNotificar() { return sql`SELECT * FROM subastas WHERE estado = 'cerrada' AND ganador_id IS NOT NULL AND notificado = false`; },

    // ── Peñas oficiales (migración 0005) ──
    async crearPena({ nombre, ciudad, pais_iso, presidente, contacto }) {
      const id = uid("pen");
      const base = String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "pena";
      for (let i = 0; i < 8; i++) {
        const slug = i === 0 ? base : base + "-" + (i + 1);
        try {
          const [p] = await sql`INSERT INTO penas (id, slug, nombre, ciudad, pais_iso, presidente, contacto)
            VALUES (${id}, ${slug}, ${nombre}, ${ciudad || ""}, ${pais_iso || "PY"}, ${presidente || ""}, ${contacto || ""}) RETURNING *`;
          return p;
        } catch (e) { if (e.code !== "23505") throw e; }   // slug ocupado → probar el siguiente
      }
      throw new Error("no se pudo generar un slug único para la peña");
    },
    async getPena(id) { const [p] = await sql`SELECT * FROM penas WHERE id = ${id} LIMIT 1`; return p || null; },
    async getPenaPorSlug(slug) { const [p] = await sql`SELECT * FROM penas WHERE slug = ${String(slug || "").toLowerCase()} LIMIT 1`; return p || null; },
    async updatePena(id, patch) { const [p] = await sql`UPDATE penas SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return p || null; },
    // Peñas con sus números: altas (hinchas que se sumaron), socios validados, Plus/Junior pagos y canjes por aprobar.
    async listPenas({ estado, id } = {}) {
      const conds = [];
      if (estado) conds.push(sql`p.estado = ${estado}`);
      if (id) conds.push(sql`p.id = ${id}`);
      const where = conds.length ? sql`WHERE ${conds.reduce((a, c, i) => (i === 0 ? c : sql`${a} AND ${c}`))}` : sql``;
      return sql`SELECT p.*,
          (SELECT COUNT(*) FROM socios s WHERE s.pena_id = p.id)::int AS altas,
          (SELECT COUNT(*) FROM socios s WHERE s.pena_id = p.id AND s.es_socio_olimpia)::int AS socios,
          (SELECT COUNT(*) FROM socios s WHERE s.pena_id = p.id AND EXISTS
             (SELECT 1 FROM membresias m WHERE m.socio_id = s.id AND m.estado = 'activa' AND m.tier_slug IN ('premium','kids')))::int AS plus,
          COALESCE((SELECT SUM(-mv.monto) FROM pena_movimientos mv WHERE mv.pena_id = p.id AND mv.motivo = 'canje' AND mv.estado = 'pendiente'), 0)::int AS canje_pendiente
        FROM penas p ${where} ORDER BY altas DESC, p.creado ASC`;
    },
    async ultimasAltasPena(penaId, limit = 8) {
      return sql`SELECT s.id, s.nombre, s.apellido, s.ciudad, s.creado, coalesce(m.tier_slug, 'olimpista') AS tier_slug
        FROM socios s LEFT JOIN LATERAL (SELECT tier_slug FROM membresias WHERE socio_id = s.id AND estado = 'activa' ORDER BY inicio DESC LIMIT 1) m ON true
        WHERE s.pena_id = ${penaId} ORDER BY s.creado DESC LIMIT ${limit}`;
    },
    async crearPenaUsuario({ penaId, usuario, passwordHash, setupToken, setupExp }) {
      const [u] = await sql`INSERT INTO pena_usuarios (id, pena_id, usuario, password_hash, setup_token, setup_exp)
        VALUES (${uid("peu")}, ${penaId}, ${String(usuario).toLowerCase()}, ${passwordHash}, ${setupToken || null}, ${setupExp || null}) RETURNING *`;
      return u;
    },
    async getPenaUsuarioPorUsuario(usuario) { const [u] = await sql`SELECT * FROM pena_usuarios WHERE usuario = ${String(usuario || "").toLowerCase()} LIMIT 1`; return u || null; },
    async getPenaUsuarioDePena(penaId) { const [u] = await sql`SELECT * FROM pena_usuarios WHERE pena_id = ${penaId} ORDER BY creado LIMIT 1`; return u || null; },
    async getPenaUsuarioPorSetupToken(token) {
      if (!token) return null;
      const [u] = await sql`SELECT * FROM pena_usuarios WHERE setup_token = ${token} AND setup_exp > now() LIMIT 1`;
      return u || null;
    },
    async updatePenaUsuario(id, patch) { const [u] = await sql`UPDATE pena_usuarios SET ${sql(patch)} WHERE id = ${id} RETURNING *`; return u || null; },
    async crearPenaSesion(penaId, token, expira) {
      await sql`DELETE FROM pena_sesiones WHERE expira < now()`;
      await sql`INSERT INTO pena_sesiones (token, pena_id, expira) VALUES (${token}, ${penaId}, ${expira})`;
      return true;
    },
    async getPenaSesion(token) {
      if (!token) return null;
      const [s] = await sql`SELECT s.token, s.pena_id, s.expira, p.nombre, p.slug, p.estado FROM pena_sesiones s JOIN penas p ON p.id = s.pena_id
        WHERE s.token = ${token} AND s.expira > now() LIMIT 1`;
      return s || null;
    },
    async borrarPenaSesion(token) { await sql`DELETE FROM pena_sesiones WHERE token = ${token}`; return true; },
    async borrarSesionesDePena(penaId) { await sql`DELETE FROM pena_sesiones WHERE pena_id = ${penaId}`; return true; },

    // ── Fondo de la peña: un libro de movimientos + el saldo, siempre juntos en una transacción ──
    // Ingreso por un pago de uno de sus hinchas. pedido_id es ÚNICO: un pedido acredita una sola vez,
    // aunque el pago se procese dos veces. Devuelve el movimiento, o null si ya estaba acreditado.
    async acreditarPena({ penaId, pedidoId, monto, detalle }) {
      return sql.begin(async (tx) => {
        const [m] = await tx`INSERT INTO pena_movimientos (id, pena_id, pedido_id, monto, motivo, detalle, estado)
          VALUES (${uid("pmv")}, ${penaId}, ${pedidoId}, ${monto}, 'ingreso', ${detalle || ""}, 'aplicado')
          ON CONFLICT (pedido_id) DO NOTHING RETURNING *`;
        if (!m) return null;
        await tx`UPDATE penas SET saldo = saldo + ${monto} WHERE id = ${penaId}`;
        return m;
      });
    },
    // Un pago revertido descuenta lo que había aportado al fondo (si el fondo ya se canjeó, el saldo puede quedar negativo: lo ve el club).
    async revertirIngresoPena(pedidoId) {
      return sql.begin(async (tx) => {
        const [m] = await tx`UPDATE pena_movimientos SET estado = 'revertido' WHERE pedido_id = ${pedidoId} AND motivo = 'ingreso' AND estado = 'aplicado' RETURNING *`;
        if (!m) return null;
        await tx`UPDATE penas SET saldo = saldo - ${m.monto} WHERE id = ${m.pena_id}`;
        return m;
      });
    },
    // La peña pide canjear parte del fondo. Queda PENDIENTE hasta que el club lo apruebe; no se puede pedir
    // más de lo disponible (saldo menos lo ya pedido y pendiente). Devuelve null si no alcanza.
    async pedirCanjePena({ penaId, monto, detalle }) {
      return sql.begin(async (tx) => {
        const [p] = await tx`SELECT id, saldo FROM penas WHERE id = ${penaId} FOR UPDATE`;
        if (!p) return null;
        const [{ pendiente }] = await tx`SELECT COALESCE(SUM(-monto), 0)::int AS pendiente FROM pena_movimientos WHERE pena_id = ${penaId} AND motivo = 'canje' AND estado = 'pendiente'`;
        if (monto > p.saldo - pendiente) return { ok: false, disponible: Math.max(0, p.saldo - pendiente) };
        const [m] = await tx`INSERT INTO pena_movimientos (id, pena_id, monto, motivo, detalle, estado)
          VALUES (${uid("pmv")}, ${penaId}, ${-monto}, 'canje', ${detalle || ""}, 'pendiente') RETURNING *`;
        return { ok: true, movimiento: m };
      });
    },
    // El club aprueba (resta el saldo) o rechaza un canje pendiente. Una sola resolución por canje.
    async resolverCanjePena(movId, { aprobar }) {
      return sql.begin(async (tx) => {
        const [m] = await tx`SELECT * FROM pena_movimientos WHERE id = ${movId} AND motivo = 'canje' FOR UPDATE`;
        if (!m) return { ok: false, motivo: "no_existe" };
        if (m.estado !== "pendiente") return { ok: false, motivo: "ya_resuelto", estado: m.estado };
        if (aprobar) {
          const [p] = await tx`UPDATE penas SET saldo = saldo + ${m.monto} WHERE id = ${m.pena_id} AND saldo + ${m.monto} >= 0 RETURNING *`;
          if (!p) return { ok: false, motivo: "saldo" };
        }
        const [r] = await tx`UPDATE pena_movimientos SET estado = ${aprobar ? "aplicado" : "rechazado"} WHERE id = ${movId} RETURNING *`;
        return { ok: true, movimiento: r };
      });
    },
    async movimientosPena(penaId, limit = 30) {
      return sql`SELECT * FROM pena_movimientos WHERE pena_id = ${penaId} ORDER BY creado DESC LIMIT ${limit}`;
    },
    async canjesPendientesPena() {
      return sql`SELECT mv.*, p.nombre AS pena, p.saldo FROM pena_movimientos mv JOIN penas p ON p.id = mv.pena_id
        WHERE mv.motivo = 'canje' AND mv.estado = 'pendiente' ORDER BY mv.creado`;
    },
    // ── Encuestas (Fan Survey) ──
    async listEncuestas() { return (await sql`SELECT * FROM encuestas ORDER BY creado DESC`).map(_enc); },
    async encuestasActivas() { return (await sql`SELECT * FROM encuestas WHERE estado = 'activa' ORDER BY creado DESC`).map(_enc); },
    async getEncuesta(id) { const [e] = await sql`SELECT * FROM encuestas WHERE id = ${id} LIMIT 1`; return e ? _enc(e) : null; },
    async crearEncuesta(d = {}) {
      const ops = Array.isArray(d.opciones) ? d.opciones : (typeof d.opciones === "string" && d.opciones.trim() ? d.opciones.split("|").map((s) => s.trim()).filter(Boolean) : []);
      const [e] = await sql`INSERT INTO encuestas ${sql({ id: uid("enc"), titulo: d.titulo || "", pregunta: d.pregunta || "", opciones: JSON.stringify(ops), tipo: d.tipo || "opcion", nivel_min: d.nivel_min || "olimpista", estado: d.estado || "borrador" })} RETURNING *`;
      return _enc(e);
    },
    async updateEncuesta(id, patch) {
      const p = { ...patch };
      if (p.opciones != null) p.opciones = JSON.stringify(typeof p.opciones === "string" ? p.opciones.split("|").map((s) => s.trim()).filter(Boolean) : p.opciones);
      const [e] = await sql`UPDATE encuestas SET ${sql(p)} WHERE id = ${id} RETURNING *`; return e ? _enc(e) : null;
    },
    async deleteEncuesta(id) { await sql`DELETE FROM encuestas WHERE id = ${id}`; return true; },
    async miRespuestaEncuesta(encuestaId, socioId) { const [r] = await sql`SELECT * FROM respuestas_encuesta WHERE encuesta_id = ${encuestaId} AND socio_id = ${socioId} LIMIT 1`; return r || null; },
    async responderEncuesta({ encuestaId, socioId, opcion, texto } = {}) {
      const [e] = await sql`SELECT estado FROM encuestas WHERE id = ${encuestaId} LIMIT 1`;
      if (!e || e.estado !== "activa") return { ok: false, motivo: "cerrada" };
      const [r] = await sql`
        INSERT INTO respuestas_encuesta (id, encuesta_id, socio_id, opcion, texto)
        VALUES (${uid("resp")}, ${encuestaId}, ${socioId}, ${opcion != null ? opcion : null}, ${texto != null ? texto : null})
        ON CONFLICT (encuesta_id, socio_id) DO UPDATE SET opcion = EXCLUDED.opcion, texto = EXCLUDED.texto, creado = now()
        RETURNING *`;
      return { ok: true, respuesta: r };
    },
    async resultadosEncuesta(encuestaId) {
      const [e0] = await sql`SELECT * FROM encuestas WHERE id = ${encuestaId} LIMIT 1`; if (!e0) return null;
      const e = _enc(e0);
      // Conteo AGREGADO en SQL (no traer todas las filas a memoria): índice en (encuesta_id, opcion).
      const [{ total }] = await sql`SELECT count(*)::int AS total FROM respuestas_encuesta WHERE encuesta_id = ${encuestaId}`;
      let conteo = [], textos = [];
      if (e.tipo === "texto") {
        const rows = await sql`SELECT texto FROM respuestas_encuesta WHERE encuesta_id = ${encuestaId} AND texto IS NOT NULL AND texto <> '' ORDER BY creado DESC LIMIT 200`;
        textos = rows.map((r) => r.texto);
      } else {
        const rows = await sql`SELECT opcion, count(*)::int AS n FROM respuestas_encuesta WHERE encuesta_id = ${encuestaId} AND opcion IS NOT NULL GROUP BY opcion`;
        const byIdx = new Map(rows.map((r) => [Number(r.opcion), r.n]));
        conteo = (e.opciones || []).map((op, i) => ({ opcion: op, i, n: byIdx.get(i) || 0 }));
      }
      return { id: e.id, titulo: e.titulo, pregunta: e.pregunta, tipo: e.tipo, total, conteo, textos };
    },
  };
}

module.exports = { createPgStore };
