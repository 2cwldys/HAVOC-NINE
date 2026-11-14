h9tts -- the data of H9's Kokoro text to speech (in the game: the folder ts\h9tts)

Kokoro is the optional neural voice of the text to speech: cl_h9_tts_engine auto or kokoro (docs\TEXT_TO_SPEECH.txt, section 3e). client.dll plays the
lines that were rendered ahead of time (lines\lines.h9pk) at once, and sends every other line to a helper program (bin\h9kokoro64.exe, 64-bit) that it
starts, watches and stops itself. With cl_h9_tts_engine system (the default) none of this is touched, and a game without the folder speaks as before.

THE FILES

  voices.txt, chains.txt      The voice catalogue and the sound chains. The masters are in the repository's h9tts folder; client.dll and the helper both
                              read them and must see the same ones: the helper reports a checksum of the catalogue it loaded and the client refuses a
                              helper whose checksum differs. Never reorder or delete a variant of a shipped voices.txt (players' picks are numbers).
  NOTICE.txt, LICENSE-*.txt   Who made what is spoken with, and under which licence. They travel with the folder.
  README.txt                  This file.
  manifest.txt                The SHA-256 of bin\h9kokoro64.exe, bin\onnxruntime.dll and bin\onnxruntime_providers_shared.dll. client.dll starts no helper
                              whose files differ from it. Written by stage_h9tts.py: make it again after every helper build.
  bin\                        h9kokoro64.exe (tools\h9kokoro64), the two ONNX Runtime 1.31.1 x64 DLLs (unchanged, Microsoft's release), their licence
                              texts (LICENSE-onnxruntime-mit.txt, ThirdPartyNotices-onnxruntime.txt).
  model\model_quantized.onnx  The 8-bit Kokoro-82M model, 92,361,116 bytes (the stage script checks its size and SHA-256).
  voices\*.bin                The Kokoro style files that voices.txt blends (unchanged, from the same Hugging Face repository as the model).
  g2p\                        tokens.txt (the phoneme symbols of the model), en_us.h9lex (the pronunciation lexicon), en_us.h9lt (the letter-to-sound trees
                              for the words the lexicon does not have).
  lines\lines.h9pk            The lines rendered ahead of time (IMA ADPCM, 24 kHz): the bots' chat lines in every voice variant a bot can get. A line in
                              the pack is played without the helper.

WHAT THE CLIENT DOES WITH IT

  A line is looked up in the pack by the voice key (the blend and the speed of the variant) and its text; found, it plays at once. Otherwise the helper
  makes it: it turns the text into phonemes (g2p), runs the model (model, voices) in pieces of a phrase each, and streams every piece back as soon as it
  is ready, so the first words play after the first phrase, not after the whole line. The client shapes every line the same way whatever made it (depth,
  machine chain or gas mask, level), so a pack line and a helper line of one voice sound alike. Without the helper, without the folder or with a file
  that does not check out, the line is spoken by the system voice (engine auto) or dropped (engine kokoro).

REBUILDING (Windows; the Visual Studio C++ tools; Python 3 with numpy for the data tools)

  helper        tools\h9kokoro64\build_helper.bat <out folder>      x64, static CRT, ONNX Runtime loaded at run time. Tests: tools\h9kokoro64\tests.
  pack tool     tools\h9tts\build_tools.bat <out folder>            h9pk.exe: build <manifest.tsv> <pack> | list | verify | extract
  g2p data      tools\h9tts\make_g2p_data.py, tools\h9tts\export_lts.py      tokens.txt and the lexicon; the trees (en_us.h9lt)
  line pack     tools\h9tts\prerender_lines.py renders every line of the chosen sources in the chosen voice variants into a work folder (resumable);
                h9pk build <work>\manifest.tsv lines.h9pk packs them. A line is looked up by its text as the client cleans it, so a changed bot_chat.ini,
                a changed voices.txt blend or speed, or a changed text cleaning in reTS\cl_dll\h9_tts.cpp means rendering again.
  the folder    tools\h9tts\stage_h9tts.py --out <folder> --helper h9kokoro64.exe --ort <the two ONNX Runtime DLLs> --model model_quantized.onnx
                --voices <the .bin files> --g2p <tokens.txt, en_us.h9lex, en_us.h9lt> --pack lines.h9pk
                Copies the masters and the parts into <folder>\h9tts, writes manifest.txt, prints every file and the total.

  The model, the voices and the pronunciation data come from the places NOTICE.txt names. The folder is in the repository as it ships
  (H9XASH\ts\h9tts), about 135 MB, 20 MB of it the line pack; the stage script prints the exact sizes. The model and the line pack go through
  Git LFS (.gitattributes): a clone made without git-lfs has small pointer files there, which fail the checks, and the line is spoken by the system voice.
