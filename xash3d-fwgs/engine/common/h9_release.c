/*
h9_release.c - H9: the release this game folder is
Copyright (C) 2026 HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

A release of HAVOC 9 is one name, the first word of h9_release.txt in the game folder (ts\h9_release.txt,
laid there from xash3d-h9-patches\overlay\ts\ by xash.bat), a date such as 2026.11.05. The engine, the
client library, the plugins and the files of a release are all one package, so the release is the one
thing to compare: a client sends it to every server in the userinfo key _h9rel (cl_presence.c), and a
server that holds its players to one release (h9_require_release) refuses a joiner whose release is
another (sv_client.c, SV_H9ReleaseRefusal). docs\H9_RELEASE.txt has the whole of it.
*/

#include "common.h"

/*
=================
H9_Release

The release of this game folder, at most 31 characters; "" when the folder has no h9_release.txt.
Read once.
=================
*/
const char *H9_Release( void )
{
	static char	release[32];
	static qboolean	read;

	if( !read )
	{
		fs_offset_t	len = 0;
		byte		*buf;
		int		i;

		read = true;
		buf = FS_LoadFile( "h9_release.txt", &len, false );

		if( buf )
		{
			for( i = 0; i < len && i < (int)sizeof( release ) - 1 && buf[i] > ' '; i++ )
				release[i] = buf[i];

			release[i] = '\0';
			Mem_Free( buf );
		}
	}

	return release;
}
