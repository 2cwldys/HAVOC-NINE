// spike: forces the dedicated server to link as C++ so side modules find the C++ runtime
#include <exception>
extern "C" int XashSpike_CxxAnchor(void) { try { throw 1; } catch (int v) { return v; } }
