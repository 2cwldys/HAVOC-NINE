===============================================================================
 H9XASH ON LINUX -- HAVOC 9 through Wine or Proton
===============================================================================

 HAVOC 9.exe is a 32-bit Windows program. On Linux it runs through Wine, or
 through Steam's Proton. h9xash.sh does here what h9xash.bat does on Windows:
 it makes this install's client id, turns networking.ini into the game's
 server lists, picks the menu music and video, and starts HAVOC 9.exe under
 Wine. The files it writes are the same as on Windows, so one H9XASH folder
 can be played from both systems.

 What you need
 -------------
   * Wine 9 or newer that runs 32-bit Windows programs (a 32-bit Wine or a
     WoW64 build). Debian and Ubuntu split the 32-bit part out:
         sudo dpkg --add-architecture i386 && sudo apt update
         sudo apt install wine wine32:i386
     Elsewhere: your distribution's wine package, or winehq.org/download.
   * Or Steam with Proton 9 or newer, or GE-Proton: no Wine install needed.
   * Working 32-bit OpenGL and sound, as for any 32-bit game: your
     distribution's 32-bit Mesa or NVIDIA libraries (Steam needs them too).

 Starting the game
 -----------------
   Unpack the archive, then in a terminal:

       cd H9XASH
       ./h9xash.sh --check            Wine, its 32-bit part, the prefix
       ./h9xash.sh                    the main menu, with a random menu track
       ./h9xash.sh -dev 2 -log        the same, with a full engine.log
       ./h9xash.sh +map h9_te_neuropolis

   From a .zip the scripts may have lost their "executable" mark: then type
   bash h9xash.sh in place of ./h9xash.sh.

   Wine is $WINE when you set it (the path of another wine), else wine on
   the PATH. Its prefix is $WINEPREFIX when you set it, else
   ~/.local/share/h9xash/prefix, made on the first start. Deleting that
   folder starts Wine over; your game settings stay in H9XASH/ts.

 Your player id
 --------------
   Link your Account in the game's main menu links it to your havoc9.org
   account, with no id to paste. The game keeps the id in user_id.ini with
   Wine's DPAPI, which keys it to your user name: out of plain sight, not
   locked. The older ways:
       ./h9_userid.sh --set     paste the player id of your havoc9.org
                                account (ACCOUNT), as enter_userid.cmd does
       ./h9_userid.sh --new     a new random id, as h9_regenerate_userid.bat
   Either takes effect on the next start. Keep your account's id to yourself.

 Steam and Proton
 ----------------
   1. Steam > Games > Add a Non-Steam Game to My Library > Browse. Pick
      H9XASH/HAVOC 9.exe (set the file type to All Files), then Add.
   2. In its Properties, name it HAVOC 9. "Start in" must be the H9XASH
      folder; Steam fills that in. Launch options:
          -game ts -console
   3. Compatibility: force Proton 9.0 or newer, or GE-Proton.

   A Steam shortcut starts HAVOC 9.exe directly, without h9xash.sh. So run
       ./h9xash.sh --prepare-only
   once before the first start, and again after you change networking.ini
   or your id. Or have Steam run it on every start, with these launch
   options in place of the ones above (your own path):
       "/home/you/H9XASH/h9xash.sh" --prepare-only %command%
   It adds -game ts -console itself.

   Without Steam, umu-launcher runs Proton too. From the H9XASH folder:
       ./h9xash.sh --prepare-only umu-run "$PWD/HAVOC 9.exe"
   umu keeps its own prefix: ~/Games/umu/umu-default, or $WINEPREFIX.

 Discord Rich Presence
 ---------------------
   The game talks to the Discord app through a Windows pipe, and Wine does
   not pass that on to the Linux Discord app by itself. A small bridge does.
   None ships with H9XASH; two that do the job:
     * wine-discord-ipc-bridge
         https://github.com/0e4ef622/wine-discord-ipc-bridge
       Start it in the same prefix, then the game:
         WINEPREFIX=~/.local/share/h9xash/prefix wine winediscordipcbridge.exe &
         ./h9xash.sh
       With Steam, its winediscordipcbridge-steam.sh goes before %command%.
     * rpc-bridge
         https://github.com/EnderIce2/rpc-bridge
       Installed once into the prefix, then it starts with Wine by itself:
         WINEPREFIX=~/.local/share/h9xash/prefix wine bridge.exe
       and click Install.
   ts_richpresence 0 in the console turns the card off.

 A server's splash MOTD
 ----------------------
   Under Wine or Proton, a server's web page is not drawn inside the game:
   you get its picture or its text, and OPEN PAGE opens the page in your
   Linux web browser after showing you the whole address. Pictures work as
   on Windows.

   Coming with the next engine build: cl_h9_motd_wine 1 in the console
   (0, the default, is the behaviour above) draws the page inside the game
   with Microsoft Edge WebView2, which must then be in the prefix.
   winetricks has no WebView2 entry: get Microsoft's "Evergreen Standalone
   Installer" (x64) from developer.microsoft.com/microsoft-edge/webview2
   and run it in the prefix:
       WINEPREFIX=~/.local/share/h9xash/prefix wine \
           MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
   cl_h9_motd_wine 2 is the same with the GPU off, for a page that stays
   blank or black. docs/H9_MOTD.txt in the H9 repository has the details.
   cl_h9_motd 0 shows every server's plain text MOTD instead.

 Known limits
 ------------
   * This is the Windows game under Wine, not a native Linux build.
   * The Steam broker (steam_broker=1 in networking.ini) is a Windows
     program h9xash.sh does not start; the server lists work as usual.
   * h9xash_server*.bat, h9_presets.bat and h9_add_to_steam.ps1 are for
     Windows only.

 Troubleshooting
 ---------------
   ./h9xash.sh --check says what it finds and what is missing.
   "no Wine"                   install Wine (above), or use Steam/Proton.
   "cannot run 32-bit ..."     add Wine's 32-bit part (above).
   A black window, no sound    install your distribution's 32-bit Mesa or
                               NVIDIA, and 32-bit PulseAudio or PipeWire,
                               libraries.
   Fullscreen trouble          ./h9xash.sh -borderless, or -windowed
                               -width 1280 -height 720.
   No Discord card             a bridge is needed (above).
   Wine's own messages         WINEDEBUG=err+all ./h9xash.sh (h9xash.sh
                               turns them off unless WINEDEBUG is set).
   Start Wine over             rm -rf ~/.local/share/h9xash/prefix
   It crashes at once          ./h9xash.sh -dev 2 -log, then read the end of
                               engine.log in the H9XASH folder.
