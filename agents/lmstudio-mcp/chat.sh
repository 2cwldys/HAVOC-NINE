#!/usr/bin/env bash
cd "$(dirname "$0")"

GRN='\033[0;32m'
YLW='\033[1;33m'
RED='\033[0;31m'
WHT='\033[1;37m'
RST='\033[0m'

if ! command -v node &>/dev/null; then
    echo ""
    echo " [ERROR] Node.js not found. Install from https://nodejs.org"
    echo ""
    exit 1
fi

if [ ! -d "node_modules/@modelcontextprotocol" ]; then
    echo ""
    echo " [ERROR] Dependencies not installed. Run ./install.sh first."
    echo ""
    exit 1
fi

# Ensure the model is loaded before starting chat
if command -v lms &>/dev/null; then
    # Auto-import any .gguf files in the local models dir so lms knows them
    LOCAL_MDIR="$(dirname "$0")/models"
    if [ -d "$LOCAL_MDIR" ]; then
        find "$LOCAL_MDIR" -name "*.gguf" 2>/dev/null | while read -r gguf; do
            lms import "$gguf" &>/dev/null || true
        done
    fi

    MODEL_NAME_ENV=$(grep -i "^MODEL_NAME=" "$(dirname "$0")/.env" 2>/dev/null | cut -d= -f2-)
    if [ -n "$MODEL_NAME_ENV" ]; then
        echo -e "${WHT} Loading model: $MODEL_NAME_ENV...${RST}"
        echo " (this may take a moment)"
        echo ""
        if echo "" | lms load "$MODEL_NAME_ENV"; then
            echo -e "${GRN}  OK${RST}     Model ready"
            echo ""
        else
            echo ""
            echo -e "${RED} [ERROR]${RST} Could not load \"$MODEL_NAME_ENV\" -- it is not downloaded yet."
            echo ""
            echo "  To fix:"
            echo "    1. Run:  npm run setup"
            echo "       Setup will offer to download a model for you."
            echo ""
            echo "    Or if you downloaded it manually to agents/lmstudio-mcp/models/:"
            echo "    2. Re-run chat.sh -- it will auto-import from the local folder."
            echo ""
            exit 1
        fi
    fi
fi

node chat.js
