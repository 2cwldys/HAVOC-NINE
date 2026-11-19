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
echo -e "${CYN}   LM Studio  >>  Unload All Models${RST}"
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   Frees VRAM without stopping the server${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

if ! command -v lms &>/dev/null; then
    echo -e "${RED} [ERROR]${RST} lms CLI not found."
    echo "         Run ./install.sh first."
    pause
    exit 1
fi

echo -e "${WHT} Unloading all models...${RST}"
echo ""
if lms unload --all; then
    echo ""
    echo -e "${GRN}  OK${RST}     All models unloaded."
else
    echo ""
    echo -e "${YLW}  !!${RST}     lms unload --all returned an error."
    echo "         Models may already be unloaded, or no model was loaded."
fi

echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${WHT}  Server is still running on http://localhost:1234${RST}"
echo -e "${WHT}  To load a model again:  ./start-server.sh${RST}"
echo -e "${WHT}  To stop the server:     ./stop-server.sh${RST}"
echo -e "${CYN} =================================================${RST}"
pause
