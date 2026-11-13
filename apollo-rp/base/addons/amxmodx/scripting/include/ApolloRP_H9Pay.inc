/*
 * ApolloRP_H9Pay.inc -- H9: the salary a job pays, set from outside (ARP_PayScale; docs\APOLLO_RP.txt, section 8; apollo-rp\ORIGIN.txt, item 49).
 *
 * ARP_Core pays each player the salary of his job as the core holds it (the job's row when it was read), and every screen that shows a salary (the HUD, /menu, the employment offer,
 * arp_joblist) reads the same number from the core. ARP_H9SetJobSalary changes that number in memory, so that the pay and the screens agree on what a plugin decides a job pays.
 * Only a plugin that includes this file declares the native (ARP_PayScale does); ApolloRP.inc does not include it, so the other plugins of the set neither see it nor change with it.
 */

#if defined _ApolloRP_H9Pay_included
	#endinput
#endif

#define _ApolloRP_H9Pay_included

// Sets the salary the core holds for a job, in memory only: the job's row in the database is not changed, and the next map load reads the row again. Each player in the game
// who has the job is paid it from the next payday, and ARP_GetJobSalary, arp_joblist and every screen that shows a salary say it. Returns 1 when it is set.
// An ARP_Core that has no such native still loads a plugin that declares it, when the plugin has a native filter that lets the load go on (ARP_PayScale has one, and then pays by the
// ARP_Salary forward alone); such a plugin must not call it.
// jobid - the id of the job; salary - the amount, a whole number
native ARP_H9SetJobSalary(jobid,salary)
