# Engine hooks for internet radio

Four edits plus one new file. Nothing in the mixer, the sound channels, the ambient system or
the client DLL is touched -- a radio stream enters through the same door a local `.mp3` does.

All line numbers are against the current `D:\Downloads\TSM\xash3d-fwgs` tree.

---

## New file

`engine/client/soundlib/snd_http.c` -- the whole feature. In this folder as `snd_http.c`.

---

## 1. `engine/client/soundlib/snd_main.c:158` -- send URLs to the network opener

`FS_OpenStream` strips the extension off the name and rebuilds `loadname.ext`, then falls back
to a `media/` prefix (line 201). Both of those mangle a URL, so a URL has to leave before any
path handling happens.

```c
 stream_t *FS_OpenStream( const char *filename )
 {
 	const char	*ext = COM_FileExtension( filename );
 	string		loadname;
 	qboolean		anyformat = true;
 	stream_t		*stream = NULL;

 	Sound_Reset(); // clear old streaminfo
+
+	// H9: an http(s) address is a live stream, not a file: no extension to probe, no
+	// media/ fallback, no length. The opener sets stream->format itself.
+	if( !Q_strnicmp( filename, "http://", 7 ) || !Q_strnicmp( filename, "https://", 8 ))
+		return Stream_OpenHTTP( filename );
+
 	Q_strncpy( loadname, filename, sizeof( loadname ));
```

That is the entire dispatch. `FS_ReadStream` (:221) and `FS_FreeStream` (:269) already call
through `stream->format->readfunc` / `->freefunc`, so once the opener fills in `format` the
rest of the engine needs no changes at all.

## 2. `engine/client/soundlib/snd_mp3.c` -- export four helpers

The radio decodes with the same mpg123 feed path a local file uses. These four are `static`
today; drop that one word from each:

| line | function |
|---|---|
| 256 | `create_decoder` |
| 280 | `feed_mpeg_header` |
| 299 | `feed_mpeg_stream` |
| 347 | `close_decoder` |

`MP3_ERR` / `MP3_OK` / `MP3_NEED_MORE` (:198-200) stay where they are -- `snd_http.c` repeats
those three defines rather than moving them, so `snd_mp3.c` keeps its current shape.

## 3. `engine/client/soundlib/snd_main.c` -- register the two cvars

In `Sound_Init()`, alongside the other soundlib setup:

```c
+	Stream_HTTPInit();	// h9_radio_buffer, h9_radio_debug
```

## 4. The build files -- add the new source

`snd_http.c` goes wherever `snd_mp3.c` is already listed (`engine/wscript`, and the CMake
list if that path is in use). It is inside `#if !XASH_DEDICATED`, so a dedicated server build
compiles it to nothing.

---

## What deliberately is *not* changed

**The loop/EOF path (`s_stream.c:288-298`).** When a read returns 0, `s_stream.c` frees the
stream and re-opens `loopName`. `mp3 play <name>` sets `loopName` to the same name
(`cl_cmds.c:96`), so for a radio URL that path re-opens the URL -- through the hooked
`FS_OpenStream`. A station that dies for good therefore reconnects on its own, using code
that already exists. Nothing to add.

**`S_StartBackgroundTrack` (`s_stream.c:96`).** Its first line is already
`S_StopBackgroundTrack()`. That is the whole of "the radio interrupts the ambience" -- the two
sources share one channel and starting either stops the other. No bookkeeping, no new state.

**Any client command.** The plugin uses `mp3 play <url>` and `mp3 stop`, which the engine has
had all along (`cl_main.c:4110`). The ambient rotation in `ts_matchmode.sma` already drives
the channel with exactly these.

---

## Plugin-side gate

While `h9_radio_ambient` is `1`, `h9_radio` owns the rotation and `ts_matchmode.sma` must not
also drive it, or its timer will cut the radio off mid-song. One guard at the top of
`task_music_queue` (`ts_matchmode.sma:~29760`):

```c
	// H9: h9_radio owns the music channel when it is running the rotation
	if( get_cvar_num( "h9_radio" ) && get_cvar_num( "h9_radio_ambient" ))
		return;
```

Set `h9_radio_ambient 0` to hand the rotation back to `ts_matchmode` and keep only the radio.

---

## Symbols to confirm at build time

This has not been compiled. These are the calls I used from memory of the tree rather than
from a definition I read, so they are the first things a build will complain about:

- `NET_StringToAdr`, `NET_NetadrToSockadr`, `NET_SockAddrLen`, `NET_SetSockAddrPort`,
  `NET_ErrorString` -- `NET_SetSockAddrPort` in particular may not exist under that name;
  the port may need setting on the `sockaddr_in` / `sockaddr_in6` directly.
- `Q_strrchr`, `Q_stristr` -- present in `public/stdlib.h` under some name; confirm spelling.
- `HTTP_TLS_OK` / `HTTP_TLS_ERROR` / `HTTP_TLS_WANT` -- the return values of
  `HTTP_TlsHandshake`; `net_http_tls.h:49` shows `HTTP_TLS_ERROR` exists, the other two are
  assumed.

`Radio_WouldBlock()` was written out by hand precisely because `NET_IsSocketWouldBlock()` does
*not* exist -- I used it first and had to take it back out.
