$lines = @(
    'game "The Specialists"',
    'url_info "http://www.specialistsmod.net"',
    'url_dl "http://www.specialistsmod.net"',
    'version "3.0"',
    'size ""',
    'svonly "0"',
    'cldll "cl_dlls\client.dll"',
    'hlversion "1110"',
    'type "multiplayer_only"',
    'nomodels "0"',
    'mpentity "info_player_deathmatch"',
    'icon "TS_big"',
    '//edicts "2048"',
    '',
    'gamedll "addons\metamod\dlls\metamod.dll"',
    '',
    '// I have never known this to actually let you specify a file other then dlls/ts_i386.so',
    '// If you want a port to a different architecture, get on the forums and send a PM to Vino.',
    '// Note that the file ts_i386.so is just a symlink to ts_i686.so, 3.0 was not released with a 386 binary.',
    'gamedll_linux "dlls/ts_i386.so"'
)
[System.IO.File]::WriteAllLines('D:\SteamLibrary\steamapps\common\Half-Life\ts\liblist.gam', $lines)