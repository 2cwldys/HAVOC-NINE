// ---- H9 ARP context menu: what the client knows and what a click does ---------------------------------------------------------
// The menu of the use key on a player (the server's ARP_H9Ctx, docs\ARP_INVENTORY.txt 10): the user message H9Ctx fills it, a click or a number key
// answers with the client command "h9ctx pick <serial> <index>", ESC or a right click with "h9ctx close <serial>". The client holds a list of rows and
// draws it; what a row means, whether it is enabled and why not are the server's, which builds the menu again at every choice. Every page of choices
// (the amounts of a fine, a license to show) is a new menu with a new serial.
//
// It has no engine in it, so a test can feed it messages and clicks and read what it holds and what it would send (tests\test_arpctx.cpp). A server is
// untrusted here: every index and string is checked and cut to the client's own limits, whatever a message says.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace arpctx
{
const int ROWS_MAX = 12;   // rows of a page, whatever the server says
const int LABEL_LEN = 24;  // a row's label, 23 characters
const int NOTE_LEN = 34;   // a row's note (its reason, or a small detail), 33 characters
const int TITLE_LEN = 36;  // the heading and the line under it, 35 characters
const int STATUS_LEN = 72; // the line the menu says a refusal in
const int MSG_MAX = 192;   // bytes a message of the server may have
const float STATUS_SECONDS = 4.0f; // how long a refusal stays in the status line

// H9Ctx ops (server to client)
enum
{
	OP_OPEN = 1,  // byte serial, byte flags (bit 0: the same menu, refreshed), byte page, byte rows, string title, string line under it
	OP_ROWS = 2,  // byte serial, byte first row, byte count, then for each: byte flags, byte key, string label, string note
	OP_CLOSE = 3, // byte serial (0: whatever is up), byte reason
	OP_NOTE = 4   // byte serial, byte level (0 plain, 1 refusal), string text
};

// the flags of a row
enum
{
	F_ON = 1,   // it can be chosen
	F_MORE = 2, // it opens a page of choices
	F_RED = 4,  // drawn in red
	F_GAP = 8   // a blank half row above it
};

// the reasons of a CLOSE
enum
{
	CLOSE_SERVER = 0, // the switch went off, or the game cannot draw the menu any more
	CLOSE_TARGET = 1, // the player the menu is about is gone or dead
	CLOSE_FAR = 2,    // the player went too far from him
	CLOSE_DONE = 3,   // a choice was carried out
	CLOSE_DIED = 4    // the player died or was restrained
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

	// A string up to its NUL, cut to cap - 1 characters. What is not text is a question mark (the credit sign, the byte 0xA2, is kept: the HUD font draws it).
	void Str(char* out, int cap)
	{
		int o = 0;
		bool ended = false;
		while (ok && i < n)
		{
			const unsigned char c = p[i++];
			if (c == 0)
			{
				ended = true;
				break;
			}
			if (o < cap - 1)
				out[o++] = (char)((c < 32 || (c > 126 && c != 0xA2)) ? '?' : c);
		}
		out[o] = 0;
		if (!ended)
			ok = false;
	}
};

struct Row
{
	int flags;
	int key; // 1 to 9, 10 for the 0 key, 0 for none
	char label[LABEL_LEN];
	char note[NOTE_LEN];

	bool On() const { return (flags & F_ON) != 0; }
};

struct Model
{
	bool open;
	int serial;        // 1 to 255 while the menu is open
	int page;          // 0 the first page
	int announced;     // the rows the OPEN said there would be
	int numRows;
	bool refreshed;    // the last OPEN was the same menu again
	int lastClose;     // the reason of the last CLOSE, -1 when none
	char title[TITLE_LEN];
	char sub[TITLE_LEN];
	Row rows[ROWS_MAX];
	char status[STATUS_LEN];
	int statusLevel;
	float statusUntil;
	float openedAt;    // when the menu came up
	int msgsOpen, msgsRows, msgsClose, msgsNote, msgsBad;

	Model()
	{
		Clear();
		msgsOpen = msgsRows = msgsClose = msgsNote = msgsBad = 0;
	}

	void Clear()
	{
		open = false;
		serial = 0;
		page = 0;
		announced = 0;
		numRows = 0;
		refreshed = false;
		lastClose = -1;
		title[0] = 0;
		sub[0] = 0;
		status[0] = 0;
		statusLevel = 0;
		statusUntil = 0.0f;
		openedAt = 0.0f;
		memset(rows, 0, sizeof(rows));
	}

	void SetStatus(const char* text, int level, float now)
	{
		snprintf(status, sizeof(status), "%s", text);
		statusLevel = level;
		statusUntil = now + STATUS_SECONDS;
	}

	bool HasStatus(float now) const { return status[0] && now < statusUntil; }

	// The row with a number key (1 to 9, 10 for 0), -1 for none.
	int RowOfKey(int key) const
	{
		for (int i = 0; i < numRows; i++)
			if (rows[i].key == key)
				return i;
		return -1;
	}

	// One message. Returns true when it changed what is shown (an OPEN that began a menu, rows, a CLOSE of the menu that was up, a note).
	bool OnMessage(const void* buf, int size, float now)
	{
		Reader r(buf, size);
		if (size <= 0 || size > MSG_MAX)
		{
			msgsBad++;
			return false;
		}
		const int op = r.Byte();
		switch (op)
		{
		case OP_OPEN: return OnOpen(r, now);
		case OP_ROWS: return OnRows(r);
		case OP_CLOSE: return OnClose(r);
		case OP_NOTE: return OnNote(r, now);
		default: msgsBad++; return false;
		}
	}

private:
	bool OnOpen(Reader& r, float now)
	{
		const int ser = r.Byte(), flags = r.Byte(), pg = r.Byte(), rowsN = r.Byte();
		char t[TITLE_LEN] = {0}, s[TITLE_LEN] = {0};
		r.Str(t, TITLE_LEN);
		r.Str(s, TITLE_LEN);
		if (!r.ok || ser < 1 || rowsN > 64)
		{
			msgsBad++;
			return false;
		}
		msgsOpen++;
		const bool same = open && ser == serial && (flags & 1);
		if (!same)
		{
			open = true;
			openedAt = now;
			status[0] = 0;
			statusUntil = 0.0f;
		}
		serial = ser;
		page = pg;
		refreshed = same;
		announced = rowsN < ROWS_MAX ? rowsN : ROWS_MAX;
		numRows = 0;
		lastClose = -1;
		memcpy(title, t, sizeof(title));
		memcpy(sub, s, sizeof(sub));
		memset(rows, 0, sizeof(rows));
		return true;
	}

	bool OnRows(Reader& r)
	{
		const int ser = r.Byte(), first = r.Byte(), count = r.Byte();
		if (!r.ok || !open || ser != serial || first != numRows || count < 1)
		{
			msgsBad++;
			return false;
		}
		msgsRows++;
		for (int k = 0; k < count; k++)
		{
			Row row;
			memset(&row, 0, sizeof(row));
			row.flags = r.Byte();
			row.key = r.Byte();
			r.Str(row.label, LABEL_LEN);
			r.Str(row.note, NOTE_LEN);
			if (!r.ok)
			{
				msgsBad++;
				return numRows > 0;
			}
			if (row.key < 0 || row.key > 10)
				row.key = 0;
			if (numRows < announced && numRows < ROWS_MAX)
				rows[numRows++] = row;
		}
		return true;
	}

	bool OnClose(Reader& r)
	{
		const int ser = r.Byte(), reason = r.Byte();
		if (!r.ok)
		{
			msgsBad++;
			return false;
		}
		msgsClose++;
		if (!open || (ser != 0 && ser != serial))
			return false;
		open = false;
		lastClose = reason;
		return true;
	}

	bool OnNote(Reader& r, float now)
	{
		const int ser = r.Byte(), level = r.Byte();
		char text[STATUS_LEN];
		r.Str(text, STATUS_LEN);
		if (!r.ok)
		{
			msgsBad++;
			return false;
		}
		msgsNote++;
		if (!open || ser != serial)
			return false;
		SetStatus(text, level, now);
		return true;
	}
};

// A menu with rows of its own, for cl_h9_ctxmenu_test and the tests: what the server's first page looks like, one row of each kind.
inline void DemoMenu(Model& md, float now)
{
	md.Clear();
	md.open = true;
	md.serial = 1;
	md.openedAt = now;
	snprintf(md.title, sizeof(md.title), "%s", "VOSS, ADRIAN");
	static const struct
	{
		int flags;
		const char* label;
		const char* note;
	} demo[] = {
		{F_ON, "Trade", ""},
		{0, "Search", "Cuff him first"},
		{F_ON, "Cuff", "uses Cuffs"},
		{F_ON, "Tie", ""},
		{0, "Tape mouth", "You have no Tape"},
		{F_MORE, "Fine", "Police only"},
		{F_ON | F_MORE, "Give money", ""},
		{F_ON | F_MORE, "Show license or card", ""},
	};
	for (int i = 0; i < (int)(sizeof(demo) / sizeof(demo[0])); i++)
	{
		Row& r = md.rows[md.numRows++];
		r.flags = demo[i].flags;
		r.key = i < 9 ? i + 1 : 10;
		snprintf(r.label, sizeof(r.label), "%s", demo[i].label);
		snprintf(r.note, sizeof(r.note), "%s", demo[i].note);
	}
	md.announced = md.numRows;
}
} // namespace arpctx
