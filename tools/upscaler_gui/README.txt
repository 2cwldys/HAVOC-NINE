H9 UPSCALER
===========

A window that AI-upscales textures. No agent, no command line, no repository: pick a folder of
images, choose how much the model is allowed to invent, look at every result at 1:1 before
anything is written, and save them as the 32-bit PNG or RLE TGA files the engine reads.

It is a separate thing from the texture pack. The pack is made by tools\texpack (one command,
tools\texpack\hd-pass.ps1) and docs\HD_TEXTURES.txt is its documentation. This is for one-off
work, for textures that are not the mod's, and for judging a setting before committing a pass to
it.


RUNNING IT
----------
    setup.cmd        make .venv and install what it needs       (setup.sh on Linux)
    run.cmd          open the window                            (run.sh)
    build.cmd        build a standalone H9Upscaler.exe          (build.sh)

    py -3 h9upscale.py --check      say what it found and exit
    py -3 h9upscale.py --selftest   upscale one picture and a small skybox, check the result, then exit
    py -3 test_skybox.py            check the skybox code on its own, with no model (exit 0 = passed)

--check only proves the imports resolved. --selftest is what proves a BUILT copy works: it runs a
small picture with a hard edge, a gradient and a transparent corner through the real model, then
checks the size, that the alpha came back hard-edged rather than softened (a soft one bleeds in
game), and that the result did not drift absurdly far from the source. It also runs a small
skybox through it and checks that the four sides were found in order and joined.


THE WINDOW
----------
SOURCE   drop in a folder or some images. png, bmp, tga and jpg. Duplicates are dropped by the
         hash of their PIXELS, so the same texture under two names is one job.

         "Add skybox folder..." is for skies. A sky is six pictures named <set>rt, <set>bk,
         <set>lf, <set>ft, <set>up and <set>dn (any case, with or without an underscore before
         the suffix, png, bmp, tga or jpg). The folder is searched, every complete set in it is
         added as one row with its six faces under it, and an incomplete set is reported and left
         out. The six faces must be the same square size.

         A set is upscaled TOGETHER, not face by face. Upscaled one at a time, the faces leave a
         visible line along every edge of the cube, because the model sees a picture with a
         border and invents detail that stops there. Here the four sides are joined into one
         wrapped strip and upscaled as one picture, and the up and down faces are padded with the
         real rows of the sides beside them. Which face is beside which is read from the pictures,
         not assumed, and the Run tab log says what was found ("ring ft-lf-bk-rt joined") or that
         the pictures did not say and the faces were done one at a time.

RUN      Fidelity, from 0 to 1, is how much of the model's result to keep against a plain Lanczos
         enlargement. 1.00 is the model alone. Lower it when the model invents: this is the knob
         that fixed the RepuHeavy armour, whose woven mesh came back as invented diagonal ribbing
         at 1.00 and as itself, sharper, at 0.25.

         Scale is 2x, 3x or 4x. The model is a 4x one; 2x and 3x come down from its result, which
         is better than enlarging the original by that much directly.

         Tile is how much goes to the GPU at once. Lower it if video memory is tight.

         Format is PNG or TGA, and it is the same pixels either way. The engine reads both and
         prefers a .png when a .tga of the same name sits beside it. Measured over this
         project's whole texture store PNG is 43 percent of the bytes, which is why it is the
         default; what it costs is decode time at map load, two to three times an RLE TGA.
         Choose TGA for a build older than that engine change, or when load time matters more
         than disk.

         Skies is the highest drift a sky face may reach before it is mixed back toward Lanczos
         (6.5, and 0 turns it off). The model reads grain and dither as detail and invents
         something sharper and wrong; a face whose result moves further than the limit from its
         source is one of those, and is brought well inside it. A face under the limit keeps the
         whole model. The four sides of a set share one setting so their seams stay alike. This is
         the same rule tools\texpack\skies.py applies, with the same default.

         A sky face is always saved as a 24-bit RLE TGA named as the engine asks (<set>rt.tga ...),
         whatever Format says: the engine looks for a sky as dds, tga or bmp and never as png. The
         game reads it from gfx\env, and from materials\gfx\env first when the HD textures are on.

REVIEW   the point of the whole program. Every result at 1:1 against the original and against a
         Lanczos control, sorted worst first by DRIFT -- shrink the result back to its original
         size and measure how far it moved. Lanczos scores about 2. Much higher means the model
         put something there that was never in the source. Look before you save.


THE MODEL IS NOT IN GIT
-----------------------
It is 64 MB and it belongs to the build, not to the source, so model\4xLSDIRplus.onnx is ignored.
The program looks for it there, then beside itself, and refuses to open a window without it.

WHY ONNX AND NOT THE .pth. The pack is made with torch and CUDA, which is 2.5 GB installed and
NVIDIA only. Neither is acceptable in something meant to be handed to a person as one folder, so
the model is converted once, offline, and runs here on onnxruntime-directml: any DX12 card,
NVIDIA, AMD or Intel, with a CPU fallback, and a bundle near 300 MB instead of 2.5 GB.

MAKING IT, from the .pth the texture pack uses. In a Python that has torch, spandrel and onnx:

    import torch
    from spandrel import ModelLoader

    model = ModelLoader().load_from_file("4xLSDIRplus.pth").model.eval()
    dummy = torch.zeros(1, 3, 64, 64)
    torch.onnx.export(
        model, dummy, "4xLSDIRplus.onnx",
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "h", 3: "w"}},
        opset_version=17,
    )

The dynamic axes are not optional: without them the exported model only ever accepts 64x64 and
every tile of a different size fails at run time.

THE TWO ARE NOT BYTE-IDENTICAL. DirectML and CUDA do not round the same way, so a texture made
here differs very slightly from one the torch pass made. It does not matter for its own sake --
both are correct -- but it means the two must not be mixed inside one pack without re-stamping
the recipe, or half the pack claims to have been made by something that did not make it. The
pack's manifest keys on the model's own hash for exactly this reason.


WHAT IT CANNOT READ YET
-----------------------
Plain image files only. It does not read .wad, .bsp, .mdl or .spr; tools\texpack does, through
SMAK, which is Node. Porting the WAD3 and BSP miptex readers to Python would be small, and the
model and sprite readers would not be. The window says so plainly rather than skipping a file it
cannot open in silence.


ANTIVIRUS
---------
A freshly built, unsigned exe that writes thousands of files gets flagged on behaviour. See
tools\texpack\ANTIVIRUS.txt before you go looking for a bug: check quarantine first, the file is
usually still there.
