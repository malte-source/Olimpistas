# Escalar Olimpistas a picos fuertes (ej. 50.000 concurrentes)

Un embudo de captación tiene un perfil de tráfico **en picos**: una campaña o un
partido pueden mandar decenas de miles de personas al mismo tiempo. Esto se aguanta,
pero hay que respetar algunas reglas. Resumen por orden de impacto.

## 1. CDN adelante (lo más importante)

El 90% del tráfico de un pico es **gente mirando la landing** (lectura, no escritura).
Eso NO debe pegarle al servidor Node: tiene que servirlo un CDN.

- Poner **Cloud CDN** (con un Load Balancer) o **Cloudflare** delante de Cloud Run.
- La app ya manda los headers correctos: estáticos `Cache-Control: max-age=86400`,
  HTML `max-age=60`. El CDN cachea y el origen casi no se entera del pico.
- El **Service Worker** (PWA) suma otra capa: tras la primera visita, los assets
  salen del dispositivo.

> Mejora recomendada: versionar los assets (`styles.css?v=hash`) para poder subir el
> `max-age` a `immutable` sin servir contenido viejo. Hoy, en cada deploy hay que
> bumpear `VERSION` en `sw.js`.

## 2. La base de datos es el cuello de botella real

El registro (escritura) es lo que no se puede cachear. Requisitos:

- **Usar Postgres, NO el store en memoria.** El modo memoria es solo para demo/dev:
  es de una sola instancia y se pierde al reiniciar. Setear `OLIMPISTAS_DATABASE_URL`.
- **Pooler de conexiones obligatorio** (pgbouncer / pooler de Supabase/Neon). Con
  muchas instancias de Cloud Run, abrir conexiones directas agota Postgres. El driver
  ya usa pool chico por instancia (`max: 6` → 6 × max-instances 50 = 300 conexiones al
  pooler; verificar que el "max client connections" de Supavisor lo soporte); el pooler hace el resto.
- Índices ya creados (`sesiones`, `membresias`, `pedidos`). La sesión se busca por PK.
- Para 50k escrituras en ráfaga, considerar **encolar** los registros (Cloud Tasks /
  Pub/Sub) y responder al usuario al toque, procesando el alta detrás.

## 3. Fotos de perfil → Cloud Storage (no en la base)

Hoy la foto se guarda como **data URL en la columna `foto`** (sirve para el MVP).
A escala eso infla la base y las respuestas. En producción:

- Subir la foto a **Google Cloud Storage** y guardar solo la **URL**.
- Servir las fotos por el **CDN**.
- Mantener el resize en el cliente (ya está) para que pesen poco.

## 4. CPU del registro (bcrypt)

`bcrypt` (cost 10) es intencionalmente costoso en CPU. 50k registros simultáneos
pueden saturar CPU. Mitigaciones:
- Autoescalar Cloud Run (ver `deploy.ps1`: `--concurrency`, `--max-instances`).
- **Rate-limiting** por IP en login/registro (hoy NO está) — para multi-instancia
  necesita un store compartido (Redis/Memorystore). Pendiente.
- Un poco más de CPU por instancia ayuda al hash.

## 5. Config de Cloud Run (ya en deploy.ps1)

```
--concurrency 250      # requests simultáneas por instancia
--min-instances 2      # calientes, evita cold start en el pico
--max-instances 100    # techo (250 * 100 ≈ 25k req simultáneas; subir si hace falta)
```
Ajustar con **pruebas de carga reales** (k6, Artillery) antes de una campaña grande.

## Checklist antes de una campaña masiva

- [ ] CDN configurado delante de Cloud Run.
- [ ] `OLIMPISTAS_DATABASE_URL` apuntando a Postgres **con pooler**.
- [ ] Fotos en Cloud Storage (no data URL).
- [ ] Rate-limiting con store compartido.
- [ ] Prueba de carga al endpoint de registro (`POST /api/auth/registro`).
- [ ] `min-instances` ≥ 2 y `max-instances` dimensionado al pico esperado.
