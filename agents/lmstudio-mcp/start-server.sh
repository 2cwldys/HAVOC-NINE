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
echo -e "${CYN}   LM Studio  >>  Start API Server${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

if command -v lms &>/dev/null; then
    # Check if llmster is already running
    if pgrep -x llmster &>/dev/null; then
        echo -e "${YLW} [NOTE]${RST}  LM Studio backend (llmster) is already running."
        echo ""
    else
        echo -e "${WHT} Starting LM Studio API server on port 1234...${RST}"
        echo ""
        lms server start --port 1234
        if [ $? -ne 0 ]; then
            echo ""
            echo -e "${YLW} [NOTE]${RST}  Server may already be running."
        else
            echo -e "${GRN}  OK${RST}     llmster started -- server on http://localhost:1234"
        fi
        echo ""
    fi

    # Auto-import any .gguf files in the local models dir so lms knows them
    LOCAL_MDIR="$(dirname "$0")/models"
    if [ -d "$LOCAL_MDIR" ]; then
        find "$LOCAL_MDIR" -name "*.gguf" 2>/dev/null | while read -r gguf; do
            lms import "$gguf" &>/dev/null || true
        done
    fi

    # Load the model from .env (interactive if model not found -- lets user pick)
    MODEL_NAME_ENV=$(grep -i "^MODEL_NAME=" "$(dirname "$0")/.env" 2>/dev/null | cut -d= -f2-)
    if [ -n "$MODEL_NAME_ENV" ]; then
        echo -e "${WHT} Loading model: $MODEL_NAME_ENV...${RST}"
        if lms load "$MODEL_NAME_ENV"; then
            echo -e "${GRN}  OK${RST}     Model ready"
        else
            echo ""
            echo -e "${RED} [ERROR]${RST} Model \"$MODEL_NAME_ENV\" is not downloaded."
            echo -e "${WHT}         Run setup to download it:  npm run setup${RST}"
        fi
    fi

    echo ""
    echo -e "${WHT} Claude Code will connect automatically when the project is open.${RST}"
    pause
    exit 0
fi

# lms CLI not found -- try GUI fallback
echo -e "${YLW} [NOTE]${RST}  lms CLI not found. Trying to launch LM Studio GUI..."
echo ""

FOUND=""
for p in \
    "$HOME/Applications/LM Studio.AppImage" \
    "/Applications/LM Studio.app" \
    "$HOME/.local/share/applications/lmstudio" \
    "/usr/local/bin/lmstudio"
do
    if [ -e "$p" ]; then
        FOUND="$p"
        break
    fi
done

if [ -z "$FOUND" ]; then
    echo -e "${RED} [ERROR]${RST} LM Studio not found on this machine."
    echo ""
    echo -e "${WHT} Run ./install.sh to download and set everything up automatically.${RST}"
    pause
    exit 1
fi

echo -e "${GRN} [OK]${RST}    Opening LM Studio from: $FOUND"
echo ""

if [[ "$FOUND" == *.AppImage ]]; then
    chmod +x "$FOUND"
    "$FOUND" &
elif [[ "$FOUND" == *.app ]]; then
    open "$FOUND"
else
    "$FOUND" &
fi

echo -e "${WHT} In LM Studio:${RST}"
echo ""
echo "   1. Click the Developer icon in the left sidebar"
echo "   2. Click  Start Server"
echo "   3. Go to My Models tab and load a model"
echo ""
echo -e "${WHT} Then open VS Code and type /mcp in Claude Code.${RST}"
pause
