#!/usr/bin/env bash

GRN='\033[0;32m'
YLW='\033[1;33m'
CYN='\033[0;36m'
WHT='\033[1;37m'
RST='\033[0m'

pause() {
    echo ""
    read -rp " Press Enter to close... " -n1 _ 2>/dev/null || true
    echo ""
}

CURRENT="$(dirname "$0")/context/CURRENT.md"

echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   LM Studio  >>  Clear Working Context${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

if [ ! -f "$CURRENT" ]; then
    echo -e "${YLW}  --   No working context file found.${RST}"
    echo "        Nothing to clear."
    pause
    exit 0
fi

rm "$CURRENT"
echo -e "${GRN}  OK   Working context cleared.${RST}"
echo ""
echo -e "${WHT}  The local model will no longer include session context${RST}"
echo -e "${WHT}  in queries until Claude starts a new task.${RST}"
pause
