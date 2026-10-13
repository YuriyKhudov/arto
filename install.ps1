# Arto — установщик. Запускается через install.bat.
# Сам определяет видеокарту, выбирает версию (Pro/Lite), докачивает только недостающее.
param([string]$Edition = "", [string]$ComfyPath = "", [switch]$NoShortcut)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = $PSScriptRoot
Set-Location $Root

function Say($t, $c = "Gray") { Write-Host $t -ForegroundColor $c }
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Yellow }

# Скачивание с докачкой; пропускает, если файл уже есть нужного размера
function Get-File($url, $dest, $what) {
  if (Test-Path $dest) { Say "   уже есть: $what" "DarkGray"; return }
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Say "   скачиваю: $what"
  # при обрыве связи — продолжаем с того же места, до 5 попыток
  for ($try = 1; $try -le 5; $try++) {
    & curl.exe -L --fail --retry 5 --retry-delay 3 -C - -o "$dest.part" $url
    if ($LASTEXITCODE -eq 0) { break }
    if ($try -lt 5) { Say "   связь прервалась, продолжаю (попытка $($try + 1) из 5)…" "DarkYellow"; Start-Sleep -Seconds 5 }
  }
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать $what. Проверьте интернет и запустите install.bat ещё раз — скачанное не пропадёт." }
  Move-Item -Force "$dest.part" $dest
}

Write-Host ""
Write-Host "   A R T O   —   установка" -ForegroundColor Yellow
Write-Host "   мастерская эскизов: бесплатно, офлайн, на вашей видеокарте"
Write-Host ""

# ---------- 1. Видеокарта и версия ----------
Step "Проверяю видеокарту"
$vram = 0; $gpu = "не найдена"
try {
  $q = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
  if ($q) { $parts = ($q | Select-Object -First 1).Split(","); $gpu = $parts[0].Trim(); $vram = [int]$parts[1].Trim() }
} catch {}
$cpuOnly = $vram -eq 0
Say "   видеокарта: $gpu$(if ($vram) { ", $([math]::Round($vram/1024)) ГБ" })"

if (-not $Edition) {
  $rec = if ($vram -ge 12000) { "pro" } else { "lite" }
  $mark = @{ pro = ""; lite = "" }; $mark[$rec] = "   <- рекомендую для этого компьютера"
  Write-Host ""
  Write-Host "   Выберите версию:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "   1) LITE$($mark.lite)" -ForegroundColor Cyan
  Write-Host "      Все возможности Arto — рисование, стиль с картинок, ИИ-редактор словами,"
  Write-Host "      исправление анатомии, редактор с кистью и лассо. Модели облегчённые:"
  Write-Host "      картинки чуть проще и меньше (до 576 px, с увеличением ×2), зато быстро."
  Write-Host "      Нужно: видеокарта NVIDIA от 6 ГБ, 16 ГБ оперативной памяти. Скачать ~19 ГБ."
  Write-Host ""
  Write-Host "   2) PRO$($mark.pro)" -ForegroundColor Cyan
  Write-Host "      Всё то же самое на тяжёлых моделях: картинки крупнее (1024 px),"
  Write-Host "      детальнее и художественнее, ИИ-редактор точнее."
  Write-Host "      Нужно: видеокарта NVIDIA от 12 ГБ, 32 ГБ оперативной памяти. Скачать ~43 ГБ."
  Write-Host ""
  if ($rec -eq "lite" -and $vram -gt 0) { Say "   У вас $([math]::Round($vram/1024)) ГБ видеопамяти — Pro может работать очень медленно или не запуститься." "DarkYellow" }
  if ($cpuOnly) { Say "   Видеокарта NVIDIA не найдена — Pro работать не будет, Lite будет работать на процессоре (минуты на картинку)." "DarkYellow" }
  do {
    $ans = (Read-Host "   Введите 1 или 2").Trim()
  } until ($ans -in @("1", "2"))
  $Edition = if ($ans -eq "2") { "pro" } else { "lite" }
}
Say "   версия: $($Edition.ToUpper())" "Green"

# ---------- 2. Двигатель ComfyUI ----------
Step "Двигатель (ComfyUI)"
$candidates = @($ComfyPath, "$Root\engine\ComfyUI_windows_portable", "C:\ComfyUI", "D:\ComfyUI", "E:\ComfyUI", "C:\ComfyUI_windows_portable", "D:\ComfyUI_windows_portable") | Where-Object { $_ }
$Comfy = $candidates | Where-Object { Test-Path "$_\python_embeded\python.exe" } | Select-Object -First 1
if ($Comfy) {
  Say "   найден готовый ComfyUI: $Comfy — использую его" "Green"
} else {
  $Comfy = "$Root\engine\ComfyUI_windows_portable"
  $pkg = "ComfyUI_windows_portable_nvidia.7z"
  # прямая ссылка на последний выпуск — без API GitHub и его лимитов
  Get-File "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/$pkg" "$Root\engine\downloads\$pkg" "двигатель ComfyUI (~2 ГБ)"
  Say "   распаковываю…"
  & "$env:SystemRoot\System32\tar.exe" -xf "$Root\engine\downloads\$pkg" -C "$Root\engine"
  if (-not (Test-Path "$Comfy\python_embeded\python.exe")) { throw "Не получилось распаковать ComfyUI" }
  Remove-Item "$Root\engine\downloads\$pkg"
}
$M = "$Comfy\ComfyUI\models"

# ---------- 3. Модели ----------
Step "Модели (докачиваются только недостающие)"
function Find-Model($folder, $name) { Get-ChildItem "$M\$folder" -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Need($folder, $name, $url, $what) {
  $f = Find-Model $folder $name
  if ($f) { Say "   уже есть: $what" "DarkGray"; return $f.FullName.Substring("$M\$folder\".Length) }
  Get-File $url "$M\$folder\atelier\$name" $what
  return "atelier\$name"
}

$HF = "https://huggingface.co"
$up = Need "upscale_models" "RealESRGAN_x2plus.pth" "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth" "увеличитель ×2 (64 МБ)"
if ($Edition -eq "pro") {
  $ckpt = Need "checkpoints" "DreamShaperXL_Turbo_v2_1.safetensors" "$HF/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_v2_1.safetensors" "художник DreamShaper XL (6,5 ГБ)"
  # редактор: если уже есть полная модель + ускоритель — используем их, иначе качаем компактную версию со встроенным ускорителем
  $full = Find-Model "diffusion_models" "qwen_image_edit_2511_bf16.safetensors"
  $lora = Find-Model "loras" "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
  $merged = Find-Model "diffusion_models" "qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors"
  if ($merged -or -not ($full -and $lora)) {
    $unet = Need "diffusion_models" "qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors" "$HF/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors" "ИИ-редактор Qwen-Image-Edit (19,5 ГБ)"
    $editCfg = @{ unet = $unet; dtype = "default"; lora = $null }
  } else {
    $editCfg = @{ unet = $full.FullName.Substring("$M\diffusion_models\".Length); dtype = "fp8_e4m3fn"; lora = $lora.FullName.Substring("$M\loras\".Length) }
  }
  $clip = Need "text_encoders" "qwen_2.5_vl_7b_fp8_scaled.safetensors" "$HF/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" "понимание текста Qwen (9 ГБ)"
  $vae = Need "vae" "qwen_image_vae.safetensors" "$HF/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors" "VAE (0,2 ГБ)"
  $null = Need "ipadapter" "ip-adapter-plus_sdxl_vit-h.safetensors" "$HF/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors" "стиль с картинок для SDXL (0,8 ГБ)"
  $null = Need "controlnet" "diffusion_pytorch_model_promax.safetensors" "$HF/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors" "рисование по наброску и раскрытие кадра (2,5 ГБ)"
} else {
  $ckpt = Need "checkpoints" "DreamShaper8_LCM.safetensors" "$HF/Lykon/DreamShaper/resolve/main/DreamShaper8_LCM.safetensors" "художник DreamShaper 8 LCM (2 ГБ)"
  $null = Need "ipadapter" "ip-adapter-plus_sd15.safetensors" "$HF/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors" "стиль с картинок для SD 1.5 (0,1 ГБ)"
  $null = Need "controlnet" "control_v11p_sd15_scribble_fp16.safetensors" "$HF/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_scribble_fp16.safetensors" "рисование по наброску (0,7 ГБ)"
  $null = Need "controlnet" "control_v11p_sd15_canny_fp16.safetensors" "$HF/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_canny_fp16.safetensors" "рисование по контуру фото (0,7 ГБ)"
  # лёгкий ИИ-редактор: FLUX.2 klein 4B (Apache 2.0)
  $null = Need "diffusion_models" "flux-2-klein-4b-fp8.safetensors" "$HF/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors" "ИИ-редактор FLUX.2 klein (3,9 ГБ)"
  $null = Need "text_encoders" "qwen_3_4b.safetensors" "$HF/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" "понимание текста для редактора (7,7 ГБ)"
  $null = Need "vae" "flux2-vae.safetensors" "$HF/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors" "VAE редактора (0,3 ГБ)"
}
$null = Need "clip_vision" "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" "$HF/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors" "зрение для стиля с картинок (2,5 ГБ)"

# узел IP-Adapter для ComfyUI (стиль с картинок)
# поиск лиц для «Исправить и увеличить» (маленькая модель, работает внутри Arto)
Get-File "$HF/deepghs/real_face_detection/resolve/main/face_detect_v0_s_yv11/model.onnx" "$Root\models\face\face_detect_v0_s_yv11.onnx" "поиск лиц (38 МБ)"
$ipaNode = "$Comfy\ComfyUI\custom_nodes\ComfyUI_IPAdapter_plus"
if (-not (Test-Path $ipaNode)) {
  Get-File "https://codeload.github.com/cubiq/ComfyUI_IPAdapter_plus/zip/refs/heads/main" "$Root\engine\downloads\ipadapter.zip" "модуль стиля для ComfyUI"
  & "$env:SystemRoot\System32\tar.exe" -xf "$Root\engine\downloads\ipadapter.zip" -C "$Comfy\ComfyUI\custom_nodes"
  Rename-Item "$Comfy\ComfyUI\custom_nodes\ComfyUI_IPAdapter_plus-main" "ComfyUI_IPAdapter_plus"
  Remove-Item "$Root\engine\downloads\ipadapter.zip"
} else { Say "   уже есть: модуль стиля для ComfyUI" "DarkGray" }

# ---------- 4. Node.js и переводчик ----------
Step "Программа"
$node = "$Root\runtime\node.exe"
if (-not (Test-Path $node)) {
  $ver = "v24.21.0"
  Get-File "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" "$Root\engine\downloads\node.zip" "Node.js (30 МБ)"
  & "$env:SystemRoot\System32\tar.exe" -xf "$Root\engine\downloads\node.zip" -C "$Root\engine\downloads"
  New-Item -ItemType Directory -Force "$Root\runtime" | Out-Null
  Copy-Item -Recurse -Force "$Root\engine\downloads\node-$ver-win-x64\*" "$Root\runtime"
  Remove-Item -Recurse -Force "$Root\engine\downloads\node-$ver-win-x64", "$Root\engine\downloads\node.zip"
}
$env:Path = "$Root\runtime;$env:Path"   # npm и его скрипты должны видеть наш Node.js
New-Item -ItemType Directory -Force "$Root\data" | Out-Null
$libOk = { Test-Path "$Root\node_modules\@huggingface\transformers\package.json" }
for ($try = 1; $try -le 3 -and -not (& $libOk); $try++) {
  Say "   ставлю библиотеки программы (попытка $try)…"
  $ErrorActionPreference = "Continue"
  # через cmd — чтобы безобидные предупреждения npm не выглядели как красные ошибки PowerShell
  & cmd.exe /c "cd /d `"$Root`" && `"$Root\runtime\npm.cmd`" install --omit=dev --ignore-scripts --no-audit --no-fund 2>&1" | Tee-Object -FilePath "$Root\data\install-npm.log"
  $ErrorActionPreference = "Stop"
}
if (-not (& $libOk)) { throw "Не удалось установить библиотеки программы. Проверьте интернет и запустите install.bat ещё раз. Подробности: data\install-npm.log" }
Say "   библиотеки на месте" "Green"
Say "   скачиваю переводчик с русского (~900 МБ)…"
& $node -e "require('./translate').preload().then(t=>{console.log(t?'   переводчик готов':'   переводчик не загрузился — Arto докачает его при первом запуске (нужен интернет)')})"

# ---------- 5. Настройки ----------
Step "Настройки"
# Личные настройки этого компьютера — в data/local.json (обновления программы их не трогают)
New-Item -ItemType Directory -Force "$Root\data" | Out-Null
$args2 = [string[]]@()
if ($cpuOnly) { $args2 = [string[]]@("--cpu") } elseif ($vram -lt 8000) { $args2 = [string[]]@("--lowvram") }
$local = [ordered]@{ edition = $Edition; comfy = [ordered]@{ path = $Comfy; args = $args2 } }
if ($Edition -eq "pro" -and $editCfg.lora) {
  $local.editions = @{ pro = @{ edit = @{ unet = $editCfg.unet; dtype = $editCfg.dtype; lora = $editCfg.lora } } }
}
[System.IO.File]::WriteAllText("$Root\data\local.json", ($local | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

# ---------- 6. Ярлык ----------
if (-not $NoShortcut) {
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Arto.lnk")
$lnk.TargetPath = "$Root\start.bat"
$lnk.WorkingDirectory = $Root
$lnk.IconLocation = "$Root\public\atelier.ico"
$lnk.WindowStyle = 7
$lnk.Save()
}

Write-Host ""
Write-Host "   Готово! На рабочем столе появился ярлык «Arto»." -ForegroundColor Green
Write-Host ""
