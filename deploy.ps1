# ─── Deploy Olimpistas → Cloud Run ────────────────────────────────────────────
# Ejecutar desde:  C:\Users\user\olimpistas\
# Requisito: gcloud autenticado.   > gcloud auth login
# ------------------------------------------------------------------------------

$PROJECT = "db-academia-497215"          # ajustar si va a otro proyecto
$REGION  = "us-central1"
$REPO    = "olimpistas"
$IMAGE   = "$REGION-docker.pkg.dev/$PROJECT/$REPO/app"
$SERVICE = "olimpistas"

Write-Host "`n[1/5] Configurando proyecto..." -ForegroundColor Cyan
gcloud config set project $PROJECT

Write-Host "`n[2/5] Habilitando APIs..." -ForegroundColor Cyan
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

Write-Host "`n[3/5] Creando Artifact Registry (si no existe)..." -ForegroundColor Cyan
gcloud artifacts repositories create $REPO `
  --repository-format=docker --location=$REGION `
  --description="Olimpistas - socios de Olimpia" 2>$null
Write-Host "  (si ya existe, se ignora el error)"

Write-Host "`n[4/5] Build y push con Cloud Build..." -ForegroundColor Cyan
gcloud builds submit --tag $IMAGE .

Write-Host "`n[5/5] Deploy a Cloud Run..." -ForegroundColor Cyan
# NOTA: setear OLIMPISTAS_DATABASE_URL y los tokens de PAGOPAR como SECRETOS
# (gcloud run deploy --set-secrets) cuando se conecte la base y los pagos.
#
# Flags pensadas para aguantar picos de tráfico (ver SCALING.md):
#   --concurrency 250   : cada instancia atiende ~250 requests a la vez.
#   --max-instances 100 : techo de autoescalado (250 * 100 = ~25k req simultáneas).
#   --min-instances 2   : instancias "calientes" para no sufrir cold start en el pico.
# Ajustar según pruebas de carga. Y SIEMPRE poner un CDN adelante (ver SCALING.md).
gcloud run deploy $SERVICE `
  --image $IMAGE `
  --platform managed --region $REGION `
  --allow-unauthenticated `
  --memory 512Mi --cpu 1 `
  --concurrency 250 `
  --min-instances 2 --max-instances 100 `
  --port 8080

Write-Host "`n✅ Deploy completado." -ForegroundColor Green
gcloud run services describe $SERVICE --region $REGION --format="value(status.url)"
