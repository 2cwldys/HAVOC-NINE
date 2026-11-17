//
// botman's stripper2 - MetaMOD plugin
//
// config.cpp
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

#include <stdio.h>
#include <string.h>

#ifndef __linux__
#include <io.h>
#else
#include <unistd.h>
#endif

#include "extdll.h"
#include "dllapi.h"
#include "vector.h"
#include "meta_api.h"

extern cvar_t *dllapi_log;

#define MAX_STRIP_ITEMS    400
#define MAX_ADD_KEYVALUE  1000
#define MAX_ADD_ITEMS      400
#define MAX_ADD_GROUPS     100

int num_strip_items;
char *strip_item_classname[MAX_STRIP_ITEMS];
bool use_strip_item_origin[MAX_STRIP_ITEMS];
vec3_t strip_item_origin[MAX_STRIP_ITEMS];
float strip_item_percent[MAX_STRIP_ITEMS];

int num_add_keyvalues;
char *add_item_keyvalue[MAX_ADD_KEYVALUE];

int num_add_items;
int first_keyvalue_in_item[MAX_ADD_ITEMS];
int num_keyvalues_in_item[MAX_ADD_ITEMS];
float add_item_percent[MAX_ADD_ITEMS];

int num_groups;
int first_item_in_group[MAX_ADD_GROUPS];
int num_items_in_group[MAX_ADD_GROUPS];
float group_percent[MAX_ADD_GROUPS];

#define MAX_PRECACHE_ITEMS 100

int num_precache_items;
char *precache_item_name[MAX_PRECACHE_ITEMS];
unsigned char precache_item_type[MAX_PRECACHE_ITEMS]; // 0=model, 1=sound, 2=sprite

#define MAX_STRING_BUFFER_SIZE 32768
int string_buffer_pos;
char string_buffer[MAX_STRING_BUFFER_SIZE];


char *allocate_string(int size)
{
   char *buffer;

   if ((string_buffer_pos + size) >= MAX_STRING_BUFFER_SIZE)
      return NULL;  // not enough space left in buffer

   buffer = &string_buffer[string_buffer_pos];

   string_buffer_pos += size;

   return buffer;
}


bool scan_stripper_cfg(FILE *fp)
{
   char input[1024];
   char item_name[64];
   int len, pos, index;
   float percent;

   while (!feof(fp))
   {
      if (fgets(input, 1023, fp) != NULL)
      {
         len = strlen(input);
         if (input[len-1] == '\n')
            input[len-1] = 0;
      }
      else
         input[0] = 0;

      pos = 0;

      while (isspace(input[pos]))
         pos++;  // skip leading blanks

      if ((input[pos] == '/') && (input[pos+1] == '/'))
         continue;  // skip comment lines

      if (input[pos] == 0)
         continue;  // skip empty lines

      index = 0;
      while (input[pos] && !isspace(input[pos]))
      {
         if (index < 63)
            item_name[index++] = input[pos++];
         else
            pos++;
      }

      item_name[index] = 0;  // add null terminator

      if (item_name[0])
      {
         use_strip_item_origin[num_strip_items] = FALSE;

         if (input[pos])
         {
            if (sscanf(&input[pos], "%f", &percent) <= 0)
               percent = 100.0f;
         }
         else
            percent = 100.0f;

         if (percent > 100.0f)
            percent = 100.0f;

         len = strlen(item_name) + 1;
         strip_item_classname[num_strip_items] = allocate_string(len);
         if (strip_item_classname[num_strip_items] == NULL)
         {
            printf("ERROR ALLOCATING MEMORY!!!\n");
            return TRUE;  // return error status
         }
         strcpy(strip_item_classname[num_strip_items], item_name);

         strip_item_percent[num_strip_items] = percent;

         num_strip_items++;
      }
   }

   return FALSE;  // no error occurred
}


bool scan_map_cfg(FILE *fp)
{
   char input[1024];
   char item_name[64];
   int len, pos, index;
   float percent;
   int section = 0;  // [strip] = 1, [add] = 2
   int token = 0;  // single or double '{' token
   float x, y, z;
   bool first_key, first_item;
   int num_in_group;

   num_in_group = 0;

   for (index=0; index < MAX_ADD_ITEMS; index++)
      num_keyvalues_in_item[index] = 0;

   // we haven't stored the first item in this group yet, set flag
   first_item = TRUE;

   while (!feof(fp))
   {
      if (fgets(input, 1023, fp) != NULL)
      {
         len = strlen(input);
         if (input[len-1] == '\n')
            input[len-1] = 0;
      }
      else
         input[0] = 0;

      pos = 0;

      while (isspace(input[pos]))
         pos++;  // skip leading blanks

      if ((input[pos] == '/') && (input[pos+1] == '/'))
         continue;  // skip comment lines

      if (input[pos] == 0)
         continue;  // skip empty lines

      if (strncmp(&input[pos], "[strip]", 7) == 0)
      {
         section = 1;
         continue;
      }

      if (strncmp(&input[pos], "[add]", 5) == 0)
      {
         section = 2;
         continue;
      }

      if (strncmp(&input[pos], "PRECACHE_", 9) == 0)
      {
         char precache_name[256];
         int offset = pos;

         while ((input[offset]) && (input[offset] != '('))
            offset++;  // skip to '('

         if (strncmp(&input[pos], "PRECACHE_MODEL", 14) == 0)
         {
            precache_item_type[num_precache_items] = 0;  // model
         }
         else if (strncmp(&input[pos], "PRECACHE_SOUND", 14) == 0)
         {
            precache_item_type[num_precache_items] = 1;  // sound
         }
         else if (strncmp(&input[pos], "PRECACHE_SPRITE", 15) == 0)
         {
            precache_item_type[num_precache_items] = 2;  // sprite
         }
         else
         {
            printf("Error in input: %s\n", input);
            return TRUE;
         }

         if (sscanf(&input[offset], "(%s)", &precache_name) < 1)
         {
            printf("Error in input: %s\n", input);
            return TRUE;
         }

         index = 0;
         while ((precache_name[index]) && (precache_name[index] != ')'))
            index++;
         precache_name[index] = 0;  // strip off terminating ')' character

         len = strlen(precache_name) + 1;
         precache_item_name[num_precache_items] = allocate_string(len);
         if (precache_item_name[num_precache_items] == NULL)
         {
            printf("ERROR ALLOCATING MEMORY!!!\n");
            return TRUE;
         }
         strcpy(precache_item_name[num_precache_items], precache_name);

         num_precache_items++;

         continue;
      }

      if (section == 1)  // stripping?
      {
         index = 0;
         while (input[pos] && !isspace(input[pos]))
         {
            if (index < 63)
               item_name[index++] = input[pos++];
            else
               pos++;
         }

         item_name[index] = 0;  // add null terminator

         if (item_name[0])
         {
            use_strip_item_origin[num_strip_items] = FALSE;

            while (isspace(input[pos]))
               pos++;  // skip leading blanks

            if (input[pos] == '(')
            {
               if (sscanf(&input[pos], "(%f %f %f)", &x, &y, &z) < 3)
               {
                  printf("Error in input: %s\n", input);
                  return TRUE;
               }

               use_strip_item_origin[num_strip_items] = TRUE;

               strip_item_origin[num_strip_items].x = x;
               strip_item_origin[num_strip_items].y = y;
               strip_item_origin[num_strip_items].z = z;

               while ((input[pos] != ')') && (input[pos]))
                  pos++;  // skip leading blanks

               if (input[pos])
                  pos++;  // skip the ')'
            }

            if (input[pos])
            {
               if (sscanf(&input[pos], "%f", &percent) <= 0)
                  percent = 100.0f;
            }
            else
               percent = 100.0f;

            if (percent > 100.0f)
               percent = 100.0f;

            len = strlen(item_name) + 1;
            strip_item_classname[num_strip_items] = allocate_string(len);
            if (strip_item_classname[num_strip_items] == NULL)
            {
               printf("ERROR ALLOCATING MEMORY!!!\n");
               return TRUE;
            }
            strcpy(strip_item_classname[num_strip_items], item_name);

            strip_item_percent[num_strip_items] = percent;

            num_strip_items++;
         }
      }
      else if (section == 2)  // adding?
      {
         if (input[pos] == '{')
         {
            if (token == 1)
               token = 2;
            else
               token = 1;

            // we haven't stored the first key in this item yet, set flag
            first_key = TRUE;

            if (first_item)
            {
               first_item = FALSE;
               first_item_in_group[num_groups] = num_add_items;
            }

            continue;  // continue with next line of input
         }

         if (input[pos] == '}')
         {
            pos++;  // skip the token

            if (input[pos])
            {
               if (sscanf(&input[pos], "%f", &percent) <= 0)
                  percent = 100.0f;
            }
            else
               percent = 100.0f;

            if (percent > 100.0f)
               percent = 100.0f;

            if (token == 2)
            {
               token = 1;
               add_item_percent[num_add_items] = (float)percent;
               num_add_items++;
               num_in_group++;
            }
            else
            {
               token = 0;

               if (num_in_group == 0)  // single item group?
               {
                  add_item_percent[num_add_items] = 100.0f;
                  num_add_items++;
                  num_in_group = 1;  // only 1 item in single item groups
               }

               float group_total = 0;
               int unspecified = 0;  // unspecified percent groups
               float unspecified_percent;

               int item_index = first_item_in_group[num_groups];

               for (int loop = 0; loop < num_in_group; loop++)
               {
                  if (add_item_percent[item_index] < 100.0f)
                     group_total += add_item_percent[item_index];
                  else
                     unspecified++;

                  item_index++;
               }

               if (group_total > 100.0f)
               {
                  printf("Error!!! group %d: total > 100 percent!!!\n", num_groups+1);
                  return TRUE;
               }

               if ((unspecified == 0) && (group_total < 100.0f))
               {
                  printf("Error!!! group %d: total < 100 percent!!!\n", num_groups+1);
                  return TRUE;
               }

               if (unspecified > 0)
               {
                  unspecified_percent = (100.0f - group_total) / unspecified;

                  item_index = first_item_in_group[num_groups];

                  for (int loop = 0; loop < num_in_group; loop++)
                  {
                     if (add_item_percent[item_index] > 99.9f)  // 100 percent?
                        add_item_percent[item_index] = unspecified_percent;

                     item_index++;
                  }
               }

               num_items_in_group[num_groups] = num_in_group;
               group_percent[num_groups] = percent;
               num_groups++;

               num_in_group = 0;

               // we haven't stored the first item in this group yet, set flag
               first_item = TRUE;
            }

            continue;  // continue with next line of input
         }

         // see if there's a comment on this line...
         index = pos;
         while (input[index])
         {
            if ((input[index] == '/') && (input[index+1] == '/'))
               input[index] = 0;  // a null terminator at comment position
            else
               index++;
         }

         // remove any trailing whitespace...
         index--;
         while (isspace(input[index]))
         {
            input[index] = 0;
            index--;
         }

         len = strlen(&input[pos]) + 1;
         add_item_keyvalue[num_add_keyvalues] = allocate_string(len);
         if (add_item_keyvalue[num_add_keyvalues] == NULL)
         {
            printf("ERROR ALLOCATING MEMORY!!!\n");
            return TRUE;
         }
         strcpy(add_item_keyvalue[num_add_keyvalues], &input[pos]);

         if (first_key)
         {
            first_key = FALSE;
            first_keyvalue_in_item[num_add_items] = num_add_keyvalues;
         }

         num_add_keyvalues++;
         num_keyvalues_in_item[num_add_items]++;
      }
   }

   return FALSE;
}


bool process_config_file(void)
{
   char game_dir[256];
   char filename[256];
   FILE *fp = NULL;
   bool status;

   string_buffer_pos = 0;

   num_strip_items = 0;

   num_add_keyvalues = 0;
   num_add_items = 0;
   num_groups = 0;
   num_precache_items = 0;

   // find the directory name of the currently running MOD...
   (*g_engfuncs.pfnGetGameDir)(game_dir);

   if (dllapi_log->value)
      LOG_MESSAGE(PLID, "GAMEDIR=%s", game_dir);

   strcpy(filename, game_dir);
#ifdef __linux__
   strcat(filename, "/maps/");
#else
   strcat(filename, "\\maps\\");
#endif
   strcat(filename, STRING(gpGlobals->mapname));
   strcat(filename, "_str.cfg");

   // check if the map specific filename does not exist...
   if (access(filename, 0) != 0)
   {
      // process the generic "stripper2.cfg" file...

      strcpy(filename, game_dir);
#ifdef __linux__
      strcat(filename, "/");
#else
      strcat(filename, "\\");
#endif
      strcat(filename, "stripper2.cfg");

      if (dllapi_log->value)
         LOG_MESSAGE(PLID, "Processing config file=%s", filename);

      if ((fp = fopen(filename, "r")) == NULL)
      {
         LOG_CONSOLE(PLID, "[STRIPPER2] ERROR: Could not open \"stripper2.cfg\" file!");
         LOG_MESSAGE(PLID, "ERROR: Could not open \"stripper2.cfg\" file!");

         return TRUE;  // return bad status
      }

      status = scan_stripper_cfg(fp);

      fclose(fp);
   }
   else
   {
      if (dllapi_log->value)
         LOG_MESSAGE(PLID, "Processing config file=%s", filename);

      if ((fp = fopen(filename, "r")) == NULL)
      {
         LOG_CONSOLE(PLID, "[STRIPPER2] ERROR: Could not open \"%s\" file!", filename);
         LOG_MESSAGE(PLID, "ERROR: Could not open \"%s\" file!", filename);

         return TRUE;  // error opening map specific filename
      }

      status = scan_map_cfg(fp);

      fclose(fp);
   }

   return status;
}
