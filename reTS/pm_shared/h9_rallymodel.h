// ---- H9 rally car: which model draws which class (no engine; tested in tests/carmenu_test.cpp) ----------------------------------------------
// A class (1..10, pm_shared/h9_rally_shop.h) is drawn with its brand's model: VOLKRA, AMBERLINE or KESTREL, each with the contract of the
// generic models/h9/rc_rally_xs.mdl (bones, sequence, controllers, attachment, skins, header box) and a _chrome companion. The generic one
// stands in for class 0, an unknown class, and a brand whose file is not there (the caller knows that; this file only names).
#pragma once

#include "h9_rally_shop.h"

#include <stdio.h>
#include <string.h>

namespace rallymodel
{
enum Brand
{
	BRAND_GENERIC = 0,
	BRAND_VOLKRA,
	BRAND_AMBERLINE,
	BRAND_KESTREL,
	BRAND_COUNT
};

static const char* const kGeneric = "models/h9/rc_rally_xs.mdl";
static const char* const kGenericChrome = "models/h9/rc_rally_xs_chrome.mdl";
static const char* const kBrandModel[BRAND_COUNT] = {
	"models/h9/rc_rally_xs.mdl",
	"models/h9/rc_rally_volkra_xs.mdl",
	"models/h9/rc_rally_amberline_xs.mdl",
	"models/h9/rc_rally_kestrel_xs.mdl",
};
static const char* const kBrandChrome[BRAND_COUNT] = {
	"models/h9/rc_rally_xs_chrome.mdl",
	"models/h9/rc_rally_volkra_xs_chrome.mdl",
	"models/h9/rc_rally_amberline_xs_chrome.mdl",
	"models/h9/rc_rally_kestrel_xs_chrome.mdl",
};

// The class's brand (BRAND_GENERIC for 0, out of range, or a make this file does not know).
inline int BrandOf(int cls)
{
	if (cls < 1 || cls > 10)
		return BRAND_GENERIC;
	const char* make = g_h9RallyCarShow[cls - 1].make;
	if (strcmp(make, "VOLKRA") == 0)
		return BRAND_VOLKRA;
	if (strcmp(make, "AMBERLINE") == 0)
		return BRAND_AMBERLINE;
	if (strcmp(make, "KESTREL") == 0)
		return BRAND_KESTREL;
	return BRAND_GENERIC;
}

// The class's model path, and its chrome overlay's. Never null.
inline const char* ClassToModel(int cls) { return kBrandModel[BrandOf(cls)]; }
inline const char* ClassToChrome(int cls) { return kBrandChrome[BrandOf(cls)]; }
} // namespace rallymodel
