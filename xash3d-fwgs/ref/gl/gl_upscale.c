/*
gl_upscale.c - h9_upscale: the 3D scene upscaled to the window with AMD FidelityFX Super Resolution 1.0
Copyright (C) 2026 Project HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

The fragment shaders in this file are a port of AMD FidelityFX Super Resolution 1.0 (FSR 1), its two passes EASU and RCAS,
from ffx-fsr/ffx_fsr1.h and ffx-fsr/ffx_a.h, version v1.20210629, https://github.com/GPUOpen-Effects/FidelityFX-FSR,
which AMD publishes under this licence:

	FidelityFX Super Resolution Sample

	Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files(the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions :
	The above copyright notice and this permission notice shall be included in
	all copies or substantial portions of the Software.
	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
	THE SOFTWARE.
*/

#include "gl_local.h"

#if !XASH_GLES

/*
================
h9_upscale

The 3D scene is drawn into the scene target, r_scene_scale of the window's size, and GL_BindScreenTarget carries it into the
screen target, the window's size, where the HUD is drawn afterwards. GL_BlitTarget asks GL_UpscaleBlit first for that one blit:
with h9_upscale on, FSR 1 draws the frame in place of it, and the blit is the answer whenever this file cannot.

	scene smaller than the screen    EASU (an edge adaptive upsampling) into a target of the screen's size, RCAS (a
	                                 sharpening) from it into the screen target; with h9_upscale_sharp 0 EASU draws into the
	                                 screen target itself
	scene of the screen's size       RCAS alone, from the scene into the screen target (nothing with h9_upscale_sharp 0)
	scene bigger than the screen     the blit: FSR does not downscale

The shaders are GLSL 1.10, which every driver with GL_ARB_shading_language_100 takes, in a compatibility context. They read
the scene with plain texture fetches at texel centres (no textureGather, no texelFetch), take their position from gl_FragCoord
and a full-screen quad from the vertex stage, and need no vendor extension. Everything else (targets, bindings, shader objects)
goes through the same pgl* pointers as the rest of the renderer.

AMD's code approximates a few reciprocals and a reciprocal square root with integer bit tricks (APrxLoRcpF1, APrxLoRsqF1,
APrxMedRcpF1); these shaders use 1.0 / x and inversesqrt() instead, and where AMD's RCAS divides by zero and relies on the
hardware's max() dropping the NaN, the same result is written out with a test.

Anything that cannot be done (no shader objects, a shader that does not compile or link, a target that cannot be made) is said
in one console line, and the blit stays in use from then on, with no retry on the next frame; h9_upscale 0 and then 1 tries
again. The cvar keeps the value the player gave it.
================
*/

#define UPSCALE_MAX_LOG 256

typedef struct
{
	GLhandleARB program;
	GLint tex;    // uniform sampler2D
	GLint con0;   // uniform vec4, EASU only
	GLint inv;    // uniform vec2: 1 / the size of the picture read
	GLint sharp;  // uniform float, RCAS only
} gl_upscale_pass_t;

static struct
{
	qboolean failed;           // the first thing that could not be done: the blit from then on, until h9_upscale goes to 0
	qboolean built;            // both programs are linked
	gl_upscale_pass_t easu;
	gl_upscale_pass_t rcas;
	gl_rendertarget_t mid;     // EASU's picture while RCAS follows: the screen's size
} up;

// one vertex stage for both passes: the quad is given in clip space
static const char upscale_vs[] =
	"#version 110\n"
	"void main()\n"
	"{\n"
	"	gl_Position = gl_Vertex;\n"
	"}\n";

// EASU: ffx_fsr1.h, FsrEasuF, with the 12 taps fetched one by one at texel centres
static const char upscale_easu_fs[] =
	"#version 110\n"
	"uniform sampler2D uTex;\n"
	"uniform vec4 uCon0;\n"           // FsrEasuCon con0: xy = input size / output size, zw = 0.5 * that - 0.5
	"uniform vec2 uInv;\n"            // 1 / input size
	"\n"
	"vec3 easuFetch(vec2 fp, float dx, float dy)\n"
	"{\n"
	"	return texture2D(uTex, (fp + vec2(dx + 0.5, dy + 0.5)) * uInv).rgb;\n"
	"}\n"
	"\n"
	"float easuLuma(vec3 c)\n"
	"{\n"
	"	return c.b * 0.5 + (c.r * 0.5 + c.g);\n"
	"}\n"
	"\n"
	"float easuRcp(float x)\n"
	"{\n"
	"	return 1.0 / max(x, 1.0e-30);\n"
	"}\n"
	"\n"
	"void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE)\n"
	"{\n"
	"	float dc = lD - lC;\n"
	"	float cb = lC - lB;\n"
	"	float lenX = easuRcp(max(abs(dc), abs(cb)));\n"
	"	float dirX = lD - lB;\n"
	"	dir.x += dirX * w;\n"
	"	lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);\n"
	"	lenX *= lenX;\n"
	"	len += lenX * w;\n"
	"	float ec = lE - lC;\n"
	"	float ca = lC - lA;\n"
	"	float lenY = easuRcp(max(abs(ec), abs(ca)));\n"
	"	float dirY = lE - lA;\n"
	"	dir.y += dirY * w;\n"
	"	lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);\n"
	"	lenY *= lenY;\n"
	"	len += lenY * w;\n"
	"}\n"
	"\n"
	"void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c)\n"
	"{\n"
	"	vec2 v;\n"
	"	v.x = (off.x * dir.x) + (off.y * dir.y);\n"
	"	v.y = (off.x * (-dir.y)) + (off.y * dir.x);\n"
	"	v *= len;\n"
	"	float d2 = v.x * v.x + v.y * v.y;\n"
	"	d2 = min(d2, clp);\n"
	"	float wB = (2.0 / 5.0) * d2 + (-1.0);\n"
	"	float wA = lob * d2 + (-1.0);\n"
	"	wB *= wB;\n"
	"	wA *= wA;\n"
	"	wB = (25.0 / 16.0) * wB + (-(25.0 / 16.0 - 1.0));\n"
	"	float w = wB * wA;\n"
	"	aC += c * w;\n"
	"	aW += w;\n"
	"}\n"
	"\n"
	"void main()\n"
	"{\n"
	"	vec2 pp = floor(gl_FragCoord.xy) * uCon0.xy + uCon0.zw;\n"
	"	vec2 fp = floor(pp);\n"
	"	pp -= fp;\n"
	"\n"
	"	vec3 b = easuFetch(fp, 0.0, -1.0);\n"
	"	vec3 c = easuFetch(fp, 1.0, -1.0);\n"
	"	vec3 e = easuFetch(fp, -1.0, 0.0);\n"
	"	vec3 f = easuFetch(fp, 0.0, 0.0);\n"
	"	vec3 g = easuFetch(fp, 1.0, 0.0);\n"
	"	vec3 h = easuFetch(fp, 2.0, 0.0);\n"
	"	vec3 i = easuFetch(fp, -1.0, 1.0);\n"
	"	vec3 j = easuFetch(fp, 0.0, 1.0);\n"
	"	vec3 k = easuFetch(fp, 1.0, 1.0);\n"
	"	vec3 l = easuFetch(fp, 2.0, 1.0);\n"
	"	vec3 n = easuFetch(fp, 0.0, 2.0);\n"
	"	vec3 o = easuFetch(fp, 1.0, 2.0);\n"
	"\n"
	"	float bL = easuLuma(b);\n"
	"	float cL = easuLuma(c);\n"
	"	float eL = easuLuma(e);\n"
	"	float fL = easuLuma(f);\n"
	"	float gL = easuLuma(g);\n"
	"	float hL = easuLuma(h);\n"
	"	float iL = easuLuma(i);\n"
	"	float jL = easuLuma(j);\n"
	"	float kL = easuLuma(k);\n"
	"	float lL = easuLuma(l);\n"
	"	float nL = easuLuma(n);\n"
	"	float oL = easuLuma(o);\n"
	"\n"
	"	vec2 dir = vec2(0.0);\n"
	"	float len = 0.0;\n"
	"	easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);\n"
	"	easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);\n"
	"	easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);\n"
	"	easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);\n"
	"\n"
	"	vec2 dir2 = dir * dir;\n"
	"	float dirR = dir2.x + dir2.y;\n"
	"	bool zro = dirR < 1.0 / 32768.0;\n"
	"	dirR = inversesqrt(max(dirR, 1.0 / 32768.0));\n"
	"	dirR = zro ? 1.0 : dirR;\n"
	"	dir.x = zro ? 1.0 : dir.x;\n"
	"	dir *= vec2(dirR);\n"
	"	len = len * 0.5;\n"
	"	len *= len;\n"
	"	float stretch = (dir.x * dir.x + dir.y * dir.y) * easuRcp(max(abs(dir.x), abs(dir.y)));\n"
	"	vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 + (-0.5) * len);\n"
	"	float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;\n"
	"	float clp = easuRcp(lob);\n"
	"\n"
	"	vec3 min4 = min(min(min(f, g), j), k);\n"
	"	vec3 max4 = max(max(max(f, g), j), k);\n"
	"\n"
	"	vec3 aC = vec3(0.0);\n"
	"	float aW = 0.0;\n"
	"	easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);\n"
	"	easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);\n"
	"	easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);\n"
	"	easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);\n"
	"	easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);\n"
	"	easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);\n"
	"	easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);\n"
	"	easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);\n"
	"	easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);\n"
	"	easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);\n"
	"	easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);\n"
	"	easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);\n"
	"\n"
	"	gl_FragColor = vec4(min(max4, max(min4, aC * (1.0 / aW))), 1.0);\n"
	"}\n";

// RCAS: ffx_fsr1.h, FsrRcasF without FSR_RCAS_DENOISE and FSR_RCAS_PASSTHROUGH_ALPHA
static const char upscale_rcas_fs[] =
	"#version 110\n"
	"uniform sampler2D uTex;\n"
	"uniform vec2 uInv;\n"            // 1 / size of the picture (it is read at the size it is written)
	"uniform float uSharp;\n"         // FsrRcasCon con.x: 2 to the power of minus the stops, 1 = the strongest
	"\n"
	"vec3 rcasFetch(float dx, float dy)\n"
	"{\n"
	"	return texture2D(uTex, (gl_FragCoord.xy + vec2(dx, dy)) * uInv).rgb;\n"
	"}\n"
	"\n"
	// the sharpening weight of one channel: where the ring's maximum (minimum) is 0 (1), AMD's reciprocal is infinite and the
	// product with 0 a NaN, which max() on a GPU drops; the guards give that result without making a NaN
	"float rcasLobe(float mn4, float mx4, float e)\n"
	"{\n"
	"	float hitMin = 1.0e30;\n"
	"	if (mx4 > 0.0)\n"
	"		hitMin = min(mn4, e) * (1.0 / (4.0 * mx4));\n"
	"	float hitMax = -1.0e30;\n"
	"	float den = 4.0 * mn4 + (-1.0 * 4.0);\n"
	"	if (den != 0.0)\n"
	"		hitMax = (1.0 - max(mx4, e)) * (1.0 / den);\n"
	"	return max(-hitMin, hitMax);\n"
	"}\n"
	"\n"
	"void main()\n"
	"{\n"
	"	vec3 b = rcasFetch(0.0, -1.0);\n"
	"	vec3 d = rcasFetch(-1.0, 0.0);\n"
	"	vec3 e = rcasFetch(0.0, 0.0);\n"
	"	vec3 f = rcasFetch(1.0, 0.0);\n"
	"	vec3 h = rcasFetch(0.0, 1.0);\n"
	"\n"
	"	vec3 mn4 = min(min(min(b, d), f), h);\n"
	"	vec3 mx4 = max(max(max(b, d), f), h);\n"
	"\n"
	"	float lobeR = rcasLobe(mn4.r, mx4.r, e.r);\n"
	"	float lobeG = rcasLobe(mn4.g, mx4.g, e.g);\n"
	"	float lobeB = rcasLobe(mn4.b, mx4.b, e.b);\n"
	"	float lobe = max(-(0.25 - (1.0 / 16.0)), min(max(lobeR, max(lobeG, lobeB)), 0.0)) * uSharp;\n"
	"\n"
	"	float rcpL = 1.0 / (4.0 * lobe + 1.0);\n"
	"	gl_FragColor = vec4((lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL, 1.0);\n"
	"}\n";

static void GL_UpscaleFreeTarget( void )
{
	if( up.mid.fbo )
		pglDeleteFramebuffers( 1, &up.mid.fbo );

	if( up.mid.texnum )
		GL_FreeTexture( up.mid.texnum );

	memset( &up.mid, 0, sizeof( up.mid ));
}

static void GL_UpscaleFreePass( gl_upscale_pass_t *pass )
{
	if( pass->program )
		pglDeleteObjectARB( pass->program );

	memset( pass, 0, sizeof( *pass ));
}

// the programs and the target, when they exist; the failure latch stays as it is
static void GL_UpscaleFree( void )
{
	GL_UpscaleFreeTarget();
	GL_UpscaleFreePass( &up.easu );
	GL_UpscaleFreePass( &up.rcas );
	up.built = false;
}

// said once: the reason, the console line, and from then on the blit
static void GL_UpscaleFail( const char *what, const char *detail )
{
	GL_UpscaleFree();
	up.failed = true;

	if( detail && detail[0] )
		gEngfuncs.Con_Printf( S_WARN "h9_upscale: %s (%s), using the plain scene blit (h9_upscale 0 and then 1 tries again)\n", what, detail );
	else
		gEngfuncs.Con_Printf( S_WARN "h9_upscale: %s, using the plain scene blit (h9_upscale 0 and then 1 tries again)\n", what );
}

// the driver's log of a shader or program, on one line
static void GL_UpscaleLog( GLhandleARB obj, char *log, size_t size )
{
	GLsizei length = 0;
	size_t i;

	log[0] = '\0';
	pglGetInfoLogARB( obj, (GLsizei)( size - 1 ), &length, log );

	if( length < 0 || (size_t)length >= size )
		length = 0;

	log[length] = '\0';

	for( i = 0; log[i]; i++ )
	{
		if( log[i] == '\n' || log[i] == '\r' || log[i] == '\t' )
			log[i] = ' ';
	}
}

static GLhandleARB GL_UpscaleCompile( GLenum type, const char *source, char *log, size_t size )
{
	GLhandleARB shader = pglCreateShaderObjectARB( type );
	GLint ok = 0;

	log[0] = '\0';

	if( !shader )
		return 0;

	pglShaderSourceARB( shader, 1, &source, NULL );
	pglCompileShaderARB( shader );
	pglGetObjectParameterivARB( shader, GL_OBJECT_COMPILE_STATUS_ARB, &ok );

	if( !ok )
	{
		GL_UpscaleLog( shader, log, size );
		pglDeleteObjectARB( shader );
		return 0;
	}

	return shader;
}

static qboolean GL_UpscaleBuildPass( gl_upscale_pass_t *pass, const char *name, const char *fragment )
{
	char log[UPSCALE_MAX_LOG];
	char what[64];
	GLhandleARB vs, fs, program;
	GLint ok = 0;

	vs = GL_UpscaleCompile( GL_VERTEX_SHADER_ARB, upscale_vs, log, sizeof( log ));
	if( !vs )
	{
		Q_snprintf( what, sizeof( what ), "the %s vertex shader did not compile", name );
		GL_UpscaleFail( what, log );
		return false;
	}

	fs = GL_UpscaleCompile( GL_FRAGMENT_SHADER_ARB, fragment, log, sizeof( log ));
	if( !fs )
	{
		Q_snprintf( what, sizeof( what ), "the %s fragment shader did not compile", name );
		pglDeleteObjectARB( vs );
		GL_UpscaleFail( what, log );
		return false;
	}

	program = pglCreateProgramObjectARB();
	if( program )
	{
		pglAttachObjectARB( program, vs );
		pglAttachObjectARB( program, fs );
		pglLinkProgramARB( program );
		pglGetObjectParameterivARB( program, GL_OBJECT_LINK_STATUS_ARB, &ok );
	}

	// attached shaders live as long as the program
	pglDeleteObjectARB( vs );
	pglDeleteObjectARB( fs );

	if( !ok )
	{
		Q_snprintf( what, sizeof( what ), "the %s program did not link", name );
		log[0] = '\0';
		if( program )
		{
			GL_UpscaleLog( program, log, sizeof( log ));
			pglDeleteObjectARB( program );
		}
		GL_UpscaleFail( what, log );
		return false;
	}

	pass->program = program;
	pass->tex = pglGetUniformLocationARB( program, "uTex" );
	pass->con0 = pglGetUniformLocationARB( program, "uCon0" );
	pass->inv = pglGetUniformLocationARB( program, "uInv" );
	pass->sharp = pglGetUniformLocationARB( program, "uSharp" );

	return true;
}

static qboolean GL_UpscaleBuild( void )
{
	if( glConfig.context == CONTEXT_TYPE_GL_CORE )
	{
		GL_UpscaleFail( "needs an OpenGL compatibility context, and this one is a core context", NULL );
		return false;
	}

	if( !GL_Support( GL_SHADER_OBJECTS_EXT ) || !GL_Support( GL_SHADER_GLSL100_EXT ))
	{
		GL_UpscaleFail( "this OpenGL driver has no shader objects (GL_ARB_shader_objects, GL_ARB_shading_language_100)", NULL );
		return false;
	}

	if( !GL_UpscaleBuildPass( &up.easu, "EASU", upscale_easu_fs ) || !GL_UpscaleBuildPass( &up.rcas, "RCAS", upscale_rcas_fs ))
		return false;

	up.built = true;
	gEngfuncs.Con_Reportf( "h9_upscale: FSR 1 (EASU and RCAS) built\n" );
	return true;
}

// EASU's picture: a colour texture and a framebuffer of its own, the way GL_CreateRenderTarget makes the engine's targets
static qboolean GL_UpscaleMakeTarget( int width, int height )
{
	const gl_texture_t *tex;
	GLenum status;

	memset( &up.mid, 0, sizeof( up.mid ));

	up.mid.texnum = GL_CreateTexture( "*fbo_upscale", width, height, NULL, TF_NOMIPMAP|TF_CLAMP|TF_HAS_ALPHA );
	if( !up.mid.texnum )
		return false;

	tex = R_GetTexture( up.mid.texnum );
	if( tex->width != width || tex->height != height )
	{
		GL_UpscaleFreeTarget();
		return false;
	}

	pglGenFramebuffers( 1, &up.mid.fbo );
	pglBindFramebuffer( GL_FRAMEBUFFER, up.mid.fbo );
	pglFramebufferTexture2D( GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex->texnum, 0 );
	status = pglCheckFramebufferStatus( GL_FRAMEBUFFER );
	pglBindFramebuffer( GL_FRAMEBUFFER, 0 );

	if( status != GL_FRAMEBUFFER_COMPLETE )
	{
		GL_UpscaleFreeTarget();
		return false;
	}

	up.mid.width = width;
	up.mid.height = height;
	return true;
}

// what the quad needs from the state the 3D passes left: no culling, no depth test, no blending, no alpha test
static void GL_UpscaleSetState( void )
{
	GL_Cull( GL_NONE );
	pglDisable( GL_DEPTH_TEST );
	pglDisable( GL_BLEND );
	pglDisable( GL_ALPHA_TEST );
}

// one pass: the texture src_texnum (src_w x src_h, read with nearest filtering) through the program into dst_fbo (dst_w x dst_h)
static void GL_UpscaleDraw( const gl_upscale_pass_t *pass, int src_texnum, int src_w, int src_h, GLuint dst_fbo, int dst_w, int dst_h, float sharp )
{
	pglBindFramebuffer( GL_FRAMEBUFFER, dst_fbo );
	pglViewport( 0, 0, dst_w, dst_h );

	GL_Bind( XASH_TEXTURE0, src_texnum );
	pglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST );
	pglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST );

	pglUseProgramObjectARB( pass->program );
	pglUniform1iARB( pass->tex, XASH_TEXTURE0 );
	pglUniform2fARB( pass->inv, 1.0f / src_w, 1.0f / src_h );

	if( pass->con0 >= 0 )
	{
		// FsrEasuCon, con0: the source position of an output pixel is pixel * scale + offset, in source texels
		float sx = (float)src_w / (float)dst_w;
		float sy = (float)src_h / (float)dst_h;

		pglUniform4fARB( pass->con0, sx, sy, 0.5f * sx - 0.5f, 0.5f * sy - 0.5f );
	}

	if( pass->sharp >= 0 )
		pglUniform1fARB( pass->sharp, sharp );

	pglBegin( GL_QUADS );
		pglVertex2f( -1.0f, -1.0f );
		pglVertex2f( 1.0f, -1.0f );
		pglVertex2f( 1.0f, 1.0f );
		pglVertex2f( -1.0f, 1.0f );
	pglEnd();

	pglUseProgramObjectARB( 0 );
}

/*
================
GL_UpscaleBlit

draws the scene's frame into the screen target when h9_upscale is on and it can; false leaves the blit to the caller
================
*/
qboolean GL_UpscaleBlit( const gl_rendertarget_t *scene, const gl_rendertarget_t *screen )
{
	float sharp;
	qboolean scaling;

	if( h9_upscale.value < 1.0f )
	{
		// turned off after it ran: the programs and the target go, and a failure is forgotten
		if( up.built || up.mid.fbo )
			GL_UpscaleFree();

		up.failed = false;
		return false;
	}

	if( up.failed )
		return false;

	// FSR upscales: a scene bigger than the screen (r_scene_scale above 1) is downsampled by the blit
	if( scene->width > screen->width || scene->height > screen->height )
		return false;

	scaling = scene->width < screen->width || scene->height < screen->height;
	sharp = bound( 0.0f, h9_upscale_sharp.value, 1.0f );

	// the scene already is the screen's size and there is nothing to sharpen
	if( !scaling && sharp <= 0.0f )
		return false;

	if( !up.built && !GL_UpscaleBuild( ))
		return false;

	if( scaling && sharp > 0.0f && ( up.mid.width != screen->width || up.mid.height != screen->height ))
	{
		GL_UpscaleFreeTarget();

		if( !GL_UpscaleMakeTarget( screen->width, screen->height ))
		{
			GL_UpscaleFail( "can't make its render target", NULL );
			return false;
		}
	}

	GL_UpscaleSetState();

	if( !scaling )
	{
		GL_UpscaleDraw( &up.rcas, scene->texnum, scene->width, scene->height, screen->fbo, screen->width, screen->height, sharp );
	}
	else if( sharp > 0.0f )
	{
		GL_UpscaleDraw( &up.easu, scene->texnum, scene->width, scene->height, up.mid.fbo, up.mid.width, up.mid.height, 0.0f );
		GL_UpscaleDraw( &up.rcas, up.mid.texnum, up.mid.width, up.mid.height, screen->fbo, screen->width, screen->height, sharp );
	}
	else
	{
		GL_UpscaleDraw( &up.easu, scene->texnum, scene->width, scene->height, screen->fbo, screen->width, screen->height, 0.0f );
	}

	return true;
}

/*
================
GL_UpscaleShutdown

frees what the upscaler holds, before the context goes
================
*/
void GL_UpscaleShutdown( void )
{
	GL_UpscaleFree();
	memset( &up, 0, sizeof( up ));
}

#else // XASH_GLES

// the OpenGL ES and WebGL renderers have no upscaler: the cvars exist, and say so when they are on
qboolean GL_UpscaleBlit( const gl_rendertarget_t *scene, const gl_rendertarget_t *screen )
{
	static qboolean said;

	(void)scene;
	(void)screen;

	if( h9_upscale.value >= 1.0f && !said )
	{
		said = true;
		gEngfuncs.Con_Printf( S_WARN "h9_upscale: this renderer has no upscaler, using the plain scene blit\n" );
	}

	return false;
}

void GL_UpscaleShutdown( void )
{
}

#endif // !XASH_GLES
