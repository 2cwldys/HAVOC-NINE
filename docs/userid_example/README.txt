===============================================================================
 h9id_example.sma -- HOW TO COMPILE AND TRY IT
===============================================================================

 What it is: a minimal, standalone proof of concept for the per-server-salted
 client id described in ..\CUSTOM_XASH_USERID.txt. It is reference material,
 not a project plugin -- it lives here under docs\, not at the TSM root, so
 build.bat never sees it (build.bat only scans *.sma at the project root).
 That means it has no build.bat shortcut; deploy and load it by hand.

 h9id_example.amxx in this same folder is already compiled (AMX Mod X
 Compiler 1.10.0.5634, from the h9id_example.sma sitting right beside it,
 unmodified) -- skip straight to DEPLOY below if you trust it as-is. Recompile
 it yourself first only if you want to verify that, or if you changed the
 source:

 1. COMPILE (optional -- skip to DEPLOY to use the .amxx already here)
    Copy h9id_example.sma into your server's scripting folder, then run its
    compiler on it, for example:

        copy h9id_example.sma "D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx\scripting\"
        cd   "D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx\scripting"
        amxxpc.exe h9id_example.sma

    This produces h9id_example.amxx right beside it in scripting\ (amxxpc's
    own default output location -- its -o flag did not behave as documented
    when this was last tested, so it is left out of this example on purpose).

 2. DEPLOY
    Copy the .amxx -- the one already in this folder, or the one you just
    compiled -- into the plugins folder:

        copy h9id_example.amxx "D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx\plugins\"

 3. REGISTER
    AMX Mod X only loads what plugins.ini lists. Add one line:

        D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx\configs\plugins.ini
            h9id_example.amxx

    Put it on its own line, with a newline after the file's existing last
    line first -- appending straight onto a line with no trailing newline
    fuses the two names into one that does not exist, which silently kills
    both plugins (the same trap build.bat's own registration step avoids).

 4. SEE IT WORK
    Restart the server (or change the map) so plugins.ini is re-read, then
    connect with an H9XASH client. The server console prints the clientid on
    connect, and the round-trip shows up a line later:

        [h9id example] YourName connected, h9_clientid = 7f3c9a...
        [h9id example] wrote to h9id_example.cfg: 7f3c9a... YourName
        [h9id example] h9id_example.cfg line 1 refers to this clientid: 7f3c9a... YourName

    The file itself lands at:

        D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx\configs\h9id_example.cfg

    Open it in any text editor -- it is plain text, one "clientid name" line
    per connect, exactly what got read back above.

 5. REMOVE IT ONCE IT HAS MADE ITS POINT
    Delete (or comment out with a leading ";") the h9id_example.amxx line in
    plugins.ini, then restart the server or change the map. Deleting the
    .sma/.amxx copies from the scripting\/plugins\ folders is optional once
    it is out of plugins.ini -- an unregistered .amxx just sits there unused.
