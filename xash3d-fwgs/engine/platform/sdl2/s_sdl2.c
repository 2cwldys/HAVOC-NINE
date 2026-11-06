/*
s_backend.c - sound hardware output
Copyright (C) 2009 Uncle Mike

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
*/

#include "common.h"
#include "platform.h"
#include "sound.h"
#include "voice.h"

#include <SDL.h>
#include <stdlib.h>

#define SAMPLE_16BIT_SHIFT 1
#define SECONDARY_BUFFER_SIZE 0x10000

#if XASH_EMSCRIPTEN
#include <emscripten.h>

/*
H9 web client: the sound on the audio thread.

SDL plays what SDL_SoundCallback gives it through a ScriptProcessorNode, and that runs on the page's main thread, the
thread every game frame runs on. A frame in progress, or the browser's own work for a key held down, holds the callback,
and a callback a buffer late leaves a hole in the sound: crackling, and a hang while the key stays down. Here the
mixer's output goes to the page instead (Module.audio, client.js audioFeed), which plays it from an AudioWorklet, a thread
of its own, and the position the mixer works from is that thread's clock. The mixer paints ahead of the play position as
always (S_UpdateChannels, 0.2 s): each time it has painted, the new frames are sent. A page without Module.audio, or a
browser without AudioWorklet, gets SDL's own device below, as before.
*/
static struct
{
	qboolean active;
	int      frames; // the ring's length in frames, a power of two
	int      pushed; // the first frame of the stream not yet sent
} h9a;

// The mixer counts samples in an int: before 2^30 frames (about 6.7 hours of sound) the clock starts over, as S_GetSoundtime's own 32 bit
// guard does
#define H9A_CLOCK_LIMIT 0x30000000

EM_JS( int, H9A_PageInit, ( int rate, int channels ), {
	var a = Module.audio;
	if( !a || !a.init )
		return 0;
	try {
		return a.init( rate, channels ) ? 1 : 0;
	} catch( e ) {
		return 0;
	}
});

// the frames the audio thread has played since its stream began
EM_JS( int, H9A_PagePosition, ( void ), {
	var a = Module.audio;
	return a ? a.position() : 0;
});

// frames [from, from + frames) of the stream, stereo 16 bit out of the ring that starts at ring, as floats
EM_JS( void, H9A_PagePush, ( const short *ring, int ring_frames, int from, int frames ), {
	var a = Module.audio;
	if( !a )
		return;
	var pcm = new Float32Array( frames * 2 );
	var at = from % ring_frames;
	var base = ring >> 1;
	for( var i = 0; i < frames; i++ ) {
		var j = base + at * 2;
		pcm[i * 2] = HEAP16[j] / 32768;
		pcm[i * 2 + 1] = HEAP16[j + 1] / 32768;
		if( ++at == ring_frames )
			at = 0;
	}
	a.push( from, pcm );
});

EM_JS( void, H9A_PageFlush, ( void ), {
	var a = Module.audio;
	if( a )
		a.flush();
});

// the page counts its played frames from 0 again (the clock is about to outgrow what the mixer counts in)
EM_JS( void, H9A_PageRebase, ( void ), {
	var a = Module.audio;
	if( a )
		a.rebase();
});

EM_JS( void, H9A_PageActivate, ( int active ), {
	var a = Module.audio;
	if( a )
		a.activate( !!active );
});

EM_JS( void, H9A_PageClose, ( void ), {
	var a = Module.audio;
	if( a )
		a.close();
});
#endif // XASH_EMSCRIPTEN

#define SDLash_IsAudioError( x ) (( x ) == 0)

/*
=======================================================================
Global variables. Must be visible to window-procedure function
so it can unlock and free the data block after it has been played.
=======================================================================
*/
static int sdl_dev;
static SDL_AudioDeviceID in_dev = 0;
static SDL_AudioFormat sdl_format;
static char sdl_backend_name[32];

static void SDL_SoundCallback( void *userdata, Uint8 *stream, int len )
{
	const int size = snd.samples << 1;
	int pos = snd.samplepos << 1;
	if( pos >= size )
		pos = snd.samplepos = 0;

	int wrapped = pos + len - size;

	if( wrapped < 0 )
	{
		memcpy( stream, snd.buffer + pos, len );
		snd.samplepos += len >> 1;
	}
	else
	{
		int remaining = size - pos;

		memcpy( stream, snd.buffer + pos, remaining );
		memcpy( stream + remaining, snd.buffer, wrapped );
		snd.samplepos = wrapped >> 1;
	}

	if( snd.samplepos >= size )
		snd.samplepos = 0;
}

/*
==================
SNDDMA_Init

Try to find a sound device to mix for.
Returns false if nothing is found.
==================
*/
qboolean SNDDMA_Init( void )
{
	SDL_AudioSpec obtained;
	int samplecount;

	// Modders often tend to use proprietary crappy solutions
	// like FMOD to play music, sometimes even with versions outdated by a few decades!
	//
	// As these bullshit sound engines prefer to use DirectSound, we ask SDL2 to do
	// the same. Why you might ask? If SDL2 uses another audio API, like WASAPI on
	// more modern versions of Windows, it breaks the logic inside Windows, and the whole
	// application could hang in WaitFor{Single,Multiple}Object function, either called by
	// SDL2 if FMOD was shut down first, or deep in dsound.dll->fmod.dll if SDL2 audio
	// was shut down first.
	//
	// I honestly don't know who is the real culprit here: FMOD, HL modders, Windows, SDL2
	// or us.
	//
	// Also, fun note, GoldSrc seems doesn't use SDL2 for sound stuff at all, as nothing
	// reference SDL audio functions there. It's probably has DirectSound backend, that's
	// why modders never stumble upon this bug.
#if XASH_WIN32
	const char *driver = "directsound";

	if( SDL_getenv( "SDL_AUDIODRIVER" ))
		driver = NULL; // let SDL2 and user decide

	SDL_SetHint( SDL_HINT_AUDIODRIVER, driver );
#endif // XASH_WIN32

	// even if we don't have PA
	// we still can safely set env variables
	SDL_setenv( "PULSE_PROP_application.name", GI->title, 1 );
	SDL_setenv( "PULSE_PROP_media.role", "game", 1 );

	// reinitialize SDL with our driver just in case
	if( SDL_WasInit( SDL_INIT_AUDIO ))
		SDL_QuitSubSystem( SDL_INIT_AUDIO );

	if( SDL_InitSubSystem( SDL_INIT_AUDIO ))
	{
		Con_Reportf( S_ERROR "Audio: SDL: %s \n", SDL_GetError( ) );
		return false;
	}

#if XASH_EMSCRIPTEN
	if( H9A_PageInit( SOUND_DMA_SPEED, 2 ))
	{
		samplecount = 0x10000; // 1.5 s of stereo frames: a stall of the page cannot wrap the position twice

		snd.format.speed    = SOUND_DMA_SPEED;
		snd.format.channels = 2;
		snd.format.width    = 2;
		snd.samples         = samplecount * 2;
		snd.buffer          = Mem_Calloc( sndpool, snd.samples * 2 );
		snd.samplepos       = 0;

		h9a.active = true;
		h9a.frames = samplecount;
		h9a.pushed = 0;

		Con_Printf( "Using the page's audio thread @ %d Hz\n", SOUND_DMA_SPEED );
		snd.initialized = true;
		snd.backend_name = "page audio thread";

		SNDDMA_Activate( true );

		return true;
	}
#endif

	SDL_AudioSpec desired =
	{
		.freq = SOUND_DMA_SPEED,
		.format = AUDIO_S16SYS,
#if XASH_EMSCRIPTEN
		// H9 web client: the browser plays this callback through a ScriptProcessorNode, which runs on the page's main
		// thread, the one the game's frames run on. With 1024 samples (21 ms) a frame that held the thread longer left a
		// hole in the sound: a held key, the scoreboard, a slower PC. 2048 samples are 43 ms
		.samples = 2048,
#else
		.samples = 1024,
#endif
		.channels = 2,
		.callback = SDL_SoundCallback,
	};

	sdl_dev = SDL_OpenAudioDevice( NULL, 0, &desired, &obtained, 0 );

	if( SDLash_IsAudioError( sdl_dev ))
	{
		Con_Printf( "Couldn't open SDL audio: %s\n", SDL_GetError( ) );
		return false;
	}

	if( obtained.format != AUDIO_S16SYS )
	{
		Con_Printf( "SDL audio format %d unsupported.\n", obtained.format );
		goto fail;
	}

	if( obtained.channels != 1 && obtained.channels != 2 )
	{
		Con_Printf( "SDL audio channels %d unsupported.\n", obtained.channels );
		goto fail;
	}

	snd.format.speed    = obtained.freq;
	snd.format.channels = obtained.channels;
	snd.format.width    = 2;
	samplecount = s_samplecount.value;
	if( !samplecount )
		samplecount = 0x8000;
	snd.samples         = samplecount * obtained.channels;
	snd.buffer          = Mem_Calloc( sndpool, snd.samples * 2 );
	snd.samplepos       = 0;

	sdl_format = obtained.format;

	Con_Printf( "Using SDL audio driver: %s @ %d Hz\n", SDL_GetCurrentAudioDriver( ), obtained.freq );
	Q_snprintf( sdl_backend_name, sizeof( sdl_backend_name ), "SDL (%s)", SDL_GetCurrentAudioDriver( ));
	snd.initialized = true;
	snd.backend_name = sdl_backend_name;

	SNDDMA_Activate( true );

	return true;

fail:
	SNDDMA_Shutdown( );
	return false;
}


/*
==============
SNDDMA_BeginPainting

Makes sure snd.buffer is valid
===============
*/
void SNDDMA_BeginPainting( void )
{
#if XASH_EMSCRIPTEN
	if( h9a.active )
	{
		// Where the audio thread has played to: every frame it has played since it began, not reduced to the ring. S_GetSoundtime only
		// unwraps a position that comes back round, and counts the wraps it sees: a clock that jumped by more than a ring between two
		// readings (the worklet starts seconds after the engine, a frame stalls for longer than the 1.5 s ring) would leave the mixer's
		// time a whole ring behind the audio thread's for good. Counted whole, the two are the same time.
		int pos = H9A_PagePosition();

		if( pos >= H9A_CLOCK_LIMIT )
		{
			H9A_PageRebase();
			h9a.pushed = 0;
			snd.paintedtime = 0x40000001; // S_GetSoundtime's 32 bit guard: it stops every sound and counts from the start
			pos = 0;
		}

		snd.samplepos = pos * 2;
		return;
	}
#endif
	SDL_LockAudioDevice( sdl_dev );
}

/*
==============
SNDDMA_Submit

Send sound to device if buffer isn't really the dma buffer
Also unlocks the dsound buffer
===============
*/
void SNDDMA_Submit( void )
{
#if XASH_EMSCRIPTEN
	if( h9a.active )
	{
		// what has been painted since the last time goes to the audio thread; what it has already played is of no use
		int from = Q_max( h9a.pushed, snd.soundtime );
		const int end = snd.paintedtime;

		if( end - from > h9a.frames )
			from = end - h9a.frames;
		if( end > from )
			H9A_PagePush( (const short *)snd.buffer, h9a.frames, from, end - from );
		if( end > h9a.pushed )
			h9a.pushed = end;
		return;
	}
#endif
	SDL_UnlockAudioDevice( sdl_dev );
}

/*
==============
SNDDMA_Shutdown

Reset the sound device for exiting
===============
*/
void SNDDMA_Shutdown( void )
{
	Con_Printf( "Shutting down audio.\n" );
	snd.initialized = false;

#if XASH_EMSCRIPTEN
	if( h9a.active )
	{
		h9a.active = false;
		H9A_PageClose();
	}
#endif

	if( sdl_dev )
	{
		SNDDMA_Activate( false );

		SDL_CloseAudioDevice( sdl_dev );
	}

	SDL_QuitSubSystem( SDL_INIT_AUDIO );

	if( snd.buffer )
	{
		Mem_Free( snd.buffer );
		snd.buffer = NULL;
	}
}

/*
===========
SNDDMA_Activate
Called when the main window gains or loses focus.
The window have been destroyed and recreated
between a deactivate and an activate.
===========
*/
void SNDDMA_Activate( qboolean active )
{
	if( !snd.initialized )
		return;

#if XASH_EMSCRIPTEN
	if( h9a.active )
	{
		H9A_PageActivate( active );
		return;
	}
#endif
	SDL_PauseAudioDevice( sdl_dev, !active );
}

#if XASH_EMSCRIPTEN
/*
===========
SNDDMA_H9Flush

S_ClearBuffer zeroed the ring: what the audio thread holds of it goes too
===========
*/
void SNDDMA_H9Flush( void )
{
	if( !h9a.active )
		return;

	H9A_PageFlush();
	h9a.pushed = Q_max( h9a.pushed, snd.paintedtime );
}
#endif

/*
===========
SDL_SoundInputCallback
===========
*/
static void SDL_SoundInputCallback( void *userdata, Uint8 *stream, int len )
{
	int size = Q_min( len, sizeof( voice.input_buffer ) - voice.input_buffer_pos );

	// engine can't keep up, skip audio
	if( !size )
		return;

	memcpy( voice.input_buffer + voice.input_buffer_pos, stream, size );
	voice.input_buffer_pos += size;
}

/*
===========
VoiceCapture_Init
===========
*/
qboolean VoiceCapture_Init( void )
{
	SDL_AudioSpec wanted, spec;

	if( !SDLash_IsAudioError( in_dev ))
	{
		VoiceCapture_Shutdown();
	}

	SDL_zero( wanted );
	wanted.freq = voice.samplerate;
	wanted.format = AUDIO_S16SYS;
	wanted.channels = VOICE_PCM_CHANNELS;
	wanted.samples = voice.frame_size;
	wanted.callback = SDL_SoundInputCallback;

	in_dev = SDL_OpenAudioDevice( NULL, SDL_TRUE, &wanted, &spec, 0 );

	if( SDLash_IsAudioError( in_dev ))
	{
		Con_Printf( "%s: error creating capture device (%s)\n", __func__, SDL_GetError() );
		return false;
	}
		
	Con_Printf( S_NOTE "%s: capture device creation success (%i: %s)\n", __func__, in_dev, SDL_GetAudioDeviceName( in_dev, SDL_TRUE ) );
	return true;
}

/*
===========
VoiceCapture_Activate
===========
*/
qboolean VoiceCapture_Activate( qboolean activate )
{
	if( SDLash_IsAudioError( in_dev ))
		return false;

	SDL_PauseAudioDevice( in_dev, activate ? SDL_FALSE : SDL_TRUE );
	return true;
}

/*
===========
VoiceCapture_Lock
===========
*/
qboolean VoiceCapture_Lock( qboolean lock )
{
	if( SDLash_IsAudioError( in_dev ))
		return false;

	if( lock ) SDL_LockAudioDevice( in_dev );
	else SDL_UnlockAudioDevice( in_dev );

	return true;
}

/*
==========
VoiceCapture_Shutdown
==========
*/
void VoiceCapture_Shutdown( void )
{
	if( SDLash_IsAudioError( in_dev ))
		return;

	SDL_CloseAudioDevice( in_dev );
	in_dev = 0;
}
