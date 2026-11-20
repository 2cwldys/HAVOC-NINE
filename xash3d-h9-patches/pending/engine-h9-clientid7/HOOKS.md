# h9_clientid as seven base36 characters

NOT BUILT and NOT in the patch chain. `../README.md` says why this is a folder rather than a
`.patch`. The web half of this change is already on `main` and is live-safe on its own: it
recognises both the old and the new form, so there is no ordering requirement between them.

All line numbers are against the current `D:\Downloads\TSM\xash3d-fwgs` tree.

---

## Why

`h9_clientid` goes into **userinfo**, which is one 256-byte string shared by every key the
client sets. The full 32 hex of an MD5 spent an eighth of it on a single key.

Seven hex would have been the obvious shortening and is not safe. `h9web/lib/clientids.js`
looks a client id up against **every account**, not the players on the server:

```js
for (const [id, pid] of pids) map.set(serverClientId(pid, a.bytes), id);
```

so the birthday bound applies to the whole account table. 16^7 is 268 million, which turns over
at about nineteen thousand accounts, and a clash is `map.set` silently overwriting -- one
account resolving to another from then on, with nothing logged. 36^7 is 78 billion: 292 times
the room in the same seven characters.

Base62 is larger again and is wrong here. Ids are compared after `toLowerCase()`
(`modules/presence/community.js:521`), which would fold the alphabet back down and break
matching at the same time.

---

## The change

One new static function and two lines, both in `engine/client/identification.c`.

```c
// H9: h9_clientid, seven base36 characters. See ../README.md and the web half in
// h9web/lib/playerid.js serverClientId7(), which must agree with this byte for byte.
// First 8 bytes of the digest, big-endian, reduced modulo 36^7, seven digits most
// significant first. The bias from reducing a 64-bit value into 36^7 is about one part in
// 10^9 and is not worth correcting.
static void ID_Base36_7( char *out, const byte digest[16] )
{
	static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
	uint64_t v = 0;
	int i;

	for( i = 0; i < 8; i++ )
		v = ( v << 8 ) | digest[i];

	v %= 78364164096ULL;                  // 36^7

	for( i = 6; i >= 0; i-- )
	{
		out[i] = digits[v % 36];
		v /= 36;
	}
	out[7] = '\0';
}
```

and the tail of `ID_GetMD5ForAddressEx` (line ~738):

```c
 	MD5Final( md5, &ctx );
-	Q_strnlwr( MD5_Print( md5 ), key, size );
+	if( size < 8 ) return;                // no room for seven characters and a NUL
+	ID_Base36_7( key, md5 );
 }
```

**No call site changes.** `cl_h9link.c:672`, `cl_h9listen.c:156` and `cl_main.c:1583` all pass
buffers larger than eight bytes already (`char key[64]`, `string h9key`), so they are untouched.

`ID_GetMD5ForAddress` -- the other function in that file, for the hardware-derived id -- is
deliberately **not** changed. Only the h9 client id is shortened.

---

## Check it against this vector

A mismatch between the two halves rejects every client and looks exactly like a bad id, so
check one known value before trusting it:

```
cl_h9_userid   0123456789abcdef0123456789abcdef
server         151.243.93.27          (bytes 97 f3 5d 1b)

old, 32 hex    21e7215375715a27ae2d8b907bd1dc33
new, 7 base36  nyzfz1j
```

`node -e "import('./h9web/lib/playerid.js').then(m=>console.log(m.serverClientId7('0123456789abcdef0123456789abcdef',[151,243,93,27])))"`
already prints `nyzfz1j`. Connect a built client to that address and `h9_clientid` in its
userinfo must read the same seven characters.

---

## STOP: what this breaks, and why the engine half must not ship yet

The web half is safe on its own because it **adds** the new form. Nothing else does. Every
consumer below assumes 32 lowercase **hex**, and seven base36 fails both halves of that
assumption -- the length check, and the character check, since base36 contains `g` to `z`.

**AMX plugins.** Two hard failures found by reading, not guessing:

```c
// h9_community.sma  cid_ok()  -- fails on BOTH counts
if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
return i == 32;

// h9_compete.sma  client_id()
get_user_info(id, "h9_clientid", out, 32);
if (strlen(out) != 32) { out[0] = 0; return false; }
```

`h9_community` would stop relaying, `h9_compete` would drop every player from match rosters
and ratings.

**This is now fixed.** `include/h9_clientid.inc` holds one definition of the shape --
`h9_cid_ok()`, which takes 32 hex or 7 base36 and lowercases in place as the old checks did --
and five plugins use it: `h9_community` (its `cid_ok` delegates), `h9_compete`, `h9_rank`,
`h9_link` and `ts_floatchat`. All five compile.

`h9_motd` and `h9_presence` read the key and needed nothing: motd only tests that it is
non-empty, with an `[8]` buffer that already suited the short form, and presence formats it
into a comparison string without caring how long it is.

They still have to be **rebuilt and deployed** before the engine changes, but nothing on the
wire has moved, so deploying them now changes no behaviour at all.

**EntMod needs no code change.** This was worth checking rather than assuming, and the first
reading of it here was wrong. `src/h9/h9_admin.cpp` matches an admin line by string compare:

```cpp
const char *h9id = INFOKEY_VALUE(GET_INFOKEYBUFFER(player), "h9_clientid");
if (h9id && h9id[0] && strcmp(field1, h9id) == 0) return 1;
```

`strcmp` has no opinion about length, and `entmod_myid` prints back whatever the client
published. So **neither `EntMod_MM.dll` nor `EntMod_i386.so` has to be rebuilt** and their
`.patch` notes are untouched.

**Admin files, and this one cannot be fixed in code.** `DF_admins.example.txt` documents field
1 of an admin line as "an H9XASH id (h9_clientid), 32 hex". Every admin currently identified
that way stops matching the moment the engine changes, and **loses admin** until their line is
rewritten with the new seven-character id. Any live `DF_admins.txt` has to be updated by hand,
on every server, in step with the engine.

**Also:** `CVARS.md` documents the key's shape.

### The order this has to happen in

1. Web half accepts both forms -- **done**, and safe on its own.
2. Plugins accept either form -- **done**, five changed, all compile. They still have to be
   **built and deployed**, but since nothing on the wire has moved, deploying them changes no
   behaviour.
3. Only then build and ship the engine patch. Until it is built nothing sends the short form,
   so there is no hurry and no risk in waiting.
4. Update `DF_admins.txt` on each server. This one is manual and cannot be fixed in code: an
   admin line keyed by the old 32-hex id stops matching the moment the engine changes.
   `entmod_myid` prints a player their current id, so an admin can read the new one and the
   line can be updated in place -- or both ids can be listed, since any line whose field 1
   matches grants the admin.

Step 3 before step 2 would take relaying and match ratings down together. Everything up to
step 2 is now done, so that ordering mistake is no longer possible by accident.

## What is already done, on main

- `h9web/lib/playerid.js` -- `serverClientId7()`, the matching encoder
- `h9web/lib/clientids.js` -- indexes **both** forms on the full build and on the
  account-created and account-deleted paths, and reports `size` as the account count rather
  than the map's entry count, which doubled
- `h9web/lib/accounts.js` -- `serverIds()` returns `clientId7` beside `clientId`
- `modules/presence/{index,community,compete}.js` -- `CLIENT_ID` accepts either form
- `src/include/h9_clientid.inc` -- `h9_cid_ok()`, one definition of the shape
- `src/{h9_community,h9_compete,h9_rank,h9_link,ts_floatchat}.sma` -- all five use it, all compile

h9web's own suite passes with these in: 495 tests, 0 failures. The one failure along the way was
`clientIdIndex ... size`, which caught the doubled map honestly and is why `size` now counts
accounts.

Once every client is on a base36 engine, the hex entry in `clientids.js` and the hex branch of
`CLIENT_ID` can be dropped. Nothing forces that; carrying both costs one extra map entry per
account.

## What a player with an old id experiences

**Nothing that matters, and no re-authentication.** An earlier draft of this file said a linked
player would have to re-authenticate. That was written before the web half indexed both shapes
and it is wrong.

The account is identified by `cl_h9_userid`, which does not change. The client id is derived
from it on every connect -- `MD5(cl_h9_userid + the server's address bytes)` -- and is never
stored on the client, so there is nothing stale to carry. `lib/clientids.js` maps both shapes to
the same account, so an updated engine resolves to exactly the account the old one did. Presence,
ratings and match rosters carry over untouched.

Three things are keyed by the client id in a file, and those do change:

| what | effect |
|---|---|
| EntMod `DF_admins.txt` | the line stops matching -- the one real break |
| `ts_floatchat` off-list | a player who turned `.bubbles` off turns it off once more |
| `h9_link` `h9_link_hints` vault | the "you can .link" hint may appear one more time |

Only the first needs anything done. `serverIds()` in `lib/accounts.js` now returns `clientId7`
beside `clientId`, so the account page can show both **before** the engine ships: the admin adds
the second line in advance and crosses over with no gap, because any line whose field 1 matches
grants the admin.

## Not changed, deliberately

The account **uid**, the **player id** (`cl_h9_userid`, 32 hex, as `user_id.ini` has always
been), the **device** hash and the **adopt key** stay at 32 characters. `lib/accounts.js:210`,
`lib/link.js:83`, `modules/presence/index.js` `HEX32`, and `lib/clientids.js` `adoptKey()` are
not in scope -- shortening any of them breaks linking or device recognition.
