#!/usr/bin/env bash
set -e

GRN='\033[0;32m'
YLW='\033[1;33m'
CYN='\033[0;36m'
RED='\033[0;31m'
WHT='\033[1;37m'
RST='\033[0m'

# Kill llmster if the install is interrupted (Ctrl+C, kill signal, etc.)
# Does NOT fire on normal exit so the server stays up after a successful install.
_cleanup_llmster() {
    echo ""
    echo -e "${YLW} [cleanup]${RST} Install interrupted -- stopping llmster..."
    pkill -x llmster 2>/dev/null || true
}
trap '_cleanup_llmster' INT TERM

pause() {
    echo ""
    read -rp " Press Enter to close... " -n1 _ 2>/dev/null || true
    echo ""
}

echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   HAVOC 9  >>  LM Studio Agent Installer${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""

# -------------------------------------------------------
# Step 1 -- Check Node.js
# -------------------------------------------------------
echo -e "${WHT} [1/5] Checking Node.js...${RST}"

if ! command -v node &>/dev/null; then
    echo ""
    echo -e "${RED} [ERROR]${RST} Node.js is not installed."
    echo ""
    echo -e "${WHT}         Install from: https://nodejs.org${RST}"
    echo "         Or via package manager:"
    echo "           Ubuntu/Debian:  sudo apt install nodejs npm"
    echo "           Mac (Homebrew): brew install node"
    pause
    exit 1
fi
echo -e "${GRN}  OK${RST}     Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
    echo -e "${RED} [ERROR]${RST} npm not found. Reinstall Node.js from https://nodejs.org"
    pause
    exit 1
fi
echo -e "${GRN}  OK${RST}     npm found"

# -------------------------------------------------------
# Step 2 -- Check / Install LM Studio
# -------------------------------------------------------
echo ""
echo -e "${WHT} [2/5] Checking LM Studio...${RST}"

LMS_FOUND=0

if command -v lms &>/dev/null; then
    echo -e "${GRN}  OK${RST}     LM Studio CLI (lms) is installed"
    LMS_FOUND=1
fi

if [ "$LMS_FOUND" -eq 0 ]; then
    for p in \
        "$HOME/Applications/LM Studio.AppImage" \
        "/Applications/LM Studio.app" \
        "$HOME/.local/share/applications/lmstudio" \
        "/usr/local/bin/lmstudio"
    do
        if [ -e "$p" ]; then
            echo -e "${GRN}  OK${RST}     LM Studio found at $p"
            LMS_FOUND=1
            break
        fi
    done
fi

if [ "$LMS_FOUND" -eq 0 ]; then
    echo ""
    echo -e "${YLW}  --${RST}     LM Studio is not installed."
    echo ""
    echo -e "         This step would download and run the official installer from"
    echo -e "           ${WHT}https://lmstudio.ai/install.sh${RST}"
    echo -e "         LM Studio is third-party software. It is NOT part of HAVOC 9 and is not"
    echo -e "         distributed with it. Installing it means accepting its own terms:"
    echo -e "           ${WHT}https://lmstudio.ai/app-terms${RST}"
    echo ""
    echo -e "         Say n and this installer still finishes: the bridge and the H9 tools work,"
    echo -e "         and you can install LM Studio yourself whenever you like."
    echo ""
    read -rp "$(echo -e " Download and install LM Studio now? (y/N): ")" lms_yn
    if [ "${lms_yn}" != "y" ] && [ "${lms_yn}" != "Y" ]; then
        echo ""
        echo -e "${YLW}  --${RST}     Skipped. Install it from https://lmstudio.ai when you want it, then run"
        echo -e "         ./start-server.sh. Nothing else here depends on it."
        echo ""
        LMS_SKIPPED=1
    elif ! curl -fsSL https://lmstudio.ai/install.sh | bash; then
        echo ""
        echo -e "${RED} [ERROR]${RST} LM Studio installation failed."
        echo -e "${WHT}         Try installing manually from https://lmstudio.ai${RST}"
        pause
        exit 1
    fi
    if [ "${LMS_SKIPPED:-0}" -eq 0 ]; then
        echo ""
        echo -e "${GRN}  OK${RST}     LM Studio installed"
    fi
fi

# -------------------------------------------------------
# Step 3 -- Install Node dependencies
# -------------------------------------------------------
echo ""
echo -e "${WHT} [3/5] Installing Node.js dependencies...${RST}"
echo ""
cd "$(dirname "$0")"
npm install
echo ""
echo -e "${GRN}  OK${RST}     Dependencies installed"

# -------------------------------------------------------
# Step 4 -- Run setup wizard
# -------------------------------------------------------
echo ""
echo -e "${WHT} [4/5] Setup wizard -- configure your model...${RST}"
echo ""
npm run setup || true

# -------------------------------------------------------
# Step 5 -- Startup task (ask first)
# -------------------------------------------------------
echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   Auto-Startup (Optional)${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""
echo -e "${WHT} Would you like the LM Studio server to start automatically${RST}"
echo -e "${WHT} each time you log in?${RST}"
echo ""
echo -e "${YLW}  Y  = Register a startup cron job (recommended -- server is always ready)${RST}"
echo -e "${YLW}  N  = Skip it (run ./start-server.sh manually after each restart)${RST}"
echo ""

read -rp "$(echo -e " Your choice (y/N): ")" yn
yn_lower=$(echo "$yn" | tr '[:upper:]' '[:lower:]')

if [ "$yn_lower" = "y" ]; then
    if command -v lms &>/dev/null; then
        ENTRY="@reboot lms server start --port 1234"
        if crontab -l 2>/dev/null | grep -qF "lms server start"; then
            echo ""
            echo -e "${YLW}  --${RST}    Startup entry already exists in crontab -- skipping."
        else
            (crontab -l 2>/dev/null || true; echo "$ENTRY") | crontab -
            echo ""
            echo -e "${GRN}  OK${RST}     Startup cron job registered -- server will auto-start on login."
            echo -e "         To remove it later, run: ${WHT}./remove-startup.sh${RST}"
        fi
    else
        echo ""
        echo -e "${YLW}  --${RST}    lms CLI not on PATH -- cannot register startup job."
        echo "         Open LM Studio manually to start the server."
    fi
else
    echo ""
    echo -e "${YLW}  --${RST}    Startup task skipped."
    echo -e "         Run ${WHT}./start-server.sh${RST} after each restart to start the server."
fi

# -------------------------------------------------------
# Step 6 -- Start server then load the chosen model
# -------------------------------------------------------
echo ""
echo -e "${WHT} [5/5] Starting LM Studio API server...${RST}"
echo ""
if command -v lms &>/dev/null; then
    lms server start --port 1234
    if [ $? -ne 0 ]; then
        echo -e "${YLW} [NOTE]${RST}  Server may already be running -- continuing."
    else
        echo ""
        echo -e "${GRN}  OK${RST}     LM Studio server running on http://localhost:1234"
    fi

    MODEL_NAME_ENV=$(grep -i "^MODEL_NAME=" "$(dirname "$0")/.env" 2>/dev/null | cut -d= -f2-)
    if [ -n "$MODEL_NAME_ENV" ]; then
        echo ""
        echo -e "${WHT} Loading model: $MODEL_NAME_ENV...${RST}"
        sleep 2
        if lms load "$MODEL_NAME_ENV"; then
            echo ""
            echo -e "${GRN}  OK${RST}     Model loaded and ready"
        else
            echo ""
            echo -e "${RED} [ERROR]${RST} Model \"$MODEL_NAME_ENV\" is not downloaded."
            echo -e "${WHT}         Run:  npm run setup${RST}"
            echo -e "${WHT}         Setup will offer to download it for you.${RST}"
        fi
    fi
else
    echo -e "${YLW} [NOTE]${RST}  lms CLI not on PATH -- open LM Studio manually and"
    echo "         enable the server under the Developer tab."
fi

# -------------------------------------------------------
# Done
# -------------------------------------------------------
echo ""
echo -e "${CYN} =================================================${RST}"
echo -e "${CYN}   All done! One last step:${RST}"
echo -e "${CYN} =================================================${RST}"
echo ""
echo -e "${WHT}  In VS Code, press  Ctrl+Shift+P  and run:${RST}"
echo ""
echo -e "${WHT}      Developer: Reload Window${RST}"
echo ""
echo -e "${WHT}  Then type  /mcp  in Claude Code.${RST}"
echo -e "${WHT}  You should see \"lmstudio\" listed as connected.${RST}"
echo ""
echo -e "${YLW}  Need to start the server again after a restart?${RST}"
echo -e "         Run:  ${WHT}./start-server.sh${RST}"
pause
