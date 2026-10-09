# Открывает окно Arto, когда сервер действительно готов. Если не запустился — понятное сообщение.
$url = "http://localhost:7777"
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest "http://127.0.0.1:7777/api/engine" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}
if ($ok) {
  try { Start-Process msedge -ArgumentList "--app=$url", "--window-size=1400,900" -ErrorAction Stop } catch { Start-Process $url }
} else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "Arto не запустился.`n`nПосмотрите текст ошибки в чёрном окне Arto или в файле data\server.log (в папке программы) и перешлите его автору.",
    "Arto", "OK", "Warning") | Out-Null
}
