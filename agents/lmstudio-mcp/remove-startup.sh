#!/usr/bin/env bash

GRN='\033[0;32m'
YLW='\033[1;33m'
CYN='\033[0;36m'
RED='\033[0;31m'
WHT='\033[1;37m'
RST='\033[0m'

pause() {
    echo ""
    read -rp " Press Enter to close... " -n1 _ 2>/dev/null || true
    echo ""
}

echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   LM Studio  >>  Remove Startup Task${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

ENTRY="lms server start --port 1234"

if ! crontab -l 2>/dev/null | grep -qF "$ENTRY"; then
    echo -e "${YLW} [NOTE]${RST}  No LM Studio startup entry found in crontab."
    echo "         Nothing to remove -- you're already clean."
    pause
    exit 0
fi

echo -e "${WHT} Removing startup entry from crontab...${RST}"
echo ""

crontab -l 2>/dev/null | grep -vF "$ENTRY" | crontab -

if crontab -l 2>/dev/null | grep -qF "$ENTRY"; then
    echo -e "${RED} [ERROR]${RST} Could not remove the cron entry."
    echo "         Try running:  crontab -e  and removing the lms line manually."
    pause
    exit 1
fi

echo -e "${GRN} [OK]${RST}    Startup entry removed."
echo ""
echo -e "${WHT} LM Studio will no longer start automatically on login.${RST}"
echo ""
echo -e "${CYN} To start the server manually when you need it, run:${RST}"
echo ""
echo -e "${WHT}    ./start-server.sh${RST}"
pause
