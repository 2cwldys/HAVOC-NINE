/*
 * playh9.c -- "Play HAVOC 9", the double-clickable launcher.
 *
 * It does exactly what h9xash_raiselimits.bat does -- runs h9xash.bat with +exec autoexec.cfg,
 * which is what raises the engine's limits -- and nothing else. The batch file stays the thing
 * that defines the launch; this only gives it an icon, a name worth double-clicking, and no
 * console window flashing up before the game opens.
 *
 * Why a native exe rather than a bat-to-exe tool: it is a few kilobytes, it needs no runtime on
 * the player's PC, the icon is a proper multi-size resource, and the SOURCE lives here under this
 * project's own licence, so there is no third-party binary to redistribute.
 *
 * WINDOWS subsystem, deliberately. The engine opens its own window, so a console here would be an
 * empty box left on screen for as long as the game runs. Anything that goes wrong before the game
 * starts is therefore reported in a message box: with no console, silence would be the alternative.
 *
 * The working directory is the EXE's own folder, never whatever the shell happened to pass. A
 * shortcut, a taskbar pin or a Steam entry can all start it from somewhere else, and h9xash.bat
 * reads the game beside itself.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>

#pragma comment(lib, "shlwapi.lib")

static void Fail(const wchar_t *what, DWORD err)
{
	wchar_t msg[1024];
	wchar_t reason[512];

	reason[0] = L'\0';
	if (err)
	{
		FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, err,
			MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), reason, 512, NULL);
	}
	wsprintfW(msg, L"%s\n\n%s\nThe game was not started.", what, reason);
	MessageBoxW(NULL, msg, L"Play HAVOC 9", MB_ICONERROR | MB_OK);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR args, int show)
{
	wchar_t dir[MAX_PATH];
	wchar_t bat[MAX_PATH];
	wchar_t cmd[MAX_PATH * 2 + 64];
	STARTUPINFOW si;
	PROCESS_INFORMATION pi;

	(void)hInst; (void)hPrev; (void)args; (void)show;

	if (!GetModuleFileNameW(NULL, dir, MAX_PATH))
	{
		Fail(L"Could not work out where this program is.", GetLastError());
		return 1;
	}
	PathRemoveFileSpecW(dir);

	lstrcpynW(bat, dir, MAX_PATH);
	PathAppendW(bat, L"h9xash.bat");
	if (!PathFileExistsW(bat))
	{
		Fail(L"h9xash.bat is not beside this program.\n"
		     L"Put Play HAVOC 9.exe in the H9XASH folder, next to h9xash.bat.", 0);
		return 1;
	}

	/* cmd /c so the batch file runs as it does when it is double-clicked. The quotes around the
	   path survive a folder with spaces, which D:\GIT Storage... and C:\Program Files both have. */
	wsprintfW(cmd, L"cmd.exe /c \"\"%s\" +exec autoexec.cfg\"", bat);

	ZeroMemory(&si, sizeof(si));
	si.cb = sizeof(si);
	ZeroMemory(&pi, sizeof(pi));

	if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir, &si, &pi))
	{
		Fail(L"Could not start h9xash.bat.", GetLastError());
		return 1;
	}

	/* The launcher's job is done once the batch is running: it does not wait, so the taskbar does
	   not keep a dead entry for as long as the game is open. */
	CloseHandle(pi.hThread);
	CloseHandle(pi.hProcess);
	return 0;
}
