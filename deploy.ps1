# ─── Deploy Olimpistas → Cloud Run ────────────────────────────────────────────
# Ejecutar desde:  C:\Users\user\olimpistas\
# Requisito: gcloud autenticado.   > gcloud auth login
#
# ⚠️ IMPORTANTE (lecciones aprendidas):
#  - La región REAL es southamerica-east1 (co-locada con Supabase sa-east-1). NO us-central1.
#  - El servicio vive detrás de un Load Balancer + Cloud CDN + cert gestionado para
#    www.olimpistas.com. NO se usan domain mappings (no están permitidos en la región).
#  - Build con `--source .` (Cloud Build / buildpacks). La SA de compute necesita rol builder.
#
# ⚠️ ENV VARS Y SECRETOS — NUNCA una lista fija en este script. Pasó dos veces el
#    mismo día: una lista hardcodeada de "las vars que importan" se desactualiza, y
#    --set-env-vars / --set-secrets BORRAN TODO lo que no esté en la lista (es el
#    comportamiento documentado: "All existing environment variables will be removed
#    first"). Así se perdieron en un deploy de rutina: RAMP_INICIO (el contador
#    público volvió de 626k a 188k en vivo), ADMIN_KEY, PAGOPAR_PUBLIC_TOKEN,
#    PAGOPAR_PRIVATE_TOKEN, PAGOPAR_TEST_KEY, PAGOPAR_PREVENTAS_LIVE y GA_ID —
#    Pagopar quedó inhabilitado sin que nadie lo pidiera.
#
#    Por eso este script LEE toda la configuración actual (env vars planas +
#    secretos) del servicio ya desplegado y la reproduce EXACTAMENTE tal cual en
#    el nuevo deploy. Un deploy de código nunca debe poder tocar ninguna variable.
#    Para cambiar una variable de verdad (mover la rampa, rotar un token, etc.),
#    hacerlo por separado, nunca en este script:
#      gcloud run services update olimpistas --region southamerica-east1 --project olimpistas `
#        --update-env-vars RAMP_INICIO=2026-06-19T15:00:00Z
# ------------------------------------------------------------------------------

# SIEMPRE parado en el repo correcto — pasó más de una vez que el comando se corrió
# desde otra carpeta y empaquetó código viejo pese a que gcloud reportaba "deployado".
Set-Location $PSScriptRoot

$PROJECT = "olimpistas"
$REGION  = "southamerica-east1"
$SERVICE = "olimpistas"

Write-Host "`n[1/3] Verificando qué se va a subir..." -ForegroundColor Cyan
Write-Host "Directorio: $PSScriptRoot"
git log -1 --format="Último commit: %h · %ci · %s"
$sinCommitear = git status --porcelain
if ($sinCommitear) {
  Write-Host "⚠️  Hay cambios SIN COMMITEAR — se van a subir igual (gcloud empaqueta el disco, no git):" -ForegroundColor Yellow
  git status --short
} else {
  Write-Host "Árbol limpio — lo que se sube es exactamente el último commit." -ForegroundColor Green
}

gcloud config set project $PROJECT | Out-Null

# Leer TODA la config actual (env vars planas + secretos) y reproducirla tal cual.
$servicioExiste = $true
$servicioJson = $null
try {
  $servicioJson = gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format="json" 2>$null | ConvertFrom-Json
  if (-not $servicioJson) { $servicioExiste = $false }
} catch { $servicioExiste = $false }

if ($servicioExiste) {
  $envActual   = $servicioJson.spec.template.spec.containers[0].env
  $envPlanos   = $envActual | Where-Object { -not $_.valueFrom }
  $envSecretos = $envActual | Where-Object { $_.valueFrom }
  $envVarsStr  = ($envPlanos   | ForEach-Object { "$($_.name)=$($_.value)" }) -join ","
  $secretsStr  = ($envSecretos | ForEach-Object { "$($_.name)=$($_.valueFrom.secretKeyRef.name):latest" }) -join ","
  $rampInicio  = ($envPlanos | Where-Object { $_.name -eq "RAMP_INICIO" }).value
  Write-Host "Preservando $($envPlanos.Count) env vars planas y $($envSecretos.Count) secretos ya configurados:" -ForegroundColor Cyan
  ($envPlanos | ForEach-Object { $_.name }) + ($envSecretos | ForEach-Object { $_.name + " (secreto)" }) | Sort-Object | ForEach-Object { Write-Host "  - $_" }
  if ($rampInicio) { Write-Host "RAMP_INICIO en producción (se preserva tal cual): $rampInicio" -ForegroundColor Cyan }
} else {
  # SOLO para el primerísimo deploy del servicio (todavía no existe nada de qué leer).
  Write-Host "Servicio nuevo — no hay nada previo que leer, uso configuración inicial." -ForegroundColor Yellow
  $envVarsStr = "NODE_ENV=production,PLAUSIBLE_DOMAIN=www.olimpistas.com,RAMP_INICIO=2099-01-01T00:00:00Z,RAMP_DESDE_N=180000,RAMP_HASTA_N=1000000,RAMP_HORAS=120,RAMP_CURVA=1.25"
  $secretsStr = "OLIMPISTAS_DATABASE_URL=olimpistas-db:latest,RESEND_API_KEY=olimpistas-resend:latest"
  $rampInicio = "2099-01-01T00:00:00Z"
}

$confirmacion = Read-Host "`n¿Continuar con el deploy? (s/n)"
if ($confirmacion -ne "s") { Write-Host "Cancelado." -ForegroundColor Yellow; exit }

Write-Host "`n[2/3] Build (--source) y deploy a Cloud Run ($REGION)..." -ForegroundColor Cyan
# Flags de capacidad (post-auditoría 2026-08):
#  - CPU 2 + concurrency 60: el registro hashea con bcrypt (CPU-bound). Con 1 vCPU y
#    concurrency 250, la ráfaga de altas congelaba el event loop. 2 vCPU + menos
#    concurrency deja respirar el hashing sin ahogar el resto de los requests.
#  - Conexiones al pooler = pg-store max(6) × max-instances(50) = 300. VERIFICAR que el
#    "max client connections" del pooler de Supabase (Supavisor) sea >= 300 con margen;
#    si no, bajar max-instances o el max del driver. (Los 3 valores deben coincidir:
#    data/pg-store.js, este archivo y SCALING.md.)
#  - min-instances: SUBIR a 4-5 antes de mover RAMP_INICIO el día D (evita cold start en el pico).
# Array de argumentos en vez de continuación con backticks: un espacio invisible
# de más después de un backtick rompe la continuación sin avisar (ya pasó una vez:
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
  "--port", "8080"
)
if ($secretsStr) { $deployArgs += @("--set-secrets", $secretsStr) }
if ($envVarsStr) { $deployArgs += @("--set-env-vars", $envVarsStr) }
& gcloud @deployArgs

# CRÍTICO: si gcloud falla, el script tiene que frenar acá — si no, sigue de largo e
# imprime "Deploy completado" aunque no se haya creado ninguna revisión nueva.
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n❌ El deploy FALLÓ (gcloud salió con código $LASTEXITCODE) — no se creó ninguna revisión nueva. Mirá el error de arriba." -ForegroundColor Red
  exit 1
}

Write-Host "`n✅ Deploy completado." -ForegroundColor Green
gcloud run services describe $SERVICE --region $REGION --format="value(status.url)"
Write-Host "Sitio público: https://www.olimpistas.com" -ForegroundColor Green

Write-Host "`n[3/3] Verificando..." -ForegroundColor Cyan
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

# Chequeo extra: confirma que la CANTIDAD de env vars + secretos no bajó (nunca más
# perder variables en silencio) y que RAMP_INICIO específicamente no cambió.
$servicioJsonPost = gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format="json" | ConvertFrom-Json
$envPost = $servicioJsonPost.spec.template.spec.containers[0].env
$rampNuevo = ($envPost | Where-Object { $_.name -eq "RAMP_INICIO" }).value
if ($rampNuevo -eq $rampInicio) {
  Write-Host "✅ RAMP_INICIO preservado: $rampNuevo" -ForegroundColor Green
} else {
  Write-Host "🚨 RAMP_INICIO CAMBIÓ: era $rampInicio, ahora es $rampNuevo — revisar YA, el contador público puede estar mal." -ForegroundColor Red
}
if ($servicioExiste -and ($envPost.Count -lt $envActual.Count)) {
  Write-Host "🚨 SE PERDIERON VARIABLES: antes había $($envActual.Count), ahora hay $($envPost.Count) — revisar YA." -ForegroundColor Red
} elseif ($servicioExiste) {
  Write-Host "✅ Cantidad de env vars + secretos preservada: $($envPost.Count)" -ForegroundColor Green
}
