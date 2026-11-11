/*
 * ApolloRP_H9Cfg.inc -- H9: a number that configs\arp\arp.cfg gives a cvar, read from the file.
 *
 * Apollo RP registers its items in the core's precache (the forward ARP_RegisterItems), and the server executes arp.cfg only after the plugins'
 * precache, so on a server's first map a cvar that arp.cfg sets is still its default when an item is registered. A plugin that registers an item
 * only when a switch is on reads the switch here. When arp.cfg does not name the cvar, `def` is the answer.
 */

#if defined _ApolloRP_H9Cfg_included
	#endinput
#endif

#define _ApolloRP_H9Cfg_included

#include <amxmodx>

stock h9_cfg_num(const name[], def)
{
	new path[128];
	get_configsdir(path, charsmax(path));
	add(path, charsmax(path), "/arp/arp.cfg");

	new fp = fopen(path, "r");
	if (!fp)
	{
		return def;
	}

	new line[256], left[48], right[16], value = def;
	while (!feof(fp))
	{
		line[0] = 0;
		fgets(fp, line, charsmax(line));
		trim(line);
		if (!line[0] || line[0] == '/' || line[0] == ';')
		{
			continue;
		}
		left[0] = 0;
		right[0] = 0;
		parse(line, left, charsmax(left), right, charsmax(right));
		if (equali(left, name))
		{
			value = str_to_num(right);
		}
	}
	fclose(fp);

	return value;
}
