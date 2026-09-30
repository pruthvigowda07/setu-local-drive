$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuild = Join-Path $taskRoot 'build\windows'
$taskPayload = Join-Path $taskBuild 'payload'
$taskDist = Join-Path $taskRoot 'dist'
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) { throw 'The .NET Framework C# compiler is required to build the Windows package.' }
New-Item -ItemType Directory -Path $taskPayload,$taskDist,(Join-Path $taskPayload 'runtime'),(Join-Path $taskPayload 'licenses') -Force | Out-Null
foreach ($taskLegacy in @('Harbor.exe','Uninstall Harbor.exe','licenses\Harbor-NOTICE.txt')) {
    $taskLegacyPath = Join-Path $taskPayload $taskLegacy
    if (Test-Path -LiteralPath $taskLegacyPath) { Remove-Item -LiteralPath $taskLegacyPath -Force }
}
foreach ($taskLegacyInstaller in @('Harbor Setup.exe','Send Local Cloud Setup.exe')) {
    $taskLegacyInstallerPath = Join-Path $taskDist $taskLegacyInstaller
    if (Test-Path -LiteralPath $taskLegacyInstallerPath) { Remove-Item -LiteralPath $taskLegacyInstallerPath -Force }
}
foreach ($taskDirectory in @('server','public')) {
    $taskTarget = Join-Path $taskPayload $taskDirectory
    if (Test-Path -LiteralPath $taskTarget) { Remove-Item -LiteralPath $taskTarget -Recurse -Force }
    New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $taskRoot $taskDirectory) -File | Copy-Item -Destination $taskTarget -Force
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'package.json'),(Join-Path $taskRoot 'README.md') -Destination $taskPayload -Force
$taskNode = (Get-Command node).Source
Copy-Item -LiteralPath $taskNode -Destination (Join-Path $taskPayload 'runtime\node.exe') -Force
$taskCloudflared = Join-Path $env:LOCALAPPDATA 'Harbor\bin\cloudflared.exe'
if (-not (Test-Path -LiteralPath $taskCloudflared)) { $taskCloudflared = (Get-Command cloudflared).Source }
Copy-Item -LiteralPath $taskCloudflared -Destination (Join-Path $taskPayload 'runtime\cloudflared.exe') -Force
$taskNodeVersion = (& $taskNode --version).Trim()
Invoke-WebRequest ('https://raw.githubusercontent.com/nodejs/node/' + $taskNodeVersion + '/LICENSE') -OutFile (Join-Path $taskPayload 'licenses\Node-LICENSE.txt')
Invoke-WebRequest 'https://raw.githubusercontent.com/cloudflare/cloudflared/2026.9.1/LICENSE' -OutFile (Join-Path $taskPayload 'licenses\Cloudflared-LICENSE.txt')
Set-Content -LiteralPath (Join-Path $taskPayload 'licenses\Setu-NOTICE.txt') -Value 'Setu is an original local application. Bundled Node.js and cloudflared are distributed under their respective included licenses. This package contains no user credentials or uploaded files.'

# Use Microsoft's installed WebView2 Runtime, without bundling another browser.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskWebViewVersion = '1.0.4191.47'
$taskWebViewRoot = Join-Path $taskRoot ('build\webview2-' + $taskWebViewVersion)
$taskWebViewPackage = Join-Path $taskWebViewRoot 'package'
if (-not (Test-Path -LiteralPath $taskWebViewPackage)) {
    New-Item -ItemType Directory -Path $taskWebViewRoot -Force | Out-Null
    $taskNupkg = Join-Path $taskWebViewRoot 'sdk.nupkg'
    Invoke-WebRequest ('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $taskWebViewVersion + '/microsoft.web.webview2.' + $taskWebViewVersion + '.nupkg') -OutFile $taskNupkg
    [IO.Compression.ZipFile]::ExtractToDirectory($taskNupkg,$taskWebViewPackage)
}
foreach($taskDll in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item -LiteralPath (Join-Path $taskWebViewPackage ('lib\net462\' + $taskDll)) -Destination $taskPayload -Force
}
Copy-Item -LiteralPath (Join-Path $taskWebViewPackage 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $taskPayload -Force
Copy-Item -LiteralPath (Join-Path $taskWebViewPackage 'LICENSE.txt') -Destination (Join-Path $taskPayload 'licenses\WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $taskWebViewPackage 'NOTICE.txt') -Destination (Join-Path $taskPayload 'licenses\WebView2-NOTICE.txt') -Force

# Draw the native Setu orange-on-black mark; no browser engine is bundled.
Add-Type -AssemblyName System.Drawing
$taskBitmap = New-Object System.Drawing.Bitmap 64,64
$taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskGraphics.Clear([System.Drawing.Color]::FromArgb(7,7,7))
$taskBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,112,25))
$taskGraphics.FillPolygon($taskBrush, [System.Drawing.Point[]]@([System.Drawing.Point]::new(32,7),[System.Drawing.Point]::new(54,19),[System.Drawing.Point]::new(54,45),[System.Drawing.Point]::new(32,57),[System.Drawing.Point]::new(10,45),[System.Drawing.Point]::new(10,19)))
$taskBrush.Dispose()
$taskPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255,218,151)),3
$taskPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$taskPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$taskGraphics.DrawLine($taskPen,32,7,32,57)
$taskGraphics.DrawLine($taskPen,10,19,32,32)
$taskGraphics.DrawLine($taskPen,54,19,32,32)
$taskGraphics.DrawLine($taskPen,10,45,32,32)
$taskGraphics.DrawLine($taskPen,54,45,32,32)
$taskPen.Color = [System.Drawing.Color]::FromArgb(30,10,3)
$taskPen.Width = 4
$taskGraphics.DrawLine($taskPen,24,27,40,37)
$taskGraphics.DrawLine($taskPen,40,27,24,37)
$taskIcon = [System.Drawing.Icon]::FromHandle($taskBitmap.GetHicon())
$taskIconFile = Join-Path $taskBuild 'setu.ico'
$taskIconStream = [System.IO.File]::Create($taskIconFile)
$taskIcon.Save($taskIconStream)
$taskIconStream.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose(); $taskPen.Dispose()

& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ ('/win32icon:' + $taskIconFile) ('/win32manifest:' + (Join-Path $taskRoot 'windows\app.manifest')) ('/out:' + (Join-Path $taskPayload 'Setu.exe')) /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Security.dll /r:System.Web.Extensions.dll ('/r:' + (Join-Path $taskPayload 'Microsoft.Web.WebView2.Core.dll')) ('/r:' + (Join-Path $taskPayload 'Microsoft.Web.WebView2.WinForms.dll')) (Join-Path $taskRoot 'windows\Harbor.cs')
if ($LASTEXITCODE -ne 0) { throw 'Setu launcher compilation failed.' }
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ ('/win32icon:' + $taskIconFile) ('/out:' + (Join-Path $taskPayload 'Uninstall Setu.exe')) /r:System.Windows.Forms.dll (Join-Path $taskRoot 'windows\Uninstall.cs')
if ($LASTEXITCODE -ne 0) { throw 'Setu uninstaller compilation failed.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = Join-Path $taskBuild ('payload-' + [Guid]::NewGuid().ToString('N') + '.zip')
[System.IO.Compression.ZipFile]::CreateFromDirectory($taskPayload,$taskZip,[System.IO.Compression.CompressionLevel]::Optimal,$false)
$taskSetup = Join-Path $taskDist 'Setu Setup.exe'
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ ('/win32icon:' + $taskIconFile) ('/out:' + $taskSetup) ('/resource:' + $taskZip + ',payload.zip') /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:Microsoft.CSharp.dll (Join-Path $taskRoot 'windows\Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Setu installer compilation failed.' }
Get-FileHash -LiteralPath $taskSetup -Algorithm SHA256 | Format-List
Get-Item -LiteralPath $taskSetup | Select-Object FullName,Length
