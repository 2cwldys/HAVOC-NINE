// ---- H9 text to speech -----------------------------------------------------------------------------------------
// A server with h9_texttospeech 1 tells each player near a speaker what the speaker said, in a voice for his model:
// one plugin-registered user message, H9Tts. The client speaks it itself -- Windows SAPI, or the browser's speech
// synthesis in the web client -- and says it can with the userinfo key _h9tts (1 while cl_h9_tts is not 0 and the
// machine has a voice). cl_h9_tts 0 is silence for this player; cl_h9_tts_volume (0 to 2, 1 by default) scales the
// voices. docs\TEXT_TO_SPEECH.txt is the protocol and the guide.
//
// A server is untrusted here: the length of a line, the rate of lines and the number of voices at once are the
// client's own limits, whatever a message says.
#pragma once

// From CHud::Init: hooks H9Tts, registers cl_h9_tts, cl_h9_tts_volume and the userinfo key _h9tts.
void H9Tts_Init();

// From HUD_Shutdown: stops the speech thread and lets go of the voices.
void H9Tts_Shutdown();
