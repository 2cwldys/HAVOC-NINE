#include <amxmodx>
#include <ApolloRP>
#include <ApolloRP_H9Pay>

// H9: ARP_PayScale -- every job's salary is paid at a percent, and a map's pay.ini names the salary of the jobs it lists (docs\APOLLO_RP.txt, section 8; ORIGIN.txt item 49).
//
// A SALARY is the whole number of credits a job is paid into the BANK (never the wallet) at each payday: ARP_Core's loop ShowHud runs every 2.0 - arp_performance / 100 seconds (a second at the
// shipped 100) and pays on every 60th pass, so a salary of 10 is 10 a minute at 100. A job's salary is its row in the jobs table of the map; the "$/hr" and "$/h" of the HUD, /menu and the
// employment offer are upstream's words for it.
//
// WHAT A JOB IS PAID is the salary of its line in pay.ini when the file has one for it, else the salary of its row, at arp_h9_pay_percent per cent: value * percent / 100 rounded half up, in whole
// numbers, with no float and no sum past 32 bits (a value counts up to 100000000; a percent is 0 to 1000). A salary of 0 stays 0, and a row below 0 is left as it is. With arp_h9_pay_percent 100
// (this plugin's own default) and no pay.ini the plugin changes nothing: it gives the core no salary, stops no payday, logs nothing and writes nothing, and the core pays what its rows say, as
// stock Apollo RP does.
//
// pay.ini is the map's file, configs\arp\maps\<map>\pay.ini, else configs\arp\pay.ini (ARP_FileOpen's rule), read when the map loads. A blank line, and a line that starts with ; (blanks in front
// of it do not matter), is skipped. A job line is  "<job name>" <salary>: the name in quotes when it holds a space, compared whole and without regard to case (never as a part of a name, as
// ARP_FindJobId does); the salary a whole number from 0 to 100000000; words after it are ignored; when two lines name a job the later one counts. A line that is no job line, and a name that is
// no job of the map, is said once in the AMX Mod X log and does nothing else. Lines are read 127 characters at a time, as every ARP file is, and 128 job lines are kept. The file is read at the
// map load, so a change to it takes a map change; the percent is read all the time. arp_h9_pay_dump lists each job's row, line and pay.
//
// HOW IT IS PAID. When ARP_Core has the native ARP_H9SetJobSalary (include\ApolloRP_H9Pay.inc) the plugin looks at the jobs every PAY_BEAT seconds, keeps each job's row from its first look and
// gives the core the salary to pay: the native sets the salary the core holds in memory for the job, and the one of each player in the game who has it, and never a row of the database. The core
// then pays it by its own code, and the HUD, /menu, the employment offer and arp_joblist, which read the salary from the core, say the same number. The plugin writes no table: a row stays as the
// table has it and is the base of the sums at the next map load. A core without the native still loads this plugin (the native filter notes it, and arp_h9_pay_dump says way=forward): the
// paycheck is the same, made by the forward below, and those four screens say the row.
//
// THE FORWARD ARP_Salary is answered in both ways, for the character whose pay it is and whose character has loaded: when the amount he is to be paid is what the core holds for his job the answer
// is PLUGIN_CONTINUE and the core pays it; when it is not (the percent was changed a moment ago and the jobs have not been looked at yet, or the core has no native) the plugin adds the amount to
// his bank itself, never past 2147483647, and answers PLUGIN_HANDLED, so that the core adds nothing. The forward stops at the first plugin that answers PLUGIN_HANDLED: ARP_HungerMod (a starving
// character) and ARP_JailMod (a cuffed or jailed one) stop a payday as they did, provided they are listed BEFORE this plugin in plugins.ini, which build.bat makes so (it adds a new plugin at the
// end); a plugin listed after this one never sees a payday that this one paid itself, and the log has a line when plugins.ini lists this one before ARP_HungerMod or ARP_JailMod.

#define PAY_JOBS_MAX 256            // the jobs of a map that the plugin counts
#define PAY_LINES_MAX 128           // the job lines of a pay.ini that it keeps
#define PAY_CAP 100000000           // the largest salary a line may give and the largest a percent may make
#define PAY_PCT_MAX 1000            // the largest percent
#define PAY_BEAT 2.0                // seconds between two looks at the jobs
#define PAY_NAME_LEN 33             // a job's name, with its end
#define PAY_LINE_LEN 127            // ARP's file readers take a line 127 characters at a time
#define PAY_MAX_CELL 2147483647     // the largest number a bank can hold

new p_Percent                       // arp_h9_pay_percent

new g_NoSetter                      // 1: the core has no ARP_H9SetJobSalary (the native filter saw it missing when the plugin loaded)
new g_PctSeen = 100                 // the percent the last look at the jobs found, for the line the log has when it changes
new g_Looked                        // 1: the names of pay.ini have been looked for among the jobs once (the ones no job has are said then)
new g_Sets                          // salaries given to the core since the map began
new g_Forward                       // paydays the plugin paid itself since the map began

// the job lines of pay.ini
new g_LineName[PAY_LINES_MAX][PAY_NAME_LEN]
new g_LineSalary[PAY_LINES_MAX]
new g_LineNo[PAY_LINES_MAX]         // the line's number in the file
new g_LineHit[PAY_LINES_MAX]        // how many jobs of the map it named
new g_Lines                         // job lines kept
new g_FileSeen                      // 1: a pay.ini was found
new g_FileRefused                   // lines of it that were no job line
new g_FileOver                      // job lines past PAY_LINES_MAX

// the jobs, by the core's id (1 on)
new g_Known[PAY_JOBS_MAX + 1]       // 1: the plugin has seen the job
new g_Base[PAY_JOBS_MAX + 1]        // the salary of the job's row when the plugin first saw it
new g_Ovr[PAY_JOBS_MAX + 1]         // the salary a pay.ini line gave it, -1 for none

// ---------------------------------------------------------------------------------------------------------------------- start

// a core without the native still loads this plugin: the filter lets the load go on and says so
public plugin_natives()
	set_native_filter("PayNativeFilter")

public PayNativeFilter(const Name[],Index,Trap)
{
	if(!equal(Name,"ARP_H9SetJobSalary"))
		return PLUGIN_CONTINUE

	if(!Trap)
		g_NoSetter = 1

	return PLUGIN_HANDLED
}

public plugin_init()
{
	p_Percent = register_cvar("arp_h9_pay_percent","100")

	ARP_AddCommand("arp_h9_pay_dump","(ADMIN) Shows what each job pays: its row, its pay.ini line, the percent, what is paid and what the core says")
	register_concmd("arp_h9_pay_dump","CmdDump",_,"- what each job pays")
}

public ARP_Init()
{
	ARP_RegisterPlugin("PayScale",ARP_VERSION,"H9","Pays every job's salary at a percent, and lets a map's pay.ini name the salary of a job")

	pay_read()
	pay_check_order()

	set_task(PAY_BEAT,"PayBeat",_,_,_,"b")
}

public ARP_Error(const Reason[])
	pause("d")

// ---------------------------------------------------------------------------------------------------------------------- pay.ini

// the whole number a text holds (digits only, at most nine of them, at most PAY_CAP), else -1
stock pay_number(const text[])
{
	new len = strlen(text),value

	if(len < 1 || len > 9)
		return -1

	for(new i;i < len;i++)
	{
		if(text[i] < '0' || text[i] > '9')
			return -1

		value = value * 10 + text[i] - '0'
	}

	return value > PAY_CAP ? -1 : value
}

// the job lines of the map's pay.ini
stock pay_read()
{
	new file = ARP_FileOpen("pay.ini","r")
	if(!file)
		return

	g_FileSeen = 1

	new line[PAY_LINE_LEN + 1],name[PAY_NAME_LEN],number[16],no,salary

	while(!feof(file))
	{
		fgets(file,line,PAY_LINE_LEN)
		no++
		trim(line)

		if(!line[0] || line[0] == ';')
			continue

		name[0] = 0
		number[0] = 0
		salary = parse(line,name,PAY_NAME_LEN - 1,number,15) < 2 ? -1 : pay_number(number)

		if(!name[0] || salary < 0)
		{
			g_FileRefused++
			log_amx("[ARP] pay: pay.ini line %d is not ^"<job name>^" <salary> (a whole number, 0 to %d): it does nothing",no,PAY_CAP)

			continue
		}

		if(g_Lines >= PAY_LINES_MAX)
		{
			g_FileOver++

			continue
		}

		copy(g_LineName[g_Lines],PAY_NAME_LEN - 1,name)
		g_LineSalary[g_Lines] = salary
		g_LineNo[g_Lines] = no
		g_Lines++
	}

	fclose(file)

	if(g_FileOver)
		log_amx("[ARP] pay: pay.ini has more than %d job lines: the %d after them do nothing",PAY_LINES_MAX,g_FileOver)
}

// the job lines that no job of the map matched, said once, when the jobs have been read
stock pay_unknown()
{
	for(new i;i < g_Lines;i++)
		if(!g_LineHit[i])
			log_amx("[ARP] pay: pay.ini line %d: no job of this map is named ^"%s^": it does nothing",g_LineNo[i],g_LineName[i])
}

// ---------------------------------------------------------------------------------------------------------------------- the sums

// value at percent per cent, in whole numbers: value * percent / 100 rounded half up, as value / 100 * percent + (value % 100 * percent + 50) / 100, which never passes 32 bits
// (value counts up to PAY_CAP, percent up to PAY_PCT_MAX). A salary of 0 or less, and 100 per cent, are as they are.
stock pay_scale(value,percent)
{
	if(value <= 0 || percent == 100)
		return value

	if(value > PAY_CAP)
		value = PAY_CAP

	return min(value / 100 * percent + (value % 100 * percent + 50) / 100,PAY_CAP)
}

stock pay_percent()
	return clamp(get_pcvar_num(p_Percent),0,PAY_PCT_MAX)

// the plugin's first look at a job: the salary of its row, and the pay.ini line that names it. 1 when the job is there and the plugin keeps it; a job that arp_deletejob has taken away (the core
// never gives its id to another job) is not there any more, and a job past PAY_JOBS_MAX is not kept
stock pay_know(job)
{
	if(job < 1 || job > PAY_JOBS_MAX || !ARP_ValidJobId(job))
		return 0

	if(g_Known[job])
		return 1

	new name[PAY_NAME_LEN]
	ARP_GetJobName(job,name,PAY_NAME_LEN - 1)

	g_Base[job] = ARP_GetJobSalary(job)
	g_Ovr[job] = -1

	for(new i;i < g_Lines;i++)
	{
		if(equali(name,g_LineName[i]))
		{
			g_Ovr[job] = g_LineSalary[i]
			g_LineHit[i]++
		}
	}

	g_Known[job] = 1

	return 1
}

// what a known job is paid at a percent
stock pay_for(job,percent)
	return pay_scale(g_Ovr[job] >= 0 ? g_Ovr[job] : g_Base[job],percent)

// ---------------------------------------------------------------------------------------------------------------------- the jobs

public PayBeat()
{
	new percent = pay_percent()

	if(percent != g_PctSeen)
	{
		log_amx("[ARP] pay: arp_h9_pay_percent is %d (it was %d)",percent,g_PctSeen)
		g_PctSeen = percent
	}

	new jobs = ARP_GetJobsNum()

	if(jobs < 1)
		return

	new top = min(jobs,PAY_JOBS_MAX),want

	for(new job = 1;job <= top;job++)
	{
		if(!pay_know(job) || g_NoSetter)
			continue

		want = pay_for(job,percent)

		if(ARP_GetJobSalary(job) != want && ARP_H9SetJobSalary(job,want))
			g_Sets++
	}

	if(!g_Looked)
	{
		g_Looked = 1
		pay_unknown()
	}
}

// the character's pay is the core's own when it holds the amount he is to be paid, and this plugin's when it does not
public ARP_Salary(id)
{
	if(!ARP_PlayerReady(id))
		return PLUGIN_CONTINUE

	new job = ARP_GetUserJobId(id)

	if(!pay_know(job))
		return PLUGIN_CONTINUE

	new want = pay_for(job,pay_percent())

	if(want == ARP_GetJobSalary(job))
		return PLUGIN_CONTINUE

	if(want > 0)
	{
		new bank = ARP_GetUserBank(id)

		ARP_SetUserBank(id,bank > PAY_MAX_CELL - want ? PAY_MAX_CELL : bank + want)
	}

	g_Forward++

	return PLUGIN_HANDLED
}

// ARP_HungerMod and ARP_JailMod stop a payday by the forward, which stops at the first plugin that does: they must be listed before this plugin, or this plugin pays the characters it pays
// itself whatever they say. The log says so when one of them is listed after it.
stock pay_check_order()
{
	new self = find_plugin_byfile("ARP_PayScale.amxx",1)

	if(self < 0)
		return

	static const names[][] = {"ARP_HungerMod.amxx","ARP_JailMod.amxx"}

	for(new i;i < sizeof names;i++)
	{
		new other = find_plugin_byfile(names[i],1)

		if(other > self)
			log_amx("[ARP] pay: plugins.ini lists ARP_PayScale before %s: list it after, or a character that plugin stops is paid by this one",names[i])
	}
}

// ---------------------------------------------------------------------------------------------------------------------- console

// arp_h9_pay_dump: the percent, how the plugin pays, what pay.ini gave and what each job pays, for a server that is looked at with nobody at a screen
public CmdDump(id,level,cid)
{
	#pragma unused level

	if(!ARP_CmdAccess(id,cid,1))
		return PLUGIN_HANDLED

	new percent = pay_percent(),jobs = ARP_GetJobsNum(),top = min(jobs,PAY_JOBS_MAX),name[PAY_NAME_LEN],ini[12]

	console_print(id,"PAY percent=%d way=%s file=%d lines=%d refused=%d over=%d jobs=%d given=%d paid_by_forward=%d",percent,g_NoSetter ? "forward" : "core",g_FileSeen,g_Lines,g_FileRefused,g_FileOver,jobs,g_Sets,g_Forward)

	for(new job = 1;job <= top;job++)
	{
		if(!pay_know(job))
			continue

		ARP_GetJobName(job,name,PAY_NAME_LEN - 1)

		if(g_Ovr[job] < 0)
			copy(ini,11,"-")
		else
			num_to_str(g_Ovr[job],ini,11)

		console_print(id,"JOB %d ^"%s^" row=%d ini=%s paid=%d core=%d",job,name,g_Base[job],ini,pay_for(job,percent),ARP_GetJobSalary(job))
	}

	return PLUGIN_HANDLED
}
