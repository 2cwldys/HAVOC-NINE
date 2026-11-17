//
// entities - Windows application to dump DLL exports to a file (by botman@planethalflife.com)
//
// To compile from the MS-DOS command line...
//
// cl entities.cpp kernel32.lib user32.lib comdlg32.lib
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

#include "windows.h"
#include "stdio.h"

BOOL CenterWindow(HWND hWnd)
{
    RECT    rRect, rParentRect;
    HWND    hParentWnd;
    int     wParent, hParent, xNew, yNew;
    int     w, h;

    GetWindowRect (hWnd, &rRect);
    w = rRect.right - rRect.left;
    h = rRect.bottom - rRect.top;

    hParentWnd = GetDesktopWindow();

    GetWindowRect( hParentWnd, &rParentRect );

    wParent = rParentRect.right - rParentRect.left;
    hParent = rParentRect.bottom - rParentRect.top;

    xNew = wParent/2 - w/2 + rParentRect.left;
    yNew = hParent/2 - h/2 + rParentRect.top;

    return SetWindowPos (hWnd, NULL, xNew, yNew, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

UINT CALLBACK CenterOpenDlgBox(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam)
{
   LPOFNOTIFY pNotify;

   switch (uMsg)
   {
      case WM_NOTIFY:
         pNotify = (LPOFNOTIFY)lParam;

         if (pNotify->hdr.code == CDN_INITDONE)
         {
            CenterWindow( GetParent(hWnd) );
            return( TRUE );
         }
   }

   return( FALSE );
}

#define DOS_SIGNATURE   0x5A4D       /* MZ */
#define NT_SIGNATURE    0x00004550   /* PE00 */


// globals
WORD *p_Ordinals = NULL;
DWORD *p_Names = NULL;
DWORD *p_Functions = NULL;
int num_ordinals;


typedef struct {                        // DOS .EXE header
    WORD   e_magic;                     // Magic number
    WORD   e_cblp;                      // Bytes on last page of file
    WORD   e_cp;                        // Pages in file
    WORD   e_crlc;                      // Relocations
    WORD   e_cparhdr;                   // Size of header in paragraphs
    WORD   e_minalloc;                  // Minimum extra paragraphs needed
    WORD   e_maxalloc;                  // Maximum extra paragraphs needed
    WORD   e_ss;                        // Initial (relative) SS value
    WORD   e_sp;                        // Initial SP value
    WORD   e_csum;                      // Checksum
    WORD   e_ip;                        // Initial IP value
    WORD   e_cs;                        // Initial (relative) CS value
    WORD   e_lfarlc;                    // File address of relocation table
    WORD   e_ovno;                      // Overlay number
    WORD   e_res[4];                    // Reserved words
    WORD   e_oemid;                     // OEM identifier (for e_oeminfo)
    WORD   e_oeminfo;                   // OEM information; e_oemid specific
    WORD   e_res2[10];                  // Reserved words
    LONG   e_lfanew;                    // File address of new exe header
  } DOS_HEADER, *P_DOS_HEADER;

typedef struct {
    WORD    Machine;
    WORD    NumberOfSections;
    DWORD   TimeDateStamp;
    DWORD   PointerToSymbolTable;
    DWORD   NumberOfSymbols;
    WORD    SizeOfOptionalHeader;
    WORD    Characteristics;
} PE_HEADER, *P_PE_HEADER;

#define SIZEOF_SHORT_NAME              8

typedef struct {
    BYTE    Name[SIZEOF_SHORT_NAME];
    union {
            DWORD   PhysicalAddress;
            DWORD   VirtualSize;
    } Misc;
    DWORD   VirtualAddress;
    DWORD   SizeOfRawData;
    DWORD   PointerToRawData;
    DWORD   PointerToRelocations;
    DWORD   PointerToLinenumbers;
    WORD    NumberOfRelocations;
    WORD    NumberOfLinenumbers;
    DWORD   Characteristics;
} SECTION_HEADER, *P_SECTION_HEADER;

typedef struct {
    DWORD   VirtualAddress;
    DWORD   Size;
} DATA_DIRECTORY, *P_DATA_DIRECTORY;

#define NUMBEROF_DIRECTORY_ENTRIES    16

typedef struct {
    WORD    Magic;
    BYTE    MajorLinkerVersion;
    BYTE    MinorLinkerVersion;
    DWORD   SizeOfCode;
    DWORD   SizeOfInitializedData;
    DWORD   SizeOfUninitializedData;
    DWORD   AddressOfEntryPoint;
    DWORD   BaseOfCode;
    DWORD   BaseOfData;
    DWORD   ImageBase;
    DWORD   SectionAlignment;
    DWORD   FileAlignment;
    WORD    MajorOperatingSystemVersion;
    WORD    MinorOperatingSystemVersion;
    WORD    MajorImageVersion;
    WORD    MinorImageVersion;
    WORD    MajorSubsystemVersion;
    WORD    MinorSubsystemVersion;
    DWORD   Win32VersionValue;
    DWORD   SizeOfImage;
    DWORD   SizeOfHeaders;
    DWORD   CheckSum;
    WORD    Subsystem;
    WORD    DllCharacteristics;
    DWORD   SizeOfStackReserve;
    DWORD   SizeOfStackCommit;
    DWORD   SizeOfHeapReserve;
    DWORD   SizeOfHeapCommit;
    DWORD   LoaderFlags;
    DWORD   NumberOfRvaAndSizes;
    DATA_DIRECTORY DataDirectory[NUMBEROF_DIRECTORY_ENTRIES];
} OPTIONAL_HEADER, *P_OPTIONAL_HEADER;

typedef struct {
    DWORD   Characteristics;
    DWORD   TimeDateStamp;
    WORD    MajorVersion;
    WORD    MinorVersion;
    DWORD   Name;
    DWORD   Base;
    DWORD   NumberOfFunctions;
    DWORD   NumberOfNames;
    DWORD   AddressOfFunctions;     // RVA from base of image
    DWORD   AddressOfNames;         // RVA from base of image
    DWORD   AddressOfNameOrdinals;  // RVA from base of image
} EXPORT_DIRECTORY, *P_EXPORT_DIRECTORY;


void FreeNameFuncGlobals(void)
{
   if (p_Ordinals)
      free(p_Ordinals);
   if (p_Functions)
      free(p_Functions);
   if (p_Names)
      free(p_Names);
}


void FgetString(char *str, FILE *bfp)
{
   char ch;

   while ((ch = fgetc(bfp)) != EOF)
   {
      *str++ = ch;
      if (ch == 0)
         break;
   }
}


void OutputExports(FILE *bfp, FILE *outfile)
{
   DOS_HEADER dos_header;
   LONG nt_signature;
   PE_HEADER pe_header;
   SECTION_HEADER section_header;
   BOOL edata_found;
   OPTIONAL_HEADER optional_header;
   LONG edata_offset;
   LONG edata_delta;
   EXPORT_DIRECTORY export_directory;
   LONG name_offset;
   LONG ordinal_offset;
   LONG function_offset;
   char function_name[256];
   int i;
   BOOL error;


   if (fread(&dos_header, sizeof(dos_header), 1, bfp) != 1)
   {
      MessageBox(NULL, "NOT a valid DLL file!", "Error!", MB_OK);
      return;
   }

   if (dos_header.e_magic != DOS_SIGNATURE)
   {
      MessageBox(NULL, "DLL file does not have a valid DLL signature!", "Error!", MB_OK);
      return;
   }

   if (fseek(bfp, dos_header.e_lfanew, SEEK_SET) == -1)
   {
      MessageBox(NULL, "error seeking to new exe header!", "Error!", MB_OK);
      return;
   }

   if (fread(&nt_signature, sizeof(nt_signature), 1, bfp) != 1)
   {
      MessageBox(NULL, "DLL file does not have a valid NT signature!", "Error!", MB_OK);
      return;
   }

   if (nt_signature != NT_SIGNATURE)
   {
      MessageBox(NULL, "DLL file does not have a valid NT signature!", "Error!", MB_OK);
      return;
   }

   if (fread(&pe_header, sizeof(pe_header), 1, bfp) != 1)
   {
      MessageBox(NULL, "DLL file does not have a valid PE header!", "Error!", MB_OK);
      return;
   }

   if (pe_header.SizeOfOptionalHeader == 0)
   {
      MessageBox(NULL, "DLL file does not have an optional header!", "Error!", MB_OK);
      return;
   }

   if (fread(&optional_header, sizeof(optional_header), 1, bfp) != 1)
   {
      MessageBox(NULL, "DLL file does not have a valid optional header!", "Error!", MB_OK);
      return;
   }

   edata_found = FALSE;

   for (i=0; i < pe_header.NumberOfSections; i++)
   {
      if (fread(&section_header, sizeof(section_header), 1, bfp) != 1)
      {
         MessageBox(NULL, "error reading section header!", "Error!", MB_OK);
         return;
      }

      if (strcmp((char *)section_header.Name, ".edata") == 0)
      {
         edata_found = TRUE;
         break;
      }
   }

   if (edata_found)
   {
      edata_offset = section_header.PointerToRawData;
      edata_delta = section_header.VirtualAddress - section_header.PointerToRawData; 
   }
   else
   {
      edata_offset = optional_header.DataDirectory[0].VirtualAddress;
      edata_delta = 0L;
   }


   if (fseek(bfp, edata_offset, SEEK_SET) == -1)
   {
      MessageBox(NULL, "DLL file does not have a valid exports section!", "Error!", MB_OK);
      return;
   }

   if (fread(&export_directory, sizeof(export_directory), 1, bfp) != 1)
   {
      MessageBox(NULL, "DLL file does not have a valid optional header!", "Error!", MB_OK);
      return;
   }

   num_ordinals = export_directory.NumberOfNames;  // also number of ordinals


   ordinal_offset = export_directory.AddressOfNameOrdinals - edata_delta;

   if (fseek(bfp, ordinal_offset, SEEK_SET) == -1)
   {
      MessageBox(NULL, "DLL file does not have a valid ordinals section!", "Error!", MB_OK);
      return;
   }

   if ((p_Ordinals = (WORD *)malloc(num_ordinals * sizeof(WORD))) == NULL)
   {
      MessageBox(NULL, "error allocating memory for ordinals section!", "Error!", MB_OK);
      return;
   }

   if (fread(p_Ordinals, num_ordinals * sizeof(WORD), 1, bfp) != 1)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "error reading ordinals table!", "Error!", MB_OK);
      return;
   }


   function_offset = export_directory.AddressOfFunctions - edata_delta;

   if (fseek(bfp, function_offset, SEEK_SET) == -1)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "DLL file does not have a valid export address section!", "Error!", MB_OK);
      return;
   }

   if ((p_Functions = (DWORD *)malloc(num_ordinals * sizeof(DWORD))) == NULL)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "error allocating memory for export address section!", "Error!", MB_OK);
      return;
   }

   if (fread(p_Functions, num_ordinals * sizeof(DWORD), 1, bfp) != 1)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "error reading export address section!", "Error!", MB_OK);
      return;
   }


   name_offset = export_directory.AddressOfNames - edata_delta;

   if (fseek(bfp, name_offset, SEEK_SET) == -1)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "DLL file does not have a valid names section!", "Error!", MB_OK);
      return;
   }

   if ((p_Names = (DWORD *)malloc(num_ordinals * sizeof(DWORD))) == NULL)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "error allocating memory for names section!", "Error!", MB_OK);
      return;
   }

   if (fread(p_Names, num_ordinals * sizeof(DWORD), 1, bfp) != 1)
   {
      FreeNameFuncGlobals();

      MessageBox(NULL, "error reading names table!", "Error!", MB_OK);
      return;
   }

   error = FALSE;

   for (i=0; (i < num_ordinals) && (error==FALSE); i++)
   {
      name_offset = p_Names[i] - edata_delta;

      if (name_offset != 0)
      {
         if (fseek(bfp, name_offset, SEEK_SET) == -1)
         {
            MessageBox(NULL, "error in loading names section!", "Error!", MB_OK);
            error = TRUE;
         }
         else
         {
            FgetString(function_name, bfp);

            if (function_name[0] == '?')
               continue;  // skip exported names beginning with '?'

            if ((function_name[0] >= 'A') && (function_name[0] <= 'Z'))
               continue;  // skip exported names beginning with uppercase letter

            fprintf(outfile, "%s\n", function_name);
         }
      }
   }

   FreeNameFuncGlobals();

   return;
}



int APIENTRY WinMain(HINSTANCE hInstance,
                     HINSTANCE hPrevInstance,
                     LPSTR     lpCmdLine,
                     int       nCmdShow)
{
   FILE *bfp, *outfile;
   OPENFILENAME ofn;
   char szFile[1024], szFileTitle[1024];
   char szFilter[] = {"DLL Files (*.dll)|*.dll|"};
   char outputfile[1024], message[1024];
   int len;

   memset( &ofn, 0, sizeof( ofn ) );

   for (int index=0; szFilter[index] != '\0'; index++)
      if (szFilter[index] == '|')
         szFilter[index] = '\0';

   szFile[0] = '\0';

   ofn.lStructSize = sizeof( ofn );
   ofn.hwndOwner = NULL;
   ofn.hInstance = NULL;
   ofn.lpstrFilter = szFilter;
   ofn.nFilterIndex = 1;
   ofn.lpstrFile = szFile;
   ofn.nMaxFile = sizeof(szFile);
   ofn.lpstrFileTitle = szFileTitle;
   ofn.nMaxFileTitle = sizeof(szFileTitle);
   ofn.lpstrInitialDir = NULL;
   ofn.Flags = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_EXPLORER | OFN_ENABLEHOOK;
   ofn.lpfnHook = CenterOpenDlgBox;

   if(!GetOpenFileName( &ofn ))
      return 0;

   // szFileTitle is filename without path ( i.e. hl.dll )
   // szFile is the full path and filename

   if ((bfp = fopen(szFile, "rb")) == NULL)
   {
      MessageBox(NULL, "Error opening DLL file!", "Error", MB_OK);
      return -1;
   }

   strcpy(outputfile, szFile);
   len = strlen(szFile) - 3;
   outputfile[len] = 0;  // terminate at trailing '.'
   strcat(outputfile, "txt");

   if ((outfile = fopen(outputfile, "w")) == NULL)
   {
      MessageBox(NULL, "Error opening output file!", "Error", MB_OK);
      return -1;
   }

   OutputExports(bfp, outfile);

   fclose(bfp);
   fclose(outfile);

   sprintf(message, "Created %s", outputfile);
   MessageBox(NULL, message, "Done!", MB_OK);

	return 0;
}



