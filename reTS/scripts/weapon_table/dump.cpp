// Prints the weapon table the game builds (compile_weapons_info), one row per weapon, tab separated.
#include "ts_weapon_info.h"
#include <stdio.h>

int main()
{
	compile_weapons_info();
	printf("id\tname\tdamage\tpellets\tclip\trate\tfiretype\tmodes\tspread\tviewkick\trecoil\tcaliber\tcalname\tprice\tslot\treload\tcoldcock\tmode1\trangeunit\tmaxcarry\tmag\tattach\tcoldcockdmg\n");
	for (int w = 0; w < TSW_COUNT; w++)
	{
		const s_weapon_info *wi = get_weapon_info((tsweapon_t)w);
		const s_ammo_info *ai = get_ammo_info(wi->iCaliber);
		printf("%d\t%s\t%.4f\t%d\t%d\t%.4f\t%d\t%d\t%.5f\t%.3f\t%.5f\t%d\t%s\t%d\t%d\t%.2f\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", w,
			wi->pszName ? wi->pszName : "", wi->flDamage, wi->iPellets, wi->iClip, wi->flFireRate, wi->iFireType,
			wi->iFireModes, wi->flSpread, wi->flViewKick, wi->flRecoil, wi->iCaliber, ai->szName, wi->iPrice,
			wi->slotCost, wi->flReloadTime, wi->iColdCockDamage, wi->iKnifeType, ai->iRangeUnit, ai->iMaxCarry,
			ai->iRoundsPerMag, wi->attachSupported, wi->iColdCockDamage);
	}
	return 0;
}
