// ---- H9 rally menus: the panels (vgui_H9RallyMenu.h; the arithmetic is h9_carmenu_calc.h, the engine's side h9_carmenu.cpp) -----------------
// HL Rally's layout in 640 x 480 virtual units, turned into pixels with XRES and YRES like every menu of this game. Its pictures (the logo, the
// headers, the button images, the car's silhouette) are not ours to use: the buttons are text in the scheme's font, the headers are plain labels, and
// the Inventory shows its three bars and no silhouette.
#include "VGUI_Font.h"
#include "VGUI_ScrollPanel.h"
#include "VGUI_TextImage.h"

#include "hud.h"
#include "cl_util.h"
#include "camera.h"
#include "kbutton.h"
#include "const.h"

#include "vgui_int.h"
#include "vgui_TeamFortressViewport.h"
#include "vgui_H9RallyMenu.h"
#include "h9_carmenu.h"

#include <stdio.h>
#include <string.h>

using namespace carmenu;

namespace
{
inline int PX(float v) { return (int)XRES(v); }
inline int PY(float v) { return (int)YRES(v); }

const int ID_MODEL0 = 100; // SetActiveInfo: a make is 1.., a model button 100 + its row, a part class 0.., a part 100 + its row
const int ID_SPECTATE = 50;

// A label in a scheme's font and colours, at a place in virtual units.
Label* MakeLabel(Panel* parent, const char* text, float x, float y, const char* scheme, Label::Alignment align)
{
	CSchemeManager* sm = gViewPort->GetSchemeManager();
	const SchemeHandle_t h = sm->getSchemeHandle(scheme);
	int r, g, b, a;
	Label* l = new Label("", PX(x), PY(y));
	l->setParent(parent);
	l->setFont(sm->getFont(h));
	sm->getFgColor(h, r, g, b, a);
	l->setFgColor(r, g, b, a);
	sm->getBgColor(h, r, g, b, a);
	l->setBgColor(r, g, b, a);
	l->setContentAlignment(align);
	l->setText("%s", text);
	return l;
}

Label* MakeMoneyLabel(Panel* parent)
{
	Label* l = MakeLabel(parent, "", kMoneyLabel.x, kMoneyLabel.y, "Briefing Text", vgui::Label::a_west);
	l->setFgColor(kMoneyR, kMoneyG, kMoneyB, 0);
	return l;
}

void SetMoney(Label* l)
{
	char sz[64];
	MoneyText(H9CarMenu_Session().ShownMoney(), sz, sizeof(sz));
	l->setText("%s", sz);
}

CommandButton* MakeButton(Panel* parent, const char* text, const Box& b)
{
	CommandButton* c = new CommandButton(text, PX(b.x), PY(b.y), PX(b.w), PY(b.h));
	c->setParent(parent);
	c->setContentAlignment(vgui::Label::a_west);
	return c;
}

// ---- a bar: the car's stat in green, what the parts add in red (HL Rally's progress bar) ----------------------------------------------------
class CRallyBar : public Panel
{
public:
	CRallyBar(int x, int y, int wide, int tall, bool vertical) : Panel(x, y, wide, tall)
	{
		m_vertical = vertical;
		m_progress = m_extra = 0;
	}
	void Set(int progress, int extra)
	{
		m_progress = progress;
		m_extra = extra;
		repaint();
	}
	virtual void paintBackground()
	{
		if (!m_vertical)
		{
			const int x = (int)(((float)_size[0] / 100.0f) * m_progress);
			drawSetColor(Scheme::sc_primary2);
			drawFilledRect(0, 0, x, _size[1]);
			drawSetColor(Scheme::sc_secondary1);
			drawOutlinedRect(0, 0, _size[0], _size[1]);
			return;
		}
		const int y = _size[1] - (int)(((float)_size[1] / 100.0f) * m_progress);
		const int extray = _size[1] - (int)(((float)_size[1] / 100.0f) * m_extra);
		drawSetColor(0, 255, 0, 0);
		drawFilledRect(0, y, _size[0], _size[1]);
		if (extray < y)
		{
			drawSetColor(255, 0, 0, 0);
			drawFilledRect(0, extray, _size[0], y);
		}
		drawSetColor(Scheme::sc_secondary1);
		drawOutlinedRect(0, 0, _size[0], _size[1]);
	}

private:
	bool m_vertical;
	int m_progress, m_extra;
};

// ---- what the buttons do -------------------------------------------------------------------------------------------------------------------
class CRaceAction : public ActionSignal // Race: send what was picked, then go
{
public:
	virtual void actionPerformed(Panel* panel)
	{
		H9CarMenu_Execute();
		gViewPort->HideTopMenu();
	}
};

class CPickCarAction : public ActionSignal // a model of the car menu: pick it (queued), back to the main menu
{
public:
	CPickCarAction() { m_cls = 0; }
	void Set(int cls) { m_cls = cls; } // the button's row shows another car with another make
	virtual void actionPerformed(Panel* panel)
	{
		if (m_cls < 1)
			return;
		H9CarMenu_Session().Pick(m_cls);
		H9CarMenu_ClearCar();
		H9CarMenu_Touch();
		gViewPort->HideTopMenu();
	}

private:
	int m_cls;
};

class CBuyAction : public ActionSignal // a part of Customise: queued, with the money taken off the figure shown, back to the main menu
{
public:
	CBuyAction() { m_part = -1; }
	void Set(int part) { m_part = part; }
	virtual void actionPerformed(Panel* panel)
	{
		if (m_part < 0)
			return;
		const Session::BuyResult r = H9CarMenu_Session().Buy(m_part);
		if (r == Session::BUY_NO_FUNDS)
		{
			CenterPrint("Insufficient Funds");
			return;
		}
		if (r != Session::BUY_OK)
			return;
		H9CarMenu_ClearCar();
		H9CarMenu_Touch();
		gViewPort->HideTopMenu();
	}

private:
	int m_part;
};

// A click on a make or a part class: its choices come up
class CChoiceAction : public ActionSignal
{
public:
	CChoiceAction(CMenuPanel* panel, int id)
	{
		m_panel = panel;
		m_id = id;
	}
	virtual void actionPerformed(Panel* panel) { m_panel->SetActiveInfo(m_id); }

private:
	CMenuPanel* m_panel;
	int m_id;
};

// The mouse on the car's window: a button down turns the car with the mouse
class CDragSignal : public InputSignal
{
public:
	CDragSignal() { m_button = 0, m_x = m_y = 0; }
	virtual void cursorEntered(Panel* panel) {}
	virtual void cursorExited(Panel* panel)
	{
		m_button = 0;
		H9CarMenu_DragEnd();
	}
	virtual void cursorMoved(int x, int y, Panel* panel)
	{
		if (m_button != 0)
			H9CarMenu_DragMove(m_button, x - m_x, y - m_y);
		m_x = x;
		m_y = y;
	}
	virtual void mousePressed(MouseCode code, Panel* panel)
	{
		if (code != MOUSE_LEFT && code != MOUSE_RIGHT)
			return;
		m_button = (code == MOUSE_LEFT) ? 1 : 2;
		H9CarMenu_DragBegin(m_button);
	}
	virtual void mouseReleased(MouseCode code, Panel* panel)
	{
		if ((code == MOUSE_LEFT && m_button == 1) || (code == MOUSE_RIGHT && m_button == 2))
		{
			m_button = 0;
			H9CarMenu_DragEnd();
		}
	}
	virtual void mouseDoublePressed(MouseCode code, Panel* panel) {}
	virtual void mouseWheeled(int delta, Panel* panel) {}
	virtual void keyPressed(KeyCode code, Panel* panel) {}
	virtual void keyTyped(KeyCode code, Panel* panel) {}
	virtual void keyReleased(KeyCode code, Panel* panel) {}
	virtual void keyFocusTicked(Panel* panel) {}

private:
	int m_button;
	int m_x, m_y;
};

// A black menu panel
class CBlackMenu : public CMenuPanel
{
public:
	CBlackMenu(int x, int y, int wide, int tall) : CMenuPanel(255, false, x, y, wide, tall) { m_wide = wide, m_tall = tall; }
	int Wide() const { return m_wide; }
	int Tall() const { return m_tall; }

protected:
	// Everywhere but the window, black; a window of w = 0 is none.
	void PaintBlack(const Box& hole)
	{
		drawSetColor(0, 0, 0, 0);
		if (hole.w <= 0)
		{
			drawFilledRect(0, 0, _size[0], _size[1]);
			return;
		}
		const int x0 = PX(hole.x), y0 = PY(hole.y), x1 = PX(hole.x + hole.w), y1 = PY(hole.y + hole.h);
		drawFilledRect(0, 0, x0, _size[1]);
		drawFilledRect(x0, 0, _size[0], y0);
		drawFilledRect(x1, y0, _size[0], _size[1]);
		drawFilledRect(x0, y1, x1, _size[1]);
	}
	int m_wide, m_tall;
};

// ================================================================================================================================================
// The main menu
// ================================================================================================================================================
class CRallyMainMenu : public CBlackMenu
{
public:
	CRallyMainMenu(int x, int y, int wide, int tall);
	virtual void Open();
	virtual void Close();
	virtual bool SlotInput(int iSlot);
	virtual void paintBackground() { PaintBlack(Box{0, 0, 0, 0}); }
	void Refresh();
	void LoadInfo();

private:
	void SetMotd(const char* text);
	CommandButton* m_pButtons[4];
	Label* m_pMoney;
	TextPanel* m_pMapInfo;
	ScrollPanel* m_pScroll;
	TextPanel* m_pMotd;
	CRallyBar* m_pBar[3];
	char m_szMotd[1024];
};

CRallyMainMenu* s_pMain = nullptr;

void MainChanged()
{
	if (s_pMain)
		s_pMain->Refresh();
}

CRallyMainMenu::CRallyMainMenu(int x, int y, int wide, int tall) : CBlackMenu(x, y, wide, tall)
{
	m_szMotd[0] = 0;
	CSchemeManager* sm = gViewPort->GetSchemeManager();
	const SchemeHandle_t hText = sm->getSchemeHandle("Briefing Text");
	int r, g, b, a;

	// the title: a plain label where HL Rally has a picture
	MakeLabel(this, "Rally: choose an option on the left", kMainTitle.x, kMainTitle.y, "Title Font", vgui::Label::a_west);

	// Select Car, Customise, Spectate, Race
	static const char* const names[4] = {"Select Car", "Customise", "Spectate", "Race"};
	for (int i = 0; i < 4; i++)
	{
		m_pButtons[i] = MakeButton(this, names[i], MainButton(i));
		m_pButtons[i]->setBoundKey('1' + i);
	}
	m_pButtons[0]->addActionSignal(new CMenuHandler_TextWindow(MENU_TEAM));
	m_pButtons[1]->addActionSignal(new CMenuHandler_TextWindow(MENU_CLASS));
	m_pButtons[2]->addActionSignal(new CMenuHandler_StringCommand("spectate", true));
	m_pButtons[3]->addActionSignal(new CRaceAction());

	// the MOTD, in its box with a scroll panel
	CTransparentPanel* pBox = new CTransparentPanel(255, PX(kMotdWindow.x), PY(kMotdWindow.y), PX(kMotdWindow.w), PY(kMotdWindow.h));
	pBox->setParent(this);
	pBox->setBorder(new LineBorder(Color(128, 128, 128, 0)));
	pBox->setVisible(true);
	const Box sc = MotdScroll();
	m_pScroll = new CTFScrollPanel(PX(sc.x), PY(sc.y), PX(sc.w), PY(sc.h));
	m_pScroll->setParent(this);
	m_pScroll->setScrollBarAutoVisible(false, false);
	m_pScroll->setScrollBarVisible(true, true);
	m_pScroll->validate();
	m_pScroll->setScrollBarAutoVisible(true, true);
	m_pScroll->setScrollBarVisible(false, false);
	m_pScroll->validate();
	m_pMotd = new TextPanel("", 0, 0, 64, 64);
	m_pMotd->setParent(m_pScroll->getClient());
	m_pMotd->setFont(sm->getFont(hText));
	sm->getFgColor(hText, r, g, b, a);
	m_pMotd->setFgColor(r, g, b, a);
	sm->getBgColor(hText, r, g, b, a);
	m_pMotd->setBgColor(r, g, b, a);

	// the Inventory: its three bars and their names (HL Rally's picture of the car is art we do not have: not drawn)
	CTransparentPanel* pParts = new CTransparentPanel(255, PX(kPartsWindow.x), PY(kPartsWindow.y), PX(kPartsWindow.w), PY(kPartsWindow.h));
	pParts->setParent(this);
	pParts->setVisible(true);
	MakeLabel(pParts, "Inventory", kPartsTitle.x, kPartsTitle.y, "Title Font", vgui::Label::a_west);
	static const char* const bars[3] = {"Accel", "Handling", "TopSpeed"};
	for (int i = 0; i < 3; i++)
	{
		const Box bb = PartsBar(i);
		m_pBar[i] = new CRallyBar(PX(bb.x), PY(bb.y), PX(bb.w), PY(bb.h), true);
		m_pBar[i]->setParent(pParts);
		m_pBar[i]->setVisible(true);
		const Box lb = PartsBarLabel(i);
		MakeLabel(pParts, bars[i], lb.x, lb.y, "Briefing Text", vgui::Label::a_center);
	}

	m_pMoney = MakeMoneyLabel(this);

	// the map's few lines
	m_pMapInfo = new TextPanel("", PX(kMapInfo.x), PY(kMapInfo.y), PX(kMapInfo.w), PY(kMapInfo.h));
	m_pMapInfo->setParent(this);
	m_pMapInfo->setFont(sm->getFont(hText));
	sm->getFgColor(hText, r, g, b, a);
	m_pMapInfo->setFgColor(r, g, b, a);
	sm->getBgColor(hText, r, g, b, a);
	m_pMapInfo->setBgColor(r, g, b, a);
}

void CRallyMainMenu::SetMotd(const char* text)
{
	if (0 == strcmp(text, m_szMotd))
		return;
	snprintf(m_szMotd, sizeof(m_szMotd), "%s", text);
	m_pMotd->setText(m_szMotd);
	// the text's size when wrapped to the scroll panel's width, then the panel as big as that (the stock MOTD window's way)
	int iScrollSizeX, iScrollSizeY;
	m_pMotd->getTextImage()->setSize(m_pScroll->getClientClip()->getWide(), m_pScroll->getClientClip()->getTall());
	m_pMotd->getTextImage()->getTextSizeWrapped(iScrollSizeX, iScrollSizeY);
	m_pMotd->setSize(iScrollSizeX, iScrollSizeY);
	m_pScroll->validate();
}

// The map's lines: maps/<map>_mapinfo.txt, else maps/default_mapinfo.txt, as HL Rally does.
void CRallyMainMenu::LoadInfo()
{
	char path[96];
	char* file = nullptr;
	if (MapInfoPath(gEngfuncs.pfnGetLevelName(), path, sizeof(path)))
		file = (char*)gEngfuncs.COM_LoadFile(path, 5, NULL);
	if (!file)
		file = (char*)gEngfuncs.COM_LoadFile((char*)kMapInfoDefault, 5, NULL);
	if (file)
	{
		m_pMapInfo->setText(file);
		gEngfuncs.COM_FreeFile(file);
	}
	else
		m_pMapInfo->setText("");
}

void CRallyMainMenu::Refresh()
{
	const Session& s = H9CarMenu_Session();
	for (int i = 0; i < 4; i++)
		m_pButtons[i]->setVisible(MainButtonShown(i, s.HasPick()));
	SetMoney(m_pMoney);
	int stat[3], total[3];
	s.Bars(stat, total);
	for (int i = 0; i < 3; i++)
		m_pBar[i]->Set(stat[i], total[i]);
}

void CRallyMainMenu::Open()
{
	SetMotd(gViewPort->GetMOTD());
	LoadInfo();
	Refresh();
	s_pMain = this;
	H9CarMenu_SetListener(MainChanged);
	H9CarMenu_SetScreen(1);
	CMenuPanel::Open();
}

void CRallyMainMenu::Close()
{
	H9CarMenu_SetListener(nullptr);
	H9CarMenu_SetScreen(0);
	CMenuPanel::Close();
}

bool CRallyMainMenu::SlotInput(int iSlot)
{
	const int i = iSlot - 1; // the keys 1 to 4 press the four buttons
	if (i >= 0 && i < 4 && m_pButtons[i]->isVisible())
	{
		m_pButtons[i]->fireActionSignal();
		return true;
	}
	return false;
}

// ================================================================================================================================================
// The car menu: makes, then the models of the make
// ================================================================================================================================================
class CRallyCarMenu : public CBlackMenu
{
public:
	CRallyCarMenu(int x, int y, int wide, int tall);
	virtual void Open();
	virtual void Close();
	virtual bool SlotInput(int iSlot);
	virtual void SetActiveInfo(int iInput);
	virtual void paintBackground() { PaintBlack(kCarModelWindow); }
	void Refresh();

private:
	CommandButton* m_pMake[H9R_NUM_CARS];
	int m_nMakes;
	CommandButton* m_pModel[H9R_NUM_CARS];
	CPickCarAction* m_pPick[H9R_NUM_CARS];
	int m_modelClass[H9R_NUM_CARS];
	CommandButton* m_pCancel;
	CommandButton* m_pSpectate;
	CTransparentPanel* m_pStats;
	CRallyBar* m_pStatBar[3];
	Label* m_pMoney;
	int m_make;     // the make whose models show, -1 none
	int m_mode;     // 0 makes, 1 models: for the number keys
	int m_lastSlot; // a model's number pressed once: its preview; twice: it is picked
	int m_current;  // SetActiveInfo's last, so a hover that stays does not redo it
};

CRallyCarMenu* s_pCar = nullptr;
void CarChanged()
{
	if (s_pCar)
		s_pCar->Refresh();
}

CRallyCarMenu::CRallyCarMenu(int x, int y, int wide, int tall) : CBlackMenu(x, y, wide, tall)
{
	m_make = -1;
	m_mode = 0;
	m_lastSlot = -1;
	m_current = -2;
	m_nMakes = NumMakes();

	MakeLabel(this, "Select your car", kCarTitle.x, kCarTitle.y, "Title Font", vgui::Label::a_west);
	MakeLabel(this, "Make", kCarMakeLabel.x, kCarMakeLabel.y, "Title Font", vgui::Label::a_west);
	MakeLabel(this, "Model", kCarModelLabel.x, kCarModelLabel.y, "Title Font", vgui::Label::a_west);

	// the statistics window: only the three bars of our table (no transmission, power, torque, gearbox or weight: we have none)
	m_pStats = new CTransparentPanel(255, PX(kCarStatWindow.x), PY(kCarStatWindow.y), PX(kCarStatWindow.w), PY(kCarStatWindow.h));
	m_pStats->setParent(this);
	MakeLabel(m_pStats, "Statistics", kCarStatTitle.x, kCarStatTitle.y, "Title Font", vgui::Label::a_center);
	static const char* const names[3] = {"Acceleration:", "Handling:", "TopSpeed:"};
	for (int i = 0; i < 3; i++)
	{
		const float rowY = kCarStatRow0 + kCarStatPitch * i;
		MakeLabel(m_pStats, names[i], kCarStatLabelX, rowY, "Briefing Text", vgui::Label::a_center);
		m_pStatBar[i] = new CRallyBar(PX(kCarStatBarX), PY(rowY), PX(kCarStatBarW), PY(kCarStatBarH), false);
		m_pStatBar[i]->setParent(m_pStats);
		m_pStatBar[i]->setVisible(true);
	}
	m_pStats->setVisible(false);

	// the car's window: it takes the mouse
	CTransparentPanel* pWindow = new CTransparentPanel(255, PX(kCarModelWindow.x), PY(kCarModelWindow.y), PX(kCarModelWindow.w), PY(kCarModelWindow.h));
	pWindow->setParent(this);
	pWindow->addInputSignal(new CDragSignal());
	MakeLabel(pWindow, "Click and drag here to turn the car", kCarModelHint.x, kCarModelHint.y, "Briefing Text", vgui::Label::a_center);

	// the makes
	for (int m = 0; m < m_nMakes; m++)
	{
		m_pMake[m] = MakeButton(this, MakeName(m), CarMakeButton(m));
		m_pMake[m]->setBoundKey('1' + m);
		m_pMake[m]->addActionSignal(new CChoiceAction(this, m + 1));
	}
	// the models' rows (shown for the make chosen), Cancel under them, Spectate under that
	for (int i = 0; i < H9R_NUM_CARS; i++)
		m_pModel[i] = nullptr;
	const int rows = ModelSlots();
	for (int i = 0; i < rows; i++)
	{
		m_pModel[i] = MakeButton(this, "", CarModelButton(i));
		m_pPick[i] = new CPickCarAction();
		m_pModel[i]->addActionSignal(m_pPick[i]);
		m_pModel[i]->setVisible(false);
		m_pModel[i]->addInputSignal(new CHandler_MenuButtonOver(this, ID_MODEL0 + i));
		m_modelClass[i] = 0;
	}
	m_pCancel = MakeButton(this, "Cancel", CarCancelButton());
	m_pCancel->setVisible(false);
	m_pCancel->addInputSignal(new CHandler_MenuButtonOver(this, ID_MODEL0 + rows));
	m_pCancel->addActionSignal(new CMenuHandler_TextWindow(HIDE_TEXTWINDOW));
	m_pSpectate = MakeButton(this, "Spectate", CarSpectateButton());
	m_pSpectate->addActionSignal(new CMenuHandler_StringCommand("spectate", true));

	m_pMoney = MakeMoneyLabel(this);
}

void CRallyCarMenu::Refresh()
{
	SetMoney(m_pMoney);
}

void CRallyCarMenu::Open()
{
	m_mode = 0;
	m_lastSlot = -1;
	m_current = -2;
	SetActiveInfo(-1);
	Refresh();
	s_pCar = this;
	H9CarMenu_SetListener(CarChanged);
	H9CarMenu_SetScreen(2);
	CMenuPanel::Open();
}

void CRallyCarMenu::Close()
{
	H9CarMenu_ClearCar();
	H9CarMenu_SetListener(nullptr);
	H9CarMenu_SetScreen(0);
	CMenuPanel::Close();
}

// -1 nothing; 1.. a make (a click); 100 + n the model row n (the mouse over it)
void CRallyCarMenu::SetActiveInfo(int iInput)
{
	if (iInput == m_current)
		return;
	m_current = iInput;
	const int rows = ModelSlots();
	if (iInput < 0)
	{
		for (int i = 0; i < rows; i++)
		{
			m_pModel[i]->setArmed(false);
			m_pModel[i]->setVisible(false);
		}
		for (int m = 0; m < m_nMakes; m++)
			m_pMake[m]->setArmed(false);
		m_pCancel->setVisible(false);
		m_pStats->setVisible(false);
		m_make = -1;
		H9CarMenu_ClearCar();
		return;
	}
	if (iInput < ID_MODEL0)
	{
		if (iInput < 1 || iInput > m_nMakes)
			return;
		m_make = iInput - 1;
		for (int m = 0; m < m_nMakes; m++)
			m_pMake[m]->setArmed(m == m_make);
		m_pStats->setVisible(false);
		H9CarMenu_ClearCar();
		int cls[H9R_NUM_CARS];
		const int n = ModelsOfMake(m_make, cls, H9R_NUM_CARS);
		for (int i = 0; i < rows; i++)
		{
			m_pModel[i]->setArmed(false);
			if (i < n)
			{
				m_modelClass[i] = cls[i];
				m_pModel[i]->setText(g_h9RallyCarShow[cls[i] - 1].model);
				m_pPick[i]->Set(cls[i]);
				m_pModel[i]->setVisible(true);
			}
			else
			{
				m_modelClass[i] = 0;
				m_pPick[i]->Set(0);
				m_pModel[i]->setVisible(false);
			}
		}
		m_pCancel->setVisible(true);
		return;
	}
	// the mouse is over a model, or Cancel
	const int row = iInput - ID_MODEL0;
	for (int i = 0; i < rows; i++)
		m_pModel[i]->setArmed(false);
	m_pCancel->setArmed(false);
	if (row == rows)
	{
		m_pCancel->setArmed(true);
		return;
	}
	if (row < 0 || row >= rows || m_modelClass[row] == 0 || m_make < 0)
		return;
	m_pModel[row]->setArmed(true);
	int stat[3];
	StatsOf(m_modelClass[row], stat);
	for (int i = 0; i < 3; i++)
		m_pStatBar[i]->Set(stat[i], stat[i]);
	m_pStats->setVisible(true);
	H9CarMenu_ShowCar(m_modelClass[row]);
}

// The number keys: a make's, then a model's (once to see it, twice to take it), then Cancel's
bool CRallyCarMenu::SlotInput(int iSlot)
{
	if (iSlot < 1)
		return false;
	const int rows = ModelSlots();
	if (m_mode == 0)
	{
		if (iSlot == m_nMakes + 1) // Spectate stands after the makes
		{
			m_pSpectate->fireActionSignal();
			return true;
		}
		if (iSlot > m_nMakes)
			return false;
		SetActiveInfo(iSlot);
		m_mode = 1;
		m_lastSlot = -1;
		return true;
	}
	if (iSlot > rows + 1)
		return false;
	if (iSlot == rows + 1)
	{
		SetActiveInfo(-1);
		m_mode = 0;
		return true;
	}
	if (!m_pModel[iSlot - 1]->isVisible())
		return false;
	if (m_lastSlot != iSlot)
	{
		SetActiveInfo(ID_MODEL0 + iSlot - 1);
		m_lastSlot = iSlot;
	}
	else
		m_pModel[iSlot - 1]->fireActionSignal();
	return true;
}

// ================================================================================================================================================
// Customise: four classes of parts, their parts, what a part does and costs
// ================================================================================================================================================
class CRallyCustomMenu : public CBlackMenu
{
public:
	CRallyCustomMenu(int x, int y, int wide, int tall);
	virtual void Open();
	virtual void Close();
	virtual bool SlotInput(int iSlot);
	virtual void SetActiveInfo(int iInput);
	virtual void paintBackground() { PaintBlack(kCustPorthole); }
	void Refresh();

private:
	void ShowPart(int part);
	CommandButton* m_pClass[H9R_NUM_PART_CLASSES];
	CTransparentPanel* m_pPartsPanel;
	CommandButton* m_pPart[kCustChoiceRows];
	CBuyAction* m_pBuy[kCustChoiceRows];
	int m_partIndex[kCustChoiceRows];
	CommandButton* m_pCancel;
	CTransparentPanel* m_pInfo;
	Label* m_pInfoTitle;
	ScrollPanel* m_pInfoScroll;
	TextPanel* m_pInfoText;
	Label* m_pEffect;
	Label* m_pCost;
	Label* m_pMoney;
	int m_class;
	int m_mode;
	int m_lastSlot;
	int m_current;
};

CRallyCustomMenu* s_pCust = nullptr;
void CustChanged()
{
	if (s_pCust)
		s_pCust->Refresh();
}

CRallyCustomMenu::CRallyCustomMenu(int x, int y, int wide, int tall) : CBlackMenu(x, y, wide, tall)
{
	m_class = -1;
	m_mode = 0;
	m_lastSlot = -1;
	m_current = -2;
	CSchemeManager* sm = gViewPort->GetSchemeManager();
	const SchemeHandle_t hText = sm->getSchemeHandle("Briefing Text");
	int r, g, b, a;

	MakeLabel(this, "Customise your car", kCustTitle.x, kCustTitle.y, "Title Font", vgui::Label::a_west);
	MakeLabel(this, "Type", kCustClassLabel.x, kCustClassLabel.y, "Title Font", vgui::Label::a_west);
	MakeLabel(this, "Part", kCustPartLabel.x, kCustPartLabel.y, "Title Font", vgui::Label::a_west);

	for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
	{
		m_pClass[c] = MakeButton(this, PartClassName(c), CustClassButton(c));
		m_pClass[c]->setBoundKey('1' + c);
		m_pClass[c]->addActionSignal(new CChoiceAction(this, c));
	}

	// the parts' buttons, in a panel of their own, and Cancel under the fourth row
	m_pPartsPanel = new CTransparentPanel(255, PX(kCustPartsPanel.x), PY(kCustPartsPanel.y), PX(kCustPartsPanel.w), PY(kCustPartsPanel.h));
	m_pPartsPanel->setParent(this);
	m_pPartsPanel->setVisible(true);
	for (int i = 0; i < kCustChoiceRows; i++)
	{
		m_pPart[i] = MakeButton(m_pPartsPanel, "", CustPartButton(i));
		m_pBuy[i] = new CBuyAction();
		m_pPart[i]->addActionSignal(m_pBuy[i]);
		m_pPart[i]->setVisible(false);
		m_pPart[i]->addInputSignal(new CHandler_MenuButtonOver(this, ID_MODEL0 + i));
		m_partIndex[i] = -1;
	}
	m_pCancel = MakeButton(m_pPartsPanel, "Cancel", CustCancelButton());
	m_pCancel->addActionSignal(new CMenuHandler_TextWindow(HIDE_TEXTWINDOW));

	// the part's window: its name, what it does, what it costs
	m_pInfo = new CTransparentPanel(255, PX(kCustInfoWindow.x), PY(kCustInfoWindow.y), PX(kCustInfoWindow.w), PY(kCustInfoWindow.h));
	m_pInfo->setParent(this);
	m_pInfoTitle = MakeLabel(m_pInfo, "Part info", kCustInfoTitle.x, kCustInfoTitle.y, "Title Font", vgui::Label::a_center);
	const Box it = CustInfoText();
	m_pInfoScroll = new CTFScrollPanel(PX(it.x), PY(it.y), PX(it.w), PY(it.h));
	m_pInfoScroll->setParent(m_pInfo);
	m_pInfoScroll->setScrollBarAutoVisible(false, false);
	m_pInfoScroll->setScrollBarVisible(true, true);
	m_pInfoScroll->validate();
	m_pInfoScroll->setScrollBarAutoVisible(true, true);
	m_pInfoScroll->setScrollBarVisible(false, false);
	m_pInfoScroll->validate();
	m_pInfoText = new TextPanel("", 0, 0, 64, 64);
	m_pInfoText->setParent(m_pInfoScroll->getClient());
	m_pInfoText->setFont(sm->getFont(hText));
	sm->getFgColor(hText, r, g, b, a);
	m_pInfoText->setFgColor(r, g, b, a);
	sm->getBgColor(hText, r, g, b, a);
	m_pInfoText->setBgColor(r, g, b, a);
	m_pEffect = MakeLabel(m_pInfo, "", kCustEffect.x, kCustEffect.y, "Briefing Text", vgui::Label::a_center);
	m_pCost = MakeLabel(m_pInfo, "", kCustCost.x, kCustCost.y, "Primary Button Text", vgui::Label::a_center);
	m_pInfo->setVisible(false);

	m_pMoney = MakeMoneyLabel(this);
}

void CRallyCustomMenu::Refresh()
{
	SetMoney(m_pMoney);
}

void CRallyCustomMenu::Open()
{
	m_mode = 0;
	m_lastSlot = -1;
	m_current = -2;
	SetActiveInfo(-1);
	Refresh();
	s_pCust = this;
	H9CarMenu_SetListener(CustChanged);
	H9CarMenu_SetScreen(3);
	H9CarMenu_ShowCar(H9CarMenu_Session().PickedCar()); // the car picked stands in the window
	CMenuPanel::Open();
}

void CRallyCustomMenu::Close()
{
	H9CarMenu_ClearCar();
	H9CarMenu_SetListener(nullptr);
	H9CarMenu_SetScreen(0);
	CMenuPanel::Close();
}

void CRallyCustomMenu::ShowPart(int part)
{
	const H9RallyPart& p = g_h9RallyParts[part];
	char sz[96];
	m_pInfoText->setText(p.name);
	int iScrollSizeX, iScrollSizeY;
	m_pInfoText->getTextImage()->setSize(m_pInfoScroll->getClientClip()->getWide(), m_pInfoScroll->getClientClip()->getTall());
	m_pInfoText->getTextImage()->getTextSizeWrapped(iScrollSizeX, iScrollSizeY);
	m_pInfoText->setSize(iScrollSizeX, iScrollSizeY);
	m_pInfoScroll->validate();
	EffectText(part, sz, sizeof(sz));
	m_pEffect->setText("%s", sz);
	CostText(part, sz, sizeof(sz));
	m_pCost->setText("%s", sz);
	m_pInfo->setVisible(true);
}

// -1 nothing; 0.. a class of parts (a click); 100 + n the part row n (the mouse over it)
void CRallyCustomMenu::SetActiveInfo(int iInput)
{
	if (iInput == m_current)
		return;
	m_current = iInput;
	if (iInput < 0)
	{
		for (int i = 0; i < kCustChoiceRows; i++)
		{
			m_pPart[i]->setArmed(false);
			m_pPart[i]->setVisible(false);
		}
		for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
			m_pClass[c]->setArmed(false);
		m_pInfo->setVisible(false);
		m_class = -1;
		return;
	}
	if (iInput < ID_MODEL0)
	{
		if (iInput >= H9R_NUM_PART_CLASSES)
			return;
		m_class = iInput;
		for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
			m_pClass[c]->setArmed(c == m_class);
		m_pInfo->setVisible(false);
		int parts[kCustChoiceRows];
		const int n = PartsOfClass(m_class, parts, kCustChoiceRows);
		for (int i = 0; i < kCustChoiceRows; i++)
		{
			m_pPart[i]->setArmed(false);
			if (i < n)
			{
				m_partIndex[i] = parts[i];
				m_pPart[i]->setText(g_h9RallyParts[parts[i]].name);
				m_pBuy[i]->Set(parts[i]);
				m_pPart[i]->setVisible(true);
			}
			else
			{
				m_partIndex[i] = -1;
				m_pBuy[i]->Set(-1);
				m_pPart[i]->setVisible(false);
			}
		}
		return;
	}
	const int row = iInput - ID_MODEL0;
	for (int i = 0; i < kCustChoiceRows; i++)
		m_pPart[i]->setArmed(false);
	if (row < 0 || row >= kCustChoiceRows || m_partIndex[row] < 0)
		return;
	m_pPart[row]->setArmed(true);
	ShowPart(m_partIndex[row]);
}

// The number keys: a class's, then a part's (once to read it, twice to buy it), then Cancel's
bool CRallyCustomMenu::SlotInput(int iSlot)
{
	if (iSlot < 1)
		return false;
	if (m_mode == 0)
	{
		if (iSlot > H9R_NUM_PART_CLASSES)
			return false;
		SetActiveInfo(iSlot - 1);
		m_mode = 1;
		m_lastSlot = -1;
		return true;
	}
	if (iSlot > kCustChoiceRows + 1)
		return false;
	if (iSlot == kCustChoiceRows + 1)
	{
		m_pCancel->fireActionSignal();
		return true;
	}
	if (!m_pPart[iSlot - 1]->isVisible())
		return false;
	if (m_lastSlot != iSlot)
	{
		SetActiveInfo(ID_MODEL0 + iSlot - 1);
		m_lastSlot = iSlot;
	}
	else
		m_pPart[iSlot - 1]->fireActionSignal();
	return true;
}

// The panels are made when first wanted and kept; a change of screen size makes new ones (the old stay hidden).
template <class T>
CMenuPanel* Persistent(T*& slot, int& w, int& h)
{
	if (slot != nullptr && (w != ScreenWidth || h != ScreenHeight))
	{
		slot->setVisible(false);
		slot = nullptr;
	}
	if (slot == nullptr)
	{
		w = ScreenWidth;
		h = ScreenHeight;
		slot = new T(0, 0, ScreenWidth, ScreenHeight);
		slot->setParent(gViewPort);
		slot->setVisible(false);
	}
	return slot;
}
CRallyMainMenu* s_main = nullptr;
CRallyCarMenu* s_car = nullptr;
CRallyCustomMenu* s_cust = nullptr;
int s_mainW = 0, s_mainH = 0, s_carW = 0, s_carH = 0, s_custW = 0, s_custH = 0;
} // namespace

CMenuPanel* H9RallyMenu_Get(int iMenu)
{
	switch (iMenu)
	{
	case MENU_INTRO: return Persistent(s_main, s_mainW, s_mainH);
	case MENU_TEAM: return Persistent(s_car, s_carW, s_carH);
	case MENU_CLASS: return Persistent(s_cust, s_custW, s_custH);
	default: return nullptr;
	}
}
