# PyInstaller spec for H9 Upscaler.
#
# onedir, not onefile. A onefile build of this size unpacks ~350 MB into a temp folder on every
# launch, which is slow and leaves rubbish behind; onedir starts at once and the folder zips just
# as well for handing to someone.
#
# Two things PyInstaller does not work out on its own:
#   * onnxruntime's native DLLs, including DirectML.dll, which is how this runs on any DX12 card
#     rather than only NVIDIA. collect_dynamic_libs finds them.
#   * the model. It is data, 64 MB, and it sits beside the exe as model\4xLSDIRplus.onnx so it can
#     be replaced with another one without rebuilding.
#
#   ..\..\..\..\gui-venv\Scripts\pyinstaller.exe build\h9upscale.spec --noconfirm
#
# Everything torch is deliberately absent: the model was converted to ONNX so the shipped program
# never needs a 2.5 GB dependency. excludes keeps it that way even if the build venv grows one.

from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs

HERE = Path(SPECPATH).resolve().parent          # tools/upscaler_gui
MODEL = HERE / "model" / "4xLSDIRplus.onnx"
ICON = HERE / "h9.ico"

binaries = collect_dynamic_libs("onnxruntime")

datas = []
if MODEL.is_file():
    datas.append((str(MODEL), "model"))
if ICON.is_file():
    datas.append((str(ICON), "."))   # the window sets it at runtime too
# the menu art the banner and the review backdrop are drawn from
for art in ("h9bg.jpg", "h9bg_dark.jpg"):
    if (HERE / art).is_file():
        datas.append((str(HERE / art), "."))

a = Analysis(
    [str(HERE / "h9upscale.py")],
    pathex=[str(HERE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=["PIL._tkinter_finder"],
    hookspath=[],
    excludes=[
        # never wanted, and each is large
        "torch", "torchvision", "spandrel", "matplotlib", "scipy", "pandas",
        "IPython", "notebook", "pytest", "setuptools", "pip",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="H9Upscaler",
    debug=False,
    strip=False,
    upx=False,                 # UPX mangles onnxruntime's DLLs
    console=False,             # it is a window, not a console program
    icon=str(ICON) if ICON.is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="H9Upscaler",
)
