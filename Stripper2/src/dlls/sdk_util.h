//
// botman's stripper2 - MetaMOD plugin
//
// sdk_util.h
//

/***
*
*   Copyright (c) 1999, 2000 Valve LLC. All rights reserved.
*
*   This product contains software technology licensed from Id
*   Software, Inc. ("Id Technology").  Id Technology (c) 1996 Id Software, Inc.
*   All Rights Reserved.
*
*   Use, distribution, and modification of this source code and/or resulting
*   object code is restricted to non-commercial enhancements to products from
*   Valve LLC.  All other use, distribution, or modification is prohibited
*   without written permission from Valve LLC.
*
****/

#ifndef SDK_UTIL_H
#define SDK_UTIL_H

// Helpers defined in sdk_util.cpp. The HLSDK util.h (pulled in through
// meta_api.h -> mutil.h) also declares these; the matching redeclarations here
// let the plugin sources include sdk_util.h directly, as the classic tree did.

// Writes message to console with timestamp.
extern void UTIL_LogPrintf( char *fmt, ... );

extern void UTIL_StringToVector( float *pVector, const char *pString );

#endif // SDK_UTIL_H
