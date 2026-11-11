// ---- H9 ARP inventory and exchange: what the client knows ----------------------------------------------------------------
// The data of the inventory window, the exchange window and the search window, and the decoding of the three messages that fill them,
// H9Inv, H9Trade and H9Search (the byte layouts are docs\ARP_INVENTORY.txt; D:\temp\wf\arpinv\DESIGN.md section 3 and DESIGN-M5.md are the
// contracts they were written from). It has no engine in it, so a test can feed it messages and read what it holds
// (reTS\cl_dll\tests\test_arpinv.cpp).
//
// A server is untrusted here: every count, index and string is checked and cut to the client's own limits, whatever a message says.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace arpinv
{
const int MAX_CELLS = 128;   // cells a window holds, whatever the server says
const int MAX_KINDS = 192;   // item kinds the client keeps a name for
const int NAME_LEN = 33;     // an item's, a player's or a character's name, 32 characters
const int DESC_LEN = 124;    // an item's description, 123 characters
const int NOTE_LEN = 124;    // a line of the status row
const int SUMMARY_LEN = 164; // the result lines of an exchange
const int OFFER_CELLS = 12;  // cells of one side's offer
const int MAX_COUNT = 9999;  // the largest count the client believes

// H9Inv ops
enum
{
	INV_OPEN = 1,
	INV_CATALOG = 2,
	INV_SLOTS = 3,
	INV_MONEY = 4,
	INV_DESC = 5,
	INV_NOTE = 6,
	INV_CLOSE = 7,
	INV_RESERVE = 8
};

// H9Trade ops
enum
{
	TR_INVITE = 1,
	TR_OPEN = 2,
	TR_OFFER = 3,
	TR_MONEY = 4,
	TR_SEAL = 5,
	TR_CLOSE = 6
};

// H9Search ops (the search of a handcuffed player: docs\ARP_INVENTORY.txt, docs\ARP_INVENTORY_WINDOW.txt, 7)
enum
{
	SR_OPEN = 1,
	SR_SLOTS = 2,
	SR_CLOSE = 3,
	SR_NOTE = 4,
	SR_MONEY = 5 // his wallet, so that the searcher can take money (a game that says _h9vgui 9)
};

// H9Search CLOSE reasons
enum
{
	SC_YOU_CLOSED = 0, // the answer to "h9inv s close"
	SC_FREED = 1,      // he is no longer handcuffed or jailed
	SC_DIED = 2,
	SC_LEFT = 3,       // he left the game, or his character was loaded again
	SC_RANGE = 4,      // the searcher moved away from him
	SC_YOU = 5,        // the searcher died, was handcuffed, or lost his own inventory window to the server
	SC_MAP = 6         // the map is changing, or the search was switched off
};

// The words of a search that has ended, for the status row; none for one the player closed himself.
inline const char* SearchCloseText(int reason)
{
	switch (reason)
	{
	case SC_YOU_CLOSED: return "";
	case SC_FREED: return "The search ended: he is free.";
	case SC_DIED: return "The search ended: he died.";
	case SC_LEFT: return "The search ended: he left.";
	case SC_RANGE: return "The search ended: you moved away.";
	default: return "The search ended.";
	}
}

// H9Trade CLOSE reasons
enum
{
	TC_DONE = 0,
	TC_YOU_WITHDREW = 1,
	TC_THEY_WITHDREW = 2,
	TC_DECLINED = 3,
	TC_LAPSED = 4,
	TC_RANGE = 5,
	TC_YOU_DIED = 6,
	TC_THEY_DIED = 7,
	TC_DISCONNECTED = 8,
	TC_JAILED = 9,
	TC_YOUR_FULL = 10,
	TC_THEIR_FULL = 11,
	TC_CHECK_FAILED = 12,
	TC_MAP = 13,
	TC_BUSY = 14,
	TC_TIMEOUT = 15
};

// A reader over one message: little-endian, never past the end.
struct Reader
{
	const unsigned char* p;
	int n;
	int i;
	bool ok;

	Reader(const void* buf, int size) : p((const unsigned char*)buf), n(size < 0 ? 0 : size), i(0), ok(buf != nullptr) {}

	int Byte()
	{
		if (!ok || i + 1 > n)
		{
			ok = false;
			return 0;
		}
		return p[i++];
	}
	int Short() // signed 16 bit, as the engine's READ_SHORT
	{
		if (!ok || i + 2 > n)
		{
			ok = false;
			return 0;
		}
		const int v = (int)(int16_t)(uint16_t)(p[i] | (p[i + 1] << 8));
		i += 2;
		return v;
	}
	int Long() // signed 32 bit
	{
		if (!ok || i + 4 > n)
		{
			ok = false;
			return 0;
		}
		const uint32_t v = (uint32_t)p[i] | ((uint32_t)p[i + 1] << 8) | ((uint32_t)p[i + 2] << 16) | ((uint32_t)p[i + 3] << 24);
		i += 4;
		return (int)v;
	}
	// A NUL-terminated string cut to size - 1 characters; the rest of a longer one is skipped. A string that never ends is not ok.
	void String(char* out, int size)
	{
		int o = 0;
		bool ended = false;
		while (ok && i < n)
		{
			const char c = (char)p[i++];
			if (c == 0)
			{
				ended = true;
				break;
			}
			if (o < size - 1)
				// ASCII, and the credit sign (the byte 0xA2, which TSHud_DrawString draws); any other byte a server sends is a "?"
				out[o++] = ((c >= 32 && c < 127) || (unsigned char)c == 0xA2) ? c : '?';
		}
		out[o] = 0;
		if (!ended)
			ok = false;
	}
};

inline int ClampInt(int v, int lo, int hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

struct Kind
{
	bool used;
	int id;
	int stackMax;
	char name[NAME_LEN];
	char desc[DESC_LEN];
	bool haveDesc;
};

struct Cell
{
	int kind;     // 0 empty
	int n;
	int reserved; // held by an open exchange
};

struct Offer
{
	int kind; // 0 empty
	int n;
	char name[NAME_LEN];
};

struct Trade
{
	bool open;
	char partner[NAME_LEN];
	int wallet;     // this player's wallet when the window opened
	int cells;      // cells a side's offer has
	bool credits;
	Offer mine[OFFER_CELLS];
	Offer theirs[OFFER_CELLS];
	int myMoney;
	int theirMoney;
	bool mySealed;
	bool theirSealed;
	float lockUntil; // client time before which this player's seal cannot be pressed

	bool invite;
	char inviter[NAME_LEN];
	float inviteUntil;

	bool result; // the result overlay of an exchange that has just closed
	int reason;
	char summary[SUMMARY_LEN];
	float resultUntil;
};

// The search of a handcuffed player: his cells, as he sees them in his own window, beside the searcher's own.
struct Search
{
	bool open;
	bool over;         // his cells are over capacity
	int cells;         // the length of his grid
	int money;         // his wallet as the server last told it, -1 when it has not: the window has no money row then
	char name[NAME_LEN];
	Cell theirs[MAX_CELLS];
};

struct Model
{
	bool open;
	int flags;
	int slots;      // cells shown
	int wallet;
	int bank;
	char name[NAME_LEN];
	char job[NAME_LEN];
	bool credits;   // the money is called credits
	bool over;      // over capacity
	bool unlimited;
	Cell cells[MAX_CELLS];
	Kind kinds[MAX_KINDS];
	Trade trade;
	Search search;

	char note[NOTE_LEN];
	int noteLevel;
	float noteUntil;

	// what a test or the command can say of the messages read
	int msgsInv, msgsTrade, msgsSearch, msgsBad;
	int lastOpInv, lastOpTrade, lastOpSearch;

	Model() { Clear(); }

	void ClearTrade()
	{
		memset(&trade, 0, sizeof(trade));
		trade.cells = OFFER_CELLS;
	}

	void ClearSearch()
	{
		memset(&search, 0, sizeof(search));
		search.money = -1;
	}

	void ClearCells()
	{
		memset(cells, 0, sizeof(cells));
	}

	// A new map or a new server: everything is forgotten.
	void Clear()
	{
		open = false;
		flags = 0;
		slots = 0;
		wallet = 0;
		bank = 0;
		name[0] = 0;
		job[0] = 0;
		credits = true;
		over = false;
		unlimited = false;
		ClearCells();
		memset(kinds, 0, sizeof(kinds));
		ClearTrade();
		ClearSearch();
		note[0] = 0;
		noteLevel = 0;
		noteUntil = 0.0f;
		msgsInv = msgsTrade = msgsSearch = msgsBad = 0;
		lastOpInv = lastOpTrade = lastOpSearch = 0;
	}

	Kind* FindKind(int id)
	{
		if (id <= 0)
			return nullptr;
		for (int i = 0; i < MAX_KINDS; i++)
			if (kinds[i].used && kinds[i].id == id)
				return &kinds[i];
		return nullptr;
	}

	const Kind* FindKind(int id) const
	{
		return const_cast<Model*>(this)->FindKind(id);
	}

	Kind* SetKind(int id, int stackMax, const char* nm)
	{
		Kind* k = FindKind(id);
		if (!k)
		{
			for (int i = 0; i < MAX_KINDS && !k; i++)
				if (!kinds[i].used)
					k = &kinds[i];
			if (!k)
				k = &kinds[0]; // the table is full: the oldest slot goes
			memset(k, 0, sizeof(*k));
		}
		k->used = true;
		k->id = id;
		k->stackMax = ClampInt(stackMax, 1, MAX_COUNT);
		strncpy(k->name, nm, NAME_LEN - 1);
		k->name[NAME_LEN - 1] = 0;
		return k;
	}

	const char* KindName(int id) const
	{
		const Kind* k = FindKind(id);
		return k ? k->name : "ITEM";
	}

	int Used() const // cells that hold something
	{
		int u = 0;
		for (int i = 0; i < slots && i < MAX_CELLS; i++)
			if (cells[i].kind != 0)
				u++;
		return u;
	}

	int SearchUsed() const // the cells of the searched player's grid that hold something
	{
		int u = 0;
		for (int i = 0; i < search.cells && i < MAX_CELLS; i++)
			if (search.theirs[i].kind != 0)
				u++;
		return u;
	}

	void SetNote(const char* text, int level, float now)
	{
		strncpy(note, text, NOTE_LEN - 1);
		note[NOTE_LEN - 1] = 0;
		noteLevel = level;
		noteUntil = now + 6.0f;
	}

	// H9Inv. Returns true when the window should now be open (op OPEN) and false otherwise; a CLOSE sets open to false.
	bool OnInv(const void* buf, int size, float now)
	{
		Reader r(buf, size);
		const int op = r.Byte();
		if (!r.ok)
		{
			msgsBad++;
			return false;
		}
		msgsInv++;
		lastOpInv = op;
		switch (op)
		{
		case INV_OPEN:
		{
			const int fl = r.Byte();
			const int sl = r.Short();
			const int w = r.Long();
			const int b = r.Long();
			char nm[NAME_LEN], jb[NAME_LEN];
			r.String(nm, sizeof(nm));
			r.String(jb, sizeof(jb));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			flags = fl;
			over = (fl & 1) != 0;
			unlimited = (fl & 2) != 0;
			credits = (fl & 4) != 0;
			slots = ClampInt(sl, 0, MAX_CELLS);
			wallet = w < 0 ? 0 : w;
			bank = b < 0 ? 0 : b;
			memcpy(name, nm, sizeof(name));
			memcpy(job, jb, sizeof(job));
			ClearCells();
			open = true;
			return true;
		}
		case INV_CATALOG:
		{
			const int count = r.Byte();
			for (int k = 0; k < count && r.ok; k++)
			{
				const int id = r.Short();
				const int sm = r.Short();
				r.Byte(); // flags, none yet
				char nm[NAME_LEN];
				r.String(nm, sizeof(nm));
				if (r.ok && id > 0)
					SetKind(id, sm, nm);
			}
			if (!r.ok)
				msgsBad++;
			return false;
		}
		case INV_SLOTS:
		{
			const int first = r.Short();
			const int count = r.Byte();
			for (int k = 0; k < count && r.ok; k++)
			{
				const int kind = r.Short();
				const int n = r.Short();
				const int at = first + k;
				if (!r.ok || at < 0 || at >= MAX_CELLS)
					continue;
				if (at >= slots)
					slots = at + 1;
				cells[at].kind = (kind > 0 && n > 0) ? kind : 0;
				cells[at].n = (kind > 0 && n > 0) ? ClampInt(n, 1, MAX_COUNT) : 0;
				if (cells[at].kind == 0)
					cells[at].reserved = 0;
			}
			if (!r.ok)
				msgsBad++;
			return false;
		}
		case INV_MONEY:
		{
			const int w = r.Long();
			const int b = r.Long();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			wallet = w < 0 ? 0 : w;
			bank = b < 0 ? 0 : b;
			return false;
		}
		case INV_DESC:
		{
			const int id = r.Short();
			char text[DESC_LEN];
			r.String(text, sizeof(text));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			Kind* k = FindKind(id);
			if (k)
			{
				memcpy(k->desc, text, sizeof(k->desc));
				k->haveDesc = true;
			}
			return false;
		}
		case INV_NOTE:
		{
			const int level = r.Byte();
			char text[NOTE_LEN];
			r.String(text, sizeof(text));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			SetNote(text, level ? 1 : 0, now);
			return false;
		}
		case INV_CLOSE:
			open = false;
			ClearSearch(); // the search stands beside the inventory window: it goes with it
			return false;
		case INV_RESERVE:
		{
			const int first = r.Short();
			const int count = r.Byte();
			for (int k = 0; k < count && r.ok; k++)
			{
				const int n = r.Short();
				const int at = first + k;
				if (r.ok && at >= 0 && at < MAX_CELLS)
					cells[at].reserved = ClampInt(n, 0, MAX_COUNT);
			}
			if (!r.ok)
				msgsBad++;
			return false;
		}
		default:
			msgsBad++;
			return false;
		}
	}

	// H9Trade. Returns true when a window should now open (OPEN) or an invitation arrived (INVITE), so the glue can react.
	bool OnTrade(const void* buf, int size, float now)
	{
		Reader r(buf, size);
		const int op = r.Byte();
		if (!r.ok)
		{
			msgsBad++;
			return false;
		}
		msgsTrade++;
		lastOpTrade = op;
		switch (op)
		{
		case TR_INVITE:
		{
			const int secs = r.Byte();
			char nm[NAME_LEN];
			r.String(nm, sizeof(nm));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			trade.invite = true;
			memcpy(trade.inviter, nm, sizeof(trade.inviter));
			trade.inviteUntil = now + (float)ClampInt(secs, 1, 30);
			return true;
		}
		case TR_OPEN:
		{
			char nm[NAME_LEN];
			r.String(nm, sizeof(nm));
			const int w = r.Long();
			const int cells = r.Byte();
			const int fl = r.Byte();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			ClearTrade();
			trade.open = true;
			memcpy(trade.partner, nm, sizeof(trade.partner));
			trade.wallet = w < 0 ? 0 : w;
			trade.cells = ClampInt(cells, 1, OFFER_CELLS);
			trade.credits = (fl & 1) != 0;
			return true;
		}
		case TR_OFFER:
		{
			const int side = r.Byte();
			const int idx = r.Byte();
			const int kind = r.Short();
			const int n = r.Short();
			char nm[NAME_LEN];
			r.String(nm, sizeof(nm));
			if (!r.ok || idx < 0 || idx >= OFFER_CELLS)
			{
				msgsBad++;
				return false;
			}
			Offer& o = (side == 0) ? trade.mine[idx] : trade.theirs[idx];
			o.kind = (kind > 0 && n > 0) ? kind : 0;
			o.n = o.kind ? ClampInt(n, 1, MAX_COUNT) : 0;
			memcpy(o.name, nm, sizeof(o.name));
			if (o.kind && !o.name[0])
				strncpy(o.name, KindName(o.kind), NAME_LEN - 1);
			return false;
		}
		case TR_MONEY:
		{
			const int side = r.Byte();
			const int amount = r.Long();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			if (side == 0)
				trade.myMoney = amount < 0 ? 0 : amount;
			else
				trade.theirMoney = amount < 0 ? 0 : amount;
			return false;
		}
		case TR_SEAL:
		{
			const int mine = r.Byte();
			const int theirs = r.Byte();
			const int lock = r.Byte();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			trade.mySealed = mine != 0;
			trade.theirSealed = theirs != 0;
			trade.lockUntil = now + (float)lock / 10.0f;
			return false;
		}
		case TR_CLOSE:
		{
			const int reason = r.Byte();
			char text[SUMMARY_LEN];
			r.String(text, sizeof(text));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			const bool wasInvite = trade.invite && !trade.open;
			ClearTrade();
			trade.result = true;
			trade.reason = reason;
			memcpy(trade.summary, text, sizeof(trade.summary));
			trade.resultUntil = now + (reason == TC_DONE ? 6.0f : 4.0f);
			(void)wasInvite;
			return false;
		}
		default:
			msgsBad++;
			return false;
		}
	}

	// H9Search. Returns true when the window should now be open (OPEN: a second OPEN while it is open replaces the header and starts his cells again,
	// which is how a search of another player, or a snapshot sent again, arrives).
	bool OnSearch(const void* buf, int size, float now)
	{
		Reader r(buf, size);
		const int op = r.Byte();
		if (!r.ok)
		{
			msgsBad++;
			return false;
		}
		msgsSearch++;
		lastOpSearch = op;
		switch (op)
		{
		case SR_OPEN:
		{
			const int fl = r.Byte();
			const int cl = r.Short();
			char nm[NAME_LEN];
			r.String(nm, sizeof(nm));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			ClearSearch();
			search.open = true;
			search.over = (fl & 1) != 0;
			search.cells = ClampInt(cl, 0, MAX_CELLS);
			memcpy(search.name, nm, sizeof(search.name));
			return true;
		}
		case SR_SLOTS:
		{
			const int first = r.Short();
			const int count = r.Byte();
			for (int k = 0; k < count && r.ok; k++)
			{
				const int kind = r.Short();
				const int n = r.Short();
				const int at = first + k;
				if (!r.ok || !search.open || at < 0 || at >= MAX_CELLS)
					continue;
				if (at >= search.cells)
					search.cells = at + 1;
				search.theirs[at].kind = (kind > 0 && n > 0) ? kind : 0;
				search.theirs[at].n = (kind > 0 && n > 0) ? ClampInt(n, 1, MAX_COUNT) : 0;
				search.theirs[at].reserved = 0;
			}
			if (!r.ok)
				msgsBad++;
			return false;
		}
		case SR_CLOSE:
		{
			const int reason = r.Byte();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			const bool was = search.open;
			ClearSearch();
			if (was)
			{
				const char* text = SearchCloseText(reason);
				if (text[0])
					SetNote(text, 1, now);
			}
			return false;
		}
		case SR_NOTE:
		{
			const int level = r.Byte();
			char text[NOTE_LEN];
			r.String(text, sizeof(text));
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			SetNote(text, level ? 1 : 0, now);
			return false;
		}
		case SR_MONEY:
		{
			const int wallet = r.Long();
			if (!r.ok)
			{
				msgsBad++;
				return false;
			}
			if (search.open)
				search.money = wallet < 0 ? 0 : wallet;
			return false;
		}
		default:
			msgsBad++;
			return false;
		}
	}
};

// The words of a close reason.
inline const char* CloseReasonText(int reason)
{
	switch (reason)
	{
	case TC_DONE: return "EXCHANGE COMPLETE";
	case TC_YOU_WITHDREW: return "YOU WITHDREW FROM THE EXCHANGE";
	case TC_THEY_WITHDREW: return "THEY WITHDREW FROM THE EXCHANGE";
	case TC_DECLINED: return "THE OFFER WAS DECLINED";
	case TC_LAPSED: return "THE OFFER LAPSED";
	case TC_RANGE: return "EXCHANGE CANCELLED: OUT OF RANGE";
	case TC_YOU_DIED: return "EXCHANGE CANCELLED: YOU DIED";
	case TC_THEY_DIED: return "EXCHANGE CANCELLED: THEY DIED";
	case TC_DISCONNECTED: return "EXCHANGE CANCELLED: THEY LEFT";
	case TC_JAILED: return "EXCHANGE CANCELLED: JAILED OR CUFFED";
	case TC_YOUR_FULL: return "EXCHANGE REFUSED: YOUR INVENTORY IS FULL";
	case TC_THEIR_FULL: return "EXCHANGE REFUSED: THEIR INVENTORY IS FULL";
	case TC_CHECK_FAILED: return "EXCHANGE REFUSED: AN ITEM OR THE MONEY CHANGED";
	case TC_MAP: return "EXCHANGE CANCELLED: NEW MAP";
	case TC_BUSY: return "THEY ARE BUSY";
	case TC_TIMEOUT: return "EXCHANGE CANCELLED: TIMED OUT";
	default: return "EXCHANGE ENDED";
	}
}

// Money as the window words it: credits "<sign> 1,250", cash "$ 1,250". The credit sign is the single byte 0xA2, which
// TSHud_DrawString draws (the HUD font has no glyph of its own for it).
inline void FormatMoney(char* out, int size, int amount, bool credits)
{
	char digits[16];
	snprintf(digits, sizeof(digits), "%d", amount < 0 ? 0 : amount);
	char grouped[24];
	int len = (int)strlen(digits), o = 0;
	for (int i = 0; i < len; i++)
	{
		if (i > 0 && (len - i) % 3 == 0)
			grouped[o++] = ',';
		grouped[o++] = digits[i];
	}
	grouped[o] = 0;
	if (credits)
		snprintf(out, size, "%c %s", (char)0xA2, grouped);
	else
		snprintf(out, size, "$ %s", grouped);
}
} // namespace arpinv
// ---- end H9 ARP inventory model ---------------------------------------------------------------------------------------
