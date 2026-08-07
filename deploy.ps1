# ─── Deploy Olimpistas → Cloud Run ────────────────────────────────────────────
# Ejecutar desde:  C:\Users\user\olimpistas\
# Requisito: gcloud autenticado.   > gcloud auth login
#
# ⚠️ IMPORTANTE (lecciones aprendidas):
#  - La región REAL es southamerica-east1 (co-locada con Supabase sa-east-1). NO us-central1.
#  - El servicio vive detrás de un Load Balancer + Cloud CDN + cert gestionado para
#    www.olimpistas.com. NO se usan domain mappings (no están permitidos en la región).
#  - NUNCA usar --env-vars-file ni un --set-env-vars PARCIAL: pisa el resto de las vars.
#    Por eso acá se setean TODAS las env vars y AMBOS secretos en cada deploy.
#  - Build con `--source .` (Cloud Build / buildpacks). La SA de compute necesita rol builder.
#
# La rampa del contador se controla por env vars (RAMP_*). Para ARRANCAR la subida
# el día del lanzamiento, mover RAMP_INICIO al momento exacto (sin redeploy):
#   gcloud run services update olimpistas --region southamerica-east1 --project olimpistas `
#     --update-env-vars RAMP_INICIO=2026-06-19T15:00:00Z
# (Mientras RAMP_INICIO esté en el futuro, el contador queda fijo en RAMP_DESDE_N.)
# ------------------------------------------------------------------------------

# SIEMPRE parado en el repo correcto — pasó más de una vez que el comando se corrió
# desde otra carpeta y empaquetó código viejo pese a que gcloud reportaba "deployado".
Set-Location $PSScriptRoot

$PROJECT = "olimpistas"
$REGION  = "southamerica-east1"
$SERVICE = "olimpistas"

Write-Host "`n[0/2] Verificando qué se va a subir..." -ForegroundColor Cyan
Write-Host "Directorio: $PSScriptRoot"
git log -1 --format="Último commit: %h · %ci · %s"
$sinCommitear = git status --porcelain
if ($sinCommitear) {
  Write-Host "⚠️  Hay cambios SIN COMMITEAR — se van a subir igual (gcloud empaqueta el disco, no git):" -ForegroundColor Yellow
  git status --short
} else {
  Write-Host "Árbol limpio — lo que se sube es exactamente el último commit." -ForegroundColor Green
}
$confirmacion = Read-Host "`n¿Continuar con el deploy? (s/n)"
if ($confirmacion -ne "s") { Write-Host "Cancelado." -ForegroundColor Yellow; exit }

Write-Host "`n[1/2] Configurando proyecto..." -ForegroundColor Cyan
gcloud config set project $PROJECT

Write-Host "`n[2/2] Build (--source) y deploy a Cloud Run ($REGION)..." -ForegroundColor Cyan
# Flags para aguantar picos (post-auditoría 2026-08):
#  - CPU 2 + concurrency 60: el registro hashea con bcrypt (CPU-bound). Con 1 vCPU y
#    concurrency 250, la ráfaga de altas congelaba el event loop. 2 vCPU + menos
#    concurrency deja respirar el hashing sin ahogar el resto de los requests.
#  - Conexiones al pooler = pg-store max(6) × max-instances(50) = 300. VERIFICAR que el
#    "max client connections" del pooler de Supabase (Supavisor) sea >= 300 con margen;
#    si no, bajar max-instances o el max del driver. (Los 3 valores deben coincidir:
#    data/pg-store.js, este archivo y SCALING.md.)
#  - min-instances: SUBIR a 4-5 antes de mover RAMP_INICIO el día D (evita cold start en el pico).
# Array de argumentos en vez de continuación con backticks: un espacio invisible
# de más después de un backtick rompe la continuación sin avisar (nos pasó recién:
# el --set-secrets se armó mal y gcloud crasheó con "Invalid secret spec").
$deployArgs = @(
  "run", "deploy", $SERVICE,
  "--source", ".",
  "--project", $PROJECT,
  "--region", $REGION,
  "--allow-unauthenticated",
  "--memory", "1Gi",
  "--cpu", "2",
  "--concurrency", "60",
  "--min-instances", "1",
  "--max-instances", "50",
  "--port", "8080",
  "--set-secrets", "OLIMPISTAS_DATABASE_URL=olimpistas-db:latest,RESEND_API_KEY=olimpistas-resend:latest",
  "--set-env-vars", "NODE_ENV=production,PLAUSIBLE_DOMAIN=www.olimpistas.com,RAMP_INICIO=2099-01-01T00:00:00Z,RAMP_DESDE_N=180000,RAMP_HASTA_N=1000000,RAMP_HORAS=60"
)
& gcloud @deployArgs

# CRÍTICO: si gcloud falla, el script tiene que frenar acá — si no, sigue de largo e
# imprime "Deploy completado" aunque no se haya creado ninguna revisión nueva (pasó).
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n❌ El deploy FALLÓ (gcloud salió con código $LASTEXITCODE) — no se creó ninguna revisión nueva. Mirá el error de arriba." -ForegroundColor Red
  exit 1
}

Write-Host "`n✅ Deploy completado." -ForegroundColor Green
gcloud run services describe $SERVICE --region $REGION --format="value(status.url)"
Write-Host "Sitio público: https://www.olimpistas.com" -ForegroundColor Green

# Verificación real (no solo confiar en el mensaje de gcloud): la revisión que gcloud
# dice haber creado debe coincidir con la que /api/salud reporta como sirviendo tráfico.
Start-Sleep -Seconds 3
$revEsperada = gcloud run services describe $SERVICE --region $REGION --format="value(status.latestReadyRevisionName)"
try {
  $salud = Invoke-RestMethod -Uri "https://www.olimpistas.com/api/salud" -TimeoutSec 10
  if ($salud.rev -eq $revEsperada) {
    Write-Host "✅ Verificado: www.olimpistas.com está sirviendo $($salud.rev)" -ForegroundColor Green
  } else {
    Write-Host "⚠️  DESAJUSTE: gcloud creó $revEsperada pero el sitio reporta $($salud.rev) — puede ser propagación (esperá y reintentá /api/salud) o un problema real de tráfico." -ForegroundColor Red
  }
} catch {
  Write-Host "⚠️  No pude verificar /api/salud ($($_.Exception.Message)) — chequealo a mano." -ForegroundColor Yellow
}
