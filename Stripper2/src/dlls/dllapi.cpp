//
// botman's stripper2 - MetaMOD plugin
//
// dllapi.cpp
//

/*
 *    This is free software; you can redistribute it and/or modify it
 *    under the terms of the GNU General Public License as published by the
 *    Free Software Foundation; either version 2 of the License, or (at
 *    your option) any later version.
 *
 *    This is distributed in the hope that it will be useful, but
 *    WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 *    General Public License for more details.
 *
 *    You should have received a copy of the GNU General Public License
 *    along with this code; if not, write to the Free Software Foundation,
 *    Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 *
 *    In addition, as a special exception, the author gives permission to
 *    link the code of this program with the Half-Life Game Engine ("HL
 *    Engine") and Modified Game Libraries ("MODs") developed by Valve,
 *    L.L.C ("Valve").  You must obey the GNU General Public License in all
 *    respects for all of the code used other than the HL Engine and MODs
 *    from Valve.  If you modify this file, you may extend this exception
 *    to your version of the file, but you are not obligated to do so.  If
 *    you do not wish to do so, delete this exception statement from your
 *    version.
 *
 */


#include "extdll.h"
#include "dllapi.h"
#include "meta_api.h"

extern globalvars_t  *gpGlobals;
extern enginefuncs_t g_engfuncs;
extern gamedll_funcs_t *gpGamedllFuncs;

extern cvar_t *dllapi_log;


extern int num_strip_items;
extern char *strip_item_classname[];
extern bool use_strip_item_origin[];
extern vec3_t strip_item_origin[];
extern float strip_item_percent[];

extern int num_add_keyvalues;
extern char *add_item_keyvalue[];

extern int num_add_items;
extern int first_keyvalue_in_item[];
extern int num_keyvalues_in_item[];
extern float add_item_percent[];

extern int num_groups;
extern int first_item_in_group[];
extern int num_items_in_group[];
extern float group_percent[];

extern int num_precache_items;
extern char *precache_item_name[];
extern unsigned char precache_item_type[]; // 0=model, 1=sound, 2=sprite


bool process_config_file(void);
void UTIL_StringToVector( float *pVector, const char *pString );


void GameDLLInit( void ) {
   RETURN_META(MRES_IGNORED);
}


int DispatchSpawn( edict_t *pent ) {
   int index;
   char *pClassname = (char *)STRING(pent->v.classname);

   if (strcmp(pClassname, "worldspawn") == 0)
   {
      // do level initialization stuff here...

      if (process_config_file())
      {
         LOG_CONSOLE(PLID, "[STRIPPER2] ERROR: Error processing .cfg file!");
         LOG_MESSAGE(PLID, "ERROR: Error Processing .cfg file!");
      }
   }
   else  // something other than the world is spawning...
   {
      // see if we need to strip this item out...
      for (index = 0; index < num_strip_items; index++)
      {
         // check if the classname matches...
         if (stricmp(pClassname, strip_item_classname[index]) == 0)
         {
            float d_x, d_y, d_z;

            d_x = fabs(pent->v.origin.x - strip_item_origin[index].x);
            d_y = fabs(pent->v.origin.y - strip_item_origin[index].y);
            d_z = fabs(pent->v.origin.z - strip_item_origin[index].z);

            // if origin not specified OR origin is specified and it matches...
            if ((!use_strip_item_origin[index]) ||
                ((use_strip_item_origin[index]) && (d_x <= 2.0f) && (d_y <= 2.0f) && (d_z <= 2.0f)))
            {
               if (strip_item_percent[index] < 100.0f)
               {
                  float value = RANDOM_FLOAT(0.0, 100.0);

                  if (value >= strip_item_percent[index])  // greater than strip percent?
                     RETURN_META_VALUE(MRES_IGNORED, 0);   // dont't strip this item out
               }

               if (dllapi_log->value)
               {
                  LOG_MESSAGE(PLID, "STRIPPING %s at (%5.2f %5.2f %5.2f)",
                              pClassname, pent->v.origin.x, pent->v.origin.y, pent->v.origin.z);
               }

               REMOVE_ENTITY(pent);
               RETURN_META_VALUE(MRES_SUPERCEDE, 0);
            }
         }
      }
   }

   // 0==Success, -1==Failure ?
   RETURN_META_VALUE(MRES_IGNORED, 0);
}


edict_t *GameCreateEntity(char *classname)
{
   edict_t *pent;
   int istr = MAKE_STRING(classname);

   pent = CREATE_NAMED_ENTITY(istr);
   if ( FNullEnt( pent ) )
   {
      ALERT ( at_console, "[STRIPPER2] ERROR: NULL Ent in GameCreateEntity!\n" );
      LOG_MESSAGE(PLID, "ERROR: NULL Ent in GameCreateEntity!");
   }

   return pent;
}


void GameKeyValue(edict_t *pent, char *classname, char *key, char *value)
{
   KeyValueData pkvd;

   pkvd.szClassName = classname;
   pkvd.szKeyName = key;
   pkvd.szValue = value;
   pkvd.fHandled = FALSE;  // not handled yet

   gpGamedllFuncs->dllapi_table->pfnKeyValue( pent, &pkvd );

   // did the game MOD DLL code NOT handle this key/value pair?
   if (pkvd.fHandled == FALSE)
   {
      // we have the handle the key/value pair ourselves...
      if (pkvd.szKeyName[0])
      {
         if (strcmp(pkvd.szKeyName, "angle") == 0)  // is the key "angle"?
         {
            pent->v.angles.x = 0;
            pent->v.angles.y = atof( pkvd.szValue );  // set the YAW angle
            pent->v.angles.z = 0;
         }
         else if (strcmp(pkvd.szKeyName, "texture") == 0)  // is the key "texture"?
         {
            // the SDK doesn't set the pkvd.fHandled flag to TRUE (it does get handled, just ignore)
         }
         else
         {
            ALERT ( at_console, "[STRIPPER2] WARNING: unknown key in GameKeyValue: %s!\n", pkvd.szKeyName);
            LOG_MESSAGE(PLID, "WARNING: unknown key in GameKeyValue: %s!", pkvd.szKeyName);
         }
      }
   }
}

static char nullname[1];
static char classname[64];
static char keyname[64];
static char value[256];

#define BBOX_MIN   (1<<0)
#define BBOX_MAX   (1<<1)

void AddGameEntity(int keyvalue_index, int num_keyvalues)
{
	edict_t	*pent;
   int index, loop, pos;
   bool classname_found;
   int bbox_flags = 0;
   vec3_t bbox_min, bbox_max;

/*

   vec3_t bbox_min, bbox_max;
   bbox_min.x = -20; bbox_min.y = -20; bbox_min.z = -20;
   bbox_max.x = 20;  bbox_max.y = 20;  bbox_max.z = 20;

   SET_SIZE(pent, bbox_min, bbox_max);
*/

   // search for a "classname" key...
   classname_found = false;
   index = keyvalue_index;
   for (loop = 0; loop < num_keyvalues; loop++, index++)
   {
      if (strncmp(add_item_keyvalue[index], "classname/", 10) == 0)
      {
         classname_found = TRUE;
         break;
      }
   }

   if (!classname_found)
   {
      LOG_MESSAGE(PLID, "WARNING! \"classname\" key not found in the following sequence...");

      index = keyvalue_index;
      for (loop = 0; loop < num_keyvalues; loop++, index++)
         LOG_MESSAGE(PLID, "%s", add_item_keyvalue[index]);

      return;  // skip items without a "classname" key
   }

   if (add_item_keyvalue[index][10] == 0)
   {
      LOG_MESSAGE(PLID, "WARNING! \"classname\" key has no value in the following sequence...");

      index = keyvalue_index;
      for (loop = 0; loop < num_keyvalues; loop++, index++)
         LOG_MESSAGE(PLID, "%s", add_item_keyvalue[index]);

      return;  // skip items with a bad "classname" keyvalue
   }

   strcpy(classname, &add_item_keyvalue[index][10]);

   if (dllapi_log->value)
      LOG_MESSAGE(PLID, "ADDING %s", classname);

   // have the engine create the entity...
   if (FNullEnt(pent = GameCreateEntity(classname)))
   {
      LOG_MESSAGE(PLID, "ERROR: error creating entity for the following sequence...");

      index = keyvalue_index;
      for (loop = 0; loop < num_keyvalues; loop++, index++)
         LOG_MESSAGE(PLID, "%s", add_item_keyvalue[index]);

      return;
   }

   nullname[0] = 0;

   GameKeyValue(pent, nullname, "classname", classname);

   // now loop through all the key/value pairs in this item and assign them...

   index = keyvalue_index;

   for (loop = 0; loop < num_keyvalues; loop++, index++)
   {
      // check if this key/value pair is "classname"
      if (strncmp(add_item_keyvalue[index], "classname/", 10) == 0)
         continue;  // skip the "classname" key

      // search for the '/' key value separator...
      pos = 0;
      while ((add_item_keyvalue[index][pos]) && (add_item_keyvalue[index][pos] != '/'))
         pos++;

      if (add_item_keyvalue[index][pos] == 0)  // no '/' found?
      {
         LOG_MESSAGE(PLID, "ERROR: invalid key/value pair for the following sequence...");

         index = keyvalue_index;
         for (loop = 0; loop < num_keyvalues; loop++, index++)
            LOG_MESSAGE(PLID, "%s", add_item_keyvalue[index]);

         return;
      }

      add_item_keyvalue[index][pos] = 0;
      pos++;

      strcpy(keyname, add_item_keyvalue[index]);
      strcpy(value, &add_item_keyvalue[index][pos]);

      if (dllapi_log->value)
         LOG_MESSAGE(PLID, "%s key/value=%s/%s", classname, keyname, value);

      if (strcmp(keyname, "bbox_min") == 0)
      {
         bbox_flags |= BBOX_MIN;
         UTIL_StringToVector(bbox_min, value);
      }
      else if (strcmp(keyname, "bbox_max") == 0)
      {
         bbox_flags |= BBOX_MAX;
         UTIL_StringToVector(bbox_max, value);
      }
      else
         GameKeyValue(pent, classname, keyname, value);
   }

   // now spawn the entity with the initialized key/value pairs...
   gpGamedllFuncs->dllapi_table->pfnSpawn( pent );

   // the user specify BOTH a bbox_min AND bbox_max key/value pair?
   if ((bbox_flags & (BBOX_MIN | BBOX_MAX)) == (BBOX_MIN | BBOX_MAX))
   {
      // set the size of the bounding box for this entity...
      SET_SIZE(pent, bbox_min, bbox_max);
   }
}


void ServerActivate( edict_t *pEdictList, int edictCount, int clientMax ) {
   int index;

   nullname[0] = 0;

   // precache all the needed items...

   for (index = 0; index < num_precache_items; index++)
   {
      switch(precache_item_type[index])
      {
         case 0:  // model
            if (dllapi_log->value)
               LOG_MESSAGE(PLID, "PRECACHING MODEL %s", precache_item_name[index]);
            PRECACHE_MODEL(precache_item_name[index]);
            break;
         case 1:  // sound
            if (dllapi_log->value)
               LOG_MESSAGE(PLID, "PRECACHING SOUND %s", precache_item_name[index]);
            PRECACHE_SOUND(precache_item_name[index]);
            break;
         case 2:  // sprite
            if (dllapi_log->value)
               LOG_MESSAGE(PLID, "PRECACHING SPRITE %s", precache_item_name[index]);
            PRECACHE_MODEL(precache_item_name[index]);
            break;
      }
   }

   // now create and spawn and new entities...

   for (int group_index = 0; group_index < num_groups; group_index++)
   {
      if (group_percent[group_index] < 100.0f)
      {
         float value = RANDOM_FLOAT(0.0, 100.0);

         if (value >= group_percent[group_index])  // greater than strip percent?
            continue;  // skip this group
      }

      int item_index = first_item_in_group[group_index];

      float value = RANDOM_FLOAT(0.0, 99.0);
      float percent_total = add_item_percent[item_index];

      for (int j = 0; j < num_items_in_group[group_index]; j++)
      {
         if (value <= percent_total)
         {
            int keyvalue_index = first_keyvalue_in_item[item_index];
            int num_keyvalues = num_keyvalues_in_item[item_index];

            AddGameEntity(keyvalue_index, num_keyvalues);

            break;  // break out of item loop, continue group loop
         }

         item_index++;

         percent_total += add_item_percent[item_index];
      }
   }

   RETURN_META(MRES_IGNORED);
}

static DLL_FUNCTIONS gFunctionTable = 
{
   GameDLLInit,     //! pfnGameInit()   Initialize the game (one-time call after loading of game .dll)
   DispatchSpawn,   //! pfnSpawn()
   NULL,            // pfnThink
   NULL,            // pfnUse
   NULL,            // pfnTouch
   NULL,            // pfnBlocked
   NULL,            // pfnKeyValue
   NULL,            // pfnSave
   NULL,            // pfnRestore
   NULL,            // pfnSetAbsBox

   NULL,            // pfnSaveWriteFields
   NULL,            // pfnSaveReadFields

   NULL,            // pfnSaveGlobalState
   NULL,            // pfnRestoreGlobalState
   NULL,            // pfnResetGlobalState

   NULL,            // pfnClientConnect
   NULL,            // pfnClientDisconnect
   NULL,            // pfnClientKill
   NULL,            // pfnClientPutInServer
   NULL,            // pfnClientCommand
   NULL,            // pfnClientUserInfoChanged
   ServerActivate,  //! pfnServerActivate()     (wd) Server is starting a new map
   NULL,            // pfnServerDeactivate

   NULL,            // pfnPlayerPreThink
   NULL,            // pfnPlayerPostThink

   NULL,            // pfnStartFrame
   NULL,            // pfnParmsNewLevel
   NULL,            // pfnParmsChangeLevel

   NULL,            // pfnGetGameDescription
   NULL,            // pfnPlayerCustomization

   NULL,            // pfnSpectatorConnect
   NULL,            // pfnSpectatorDisconnect
   NULL,            // pfnSpectatorThink
   
   NULL,            // pfnSys_Error

   NULL,            // pfnPM_Move
   NULL,            // pfnPM_Init
   NULL,            // pfnPM_FindTextureType
   
   NULL,            // pfnSetupVisibility
   NULL,            // pfnUpdateClientData
   NULL,            // pfnAddToFullPack
   NULL,            // pfnCreateBaseline
   NULL,            // pfnRegisterEncoders
   NULL,            // pfnGetWeaponData
   NULL,            // pfnCmdStart
   NULL,            // pfnCmdEnd
   NULL,            // pfnConnectionlessPacket
   NULL,            // pfnGetHullBounds
   NULL,            // pfnCreateInstancedBaselines
   NULL,            // pfnInconsistentFile
   NULL,            // pfnAllowLagCompensation
};

C_DLLEXPORT int GetEntityAPI2( DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion )
{
   if(!pFunctionTable) {
      UTIL_LogPrintf("GetEntityAPI2 called with null pFunctionTable");
      return(FALSE);
   }
   else if(*interfaceVersion != INTERFACE_VERSION) {
      UTIL_LogPrintf("GetEntityAPI2 version mismatch; requested=%d ours=%d", *interfaceVersion, INTERFACE_VERSION);
      //! Tell engine what version we had, so it can figure out who is out of date.
      *interfaceVersion = INTERFACE_VERSION;
      return(FALSE);
   }
   memcpy( pFunctionTable, &gFunctionTable, sizeof( DLL_FUNCTIONS ) );
   return(TRUE);
}

