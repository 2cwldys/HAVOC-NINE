#include "plugin.h"
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <string.h>
#else
#include <strings.h>
#endif
#include <stdlib.h>
#include <ctype.h>

// EntMod4 -- reconstructed: string / parse helpers and the HL server map-cycle parser.
// Addresses are the original EntMod ELF offsets. The map-cycle parser (DestroyMapCycle,
// CurrentMap, COM_Parse, COM_TokenWaiting, ReloadMapCycleFile) has no caller in the
// reconstructed set and is likely dead in the metamod build; it is kept here for parity.

// ---- map-cycle structures (mapcycle_s is forward-declared opaque in entmod_decl.h) ----
// mapcycle_item_s is operator_new(0x42c) in the original: next(4)+mapname(32)+min(4)+max(4)+rules(1024).
struct mapcycle_item_s
{
	mapcycle_item_s *next;
	char             mapname[32];
	int              minplayers;
	int              maxplayers;
	char             rulebuffer[1024];
};
struct mapcycle_s
{
	mapcycle_item_s *items;
	mapcycle_item_s *next_item;
};

// Quake token parser scratch, shared only by COM_Parse / ReloadMapCycleFile in this TU.
static char com_token[1024];

// ======================================================================================
// caseless compare / search
// ======================================================================================

// Q_strncasecmp @0x54200 -- Quake caseless strncmp (uppercases a-z only); 0 == equal, -1 == differ.
int Q_strncasecmp(const char *a, const char *b, int n)
{
	int i = 0;
	while (1)
	{
		if (i == n)
			return 0;
		int c1 = a[i];
		int c2 = b[i];
		if (c1 != c2)
		{
			if ((unsigned)(c1 - 'a') < 26u) c1 -= 0x20;
			if ((unsigned)(c2 - 'a') < 26u) c2 -= 0x20;
			if (c1 != c2)
				return -1;
		}
		i++;
		if (c1 == 0)
			return 0;
	}
}

// Q_strcasecmp @0x54270
int Q_strcasecmp(const char *a, const char *b)
{
	return Q_strncasecmp(a, b, 99999);
}

// Q_strcasestr @0x542a0 -- caseless substring. Empty needle returns the haystack copy.
char *Q_strcasestr(const char *haystack, const char *needle)
{
	// The original copied both args into 0x200 stack buffers and returned a pointer into the
	// haystack copy; static buffers here keep that returned pointer valid (callers only null-test).
	static char hay[0x200];
	static char ndl[0x200];
	hay[0] = '\0';
	ndl[0] = '\0';
	strncpy(hay, haystack, sizeof(hay) - 1); hay[sizeof(hay) - 1] = '\0';
	strncpy(ndl, needle,   sizeof(ndl) - 1); ndl[sizeof(ndl) - 1] = '\0';

	if (ndl[0] == '\0')
		return hay;
	for (char *h = hay; *h != '\0'; h++)
	{
		char *hp = h;
		char *np = ndl;
		while (*np != '\0' && toupper((unsigned char)*hp) == toupper((unsigned char)*np))
		{
			hp++;
			np++;
		}
		if (*np == '\0')
			return h;
	}
	return NULL;
}

// ======================================================================================
// line / word helpers
// ======================================================================================

// FormatLine @0x54fb0 -- in place, collapse the escapes "^n" and "\n" to a real newline.
void FormatLine(char *s)
{
	char       *w = s;
	const char *r = s;
	while (*r != '\0')
	{
		if ((*r == '^' || *r == '\\') && r[1] == 'n')
		{
			*w++ = '\n';
			r += 2;
		}
		else
		{
			*w++ = *r++;
		}
	}
	*w = '\0';
}

// StripReturn @0x56e80 -- strip trailing CR/LF in place; returns the same buffer.
char *StripReturn(char *s)
{
	if (s != NULL)
	{
		char *p = s + strlen(s) - 1;
		while (p >= s && (*p == '\r' || *p == '\n'))
			p--;
		p[1] = '\0';
	}
	return s;
}

// Strings_GetFirstWord @0x56ed0 -- copy the first whitespace-delimited word of src into out.
void Strings_GetFirstWord(const char *src, char *out)
{
	while (*src != '\0' && isspace((unsigned char)*src))
		src++;
	while (*src != '\0' && !isspace((unsigned char)*src))
		*out++ = *src++;
	*out = '\0';
}

// Strings_CountWords @0x56f50 -- count tokens; a "quoted string" (with \-escapes) is one token.
int Strings_CountWords(const char *src)
{
	if (src == NULL)
		return 0;
	int count = 0;
	const char *p = src;
	while (*p != '\0')
	{
		while (isspace((unsigned char)*p))
		{
			p++;
			if (*p == '\0')
				return count;
		}
		if (*p == '\0')
			return count;
		if (*p == '"')
		{
			const char *q = p + 1;
			if (*q == '"')
			{
				q++;
			}
			else
			{
				while (*q != '\0' && *q != '"')
				{
					if (*q == '\\') q++;
					if (*q == '\0') break;
					q++;
				}
				if (*q == '"') q++;
			}
			p = q;
		}
		else
		{
			while (*p != '\0' && !isspace((unsigned char)*p))
				p++;
		}
		count++;
	}
	return count;
}

// Strings_GetWord @0x57010 -- 0-based index-th token into a static buffer; NULL if out of range.
char *Strings_GetWord(const char *src, int index)
{
	static char temp[1024];
	if (src == NULL || index >= Strings_CountWords(src))
		return NULL;
	temp[0] = '\0';

	const char *p = src;
	int word = 1;
	while (*p != '\0')
	{
		while (isspace((unsigned char)*p))
			p++;
		if (*p == '\0')
			break;

		if (word == index + 1)
		{
			char *out = temp;
			if (*p == '"')
			{
				const char *q = p + 1;
				if (*q != '"' && *q != '\0')
				{
					while (*q != '\0' && *q != '"')
					{
						if (*q == '\\') q++;
						if (*q == '\0') break;
						*out++ = *q++;
					}
				}
			}
			else
			{
				while (*p != '\0' && !isspace((unsigned char)*p))
					*out++ = *p++;
			}
			*out = '\0';
			return temp;
		}

		if (*p == '"')
		{
			const char *q = p + 1;
			if (*q == '"')
			{
				q++;
			}
			else
			{
				while (*q != '\0' && *q != '"')
				{
					if (*q == '\\') q++;
					if (*q == '\0') break;
					q++;
				}
				if (*q == '"') q++;
			}
			p = q;
		}
		else
		{
			while (*p != '\0' && !isspace((unsigned char)*p))
				p++;
		}
		word++;
	}
	return NULL;
}

// ======================================================================================
// substring helpers (strdup-returning)
// ======================================================================================

// strLeft @0x58020 -- strdup(s) truncated to the leftmost count characters.
char *strLeft(const char *s, int count)
{
	char *r   = strdup(s);
	int   len = (int)strlen(r);
	int   n   = len - count;
	if (n < 0) n = -n;
	strncpy(r + count, "", n);
	return r;
}

// strrev @0x58080 -- reverse a string in place.
char *strrev(char *s)
{
	char *a = s;
	char *b = s;
	while (*b != '\0')
		b++;
	b--;
	while (a < b)
	{
		char t = *a;
		*a++ = *b;
		*b-- = t;
	}
	return s;
}

// strRight @0x580d0 -- strdup(s) keeping the rightmost count characters.
char *strRight(const char *s, int count)
{
	char *r = strdup(s);
	strrev(r);
	int len = (int)strlen(r);
	strncpy(r + count, "", len - count);
	strrev(r);
	return r;
}

// strRemoveReturn @0x58180 -- strdup(s) with leading and trailing CR/LF removed.
char *strRemoveReturn(char *s)
{
	char *r = strdup(s);
	if (*r == '\0')
		return r;
	while (*r == '\r' || *r == '\n')
		r = strRight(r, (int)strlen(r) - 1);
	if (*r != '\0')
	{
		for (;;)
		{
			size_t len  = strlen(r);
			char   last = len ? r[len - 1] : '\0';
			if (last == '\r' || last == '\n')
				r = strLeft(r, (int)len - 1);
			else
				break;
		}
	}
	return r;
}

// strTrim @0x58270 -- strdup(s) with leading and trailing spaces/tabs removed.
char *strTrim(char *s)
{
	char *r = strdup(s);
	if (*r == '\0')
		return r;
	while (*r == ' ' || *r == '\t')
		r = strRight(r, (int)strlen(r) - 1);
	if (*r != '\0')
	{
		for (;;)
		{
			size_t len  = strlen(r);
			char   last = len ? r[len - 1] : '\0';
			if (last == ' ' || last == '\t')
				r = strLeft(r, (int)len - 1);
			else
				break;
		}
	}
	return r;
}

// ======================================================================================
// string-to-number parsers
// ======================================================================================

// UTIL_StringToVector @0x54bc0 -- parse up to 3 space-separated floats; zero-fill the rest.
void UTIL_StringToVector(float *out, const char *str)
{
	char buf[128];
	strncpy(buf, str, sizeof(buf) - 1);
	buf[sizeof(buf) - 1] = '\0';

	char *p = buf;
	int   i = 0;
	while (1)
	{
		out[i] = (float)strtod(p, NULL);
		char c = *p;
		if (c != '\0' && c != ' ')
		{
			do
			{
				p++;
				c = *p;
				if (c == ' ') break;
			} while (c != '\0');
		}
		if (c == '\0')
		{
			if (i != 2)
			{
				for (i = i + 1; i != 3; i++)
					out[i] = 0.0f;
			}
			return;
		}
		i++;
		p++;
		if (i == 3)
			return;
	}
}

// UTIL_StringToIntArray @0x55010 -- parse up to count space-separated ints; zero-fill the rest.
void UTIL_StringToIntArray(int *out, int count, const char *str)
{
	char buf[128];
	strncpy(buf, str, sizeof(buf) - 1);
	buf[sizeof(buf) - 1] = '\0';

	if (count <= 0)
		return;

	char *p    = buf;
	int   i    = 0;
	int   last = 0;
	do
	{
		out[i] = (int)strtol(p, NULL, 10);
		char c = *p;
		if (c != ' ')
		{
			while (c != '\0')
			{
				p++;
				c = *p;
				if (c == ' ') break;
			}
		}
		last = i;
		if (c == '\0')
			break;
		i++;
		p++;
		last = count;
	} while (i != count);

	for (last = last + 1; last < count; last++)
		out[last] = 0;
}

// UTIL_StringSearchReplace @0x56180 -- replace every occurrence of find with replace, in place.
void UTIL_StringSearchReplace(char *str, const char *find, const char *replace)
{
	static char Output[0x2000];
	static char Temp[0x2000];

	snprintf(Output, sizeof(Output), "%s", str);
	char *pos;
	while ((pos = strstr(Output, find)) != NULL)
	{
		*pos = '\0';
		size_t flen = strlen(find);
		snprintf(Temp, sizeof(Temp), "%s%s%s", Output, replace, pos + flen);
		snprintf(Output, sizeof(Output), "%s", Temp);
	}
	strcpy(str, Output);
}

// ======================================================================================
// map-cycle parser (stock HL server code; likely dead in the metamod build)
// ======================================================================================

// DestroyMapCycle @0x57c20 -- free the circular item list and clear the cycle.
void DestroyMapCycle(mapcycle_s *cycle)
{
	mapcycle_item_s *head = cycle->items;
	if (head != NULL)
	{
		mapcycle_item_s *p = head->next;
		while (p != head)
		{
			mapcycle_item_s *next = p->next;
			::operator delete(p);
			p = next;
		}
		::operator delete(head);
	}
	cycle->items     = NULL;
	cycle->next_item = NULL;
}

// CurrentMap @0x57c70 -- find the item matching the running map; walks from next_item.
int CurrentMap(mapcycle_s *cycle)
{
	mapcycle_item_s *start = cycle->next_item;
	mapcycle_item_s *p     = start;
	mapcycle_item_s *next;
	int cmp;
	do
	{
		next = p->next;
		if (start == next)
			return (int)(size_t)start;
		cmp = strcasecmp(p->mapname, STRING(gpGlobals->mapname));
		p = next;
	} while (cmp != 0);
	return (int)(size_t)next;
}

// COM_Parse @0x57cd0 -- Quake token parser; result in com_token, returns the parse cursor.
char *COM_Parse(char *data)
{
	com_token[0] = '\0';
	if (data == NULL)
		return NULL;

	int c;
	int len = 0;

skipwhite:
	while ((c = *data) <= ' ')
	{
		if (c == 0)
		{
			com_token[0] = '\0';
			return NULL;
		}
		data++;
	}

	if (c == '/' && data[1] == '/')
	{
		while (*data != '\0' && *data != '\n')
			data++;
		goto skipwhite;
	}

	if (c == '"')
	{
		data++;
		while (1)
		{
			c = *data++;
			if (c == '"' || c == 0)
			{
				com_token[len] = '\0';
				return data;
			}
			com_token[len++] = (char)c;
		}
	}

	if (c == '{' || c == '}' || c == ')' || c == '(' || c == '\'' || c == ',')
	{
		com_token[len++] = (char)c;
		com_token[len]   = '\0';
		return data + 1;
	}

	do
	{
		com_token[len++] = (char)c;
		data++;
		c = *data;
		if (c == '{' || c == '}' || c == '(' || c == ')' || c == '\'' || c == ',')
			break;
	} while (c > ' ');
	com_token[len] = '\0';
	return data;
}

// COM_TokenWaiting @0x57e20 -- non-zero if a token waits on the current line.
int COM_TokenWaiting(char *buffer)
{
	for (char *p = buffer; *p != '\0' && *p != '\n'; p++)
	{
		if (!isspace((unsigned char)*p) || isalnum((unsigned char)*p))
			return 1;
	}
	return 0;
}

// ReloadMapCycleFile @0x57e80 -- load filename, build the cycle's circular item list.
void ReloadMapCycleFile(const char *filename, mapcycle_s *cycle)
{
	int   length = 0;
	char *data   = (char *)LOAD_FILE_FOR_ME((char *)filename, &length);
	if (data == NULL)
		return;

	if (length != 0)
	{
		char *p = data;
		for (;;)
		{
			char rulebuffer[1024];
			memset(rulebuffer, 0, sizeof(rulebuffer));

			p = COM_Parse(p);
			if (com_token[0] == '\0')
				break;

			char mapname[32];
			strncpy(mapname, com_token, sizeof(mapname) - 1);
			mapname[sizeof(mapname) - 1] = '\0';

			if (COM_TokenWaiting(p))
			{
				p = COM_Parse(p);
				if (com_token[0] != '\0')
				{
					strncpy(rulebuffer, com_token, sizeof(rulebuffer) - 1);
					rulebuffer[sizeof(rulebuffer) - 1] = '\0';
				}
			}

			if (IS_MAP_VALID(mapname))
			{
				mapcycle_item_s *item = (mapcycle_item_s *)::operator new(sizeof(mapcycle_item_s));
				strncpy(item->mapname, mapname, sizeof(item->mapname) - 1);
				item->mapname[sizeof(item->mapname) - 1] = '\0';
				item->next   = cycle->items;
				cycle->items = item;
			}
		}
		FREE_FILE(data);
	}

	mapcycle_item_s *prev = NULL;
	mapcycle_item_s *cur  = cycle->items;
	if (cur != NULL)
	{
		while (cur != NULL)
		{
			mapcycle_item_s *next = cur->next;
			cur->next = prev;
			prev = cur;
			cur  = next;
		}
		cycle->items = prev;

		mapcycle_item_s *tail = prev;
		while (tail->next != NULL)
			tail = tail->next;
		tail->next = prev;

		cycle->next_item = prev;
	}
}
