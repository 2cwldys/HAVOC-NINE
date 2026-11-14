===============================================================================
 HAVOC9.ORG ON A WINDOWS HOST -- STEP BY STEP
===============================================================================

 This package puts the whole of havoc9.org on one Windows machine (Windows
 Server 2019 or later, or Windows 10/11 that stays on): the site, h9web
 (accounts, forum, communities, the web client's relay), the H9 server list
 the game's Internet tab reads, HTTPS for the domain, the firewall and the
 daily backups. Every step can be done by hand from this file alone; setup.ps1
 does steps 4 and 5 in one go and is safe to run again at any time. The Linux
 package (havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip, README-VPS.txt) is the
 same site on a Linux VPS; the two use the same backups, so a site moves
 between them.

 Everything goes through the domain: players, game clients and the site use
 https://havoc9.org/ whatever the machine's address is, so moving to another
 host later only means pointing DNS at it (step 10).

 Nothing in this package is secret. The secrets are made on the host (h9web's
 secrets.json and data.key) or typed in there (the list's Discord token and
 heartbeat key, the backup passphrase), and never go into the package or git.

 CONTENTS
    0. What is in the package, and the stack
    1. What you need
    2. DNS, and the router for a home connection
    3. Copying the package over
    4. setup.ps1
    5. HTTPS
    6. First start: the keys, the first admin
    7. The game servers and the server list
    8. Backups
    9. Restoring a backup on a new host
   10. Moving to another host, in order
   11. Updating to a new package
   12. The web client (optional)
   13. The downloads
   14. When something is wrong
   15. Checklist
   16. The P2P relay (optional)


 0. WHAT IS IN THE PACKAGE, AND THE STACK
 ----------------------------------------
   README-WINDOWS.txt   this file
   setup.ps1, setup.cmd installs or updates everything (step 4); setup.cmd
                        runs setup.ps1 in an administrator PowerShell
   Caddyfile.template   the web server's settings (setup.ps1 fills it in)
   BUILD.txt            the build this package was made from
   h9web\, havoc9.org\, serverlist-bot\   h9web, the site and the list, the
                        same as in the Linux package
   p2p\                 the P2P relay's code and its settings examples, for
                        step 16 (p2p\README.txt); setup.ps1 puts it in place
                        only when asked (-P2P module or -P2P standalone)

 The stack, and why:
   * Node.js 24 runs h9web, as on Linux.
   * Caddy is the web server: it gets the Let's Encrypt certificate and
     renews it by itself, so there is nothing else to install or schedule
     for HTTPS. It sends http:// to https://, serves the site, and passes
     /api/ and the relay to h9web and /serverlist/ to the list.
   * WinSW (MIT licence) runs h9web, the list and Caddy as real Windows
     services: started at boot, restarted when one stops, run as
     LocalService (no password stored, no administrator rights while they
     run), their logs in C:\havoc9\logs, kept 30 days.
   * Python runs the server list.
 setup.ps1 downloads each of them at a pinned version and checks it against
 its SHA-256 or SHA-512 before it uses it; the Python installer's signature
 is checked as well. Nothing else is downloaded but the list's Python
 packages (serverlist-bot\requirements.txt, from PyPI).

 Where things go (C:\havoc9 unless setup.ps1 -Root says otherwise):
   tools\            node, python, caddy, winsw
   h9web\            h9web's code
   serverlist\       the list's code and its Python packages
   site\             the site; site\downloads\ the downloads and their file
                     index (step 13)
   game\             the web client's game files (step 12)
   etc\              config.json, servers.json, Caddyfile, Caddyfile.extra,
                     backup-passphrase (SYSTEM, Administrators; LocalService
                     reads)
   data\h9web\       h9web.db, secrets.json, data.key, modules\, backups\,
                     offsite\ (SYSTEM, Administrators and LocalService only)
   data\serverlist\  the list's serverlist.ini, serverlist.cfg (its secrets),
                     servers.txt, blacklisted.ini, serverlist.log
   data\caddy\       the certificates
   services\         the service wrappers;  logs\  the services' logs
   downloads\        the checked downloads, kept for the next run
   p2p\              the P2P relay's code (step 16);  etc\p2p\  its
                     relay.config.json and hosts.json, when it runs as a
                     service of its own


 1. WHAT YOU NEED
 ----------------
   * Windows Server 2019/2022/2025, or Windows 10/11, 64-bit, that stays on
     and does not sleep; 2 GB of memory or more, 10 GB free (25 GB with the
     web client). An administrator account on it.
   * The domain havoc9.org at its registrar, where you can edit its DNS.
   * Ports 80 and 443 (TCP) reachable from the internet, and 27015 (UDP)
     for a game server. Nothing else may use 80 or 443 on the machine (IIS,
     another web server, Skype's old setting): Caddy needs them.
   * This package, havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip, and for a
     move or a restore the offline copies of secrets.json, data.key and the
     backup passphrase.


 2. DNS, AND THE ROUTER FOR A HOME CONNECTION
 --------------------------------------------
 At the registrar, for havoc9.org:
   A      havoc9.org        <the machine's public IPv4 address>
   A      www.havoc9.org    <the same>
   AAAA   (both names)      <its IPv6 address, only if it has one>
 Remove any other A or AAAA records for those names. TTL 300 makes a later
 move quick. Check from any PC:  nslookup havoc9.org
 On a home connection the public address is the router's: forward TCP 80
 and 443 and UDP 27015 on the router to this machine's LAN address, and give
 the machine a fixed LAN address. If the provider changes the public address
 now and then, use the registrar's dynamic DNS, or a VPS.


 3. COPYING THE PACKAGE OVER
 ---------------------------
 Copy havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip to the machine (Remote
 Desktop copy and paste works), then right-click it, Properties, tick Unblock
 if it is there, OK, and Extract All, for example into C:\setup.


 4. SETUP.PS1
 ------------
 Right-click setup.cmd, Run as administrator. Or in an administrator
 PowerShell in the unpacked folder:
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
 For a restore or a move use step 9 instead: h9web must not start before
 the old keys are in place.
   -WhatIf             show every step, change nothing (a dry run)
   -Check              only show what is installed and running
   -FileIndex          only the downloads' file index (step 13)
   -Root D:\havoc9     another folder than C:\havoc9
   -Email you@...      the address Let's Encrypt may write to (optional)
   -GamePorts 27015/udp,27016/udp    the game servers' ports to open
   -H9Xash D:\H9XASH   without -GamePorts: the port= under [server] in
                       that folder's networking.ini (27015 when none)
   -NoFirewall         leave the firewall alone
   -P2P module|standalone   the P2P relay (step 16); -P2PPort 27248 is its
                       UDP port. Without -P2P nothing of it is touched.
 What it does, in order (each step is safe to repeat):
   1. makes the folders, and gives data\, etc\ and logs\ to SYSTEM,
      Administrators and LocalService only;
   2. downloads and checks Node.js, Caddy, WinSW and Python (only what is
      missing or another version);
   3. takes a backup when h9web is already there, stops the services, puts
      h9web's code in, and makes etc\config.json (this host's folders and the
      domain) and an empty servers.json when there are none: an existing one
      is never touched;
   4. puts the list's code in with its Python packages, and makes its
      settings in data\serverlist when there are none;
   5. puts the site in (the downloads, their file index, H9XASH-Updater's
      files\ and the web client's files there are kept), then links the
      downloads into the file index and writes its SHA256SUMS.txt (step 13);
   6. writes etc\Caddyfile from Caddyfile.template and checks it; your own
      additions go in etc\Caddyfile.extra, which it never writes;
   7. (only with -Restore or -Keys, step 9) puts the keys in place and
      restores the backup;
   8. installs and starts the three services: havoc9-h9web,
      havoc9-serverlist, havoc9-caddy;
   9. schedules the backups and the log cleanup (step 8);
  10. opens TCP 80 and 443 and the game ports in Windows' firewall.
 With -P2P there is one more step after 4 (the relay's code, and for
 standalone its settings and its service havoc9-p2p) and one more firewall
 rule (its UDP port).
 It ends with a list of warnings, if there were any.


 5. HTTPS
 --------
 Caddy asks Let's Encrypt for the certificate by itself, as soon as DNS
 points havoc9.org and www.havoc9.org here and port 80 or 443 reaches the
 machine, and renews it by itself. Nothing to run. Check:
   https://havoc9.org/ in a browser: a padlock;  http:// sends you there.
 If it does not come: C:\havoc9\logs\havoc9-caddy*.log says why (most often
 DNS, or the router or the provider's firewall not letting 80 and 443 in).


 6. FIRST START: THE KEYS, THE FIRST ADMIN
 -----------------------------------------
 On its first start h9web makes C:\havoc9\data\h9web\secrets.json (every
 password and player id depends on it) and data.key (it seals the Discord
 links). setup.ps1 warns when it has just made them. Copy both NOW to
 somewhere safe and offline (a password manager, an encrypted USB stick),
 apart from the backups; they never change after this.

 The first admin: open https://havoc9.org/, CREATE ACCOUNT, then in an
 administrator PowerShell:
   C:\havoc9\tools\node\node.exe C:\havoc9\h9web\bin\h9web-admin.js --config C:\havoc9\etc\config.json set-role <your username> admin
 Every other admin job: docs\H9WEB_ADMIN.txt in the repository (section 3
 on; use the line above in place of $A), or h9web\README.txt section 11.
 Settings: C:\havoc9\etc\config.json (h9web\README.txt section 7). After an
 edit: Restart-Service havoc9-h9web


 7. THE GAME SERVERS AND THE SERVER LIST
 ---------------------------------------
   * C:\havoc9\etc\servers.json: the servers the web client may join through
     the relay and the site's SERVERS page shows (h9web\README.txt section
     6); read again within 2 seconds of an edit.
   * The H9 server list: what the downloaded game's Internet tab shows,
     https://havoc9.org/serverlist. A dedicated server started with
     h9xash_server.bat announces itself to it every two minutes
     (docs\NETWORKING.txt section 7; heartbeat=0 under [server] in its
     networking.ini turns that off). Others get on from
     C:\havoc9\data\serverlist\servers.txt (it ships with havoc9.org:27015,
     a game server on this machine) or from Discord (/addserver).
 The list's secrets, for Discord commands and heartbeats from other
 addresses, in C:\havoc9\data\serverlist\serverlist.cfg (open Notepad as
 administrator):
     heartbeat_key = <a long random string>
     discord_token = <the bot token, only for the Discord commands>
   Restart-Service havoc9-serverlist
 Check it: https://havoc9.org/serverlist/v1/servers/ts in a browser.


 8. BACKUPS
 ----------
 Every day at 03:30 the task "havoc9 h9web backup" backs up the database, the
 forum's pictures and the presence keys into C:\havoc9\data\h9web\backups,
 the newest 14 kept; logs\backup.log has each run. By hand (administrator
 PowerShell):
   $B = 'C:\havoc9\h9web\bin\h9web-backup.js'
   C:\havoc9\tools\node\node.exe $B --config C:\havoc9\etc\config.json backup
   C:\havoc9\tools\node\node.exe $B --config C:\havoc9\etc\config.json list
   C:\havoc9\tools\node\node.exe $B verify <file>
 Copies that leave the machine are encrypted, and they carry secrets.json and
 data.key too, so a copy and the passphrase are all a new host needs (step
 9). Make the passphrase file once (12 characters or more, one line) and
 keep the passphrase offline with the keys:
   notepad C:\havoc9\etc\backup-passphrase       (as administrator; no .txt)
   then run setup.ps1 again
 From then on "havoc9 h9web backup offsite" writes one at 03:45 into
 C:\havoc9\data\h9web\offsite (7 kept). Copy that folder to storage of your
 own now and then. Never copy the whole of data\h9web off the machine.
 Every option: h9web\README.txt section 10.


 9. RESTORING A BACKUP ON A NEW HOST
 -----------------------------------
 You need the newest .h9backup (one from offsite\ holds the keys too), the
 passphrase for an encrypted one, and for a backup without the keys the old
 secrets.json and data.key in a folder. After steps 1 to 3, in an
 administrator PowerShell in the unpacked folder:
   .\setup.ps1 -Restore C:\setup\h9web-havoc9.org-<time>.h9backup -PassphraseFile C:\setup\pass.txt
   (add -Keys C:\setup\keys for a backup without the keys; no
    -PassphraseFile for a plain one)
 setup.ps1 puts the keys in place, checks the backup, restores it and only
 then starts h9web. The restore refuses a secrets.json other than the
 backup's. Then delete pass.txt and the keys folder, and sign in with an
 existing account to check. If h9web was started here before and made new
 keys, stop it (Stop-Service havoc9-h9web) and move secrets.json and
 data.key out of C:\havoc9\data\h9web first. A backup made on the Linux host
 restores here the same way, and the other way round. A restore brings back
 the sessions the backup holds: after restoring past a security incident,
 sign those accounts out (h9web\README.txt section 10).


 10. MOVING TO ANOTHER HOST, IN ORDER
 ------------------------------------
   1. A day before: DNS TTL 300.
   2. The new host: steps 1 and 3. Do not run setup.ps1 yet.
   3. The old host: stop h9web so nothing changes from here on, and take a
      last backup with the keys, encrypted (on Linux: README-VPS.txt step 10;
      on Windows):
        Stop-Service havoc9-h9web
        C:\havoc9\tools\node\node.exe C:\havoc9\h9web\bin\h9web-backup.js --config C:\havoc9\etc\config.json backup --encrypt --with-keys --passphrase-file C:\havoc9\etc\backup-passphrase --out C:\setup\move
      and copy it over, with etc\servers.json and the list's
      data\serverlist\serverlist.cfg, servers.txt and serverlist.ini.
   4. The new host: put servers.json in C:\havoc9\etc and the list's three
      files in C:\havoc9\data\serverlist first (make the folders; setup.ps1
      keeps files that are there), then step 9's setup.ps1 -Restore.
   5. Point the A and AAAA records at the new host. Caddy gets the
      certificate there by itself once they have spread.
   6. Each game server's firewall lets the relay's address in
      (havoc9.org\webclient\DEPLOY.txt section 7): add the new address.
   7. Keep the old host stopped, with its data, for a few days; then wipe it.


 11. UPDATING TO A NEW PACKAGE
 -----------------------------
 Unpack the new havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip beside the old
 one and run its setup.cmd as administrator (or .\setup.ps1). It backs up the
 data first, stops the services, puts in the new code, site and tools, keeps
 every setting, key and all data, and starts the services again. A change to
 the database's layout runs at h9web's start, after one more copy into
 data\h9web\backups. Check with .\setup.ps1 -Check and the site. To go
 back: run the older package's setup.ps1, then restore the backup the newer
 one took first.


 12. THE WEB CLIENT (OPTIONAL)
 -----------------------------
 PLAY on the site runs the game in the browser. Its files (about 1.2 GB) are
 not in this package. Copy webclient-build\stage from the PC that builds it
 (export.bat makes it) to the host, then:
   .\setup.ps1 -WebClientStage C:\setup\stage
 or unzip havoc9-vps-webclient-<build>-<yyyyMMdd-HHmm>.zip
 (make-vps-package.ps1 -WebClient) and give its webclient-build\stage folder.
 Without it PLAY says the client is in preparation; everything else works.


 13. THE DOWNLOADS
 -----------------
 The DOWNLOADS page's buttons and its file index (ALL FILES,
 https://havoc9.org/downloads/files/) show files you put in the site folder
 yourself; setup.ps1 keeps them when it puts a new copy of the site in.
   C:\havoc9\site\downloads\         you copy in the buttons' files:
                                     H9XASH.zip, H9XASH-linux.zip,
                                     H9XASH-Updater.exe
   C:\havoc9\site\downloads\files\   you copy in the two host packages
                                     (havoc9-vps-linux- and
                                     havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip);
                                     setup.ps1 adds the buttons' three files
                                     and SHA256SUMS.txt (below)
 They come from dist\ in the repository on the PC that builds them:
 stage-h9xash.ps1 makes the two client ZIPs, tools\updater\build.cmd makes
 H9XASH-Updater.exe and make-vps-package.ps1 the two host packages. The
 .report.txt files made beside them stay off the index unless the owner
 chooses otherwise: they are the build PC's own records, and
 H9XASH.report.txt names its folders. Nothing else goes in the index:
 not dist\files (the updater's own files, served at /files/), not the web
 client's files, and never a config, key or token (ts_advertise.cfg,
 secrets.json, data.key, serverlist.cfg, config.json), a backup or anyone's
 data. Only .zip, .exe and .txt files are served there; any other file, a
 subfolder and every dot file is a 404.
 After new files go in (Remote Desktop copy and paste works), run in an
 administrator PowerShell in the unpacked package folder:
   .\setup.ps1 -FileIndex
 Every full run of setup.ps1 does the same. It makes the buttons' three
 files symbolic links in downloads\files, so the disk holds one copy and the
 index serves exactly the file the button does, whatever replaced it since;
 checks each link (its SHA-256 must be that of the file in downloads\: a
 difference is a [WARN] that says IS NOT THE SAME FILE); skips, saying so, a
 button file that is not there yet; and writes SHA256SUMS.txt for every
 file the index lists. To check by hand, in PowerShell:
   Get-ChildItem C:\havoc9\site\downloads\files | Format-Table Name, LinkType, Target
   Get-FileHash C:\havoc9\site\downloads\H9XASH.zip, C:\havoc9\site\downloads\files\H9XASH.zip
 (the same hash twice), and every line of SHA256SUMS.txt against its file:
   cd C:\havoc9\site\downloads\files
   Get-Content SHA256SUMS.txt | ForEach-Object { $h, $n = $_ -split '  ', 2; '{0}  {1}' -f $(if ((Get-FileHash $n).Hash -eq $h) { 'OK' } else { 'DIFFERENT' }), $n }
 Remove a host package's older build when its new one goes in. A player
 checks a download with sha256sum -c SHA256SUMS.txt --ignore-missing
 (Linux) or Get-FileHash <file> (Windows).


 14. WHEN SOMETHING IS WRONG
 ---------------------------
   .\setup.ps1 -Check                       what runs, what answers
   Get-Service havoc9-*                     the three services (and havoc9-p2p)
   C:\havoc9\logs                           their logs, a file a day
   Restart-Service havoc9-h9web             (or -serverlist, -caddy)
   * The site answers 502 on account pages: h9web is not running; its log
     says why (a bad edit of config.json is the usual cause).
   * 502 at /serverlist/: the list is not running (its log).
   * No certificate: step 5. Ports 80 and 443 taken: netstat -abno | findstr ":80 "
   * A service that will not start at all: Event Viewer, Windows Logs,
     System, and the service's .wrapper.log in C:\havoc9\logs.


 15. CHECKLIST
 -------------
   [ ] DNS: havoc9.org and www.havoc9.org answer this host's public address
   [ ] TCP 80 and 443 (and UDP 27015) reach the machine (router, provider)
   [ ] setup.ps1 finished without a [FAIL]; its warnings read
   [ ] https://havoc9.org/ opens with a padlock; http:// sends you there
   [ ] https://havoc9.org/api/me answers {"signedIn":false}
   [ ] https://havoc9.org/serverlist/v1/servers/ts answers
   [ ] secrets.json and data.key copied offline (step 6)
   [ ] the first admin account (step 6)
   [ ] servers.json and the list's servers.txt name the servers (step 7)
   [ ] the backup passphrase set and kept offline; offsite\ copied once
       (step 8)
   [ ] the downloads and their file index in place, SHA256SUMS.txt made
       (step 13)
   [ ] .\setup.ps1 -Check: the three services running
   [ ] only with the P2P relay (step 16): https://havoc9.org/api/p2p/v1/health
       answers {"ok":true,"v":1,...} and its UDP port reaches the machine


 16. THE P2P RELAY (OPTIONAL)
 ----------------------------
 What it is: a player who hosts a listen game at home can let friends in with
 no port forwarded (a one-use invite code), and may list the game on the
 site's SERVERS page (P2P GAMES). This host carries the rendezvous and relay
 service that makes that work. docs\P2P_HOSTING.txt of the repository is the
 whole guide (the three ways to host it, cost and risk); p2p\README.txt
 documents every setting. It needs one UDP port reachable on this machine's
 own address: Cloudflare cannot carry UDP, so the name players use for that
 port is DNS only (grey cloud), like the game servers' name. Off unless you ask.
 A game that a host lists publicly shows on the site's SERVERS page. It does
 NOT show in the game's own server browser (Find Servers); the guide says why
 and what that would need.

   a. DNS: a DNS-only name for the UDP port, for example play.havoc9.org (an A
      record to this host). It is the relay's publicUdp host. At home, the
      router forwards UDP 27248 to this machine (step 2).
   b. One of two ways to run it:

      In h9web (the way for havoc9.org: a host is a havoc9.org account and uses
      the link token its game holds; handing that token to the helper is not
      built yet, docs\P2P_HOSTING.txt section 10), in an administrator
      PowerShell:
        .\setup.ps1 -P2P module
      puts the code in C:\havoc9\p2p (beside h9web's, which is where the module
      looks) and opens UDP 27248 (-P2PPort for another). Then put in
      C:\havoc9\etc\config.json, and restart h9web (Restart-Service havoc9-h9web):
        "modules": ["forum", "discord", "presence", "p2p"],
        "moduleSettings": { "p2p": { "enabled": true,
          "publicUdp": { "host": "play.havoc9.org", "port": 27248 },
          "bind": { "udp": { "host": "0.0.0.0", "port": 27248 } } } }
      Hosts use the service address https://havoc9.org/api/p2p (the server
      setting h9_p2p_service). Cloudflare: the WAF skip rule that has
      /api/link/ gets /api/p2p/ too (docs\DEPLOY_CLOUDFLARE.txt, section 3).

      As a service of its own (its own people, its own host tokens):
        .\setup.ps1 -P2P standalone
      makes C:\havoc9\etc\p2p\relay.config.json and hosts.json from the
      examples, installs the havoc9-p2p service and leaves it stopped until
      they are finished (setup.ps1 says what is missing). Edit publicUdp.host,
      then make a token for each host:
        C:\havoc9\tools\node\node.exe C:\havoc9\p2p\bin\h9rv.js token Mike --hosts C:\havoc9\etc\p2p\hosts.json
      (the token is shown once; the file keeps its hash) and start it:
        Start-Service havoc9-p2p
      Its control plane listens on 127.0.0.1:28247: give it a name of its own
      behind Caddy, never the plain port on the Internet (invite codes would
      cross the network in clear). In C:\havoc9\etc\Caddyfile.extra:
        play.havoc9.org {
            reverse_proxy 127.0.0.1:28247
        }
      and the hosts use https://play.havoc9.org as h9_p2p_service.
   c. Check: https://havoc9.org/api/p2p/v1/health (the module) or
      http://127.0.0.1:28247/v1/health (standalone) answers {"ok":true,"v":1,...};
      .\setup.ps1 -Check shows the service.
   d. The relay keeps nothing on disk: a restart forgets the sessions and the
      hosts open again by themselves. Nothing to back up but etc\p2p.
   e. Risk, plainly: the UDP port is new attack surface on this machine's
      address. The relay answers only packets that carry a valid tag, so it is
      not a reflector and not an open relay; a flood of raw UDP is the
      provider's matter, as for the game ports. Relayed traffic costs
      bandwidth: about 50 to 300 kbit/s per player each way (an estimate).
