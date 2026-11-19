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
echo -e "${CYN}   LM Studio  >>  Stop API Server${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

# Preferred: lms CLI
if command -v lms &>/dev/null; then
    MODEL_NAME_ENV=$(grep -i "^MODEL_NAME=" "$(dirname "$0")/.env" 2>/dev/null | cut -d= -f2-)
    if [ -n "$MODEL_NAME_ENV" ]; then
        echo -e "${WHT} Unloading model: $MODEL_NAME_ENV...${RST}"
        lms unload "$MODEL_NAME_ENV" &>/dev/null || true
        echo -e "${GRN}  OK${RST}     Model unloaded"
        echo ""
    fi

    echo -e "${WHT} Stopping server via lms CLI...${RST}"
    lms server stop &>/dev/null || true
    echo ""
fi

# Always kill llmster regardless of whether lms server stop succeeded
if pgrep -x llmster &>/dev/null; then
    echo -e "${WHT} Stopping llmster process...${RST}"
    if pkill -x llmster 2>/dev/null; then
        sleep 1
        # Force kill if still running
        if pgrep -x llmster &>/dev/null; then
            pkill -9 -x llmster 2>/dev/null || true
        fi
        echo -e "${GRN}  OK${RST}     llmster stopped."
    else
        echo -e "${RED}  !!${RST}     Could not kill llmster -- try running with sudo."
    fi
else
    echo -e "${YLW}  --${RST}     llmster was not running."
fi

# Port fallback -- kill anything still on 1234
PID=""
if command -v lsof &>/dev/null; then
    PID=$(lsof -ti tcp:1234 2>/dev/null | head -1)
elif command -v ss &>/dev/null; then
    PID=$(ss -tlnp 2>/dev/null | awk '/:1234 /{match($0,/pid=([0-9]+)/,a); if(a[1]) print a[1]}' | head -1)
elif command -v fuser &>/dev/null; then
    PID=$(fuser 1234/tcp 2>/dev/null | awk '{print $1}')
fi

if [ -n "$PID" ]; then
    echo ""
    echo -e "${WHT} Process still on port 1234 [PID $PID] -- killing...${RST}"
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
    echo -e "${GRN}  OK${RST}     Port 1234 freed."
fi

echo ""
echo -e "${GRN}  OK${RST}     Server fully stopped."
pause
