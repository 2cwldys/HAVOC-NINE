# Release event -- the lines to add to vps\windows\receive-deploy.ps1
#
# Not applied to the real receive-deploy.ps1 yet.
#
# Goes at the very END of a successful install, after the delivery folder is removed and after
# start-all.ps1's checks pass -- that is, at the point where the build is genuinely live and
# serving. Not earlier.
#
# That placement is the whole point. On 2026-11-19 the 1.68 package built, uploaded every file,
# and was then refused by this script's own free-space guard. Nothing anywhere announced a
# failure, so the release looked done from the sending side and the server list bot sat on 1.66
# until someone noticed by eye. An announcement written here cannot repeat that, because this
# line is only reached when the install worked.

# --- add near the top, with the other paths -------------------------------------------------
$ReleaseFile = Join-Path $Root 'data\release.json'

# --- add at the end, on the success path only -----------------------------------------------
# $Version is whatever this script already knows the build to be; if it does not track one,
# read it from the manifest it just installed rather than inventing a number here.
try {
    $verFile = Join-Path $Site 'h9_release.txt'
    $version = if (Test-Path -LiteralPath $verFile) { (Get-Content -LiteralPath $verFile -Raw).Trim() } else { '' }

    if ($version) {
        $changed = 0
        $mb = 0.0
        if (Test-Path -LiteralPath $manifestPath) {
            # whatever this script already counted during the ingest; these two are only for
            # the embed's "Files changed" and "Download" fields and are safe to leave at 0
            $changed = $filesInstalled
            $mb = [math]::Round($bytesInstalled / 1MB, 1)
        }

        $payload = [ordered]@{
            version = $version
            at      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            files   = $changed
            mb      = $mb
        }

        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReleaseFile) | Out-Null

        # Written to a temp name and moved into place, so the bot can never read a half-written
        # file. The bot tolerates a torn read anyway (it just waits for the next tick), but a
        # rename is atomic and costs nothing.
        $tmp = "$ReleaseFile.tmp"
        $payload | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $ReleaseFile -Force

        Say "release $version recorded for the bot ($ReleaseFile)"
    }
}
catch {
    # An announcement that cannot be written must never fail an install that worked.
    Write-Host "  could not record the release for the bot: $($_.Exception.Message)"
}
