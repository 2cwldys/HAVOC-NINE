/*
snd_http.c - HTTP/HTTPS audio streaming (internet radio) for the background music channel

NOT BUILT and NOT in the patch chain. ../README.md says why this is a folder rather than
a .patch, and HOOKS.md has the exact edits. Target location once it goes in:
engine/client/soundlib/snd_http.c

Why this slots in cleanly
-------------------------
A background track is a stream_t that carries its own vtable:

    struct stream_s { const streamfmt_t *format; ... void *ptr; ... };

and FS_ReadStream()/FS_FreeStream() (snd_main.c:221, :269) do nothing but call through
stream->format->readfunc / ->freefunc. So a network radio is "just another stream format":
set stream->format to the table at the bottom of this file and the whole mixer path works
unchanged.

S_StartBackgroundTrack() (s_stream.c:96) calls S_StopBackgroundTrack() as its first line.
That is the "interrupt any ambience being played" requirement -- we get it for free, because
starting the radio goes through the same door as starting a map's music track.

The decoder is already here too: snd_mp3.c feeds mpg123 in FEED mode at line 287
(mpg123_open_feed / mpg123_decode), which is exactly what a socket needs -- no file handle,
no seeking, push bytes in and pull PCM out.

TLS is already here: engine/common/http/net_http_tls.c is an H9 addition wrapping mbedTLS,
and net_http_tls.h exposes HTTP_TlsNew/Handshake/Send/Recv over a plain socket fd.

So this file is the only new code. The three hook points are in hooks.md.

The one rule that matters
-------------------------
Stream_ReadHTTP MUST NOT return 0 on a buffer underrun. s_stream.c treats a short read as
end-of-track and tears the stream down (s_stream.c:274-294). A radio that hiccups for 200 ms
would silently die. On underrun we write silence and report a full buffer, and keep the
connection alive. 0 is returned only when the station is given up on for good.
*/

#include "common.h"
#include "sound.h"
#include "client.h"
#include "soundlib.h"
#include "net_http_tls.h"

#if !XASH_DEDICATED

// From snd_mp3.c. These four are static there today and the three defines are local to that
// file; hooks.md lists the one-word change that exports them. Nothing else is borrowed, and
// no mp3 decoding is duplicated here -- a radio stream is the same mpg123 feed path a local
// file already uses, with a socket in place of the file handle.
extern mpg123_handle *create_decoder( int *error );
extern void close_decoder( mpg123_handle *mh );
extern int feed_mpeg_header( mpg123_handle *mh, const byte *data, long bufsize, long streamsize, wavinfo_t *sc );
extern int feed_mpeg_stream( mpg123_handle *mh, const byte *data, long bufsize, byte *outbuf, size_t *outsize );

#define MP3_ERR       -1
#define MP3_OK        0
#define MP3_NEED_MORE 1

// defined at the foot of this file, referenced by the opener
extern const streamfmt_t stream_http;

/*
=================
Radio_WouldBlock

There is no NET_IsSocketWouldBlock() in net_ws.h -- net_ws.c tests the platform error inline
(net_ws.c:1396, :1554) and so do we. A non-blocking socket reports "nothing right now" this
way on every step, so getting it wrong would look like a station that drops instantly.
=================
*/
static qboolean Radio_WouldBlock( void )
{
#if XASH_WIN32
	int err = WSAGetLastError();

	return err == WSAEWOULDBLOCK || err == WSAEINPROGRESS;
#else
	return errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR;
#endif
}

#define RADIO_NET_CHUNK     4096        // bytes pulled off the socket per pump
#define RADIO_PCM_SECONDS   4           // decoded ring size, in seconds of audio
#define RADIO_PRIME_SECONDS 2           // fill this much before the first sample is heard
#define RADIO_HDR_MAX       2048
#define RADIO_CONNECT_WAIT  10.0        // seconds before a connect attempt is abandoned
#define RADIO_RETRY_WAIT    3.0         // seconds between reconnect attempts
#define RADIO_RETRY_MAX     5
#define RADIO_REDIRECT_MAX  4

enum
{
	RADIO_IDLE = 0,
	RADIO_RESOLVING,
	RADIO_CONNECTING,
	RADIO_TLS_HANDSHAKE,
	RADIO_SENDING,
	RADIO_HEADERS,
	RADIO_PLAYING,
	RADIO_RETRY,
	RADIO_DEAD
};

typedef struct
{
	// where
	string      url;              // as given, for messages and reconnects
	string      host;
	string      path;
	int         port;
	qboolean    secure;

	// connection
	int         socket;
	tlsctx_t   *tls;
	struct sockaddr_storage addr;
	int         state;
	double      deadline;         // state-specific timeout
	int         retries;
	int         redirects;

	// request/response plumbing
	char        request[1024];
	int         request_sent;
	int         request_len;
	char        hdr[RADIO_HDR_MAX];
	int         hdr_len;

	// decode
	mpg123_handle *mpg;
	qboolean    have_format;

	// decoded PCM ring
	byte       *pcm;
	size_t      pcm_size;
	size_t      pcm_head;         // bytes written, monotonic
	size_t      pcm_tail;         // bytes read, monotonic
	size_t      prime_bytes;
	qboolean    primed;

	// scratch
	byte        net[RADIO_NET_CHUNK];
	byte        out[OUTBUF_SIZE];

	size_t      served;           // total PCM handed to the mixer, for GetPos
	qboolean    reported;         // "now playing" printed once
} radio_t;

static CVAR_DEFINE_AUTO( h9_radio_buffer, "4", FCVAR_ARCHIVE, "internet radio buffer, in seconds (2-15)" );
static CVAR_DEFINE_AUTO( h9_radio_debug, "0", 0, "log internet radio connection steps" );

/*
=================
Radio_URL

split "https://host:8061/listen.mp3" into its parts. Defaults: port 80 (http) / 443 (https),
path "/".
=================
*/
static qboolean Radio_URL( radio_t *r, const char *url )
{
	const char *p = url;
	const char *slash, *colon;
	string      hostport;
	size_t      n;

	if( !Q_strnicmp( p, "https://", 8 ))
	{
		r->secure = true;
		r->port = 443;
		p += 8;
	}
	else if( !Q_strnicmp( p, "http://", 7 ))
	{
		r->secure = false;
		r->port = 80;
		p += 7;
	}
	else return false;

	slash = Q_strchr( p, '/' );

	if( slash )
	{
		n = slash - p;
		Q_strncpy( r->path, slash, sizeof( r->path ));
	}
	else
	{
		n = Q_strlen( p );
		Q_strncpy( r->path, "/", sizeof( r->path ));
	}

	if( n == 0 || n >= sizeof( hostport ))
		return false;

	memcpy( hostport, p, n );
	hostport[n] = '\0';

	// an IPv6 literal is bracketed: [::1]:8061
	if( hostport[0] == '[' )
	{
		char *close = Q_strchr( hostport, ']' );

		if( !close ) return false;
		*close = '\0';
		Q_strncpy( r->host, hostport + 1, sizeof( r->host ));
		colon = Q_strchr( close + 1, ':' );
	}
	else
	{
		colon = Q_strrchr( hostport, ':' );

		if( colon )
		{
			size_t hl = colon - hostport;

			if( hl >= sizeof( r->host )) return false;
			memcpy( r->host, hostport, hl );
			r->host[hl] = '\0';
		}
		else Q_strncpy( r->host, hostport, sizeof( r->host ));
	}

	if( colon && colon[1] )
	{
		int port = Q_atoi( colon + 1 );

		if( port > 0 && port < 65536 )
			r->port = port;
	}

	return r->host[0] != '\0';
}

static void Radio_Log( radio_t *r, const char *fmt, ... )
{
	va_list	args;
	char	text[1024];

	if( !h9_radio_debug.value )
		return;

	va_start( args, fmt );
	Q_vsnprintf( text, sizeof( text ), fmt, args );
	va_end( args );

	Con_Printf( "radio: %s\n", text );
}

static void Radio_Disconnect( radio_t *r )
{
	if( r->tls )
	{
		HTTP_TlsFree( r->tls );
		r->tls = NULL;
	}

	if( r->socket >= 0 )
	{
		closesocket( r->socket );
		r->socket = -1;
	}

	r->hdr_len = 0;
	r->request_sent = 0;
}

/*
=================
Radio_Begin

start (or restart) the connection. Does not block: the socket is non-blocking and the state
machine in Radio_Pump carries it the rest of the way.
=================
*/
static qboolean Radio_Begin( radio_t *r )
{
	netadr_t	adr;

	Radio_Disconnect( r );

	if( !NET_StringToAdr( r->host, &adr ))
	{
		Con_Printf( S_ERROR "radio: cannot resolve %s\n", r->host );
		r->state = RADIO_DEAD;
		return false;
	}

	NET_NetadrToSockadr( &adr, &r->addr );
	NET_SetSockAddrPort( &r->addr, MSG_BigShort((short)r->port ));

	r->socket = socket( r->addr.ss_family, SOCK_STREAM, IPPROTO_TCP );

	if( r->socket < 0 )
	{
		Con_Printf( S_ERROR "radio: socket() failed: %s\n", NET_ErrorString());
		r->state = RADIO_DEAD;
		return false;
	}

	{
		uint nonblocking = 1;
		ioctlsocket( r->socket, FIONBIO, &nonblocking );
	}

	// non-blocking: this returns "in progress" and RADIO_CONNECTING waits on the socket
	connect( r->socket, (struct sockaddr *)&r->addr, NET_SockAddrLen( &r->addr ));

	r->state = RADIO_CONNECTING;
	r->deadline = host.realtime + RADIO_CONNECT_WAIT;

	Radio_Log( r, "connecting to %s:%d%s", r->host, r->port, r->secure ? " (tls)" : "" );
	return true;
}

/*
=================
Radio_BuildRequest

Icy-MetaData is deliberately NOT requested. With it on, Icecast interleaves title metadata
into the audio byte stream every icy-metaint bytes, which would be fed to mpg123 as garbage.
Connection: close keeps it a plain one-shot response body we read until the socket dies.
=================
*/
static void Radio_BuildRequest( radio_t *r )
{
	r->request_len = Q_snprintf( r->request, sizeof( r->request ),
		"GET %s HTTP/1.0\r\n"
		"Host: %s\r\n"
		"User-Agent: Xash3D-FWGS\r\n"
		"Icy-MetaData: 0\r\n"
		"Accept: audio/mpeg, */*\r\n"
		"Connection: close\r\n"
		"\r\n",
		r->path, r->host );

	r->request_sent = 0;
}

static int Radio_Send( radio_t *r, const void *buf, int len )
{
	if( r->tls )
		return HTTP_TlsSend( r->tls, buf, len );

	return send( r->socket, buf, len, 0 );
}

static int Radio_Recv( radio_t *r, void *buf, int len )
{
	if( r->tls )
		return HTTP_TlsRecv( r->tls, buf, len );

	return recv( r->socket, buf, len, 0 );
}

/*
=================
Radio_ParseHeaders

Icecast answers "ICY 200 OK", a normal server answers "HTTP/1.0 200 OK". Both are accepted.
Returns: 1 ok and playing, 0 need more bytes, -1 fatal, 2 redirect taken.
=================
*/
static int Radio_ParseHeaders( radio_t *r, const byte *data, int len, int *consumed )
{
	char *end;
	int   code = 0;

	*consumed = 0;

	if( r->hdr_len + len > RADIO_HDR_MAX - 1 )
		len = RADIO_HDR_MAX - 1 - r->hdr_len;

	if( len > 0 )
	{
		memcpy( r->hdr + r->hdr_len, data, len );
		r->hdr_len += len;
		r->hdr[r->hdr_len] = '\0';
		*consumed = len;
	}

	end = Q_strstr( r->hdr, "\r\n\r\n" );

	if( !end )
	{
		if( r->hdr_len >= RADIO_HDR_MAX - 1 )
		{
			Con_Printf( S_ERROR "radio: response headers too large\n" );
			return -1;
		}
		return 0; // need more
	}

	// how many of the bytes we just copied belonged to the body
	*consumed -= ( r->hdr + r->hdr_len ) - ( end + 4 );

	if( !Q_strnicmp( r->hdr, "ICY ", 4 ))
		code = Q_atoi( r->hdr + 4 );
	else if( !Q_strnicmp( r->hdr, "HTTP/", 5 ))
	{
		const char *sp = Q_strchr( r->hdr, ' ' );
		code = sp ? Q_atoi( sp + 1 ) : 0;
	}

	Radio_Log( r, "status %d", code );

	if( code == 301 || code == 302 || code == 303 || code == 307 || code == 308 )
	{
		const char *loc = Q_stristr( r->hdr, "\nLocation:" );

		if( loc && r->redirects < RADIO_REDIRECT_MAX )
		{
			string next;
			const char *s = loc + 10;
			int i = 0;

			while( *s == ' ' || *s == '\t' ) s++;
			while( *s && *s != '\r' && *s != '\n' && i < (int)sizeof( next ) - 1 )
				next[i++] = *s++;
			next[i] = '\0';

			r->redirects++;
			Radio_Log( r, "redirect -> %s", next );

			if( Radio_URL( r, next ))
			{
				Q_strncpy( r->url, next, sizeof( r->url ));
				Radio_Begin( r );
				return 2;
			}
		}

		Con_Printf( S_ERROR "radio: too many redirects\n" );
		return -1;
	}

	if( code != 200 )
	{
		Con_Printf( S_ERROR "radio: station answered %d\n", code );
		return -1;
	}

	// a content-type that is not mpeg is a hard stop: we only decode mp3 here
	if( Q_stristr( r->hdr, "Content-Type:" ) && !Q_stristr( r->hdr, "audio/mpeg" )
		&& !Q_stristr( r->hdr, "audio/mp3" ))
	{
		Con_Printf( S_ERROR "radio: %s is not an mp3 stream\n", r->url );
		return -1;
	}

	if( !r->reported )
	{
		const char *name = Q_stristr( r->hdr, "\nicy-name:" );

		if( name )
		{
			string label;
			const char *s = name + 10;
			int i = 0;

			while( *s == ' ' || *s == '\t' ) s++;
			while( *s && *s != '\r' && *s != '\n' && i < (int)sizeof( label ) - 1 )
				label[i++] = *s++;
			label[i] = '\0';
			Con_Printf( "radio: %s\n", label );
		}
		else Con_Printf( "radio: %s\n", r->url );

		r->reported = true;
	}

	return 1;
}

static size_t Radio_RingAvail( radio_t *r )
{
	return r->pcm_head - r->pcm_tail;
}

static void Radio_RingWrite( radio_t *r, const byte *data, size_t len )
{
	size_t i;

	// a full ring means the mixer is behind; drop the oldest rather than block
	if( len > r->pcm_size )
	{
		data += len - r->pcm_size;
		len = r->pcm_size;
	}

	for( i = 0; i < len; i++ )
		r->pcm[( r->pcm_head + i ) % r->pcm_size] = data[i];

	r->pcm_head += len;

	if( Radio_RingAvail( r ) > r->pcm_size )
		r->pcm_tail = r->pcm_head - r->pcm_size;
}

static size_t Radio_RingRead( radio_t *r, byte *out, size_t len )
{
	size_t avail = Radio_RingAvail( r );
	size_t i;

	if( len > avail ) len = avail;

	for( i = 0; i < len; i++ )
		out[i] = r->pcm[( r->pcm_tail + i ) % r->pcm_size];

	r->pcm_tail += len;
	return len;
}

/*
=================
Radio_Feed

push raw mp3 bytes into mpg123 and drain every PCM frame it will give back.
=================
*/
static void Radio_Feed( stream_t *stream, radio_t *r, const byte *data, int len )
{
	size_t done;
	int    ret;

	if( len <= 0 ) return;

	if( !r->have_format )
	{
		wavinfo_t sc;

		// first chunk: let mpg123 discover rate/channels
		if( feed_mpeg_header( r->mpg, data, len, -1, &sc ))
		{
			stream->channels = sc.channels;
			stream->rate     = sc.rate;
			stream->width    = 2;
			r->have_format   = true;

			// size the ring now that the format is known
			r->pcm_size    = (size_t)sc.rate * sc.channels * 2 * bound( 2, (int)h9_radio_buffer.value, 15 );
			r->prime_bytes = (size_t)sc.rate * sc.channels * 2 * RADIO_PRIME_SECONDS;
			r->pcm         = Mem_Calloc( host.soundpool, r->pcm_size );

			Radio_Log( r, "format %d Hz, %d ch, ring %u bytes", sc.rate, sc.channels, (uint)r->pcm_size );
		}
		else return; // still looking for a frame header

		data = NULL; // header feed consumed it
		len  = 0;
	}

	// drain: feed once, then keep pulling until mpg123 wants more
	for( ;; )
	{
		ret = feed_mpeg_stream( r->mpg, data, len, r->out, &done );

		data = NULL; // only the first call carries new input
		len  = 0;

		if( ret == MP3_ERR )
		{
			Radio_Log( r, "decode error, resyncing" );
			return;
		}

		if( done > 0 )
			Radio_RingWrite( r, r->out, done );

		if( ret == MP3_NEED_MORE || done == 0 )
			break;
	}

	if( !r->primed && Radio_RingAvail( r ) >= r->prime_bytes )
	{
		r->primed = true;
		Radio_Log( r, "buffered, playing" );
	}
}

/*
=================
Radio_Pump

one non-blocking step of the state machine. Called from the read function, so it runs at
mixer rate and never on its own thread.
=================
*/
static void Radio_Pump( stream_t *stream, radio_t *r )
{
	int got, consumed;

	switch( r->state )
	{
	case RADIO_CONNECTING:
	{
		fd_set	 wr, ex;
		struct timeval tv = { 0, 0 };

		FD_ZERO( &wr ); FD_SET( r->socket, &wr );
		FD_ZERO( &ex ); FD_SET( r->socket, &ex );

		if( select( r->socket + 1, NULL, &wr, &ex, &tv ) > 0 )
		{
			if( FD_ISSET( r->socket, &ex ))
			{
				Radio_Log( r, "connect refused" );
				r->state = RADIO_RETRY;
				r->deadline = host.realtime + RADIO_RETRY_WAIT;
				break;
			}

			if( r->secure )
			{
				r->tls = HTTP_TlsNew( r->socket, r->host );

				if( !r->tls )
				{
					Con_Printf( S_ERROR "radio: TLS unavailable for %s\n", r->host );
					r->state = RADIO_DEAD;
					break;
				}

				r->state = RADIO_TLS_HANDSHAKE;
			}
			else
			{
				Radio_BuildRequest( r );
				r->state = RADIO_SENDING;
			}
		}
		else if( host.realtime > r->deadline )
		{
			Radio_Log( r, "connect timed out" );
			r->state = RADIO_RETRY;
			r->deadline = host.realtime + RADIO_RETRY_WAIT;
		}
		break;
	}

	case RADIO_TLS_HANDSHAKE:
	{
		int ret = HTTP_TlsHandshake( r->tls );

		if( ret == HTTP_TLS_OK )
		{
			Radio_BuildRequest( r );
			r->state = RADIO_SENDING;
		}
		else if( ret == HTTP_TLS_ERROR )
		{
			// the common cause is a station that does not send its intermediate CA.
			// browsers chase the missing cert (AIA); mbedTLS, like curl, does not.
			Con_Printf( S_ERROR "radio: TLS handshake with %s failed\n", r->host );
			Con_Printf( "radio: if the station is otherwise fine, its server is probably not\n" );
			Con_Printf( "radio: sending the full certificate chain. Try its http:// address.\n" );
			r->state = RADIO_DEAD;
		}
		else if( host.realtime > r->deadline )
		{
			r->state = RADIO_RETRY;
			r->deadline = host.realtime + RADIO_RETRY_WAIT;
		}
		break;
	}

	case RADIO_SENDING:
	{
		int sent = Radio_Send( r, r->request + r->request_sent, r->request_len - r->request_sent );

		if( sent > 0 )
		{
			r->request_sent += sent;

			if( r->request_sent >= r->request_len )
			{
				r->state = RADIO_HEADERS;
				r->deadline = host.realtime + RADIO_CONNECT_WAIT;
			}
		}
		else if( sent < 0 && !Radio_WouldBlock( ))
		{
			r->state = RADIO_RETRY;
			r->deadline = host.realtime + RADIO_RETRY_WAIT;
		}
		break;
	}

	case RADIO_HEADERS:
		got = Radio_Recv( r, r->net, sizeof( r->net ));

		if( got > 0 )
		{
			int res = Radio_ParseHeaders( r, r->net, got, &consumed );

			if( res == 1 )
			{
				r->state = RADIO_PLAYING;
				r->retries = 0;

				// anything past the blank line is already audio
				if( got > consumed )
					Radio_Feed( stream, r, r->net + consumed, got - consumed );
			}
			else if( res == -1 ) r->state = RADIO_DEAD;
			// res == 0 need more, res == 2 redirect already restarted
		}
		else if( got == 0 || ( got < 0 && !Radio_WouldBlock( )))
		{
			r->state = RADIO_RETRY;
			r->deadline = host.realtime + RADIO_RETRY_WAIT;
		}
		else if( host.realtime > r->deadline )
		{
			r->state = RADIO_RETRY;
			r->deadline = host.realtime + RADIO_RETRY_WAIT;
		}
		break;

	case RADIO_PLAYING:
		// pull everything waiting, but bounded, so one slow frame cannot stall the mixer
		for( int i = 0; i < 8; i++ )
		{
			got = Radio_Recv( r, r->net, sizeof( r->net ));

			if( got > 0 )
			{
				Radio_Feed( stream, r, r->net, got );
				continue;
			}

			if( got == 0 || ( got < 0 && !Radio_WouldBlock( )))
			{
				Radio_Log( r, "stream dropped, reconnecting" );
				r->state = RADIO_RETRY;
				r->deadline = host.realtime + RADIO_RETRY_WAIT;
			}
			break;
		}
		break;

	case RADIO_RETRY:
		if( host.realtime < r->deadline )
			break;

		if( ++r->retries > RADIO_RETRY_MAX )
		{
			Con_Printf( S_ERROR "radio: giving up on %s\n", r->url );
			r->state = RADIO_DEAD;
			break;
		}

		Con_Printf( "radio: reconnecting (%d/%d)\n", r->retries, RADIO_RETRY_MAX );
		r->primed = false;
		Radio_Begin( r );
		break;

	default:
		break;
	}
}

/*
=================
Stream_OpenHTTP

returns immediately; nothing here blocks on the network. The mixer gets silence until the
prebuffer fills, which is what RADIO_PRIME_SECONDS is for.
=================
*/
stream_t *Stream_OpenHTTP( const char *url )
{
	stream_t *stream;
	radio_t  *r;
	int       err = 0;

	if( !url || !*url )
		return NULL;

	r = Mem_Calloc( host.soundpool, sizeof( radio_t ));
	r->socket = -1;

	if( !Radio_URL( r, url ))
	{
		Con_Printf( S_ERROR "radio: cannot parse %s\n", url );
		Mem_Free( r );
		return NULL;
	}

	Q_strncpy( r->url, url, sizeof( r->url ));

	if( r->secure && !HTTP_TlsAvailable( ))
	{
		Con_Printf( S_ERROR "radio: this build has no TLS; https stations cannot be played\n" );
		Mem_Free( r );
		return NULL;
	}

	if(( r->mpg = create_decoder( &err )) == NULL )
	{
		Con_Printf( S_ERROR "radio: no mp3 decoder\n" );
		Mem_Free( r );
		return NULL;
	}

	if( !Radio_Begin( r ))
	{
		close_decoder( r->mpg );
		Mem_Free( r );
		return NULL;
	}

	stream = Mem_Calloc( host.soundpool, sizeof( stream_t ));
	stream->ptr      = r;
	stream->type     = WF_MPGDATA;
	stream->format   = &stream_http;

	// provisional; corrected the moment the first frame header is decoded
	stream->channels = 2;
	stream->rate     = 44100;
	stream->width    = 2;
	stream->size     = 0;    // unknown: a live stream has no length

	return stream;
}

/*
=================
Stream_ReadHTTP

The contract that keeps a radio alive: always hand back needBytes. Silence while buffering,
silence on an underrun, silence while reconnecting. Returning 0 would make s_stream.c treat
it as the end of the track and destroy the stream.
=================
*/
int Stream_ReadHTTP( stream_t *stream, int needBytes, void *buffer )
{
	radio_t *r = stream->ptr;
	size_t   got;

	if( !r ) return 0;

	Radio_Pump( stream, r );

	// dead for good: let the mixer stop the track
	if( r->state == RADIO_DEAD && Radio_RingAvail( r ) == 0 )
		return 0;

	if( !r->primed || !r->pcm )
	{
		memset( buffer, 0, needBytes );
		r->served += needBytes;
		return needBytes;
	}

	got = Radio_RingRead( r, buffer, needBytes );

	if( got < (size_t)needBytes )
	{
		// underrun: pad with silence and re-prime so we do not stutter every frame
		memset( (byte *)buffer + got, 0, needBytes - got );

		if( r->state == RADIO_PLAYING )
		{
			r->primed = false;
			Radio_Log( r, "underrun, rebuffering" );
		}
	}

	r->served += needBytes;
	return needBytes;
}

int Stream_SetPosHTTP( stream_t *stream, int newpos )
{
	return false; // live radio does not seek
}

int Stream_GetPosHTTP( stream_t *stream )
{
	radio_t *r = stream->ptr;

	return r ? (int)r->served : 0;
}

void Stream_FreeHTTP( stream_t *stream )
{
	radio_t *r = stream->ptr;

	if( r )
	{
		Radio_Disconnect( r );

		if( r->mpg ) close_decoder( r->mpg );
		if( r->pcm ) Mem_Free( r->pcm );

		Mem_Free( r );
	}

	Mem_Free( stream );
}

void Stream_HTTPInit( void )
{
	Cvar_RegisterVariable( &h9_radio_buffer );
	Cvar_RegisterVariable( &h9_radio_debug );
}

const streamfmt_t stream_http =
{
	"http", Stream_OpenHTTP, Stream_ReadHTTP, Stream_SetPosHTTP, Stream_GetPosHTTP, Stream_FreeHTTP
};

#endif // !XASH_DEDICATED
