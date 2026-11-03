/*
 * h9id_example.sma -- proof of concept for ..\CUSTOM_XASH_USERID.txt.
 *
 * On connect: reads a player's h9_clientid userinfo key (see that doc,
 * section 3 -- the per-server-salted id, not the raw value in user_id.ini),
 * prints it to the SERVER console, then appends it to a plain-text .cfg file
 * under configs\ and immediately reads that same file back -- proving the id
 * round-trips through a file a host can open and read themselves, not just
 * plugin memory.
 *
 * Lives under docs\ as reference material, not in the TSM root plugin set,
 * so build.bat never sees or touches it (it only scans *.sma at the project
 * root). See README.txt in this folder for how to compile and try it.
 */

#include <amxmodx>
#include <amxmisc>

#define CFG_FILE "h9id_example.cfg"

public plugin_init()
{
	register_plugin("h9id example", "1.0", "h9xash");
}

public client_putinserver(id)
{
	new clientid[33];
	if (!get_user_info(id, "h9_clientid", clientid, charsmax(clientid)) || !clientid[0])
	{
		server_print("[h9id example] no h9_clientid for this connection -- not launched via h9xash.bat?");
		return;
	}

	new name[32];
	get_user_name(id, name, charsmax(name));
	server_print("[h9id example] %s connected, h9_clientid = %s", name, clientid);

	new path[128];
	get_configsdir(path, charsmax(path));
	format(path, charsmax(path), "%s/%s", path, CFG_FILE);

	new line[160];
	formatex(line, charsmax(line), "%s %s", clientid, name);
	write_file(path, line, -1); // -1: append as a new last line
	server_print("[h9id example] wrote to %s: %s", CFG_FILE, line);

	// Read the file back and show every line that refers to this clientid --
	// the line just written will be among them, proving the cfg file itself
	// (not just this plugin's memory) is what holds it now.
	new line_num = 1, text[160], text_len;
	while (read_file(path, line_num, text, charsmax(text), text_len))
	{
		if (equal(text, clientid, 32))
			server_print("[h9id example] %s line %d refers to this clientid: %s", CFG_FILE, line_num, text);
		line_num++;
	}
}
