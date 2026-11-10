===============================================================================
 HAVOC9.ORG ON A VPS -- STEP BY STEP
===============================================================================

 This package puts the whole of havoc9.org on one Linux VPS: the site, h9web
 (accounts, forum, communities, the web client's relay), the H9 server list
 the game's Internet tab reads, nginx with a Let's Encrypt certificate, the
 firewall and the daily backups. Every step below can be done by hand from
 this file alone; setup.sh does steps 4 to 6 in one go and is safe to run
 again at any time.

 Everything goes through the domain: players, game clients and the site use
 https://havoc9.org/ whatever the VPS's IP address is, so moving to another
 VPS later only means pointing DNS at the new one (step 10).

 Nothing in this package is secret. The secrets are made on the VPS (h9web's
 secrets.json and data.key) or typed in there (the list's Discord token and
 heartbeat key, the backup passphrase), and never go into the package or git.

 CONTENTS
    0. What is in the package
    1. What you need
    2. DNS
    3. The VPS: first login, copying the package over
    4. setup.sh
    5. The certificate
    6. First start: the keys, the first admin
    7. The game servers and the server list
    8. Backups
    9. Restoring a backup on a new VPS
   10. Moving to another VPS, in order
   11. Updating to a new package
   12. The web client (optional)
   13. The downloads
   14. When something is wrong
   15. Checklist


 0. WHAT IS IN THE PACKAGE
 -------------------------
   README-VPS.txt       this file
   setup.sh             installs or updates everything (step 4)
   (for a Windows host: havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip and
   its README-WINDOWS.txt instead of this package)
   BUILD.txt            the build this package was made from
   systemd/             the services: h9web.service, h9-serverlist.service,
                        h9web-backup.service/.timer (daily),
                        h9web-backup-offsite.service/.timer (encrypted, daily)
   hardening/           SSH (keys only), log retention (30 days), automatic
                        security updates
   h9web/               h9web's code; its guide is h9web/README.txt
   havoc9.org/          the site; havoc9.org/deploy/ holds the nginx and
                        certificate scripts setup.sh runs
                        (havoc9.org/webclient/DEPLOY.txt explains them)
   serverlist-bot/      the H9 server list (serverlist-bot/README.md)

 Where things go on the VPS:
   /opt/h9web                 h9web's code (root's)
   /etc/h9web                 config.json, servers.json, backup-passphrase
   /var/lib/h9web             h9web's data: h9web.db, secrets.json, data.key,
                              modules/ (pictures, presence keys), backups/,
                              offsite/ (the h9web user's only)
   /opt/h9-serverlist         the list's code and its Python packages
   /var/lib/h9-serverlist     the list's serverlist.ini, serverlist.cfg (the
                              Discord token and heartbeat key), servers.txt,
                              serverlist.log (the h9list user's only)
   /var/www/havoc9.org        the site
   /var/www/havoc9.org/downloads   the downloads and their file index
                              (step 13)
   /srv/h9web/game            the web client's game files (step 12)


 1. WHAT YOU NEED
 ----------------
   * A VPS with Debian 12 (or newer) or Ubuntu 22.04 / 24.04, 1 GB of memory
     or more, 10 GB of disk (25 GB with the web client), a public IPv4
     address (IPv6 as well is good). Turn on the provider's disk encryption
     where it has one.
   * The domain havoc9.org at its registrar, where you can edit its DNS.
   * An SSH key on your own PC (Windows: ssh-keygen in PowerShell makes
     C:\Users\<you>\.ssh\id_ed25519 and id_ed25519.pub). Give the .pub file
     to the provider when you create the VPS, so you sign in with the key.
   * This package, havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip, and on your
     PC the offline copies of secrets.json, data.key and the backup
     passphrase if this is a move or a restore.


 2. DNS
 ------
 At the registrar, for havoc9.org:
   A      havoc9.org        <the VPS's IPv4 address>
   A      www.havoc9.org    <the VPS's IPv4 address>
   AAAA   havoc9.org        <the VPS's IPv6 address>     (only if it has one)
   AAAA   www.havoc9.org    <the VPS's IPv6 address>     (only if it has one)
 Remove any other A or AAAA records for those two names. A TTL of 300 (five
 minutes) makes a later move quick. Check from your PC that it has spread:
   nslookup havoc9.org            (Windows)
   dig +short havoc9.org A        (Linux)
 It must answer the VPS's address before the certificate can be made (step
 5). Until then setup.sh can run with --no-tls.


 3. THE VPS: FIRST LOGIN, COPYING THE PACKAGE OVER
 -------------------------------------------------
 From your PC (PowerShell or a terminal):
   ssh root@<the VPS's address>
 (or the user the provider made, then sudo -i). If the provider gave a
 password instead of using your key, put your key on first:
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<address> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
 Then copy the package over and unpack it:
   scp havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip root@<address>:/root/
   ssh root@<address>
   apt-get update && apt-get install -y unzip
   cd /root && unzip havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip
   cd havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>


 4. SETUP.SH
 -----------
   sudo bash setup.sh                 a new site (no backup to restore)
   sudo bash setup.sh --no-tls        the same, but no nginx or certificate yet
                                      (DNS not there); run it again later
   sudo bash setup.sh --file-index    only the downloads' file index (step 13)
 For a restore or a move, use step 9 instead: h9web must not start before
 the old keys are in place.

 What it does, in order (each step is safe to repeat):
   1. installs the system packages (nginx, ufw, rsync, Python, curl ...);
   2. installs Node.js 24 from NodeSource when /usr/bin/node is older;
   3. makes the h9web and h9list service users and their folders (section 0);
   4. copies h9web's code to /opt/h9web, and makes /etc/h9web/config.json
      from config.example.json and an empty servers.json when there are none
      (an existing one is never touched). Before it updates a running
      h9web it takes a backup;
   5. copies the server list to /opt/h9-serverlist with its Python packages,
      and makes its settings in /var/lib/h9-serverlist when there are none;
   6. copies the site to /var/www/havoc9.org (the downloads, their file
      index and H9XASH-Updater's files/ there are kept), then links the
      downloads into the file index and writes its SHA256SUMS.txt (step 13);
   7. (only with --restore or --keys, step 9) puts the keys in place and
      restores the backup;
   8. installs the services and starts h9web, the list and the backup timer;
   9. keeps logs 30 days, turns on automatic security updates, and turns SSH
      passwords off once an SSH key can sign in (HARDEN_SSH=0 skips that);
  10. turns the firewall on: SSH, 80 and 443, and the game ports
      (GAME_PORTS="27015/udp 27016/udp" for more; without it, H9XASH_DIR
      names the H9XASH folder whose networking.ini port= under [server] is
      the game server's port, 27015 when there is none; UFW=0 skips it);
  11. runs havoc9.org/deploy/nginx-setup.sh: the certificate (step 5) and
      the nginx site, with the security headers, the rate limits and the
      rules that hide scripts and backups, then checks it from outside.
 It ends with a list of warnings, if there were any. To see the state later:
   sudo bash setup.sh --check


 5. THE CERTIFICATE
 ------------------
 setup.sh's step 11 makes it the first time, with havoc9.org/deploy/
 https-setup.sh: a test certificate from Let's Encrypt's staging service
 first (a mistake there costs nothing), then the real one, for havoc9.org and
 www.havoc9.org. It renews by itself (certbot's timer) and nginx reloads after
 each renewal. To do it by hand:
   cd havoc9.org/deploy
   sudo bash https-setup.sh                  the test one
   sudo STAGING=0 bash https-setup.sh        the real one
   sudo bash nginx-setup.sh                  the site's nginx
 If it fails: DNS does not point at this VPS yet (step 2), or port 80 is
 closed at the provider's own firewall (open 80 and 443 there too).
 sudo certbot certificates shows when it runs out.


 6. FIRST START: THE KEYS, THE FIRST ADMIN
 -----------------------------------------
 On its first start h9web makes /var/lib/h9web/secrets.json (every password
 and player id depends on it) and data.key (it seals the Discord links).
 setup.sh warns when it has just made them. Copy both to your PC NOW and keep
 them offline (a password manager or an encrypted USB stick), apart from the
 backups:
   sudo cat /var/lib/h9web/secrets.json
   sudo cat /var/lib/h9web/data.key
 Losing secrets.json loses every account's password. They never change after
 this, so once is enough.

 The first admin: open https://havoc9.org/, CREATE ACCOUNT, then on the VPS
   A="sudo -u h9web /usr/bin/node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json"
   $A set-role <your username> admin
 Every other admin job: docs/H9WEB_ADMIN.txt in the repository (section 3
 onwards), or h9web/README.txt section 11.

 Settings: /etc/h9web/config.json (h9web/README.txt section 7; every key has
 a default in h9web/lib/config.js). After an edit: sudo systemctl restart h9web.
 Discord linking needs moduleSettings.discord and its secrets file
 (h9web/README.txt section 18); without them the rest works.


 7. THE GAME SERVERS AND THE SERVER LIST
 ---------------------------------------
 Two lists, for two kinds of players:
   * /etc/h9web/servers.json: the servers the web client may join through
     the relay and the site's SERVERS page shows (h9web/README.txt section
     6). It is read again within 2 seconds of an edit.
   * The H9 server list: what the downloaded game's Internet tab shows. The
     game asks https://havoc9.org/serverlist (networking.ini's list_bot);
     nginx passes that to the h9-serverlist service on 127.0.0.1:8081.
     Servers get on it from /var/lib/h9-serverlist/servers.txt (one
     host:port per line; it ships with havoc9.org:27015, a game server on
     this VPS), from Discord (/addserver), or by a heartbeat. Each is listed
     only while it answers.
 The list's secrets, in /var/lib/h9-serverlist/serverlist.cfg:
   sudo -u h9list nano /var/lib/h9-serverlist/serverlist.cfg
     heartbeat_key = <a long random string, the same on every server that sends heartbeats>
     discord_token = <the bot token, only for the Discord commands>
   sudo systemctl restart h9-serverlist
 Its settings: /var/lib/h9-serverlist/serverlist.ini (serverlist-bot/
 README.md). Check it: curl https://havoc9.org/serverlist/v1/servers/ts
 A game server on this VPS needs its UDP port open: GAME_PORTS for setup.sh,
 or sudo ufw allow 27015/udp. Each game server's own settings for the web
 client's players: havoc9.org/webclient/DEPLOY.txt section 7.


 8. BACKUPS
 ----------
 Daily, by the h9web-backup timer: the database, the forum's pictures and the
 presence keys into /var/lib/h9web/backups, the newest 14 kept. By hand:
   B="sudo -u h9web /usr/bin/node /opt/h9web/bin/h9web-backup.js --config /etc/h9web/config.json"
   $B backup              a backup now
   $B list                the backups, each checked
   $B verify <file>       one checked through
 Copies off the VPS are encrypted. Make the passphrase file once (12
 characters or more, on one line), and keep the passphrase offline with
 the keys:
   sudo install -m 600 -o h9web -g h9web /dev/null /etc/h9web/backup-passphrase
   sudo nano /etc/h9web/backup-passphrase
   sudo bash setup.sh                      (turns on the encrypted timer)
 From then on /var/lib/h9web/offsite gets an encrypted backup every day (7
 kept). Each one holds secrets.json and data.key as well, sealed with the
 passphrase, so a copy and the passphrase are all a new VPS needs (step 9).
 Copy that folder to your PC or to storage of your own now and then,
 for example from your PC:
   scp -r root@havoc9.org:/var/lib/h9web/offsite ./h9web-offsite
 Never copy the whole of /var/lib/h9web off the VPS (it holds the keys).
 Every option: h9web/README.txt section 10; for admins docs/H9WEB_ADMIN.txt
 section 18; the timers: havoc9.org/webclient/DEPLOY.txt section 13.


 9. RESTORING A BACKUP ON A NEW VPS
 ----------------------------------
 You need: the newest .h9backup (an encrypted one from offsite/ is fine), the
 old secrets.json and data.key (unless the backup was made --with-keys), and
 the passphrase for an encrypted backup. On the new VPS, after steps 2 and 3:
   mkdir -p /root/h9keys && chmod 700 /root/h9keys
   (copy secrets.json and data.key into /root/h9keys, and the backup and, for
    an encrypted one, a file with the passphrase into /root)
   sudo bash setup.sh --restore /root/<file>.h9backup --keys /root/h9keys \
        --passphrase-file /root/backup-passphrase.txt
 (no --passphrase-file for a plain backup; no --keys for one that holds the
 keys, as every copy from offsite/ does). setup.sh puts the keys in place, checks the backup, restores it
 and only then starts h9web. The restore refuses a secrets.json other than
 the backup's: every password would fail. Then delete /root/h9keys and the
 passphrase file, and sign in with an existing account to check.
 If h9web was started on this VPS before (it made new keys), move those away
 first: sudo systemctl stop h9web; sudo mkdir /root/new-keys;
 sudo mv /var/lib/h9web/secrets.json /var/lib/h9web/data.key /root/new-keys/
 By hand instead of setup.sh: havoc9.org/webclient/DEPLOY.txt section 13C.
 A restore brings back the sessions the backup holds: after restoring past a
 security incident, sign those accounts out (h9web/README.txt section 10).


 10. MOVING TO ANOTHER VPS, IN ORDER
 -----------------------------------
   1. A day before: DNS TTL 300 (step 2).
   2. The new VPS: steps 1 and 3 there, the package copied over. Do not run
      setup.sh yet.
   3. The old VPS: stop h9web, so nothing changes from here on, and take a
      last backup:
        sudo systemctl stop h9web
        sudo -u h9web /usr/bin/node /opt/h9web/bin/h9web-backup.js --config /etc/h9web/config.json backup --out /var/lib/h9web/move
      and copy it, with /etc/h9web/config.json and servers.json and the
      list's /var/lib/h9-serverlist/serverlist.cfg, servers.txt and
      serverlist.ini, to the new VPS (scp through your PC).
   4. The new VPS: put config.json and servers.json in /etc/h9web and the
      list's three files in /var/lib/h9-serverlist first (sudo mkdir -p each;
      setup.sh keeps files that are there and fixes their owners), then
        sudo bash setup.sh --no-tls --restore /root/<file>.h9backup --keys /root/h9keys
      and check it from the VPS: curl -s http://127.0.0.1:8090/api/me
   5. Point the A and AAAA records at the new VPS (step 2), wait until
      nslookup havoc9.org answers the new address, then on the new VPS
        sudo bash setup.sh            (the certificate and nginx now)
   6. Each game server's firewall lets the relay's address in (DEPLOY.txt
      section 7): add the new VPS's address. The presence keys came with the
      backup, so the game servers go on reporting as they did.
   7. Keep the old VPS stopped, with its data, for a few days; then delete it.


 11. UPDATING TO A NEW PACKAGE
 -----------------------------
 Copy the new havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip over, unpack it
 beside the old one and run its setup.sh:
   cd /root && unzip havoc9-vps-linux-<new build>-<yyyyMMdd-HHmm>.zip
   cd havoc9-vps-linux-<new build>-<yyyyMMdd-HHmm>
   sudo bash setup.sh
 It backs up the data first, puts in the new code, site and services, keeps
 every setting, key and all data, and restarts h9web and the list. A change
 to the database's layout runs at h9web's start, after one more copy into
 /var/lib/h9web/backups. Check with sudo bash setup.sh --check and the site.
 To go back: run the older package's setup.sh, then restore the backup it
 took first ($B list shows it).


 12. THE WEB CLIENT (OPTIONAL)
 -----------------------------
 PLAY on the site runs the game in the browser. Its files (about 1.2 GB) are
 not in this package. Two ways to put them on the VPS:
   * From a clone of the public repository on the VPS (no upload from your
     PC):
       sudo apt-get install -y git git-lfs python3
       git clone https://github.com/2cwldys/HAVOC-NINE.git /root/h9
       cd /root/h9/havoc9.org/deploy
       sudo REPACK=1 bash webclient-setup.sh
   * From your PC: make-vps-package.ps1 -WebClient also writes
     havoc9-vps-webclient-<build>-<yyyyMMdd-HHmm>.zip, with one folder of
     its own around tools/ and webclient-build/. Copy it over like the
     package. webclient-setup.sh looks for those two folders beside
     havoc9.org/ in the unpacked package folder, so put them there:
       cd /root/havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>
       W=/root/havoc9-vps-webclient-<build>-<yyyyMMdd-HHmm>
       unzip $W.zip -d /root
       cp -r $W/tools $W/webclient-build .
       cd havoc9.org/deploy && sudo bash webclient-setup.sh
 Without them PLAY says the client is in preparation; everything else works.
 havoc9.org/webclient/DEPLOY.txt sections 3 to 5 explain the build.


 13. THE DOWNLOADS
 -----------------
 The DOWNLOADS page's buttons and its file index (ALL FILES,
 https://havoc9.org/downloads/files/) show files you put in the site folder
 yourself; setup.sh keeps them when it puts a new copy of the site in.
   /var/www/havoc9.org/downloads/         you copy in the buttons' files:
                                          H9XASH.zip, H9XASH-linux.zip,
                                          H9XASH-Updater.exe
   /var/www/havoc9.org/downloads/files/   you copy in the two host packages
                                          (havoc9-vps-linux- and
                                          havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip);
                                          setup.sh adds the buttons' three
                                          files and SHA256SUMS.txt (below)
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
 From your PC, in the repository's folder (each file goes up once):
   scp dist\H9XASH.zip dist\H9XASH-linux.zip dist\H9XASH-Updater.exe root@havoc9.org:/var/www/havoc9.org/downloads/
   scp dist\havoc9-vps-linux-<build>-<yyyyMMdd-HHmm>.zip root@havoc9.org:/var/www/havoc9.org/downloads/files/
   scp dist\havoc9-vps-windows-<build>-<yyyyMMdd-HHmm>.zip root@havoc9.org:/var/www/havoc9.org/downloads/files/
 then on the VPS, in the unpacked package folder:
   sudo bash setup.sh --file-index
 Every full run of setup.sh does the same. It links the buttons' three
 files into downloads/files (../<name>), so the disk holds one copy and the
 index serves exactly the file the button does, whatever replaced it since;
 checks each link (its SHA-256 must be that of the file in downloads/: a
 difference is a [WARN] that says IS NOT THE SAME FILE); skips, saying so, a
 button file that is not there yet; and writes SHA256SUMS.txt for every
 file the index lists. To check by hand:
   ls -l /var/www/havoc9.org/downloads/files
   sha256sum /var/www/havoc9.org/downloads/H9XASH.zip /var/www/havoc9.org/downloads/files/H9XASH.zip
 (the same hash twice), and every line of SHA256SUMS.txt against its file:
   cd /var/www/havoc9.org/downloads/files && sha256sum -c SHA256SUMS.txt
 Remove a host package's older build when its new one goes in. A player
 checks a download with sha256sum -c SHA256SUMS.txt --ignore-missing
 (Linux) or Get-FileHash <file> (Windows).


 14. WHEN SOMETHING IS WRONG
 ---------------------------
   sudo bash setup.sh --check                   what runs, what answers
   sudo systemctl status h9web h9-serverlist nginx
   sudo journalctl -u h9web -n 100              h9web's log
   sudo journalctl -u h9-serverlist -n 100      the list's log
   sudo nginx -t                                the nginx config
   sudo tail -n 50 /var/log/nginx/error.log
   * 502 Bad Gateway on the site's account pages: h9web is not running
     (its log says why; a bad edit of config.json is the usual cause).
   * 502 at /serverlist/: the list is not running (its log), or its port is
     not 8081 in serverlist.ini.
   * The certificate: step 5. Locked out of SSH: the provider's web console,
     then rm /etc/ssh/sshd_config.d/05-havoc9.conf and systemctl reload ssh.


 15. CHECKLIST
 -------------
   [ ] DNS: havoc9.org and www.havoc9.org answer the VPS's address
   [ ] sudo bash setup.sh finished without a [FAIL]; its warnings read
   [ ] https://havoc9.org/ opens with a padlock; http:// sends you there
   [ ] curl -s https://havoc9.org/api/me answers {"signedIn":false}
   [ ] curl -s https://havoc9.org/serverlist/v1/servers/ts answers (a comment
       line, then one "ip" line per server that is up)
   [ ] secrets.json and data.key copied offline (step 6)
   [ ] the first admin account (step 6)
   [ ] /etc/h9web/servers.json and the list's servers.txt name the servers
   [ ] the list's heartbeat key (and Discord token) set (step 7)
   [ ] the backup passphrase set and kept offline; offsite/ copied once
       (step 8)
   [ ] a game server here: its UDP port open (step 7)
   [ ] the downloads and their file index in place, SHA256SUMS.txt made
       (step 13)
   [ ] sudo bash setup.sh --check: every service running
