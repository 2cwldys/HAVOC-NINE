# generate_patches.ps1 -- for each tracked DLL/EXE target below, git-diffs its source
# folder since the commit that last touched its .patch file, and folds any change into
# that .patch via the project's existing dllmerge.ps1 (xash3d-h9-patches\dllmerge.ps1 --
# same append-only, history-block, conflict-detecting merge xash.bat's own :dllpatch
# step already uses for xash.dll/menu.dll/etc., reused here rather than reimplemented).
#
# Targets are an explicit list, not whole-repo auto-discovery: inferring "this DLL goes
# with that source folder" isn't reliably guessable, and a wrong guess would be worse
# than no guess. Add a new target by adding one entry to $Targets below.
#
# xash.dll/ref_gl.dll/filesystem_stdio.dll/menu.dll/vgui.dll/HAVOC 9.exe are NOT here on
# purpose -- xash.bat already regenerates those on every engine build. Running this
# against them too would just race the same .patch file against two writers.

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$DllMerge = Join-Path $RepoRoot 'xash3d-h9-patches\dllmerge.ps1'
$LogPath = Join-Path $RepoRoot 'generate_patches.log'

$Targets = @(
    @{
        Name        = 'rcbot_mm.dll'
        PatchFile   = 'rcbot-patch\rcbot_mm.dll.patch'
        SourcePaths = @('rcbot-patch\src')
        Description = 'RCBot: see rcbot-patch\README.txt for what each change does.'
    }
    # Add more targets the same shape, e.g.:
    # @{
    #     Name        = 'client.dll'
    #     PatchFile   = 'decompile_dll\client.dll.patch'
    #     SourcePaths = @('decompile_dll\client_src')
    #     Description = 'One line: what this DLL is and what its patches do.'
    # }
)

function Write-Log([string]$line) {
    Write-Host $line
    Add-Content -LiteralPath $LogPath -Value $line
}

"=== generate_patches.ps1 run $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content -LiteralPath $LogPath

Push-Location $RepoRoot
try {
    foreach ($t in $Targets) {
        $patchFull = Join-Path $RepoRoot $t.PatchFile
        Write-Log "--- $($t.Name) ---"

        if (Test-Path -LiteralPath $patchFull) {
            $sinceHash = (git log -1 --format=%H -- $t.PatchFile 2>$null)
            if (-not $sinceHash) {
                Write-Log "  [CONFLICT] $($t.PatchFile) exists but is not tracked by git -- can't tell what it's already seen. Commit it first, or delete it to start fresh."
                continue
            }
        } else {
            $sinceHash = $null
        }

        $diffArgs = @('diff')
        if ($sinceHash) { $diffArgs += $sinceHash; $diffArgs += 'HEAD' }
        $diffArgs += '--'
        $diffArgs += $t.SourcePaths
        $diff = & git @diffArgs 2>&1

        if (-not $sinceHash -and -not $diff) {
            Write-Log "  [SKIP] no existing patch and no committed source differences to build one from yet."
            continue
        }
        if ($sinceHash -and -not $diff) {
            Write-Log "  no change in $($t.SourcePaths -join ', ') since $($sinceHash.Substring(0,7)) -- patch left as is."
            continue
        }

        $commits = & git log --oneline "$sinceHash..HEAD" -- $t.SourcePaths 2>&1
        if (-not $sinceHash) { $commits = & git log --oneline -1 -- $t.SourcePaths 2>&1 }
        $status = & git status --porcelain -- $t.SourcePaths 2>&1

        $tmp = New-TemporaryFile
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add("$($t.Name) -- patched source")
        $lines.Add('')
        $lines.Add($t.Description)
        $lines.Add('')
        $lines.Add("Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') by generate_patches.ps1")
        if ($status) { $lines.Add('Working tree status at generation time:'); $lines.AddRange(@($status)) }
        if ($commits) { $lines.Add('Commits in this diff:'); $lines.AddRange(@($commits)) }
        $lines.Add('')
        $lines.Add('== Patch history ==')
        $lines.Add('')
        $lines.AddRange(@($diff))
        [System.IO.File]::WriteAllText($tmp.FullName, ($lines -join "`n") + "`n")

        $mergeOut = & powershell -NoProfile -File $DllMerge -Final $patchFull -New $tmp.FullName 2>&1
        $mergeOut | ForEach-Object { Write-Log "  $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  [CONFLICT] dllmerge.ps1 exited $LASTEXITCODE for $($t.PatchFile) -- see the line above."
        }
    }
}
finally {
    Pop-Location
}

Write-Log "=== done ==="
