# Mata tudo que o windows\start.bat sobe. Chamado pelo windows\stop.bat.
#
# Estrategia:
#   1. node.exe rodando server.js / worker.js / vite
#   2. cmd.exe PAI desses node (que mantem a janela aberta por causa do cmd /k)
#   3. cmd.exe orfaos com titulo "Nimbus - *" que sobraram

$killed = @()

# 1+2. node.exe relacionados ao Nimbus + cmd.exe pai
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.js|worker\.js|vite' }

foreach ($n in $nodes) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($n.ParentProcessId)" -ErrorAction SilentlyContinue
    Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += "node($($n.ProcessId))"
    if ($parent -and $parent.Name -eq 'cmd.exe') {
        Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
        $killed += "cmd-parent($($parent.ProcessId))"
    }
}

# 3. cmd.exe orfaos com titulo "Nimbus - *" (caso a janela tenha perdido o filho)
$cmds = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'Nimbus - ' }
foreach ($c in $cmds) {
    Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += "cmd-orphan($($c.ProcessId))"
}

if ($killed.Count -gt 0) {
    Write-Host ("Processos parados: " + ($killed -join ', '))
} else {
    Write-Host "Nada estava rodando."
}
