#include "plugin.h"
#include "h9_hooks.h"

// ======================================================================================
// Pure (upstream-identical) EntMod build: the H9 seams do nothing, so the plugin behaves
// exactly like the original. The HAVOC9 build does NOT compile this file -- it links the real
// implementations in src/h9 instead (the Makefile selects one or the other). See h9_hooks.h.
// ======================================================================================

int H9AdminIdMatch(edict_t * /*player*/, const char * /*field1*/) { return 0; }
int H9HandleIdCommand(edict_t * /*player*/) { return 0; }

void H9GameInit(void) {}
void H9OnServerActivate(edict_t * /*l*/, int /*c*/, int /*m*/) {}
int  H9EntModActive(void) { return 1; }   // pure build: always active (no entmap/entmod gate)
void H9RegisterCommands(void) {}          // pure build: commands via the ClientCommand hook only
