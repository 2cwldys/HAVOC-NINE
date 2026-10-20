/*
msr_webauth.h - tickets for players who join without Steam (msr-web)

The same file is used by the client (Xash3D) and by the game server (MSR-ReHLDS).

A service next to the game server (tools/bridge) gives a player a credential:

	id      32 bit account number, from a range Steam does not use
	expiry  unix time after which the credential is refused
	secret  HMAC-SHA256( server key, head )           head = "MSRW" 1 id expiry

To connect, the client sends a ticket in the place of the Steam ticket:

	head | HMAC-SHA256( secret, challenge )

The challenge is the number the server handed out for this connection attempt, so a
ticket seen on the wire is useless for another attempt and the secret is never sent
to the game server. The server recomputes the secret from its key and checks the proof.

All integers are little endian.
*/
#ifndef MSR_WEBAUTH_H
#define MSR_WEBAUTH_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define MSRW_HEAD_SIZE   13
#define MSRW_HASH_SIZE   32
#define MSRW_TICKET_SIZE ( MSRW_HEAD_SIZE + MSRW_HASH_SIZE )
#define MSRW_CRED_SIZE   ( 8 + MSRW_HASH_SIZE ) // id, expiry, secret: what the client keeps
#define MSRW_ID_MIN      0xF0000000u // Steam's account numbers are far below this

typedef struct
{
	uint32_t h[8];
	uint8_t  buf[64];
	uint64_t len;
	uint32_t n;
} msrw_sha256_t;

#define MSRW_ROR( x, n ) ((( x ) >> ( n )) | (( x ) << ( 32 - ( n ))))

static inline void msrw_sha256_block( msrw_sha256_t *s, const uint8_t *p )
{
	static const uint32_t k[64] =
	{
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	};
	uint32_t w[64], v[8], t1, t2;
	int i;

	for( i = 0; i < 16; i++ )
		w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | (uint32_t)p[4 * i + 3];
	for( ; i < 64; i++ )
	{
		uint32_t s0 = MSRW_ROR( w[i - 15], 7 ) ^ MSRW_ROR( w[i - 15], 18 ) ^ ( w[i - 15] >> 3 );
		uint32_t s1 = MSRW_ROR( w[i - 2], 17 ) ^ MSRW_ROR( w[i - 2], 19 ) ^ ( w[i - 2] >> 10 );
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}

	memcpy( v, s->h, sizeof( v ));
	for( i = 0; i < 64; i++ )
	{
		t1 = v[7] + ( MSRW_ROR( v[4], 6 ) ^ MSRW_ROR( v[4], 11 ) ^ MSRW_ROR( v[4], 25 )) + (( v[4] & v[5] ) ^ ( ~v[4] & v[6] )) + k[i] + w[i];
		t2 = ( MSRW_ROR( v[0], 2 ) ^ MSRW_ROR( v[0], 13 ) ^ MSRW_ROR( v[0], 22 )) + (( v[0] & v[1] ) ^ ( v[0] & v[2] ) ^ ( v[1] & v[2] ));
		v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1;
		v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
	}
	for( i = 0; i < 8; i++ )
		s->h[i] += v[i];
}

static inline void msrw_sha256_init( msrw_sha256_t *s )
{
	static const uint32_t h[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };

	memcpy( s->h, h, sizeof( h ));
	s->len = 0;
	s->n = 0;
}

static inline void msrw_sha256_update( msrw_sha256_t *s, const void *data, size_t len )
{
	const uint8_t *p = (const uint8_t *)data;

	s->len += len;
	while( len-- )
	{
		s->buf[s->n++] = *p++;
		if( s->n == 64 )
		{
			msrw_sha256_block( s, s->buf );
			s->n = 0;
		}
	}
}

static inline void msrw_sha256_final( msrw_sha256_t *s, uint8_t out[MSRW_HASH_SIZE] )
{
	uint64_t bits = s->len * 8;
	uint8_t pad = 0x80, zero = 0, lenbuf[8];
	int i;

	msrw_sha256_update( s, &pad, 1 );
	while( s->n != 56 )
		msrw_sha256_update( s, &zero, 1 );
	for( i = 0; i < 8; i++ )
		lenbuf[i] = (uint8_t)( bits >> ( 56 - 8 * i ));
	msrw_sha256_update( s, lenbuf, 8 );
	for( i = 0; i < 8; i++ )
	{
		out[4 * i] = (uint8_t)( s->h[i] >> 24 );
		out[4 * i + 1] = (uint8_t)( s->h[i] >> 16 );
		out[4 * i + 2] = (uint8_t)( s->h[i] >> 8 );
		out[4 * i + 3] = (uint8_t)s->h[i];
	}
}

static inline void msrw_hmac( const uint8_t *key, size_t keylen, const void *msg, size_t msglen, uint8_t out[MSRW_HASH_SIZE] )
{
	uint8_t k[64] = { 0 }, pad[64], inner[MSRW_HASH_SIZE];
	msrw_sha256_t s;
	int i;

	if( keylen > sizeof( k ))
	{
		msrw_sha256_init( &s );
		msrw_sha256_update( &s, key, keylen );
		msrw_sha256_final( &s, k );
	}
	else memcpy( k, key, keylen );

	for( i = 0; i < 64; i++ )
		pad[i] = k[i] ^ 0x36;
	msrw_sha256_init( &s );
	msrw_sha256_update( &s, pad, sizeof( pad ));
	msrw_sha256_update( &s, msg, msglen );
	msrw_sha256_final( &s, inner );

	for( i = 0; i < 64; i++ )
		pad[i] = k[i] ^ 0x5c;
	msrw_sha256_init( &s );
	msrw_sha256_update( &s, pad, sizeof( pad ));
	msrw_sha256_update( &s, inner, sizeof( inner ));
	msrw_sha256_final( &s, out );
}

static inline void msrw_put32( uint8_t *p, uint32_t v )
{
	p[0] = (uint8_t)v; p[1] = (uint8_t)( v >> 8 ); p[2] = (uint8_t)( v >> 16 ); p[3] = (uint8_t)( v >> 24 );
}

static inline uint32_t msrw_get32( const uint8_t *p )
{
	return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static inline void msrw_head( uint8_t head[MSRW_HEAD_SIZE], uint32_t id, uint32_t expiry )
{
	memcpy( head, "MSRW", 4 );
	head[4] = 1; // format version
	msrw_put32( head + 5, id );
	msrw_put32( head + 9, expiry );
}

static inline void msrw_proof( const uint8_t secret[MSRW_HASH_SIZE], uint32_t challenge, uint8_t out[MSRW_HASH_SIZE] )
{
	uint8_t c[4];

	msrw_put32( c, challenge );
	msrw_hmac( secret, MSRW_HASH_SIZE, c, sizeof( c ), out );
}

// client: cred is what the service handed out (MSRW_CRED_SIZE bytes)
static inline void msrw_ticket( uint8_t ticket[MSRW_TICKET_SIZE], const uint8_t *cred, uint32_t challenge )
{
	msrw_head( ticket, msrw_get32( cred ), msrw_get32( cred + 4 ));
	msrw_proof( cred + 8, challenge, ticket + MSRW_HEAD_SIZE );
}

// server: 0 = not one of our tickets, 1 = valid (*id is set), -1 = ours and refused
static inline int msrw_verify( const uint8_t *ticket, size_t len, const uint8_t *key, size_t keylen, uint32_t challenge, uint32_t now, uint32_t *id )
{
	uint8_t secret[MSRW_HASH_SIZE], proof[MSRW_HASH_SIZE], diff = 0;
	uint32_t expiry;
	int i;

	if( len < 4 || memcmp( ticket, "MSRW", 4 ))
		return 0;
	if( len < MSRW_TICKET_SIZE || ticket[4] != 1 || !key || keylen < 16 )
		return -1;

	*id = msrw_get32( ticket + 5 );
	expiry = msrw_get32( ticket + 9 );
	if( *id < MSRW_ID_MIN || expiry < now )
		return -1;

	msrw_hmac( key, keylen, ticket, MSRW_HEAD_SIZE, secret );
	msrw_proof( secret, challenge, proof );
	for( i = 0; i < MSRW_HASH_SIZE; i++ )
		diff |= proof[i] ^ ticket[MSRW_HEAD_SIZE + i];

	return diff ? -1 : 1;
}

#endif // MSR_WEBAUTH_H
