// ---- H9 chat bubbles --------------------------------------------------------------------------------------------
// What a player said, drawn over his head by this client. A server with ts_floatchat.amxx sends each line once, as the H9Say
// user message, to a game that says it draws them (the userinfo key _h9chatbubble: 1 while cl_h9_chatbubble is not 0, 1s when
// cl_h9_chatbubble_own also asks for the player's own line); this client keeps each speaker's latest line and draws it in a box
// in H9's panel style over the head of the speaker its crosshair is on (over his typing sprite, while that shows), placed on its
// own screen every frame. Every switch is a saved cvar named cl_h9_chatbubble_*; cl_h9_chatbubble_list prints them.
// docs\CHAT_BUBBLES.txt is the protocol and the guide.
//
// A server is untrusted here: the length of a line, the rate of lines, how long one stays and how many boxes show at once are
// the client's own limits, whatever a message says.
#pragma once

// From CHud::Init: hooks H9Say, registers the cl_h9_chatbubble_* cvars, the commands cl_h9_chatbubble_list and
// cl_h9_chatbubble_test and the userinfo key _h9chatbubble, and adds the HUD element that places the boxes every frame.
void H9ChatBubble_Init();

// From HUD_AddEntity: true for the typing sprite ts_floatchat puts over a player writing, while cl_h9_chatbubble_typing is 0;
// the entity is then left out of the frame.
bool H9ChatBubble_HideEntity(const char* modelname);

// From HUD_AddEntity, for an entity it lets through: notes the typing sprite over a player writing, by its owner, so that the
// box for that player's words rests over the sprite and not through it.
struct cl_entity_s;
void H9ChatBubble_NoteEntity(const struct cl_entity_s* ent, const char* modelname);
// ---- end H9 chat bubbles ----------------------------------------------------------------------------------------
