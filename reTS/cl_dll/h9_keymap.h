// H9 per-gamemode key layouts on the client: while a mode is on, the keys its keymap file lists run that file's command instead of the player's
// own bind, and the rest are the player's. No bind is ever written. The logic is h9_keymap_calc.h (tested by tests/keymap_test.cpp); this file
// asks the engine. The files are game folder h9/keys/<name>.txt, the name from the cvar cl_h9_keys_<mode> (rally: "rally"; "" is off).
#pragma once

void H9Keys_Init();                           // from CHud::Init: the cvars
void H9Keys_VidInit();                        // from CHud::VidInit: the files are read again (a map start)
void H9Keys_Frame();                          // from HUD_Frame: a mode that has ended lets go of the keys it holds
bool H9Keys_Event(int down, int keynum);      // from HUD_Key_Event: true when the keymap took the key (the engine must not run the player's bind)
