# Run from a private local terminal. Password is read without echo, never placed
# in process arguments, environment variables, command history, or a file.
$ErrorActionPreference = 'Stop'
$taskScript = Join-Path $PSScriptRoot 'provision-basic-unlimited.cjs'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    & node $taskScript --check
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning preflight failed. No account was created.' }
    $taskPassword = Read-Host 'Password for a NEW account (an existing account keeps its current password)' -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskPassword)
    try {
        $taskStart = New-Object System.Diagnostics.ProcessStartInfo
        $taskStart.FileName = (Get-Command node).Source
        $taskStart.Arguments = '"' + $taskScript + '"'
        $taskStart.WorkingDirectory = (Get-Location).Path
        $taskStart.UseShellExecute = $false
        $taskStart.CreateNoWindow = $true
        $taskStart.RedirectStandardInput = $true
        $taskProcess = [System.Diagnostics.Process]::Start($taskStart)
        try {
            $taskPayload = @{ password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) } | ConvertTo-Json -Compress
            $taskProcess.StandardInput.WriteLine($taskPayload)
            $taskPayload = $null
            $taskProcess.StandardInput.Close()
            $taskProcess.WaitForExit()
            if ($taskProcess.ExitCode -ne 0) { throw 'Provisioning did not complete. Correct the reported setup issue and rerun safely.' }
        } finally { $taskProcess.Dispose() }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
        $taskPassword.Dispose()
        $taskPayload = $null
    }
} finally { Pop-Location }
