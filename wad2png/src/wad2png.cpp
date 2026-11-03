// wad2png.cpp - Standalone Win32 GoldSrc WAD3 / Quake WAD2 to PNG converter.
// No Python, third-party libraries, or external DLLs required.
// Build with: cl /O2 /EHsc /std:c++17 wad2png.cpp /Fe:wad2png.exe
//
// Each lump is decoded by its directory type:
//   0x43 MIPTEX   in-game textures with four mip levels (the base level is exported)
//   0x42 QPIC     menu and HUD pictures (gfx.wad: LAMBDA, PAUSED, BACKTILE, ...)
//   0x46 FONT     the console and credits fonts (CONCHARS, CREDITSFONT)
//   0x40 PALETTE  a 256-colour palette, exported as a 16x16 swatch
// WAD3 lumps carry their own palette. WAD2 (Quake) pictures and textures do not: they use
// --palette, or else a PALETTE lump in the same WAD. Palette index 255 is written as
// transparent where the engine draws it so: fonts, pictures that use it, and textures whose
// names start with "{".
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <sstream>

namespace fs = std::filesystem;
using std::string;
using std::vector;
using u8 = uint8_t;
using u16 = uint16_t;
using u32 = uint32_t;
using u64 = uint64_t;

enum : u8 {
    TYP_PALETTE = 0x40,
    TYP_QPIC = 0x42,
    TYP_MIPTEX = 0x43,
    TYP_WAD2_MIPTEX = 0x44, // Quake's miptex type ('D'); in WAD3 0x44 is a script
    TYP_FONT = 0x46,
};
static const u32 MAX_SIDE = 16384;
static const u32 MIPTEX_HEADER = 40;
static const u32 FONT_DATA = 16 + 256 * 4; // qfont_t: four ints, then 256 x (startoffset, charwidth)
static const u32 QCHAR_WIDTH = 16;
static const u8 TRANSPARENT_INDEX = 255;

static u16 rd16(const u8* p) { return u16(p[0]) | (u16(p[1]) << 8); }
static u32 rd32(const u8* p) { return u32(p[0]) | (u32(p[1]) << 8) | (u32(p[2]) << 16) | (u32(p[3]) << 24); }
static void put16be(vector<u8>& o, u16 v) { o.push_back(u8(v >> 8)); o.push_back(u8(v)); }
static void put32be(vector<u8>& o, u32 v) { o.push_back(u8(v >> 24)); o.push_back(u8(v >> 16)); o.push_back(u8(v >> 8)); o.push_back(u8(v)); }

static u32 crc32bytes(const u8* p, size_t n) {
    u32 c = 0xffffffffu;
    for (size_t i = 0; i < n; ++i) {
        c ^= p[i];
        for (int k = 0; k < 8; ++k) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u)));
    }
    return c ^ 0xffffffffu;
}
static u32 adler32bytes(const vector<u8>& data) {
    u32 a = 1, b = 0;
    for (u8 x : data) { a = (a + x) % 65521u; b = (b + a) % 65521u; }
    return (b << 16) | a;
}
static void pngChunk(vector<u8>& png, const char type[4], const vector<u8>& data) {
    put32be(png, u32(data.size()));
    size_t start = png.size();
    png.insert(png.end(), type, type + 4);
    png.insert(png.end(), data.begin(), data.end());
    put32be(png, crc32bytes(png.data() + start, png.size() - start));
}
static vector<u8> zlibStore(const vector<u8>& raw) {
    vector<u8> z;
    z.push_back(0x78); z.push_back(0x01); // zlib header: deflate, fastest/no compression
    size_t pos = 0;
    do {
        size_t n = std::min<size_t>(65535, raw.size() - pos);
        bool finalBlock = (pos + n == raw.size());
        z.push_back(finalBlock ? 1 : 0); // stored block, byte-aligned
        u16 len = u16(n), nlen = u16(~len);
        z.push_back(u8(len)); z.push_back(u8(len >> 8));
        z.push_back(u8(nlen)); z.push_back(u8(nlen >> 8));
        z.insert(z.end(), raw.begin() + pos, raw.begin() + pos + n);
        pos += n;
    } while (pos < raw.size());
    u32 a = adler32bytes(raw);
    z.push_back(u8(a >> 24)); z.push_back(u8(a >> 16)); z.push_back(u8(a >> 8)); z.push_back(u8(a));
    return z;
}
static bool writePng(const fs::path& path, u32 w, u32 h, const vector<u8>& pixels, const vector<u8>& palette, bool transparent) {
    if (!w || !h || pixels.size() != size_t(w) * h || palette.size() < 768) return false;
    vector<u8> raw;
    raw.reserve(size_t(h) * (size_t(w) + 1));
    for (u32 y = 0; y < h; ++y) {
        raw.push_back(0); // PNG filter None
        raw.insert(raw.end(), pixels.begin() + size_t(y) * w, pixels.begin() + size_t(y + 1) * w);
    }
    vector<u8> png = {137,80,78,71,13,10,26,10};
    vector<u8> ihdr;
    put32be(ihdr, w); put32be(ihdr, h);
    ihdr.push_back(8); ihdr.push_back(3); // 8-bit indexed color
    ihdr.push_back(0); ihdr.push_back(0); ihdr.push_back(0);
    pngChunk(png, "IHDR", ihdr);
    vector<u8> plte(palette.begin(), palette.begin() + 768);
    pngChunk(png, "PLTE", plte);
    if (transparent) {
        // Every entry opaque except the last, which the engine draws as see-through.
        vector<u8> trns(TRANSPARENT_INDEX, 0xff);
        trns.push_back(0);
        pngChunk(png, "tRNS", trns);
    }
    vector<u8> idat = zlibStore(raw);
    pngChunk(png, "IDAT", idat);
    pngChunk(png, "IEND", {});
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    f.write(reinterpret_cast<const char*>(png.data()), std::streamsize(png.size()));
    return bool(f);
}
static string cleanName(string s) {
    for (char& c : s) {
        unsigned char u = static_cast<unsigned char>(c);
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') c = '_';
        else if (u < 32) c = '_';
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '.')) s.pop_back();
    while (!s.empty() && s.front() == ' ') s.erase(s.begin());
    return s.empty() ? "unnamed_texture" : s;
}
static string lumpName(const u8* p, size_t n) {
    size_t len = 0; while (len < n && p[len]) ++len;
    return cleanName(string(reinterpret_cast<const char*>(p), len));
}
static string lower(string s) {
    for (char& c : s) c = char(std::tolower(static_cast<unsigned char>(c)));
    return s;
}
struct Lump { string name; u32 pos=0, diskSize=0, size=0; u8 type=0, compression=0; };

// What a decoder hands back: the image, its palette, and whether index 255 is see-through.
struct Image { u32 w=0, h=0; vector<u8> pixels, palette; bool transparent=false; string kind; };

static bool readFile(const fs::path& path, vector<u8>& data) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    f.seekg(0, std::ios::end); auto end = f.tellg();
    if (end < 0) return false;
    data.resize(size_t(end)); f.seekg(0, std::ios::beg);
    if (!data.empty()) f.read(reinterpret_cast<char*>(data.data()), std::streamsize(data.size()));
    return bool(f) || data.empty();
}

// A palette stored as a 16-bit colour count and RGB triples at pos in the lump.
static bool embeddedPalette(const u8* p, u64 size, u64 pos, vector<u8>& palette) {
    if (pos + 2 > size) return false;
    u16 count = rd16(p + pos);
    u64 start = pos + 2;
    if (count < 256 || start + 768 > size) return false;
    palette.assign(p + start, p + start + 768);
    return true;
}
static bool usePalette(vector<u8>& palette, const vector<u8>& external, const char* what, string& reason) {
    if (!palette.empty()) return true;
    if (!external.empty()) { palette = external; return true; }
    reason = string(what) + " has no palette of its own (WAD2); pass --palette or use a WAD with a PALETTE lump";
    return false;
}
static bool sizeOk(u32 w, u32 h) { return w && h && w <= MAX_SIDE && h <= MAX_SIDE; }

static bool decodeMiptex(const u8* p, u32 size, const vector<u8>& external, Image& img, string& name, string& reason) {
    if (size < MIPTEX_HEADER) { reason = "lump is too small for a mip texture header"; return false; }
    name = lumpName(p, 16);
    u32 w = rd32(p + 16), h = rd32(p + 20);
    u32 offsets[4] = {rd32(p+24), rd32(p+28), rd32(p+32), rd32(p+36)};
    if (!sizeOk(w, h)) { reason = "invalid texture dimensions " + std::to_string(w) + "x" + std::to_string(h); return false; }
    if (w % 16 || h % 16) { reason = "texture dimensions are not multiples of 16"; return false; }
    u64 mipSizes[4] = { u64(w) * h, u64(w / 2) * (h / 2), u64(w / 4) * (h / 4), u64(w / 8) * (h / 8) };
    for (int i = 0; i < 4; ++i)
        if (offsets[i] < MIPTEX_HEADER || offsets[i] + mipSizes[i] > size) { reason = "mip level " + std::to_string(i) + " is outside the lump"; return false; }
    img.w = w; img.h = h;
    img.pixels.assign(p + offsets[0], p + offsets[0] + size_t(mipSizes[0]));
    // WAD3 stores a colour count and the palette right after the smallest mip level.
    embeddedPalette(p, size, u64(offsets[3]) + mipSizes[3], img.palette);
    if (!usePalette(img.palette, external, "texture", reason)) return false;
    img.transparent = !name.empty() && name[0] == '{';
    img.kind = "texture";
    return true;
}
static bool decodeQpic(const u8* p, u32 size, const vector<u8>& external, const string& name, Image& img, string& reason) {
    if (size < 8) { reason = "lump is too small for a picture header"; return false; }
    u32 w = rd32(p), h = rd32(p + 4);
    if (!sizeOk(w, h)) { reason = "invalid picture dimensions " + std::to_string(w) + "x" + std::to_string(h); return false; }
    if (8 + u64(w) * h > size) { reason = "picture data is outside the lump"; return false; }
    img.w = w; img.h = h;
    img.pixels.assign(p + 8, p + 8 + size_t(w) * h);
    embeddedPalette(p, size, 8 + u64(w) * h, img.palette);
    if (!usePalette(img.palette, external, "picture", reason)) return false;
    // The engine masks index 255 in any picture that uses it, except the console background.
    img.transparent = std::find(img.pixels.begin(), img.pixels.end(), TRANSPARENT_INDEX) != img.pixels.end()
        && lower(name).find("conback") == string::npos;
    img.kind = "picture";
    return true;
}
static bool decodeFont(const u8* p, u32 size, Image& img, string& reason) {
    if (size < FONT_DATA) { reason = "lump is too small for a font header"; return false; }
    u32 cellWidth = rd32(p), h = rd32(p + 4);
    if (!sizeOk(1, h)) { reason = "invalid font height"; return false; }
    // The Half-Life 1.1 layout is width * 16 pixels across, and its size says so exactly;
    // the older CONCHARS / CREDITSFONT layout is always 256 across.
    u32 w = 256;
    if (cellWidth && u64(FONT_DATA) + u64(cellWidth) * QCHAR_WIDTH * h + 2 + 768 + 64 == size) w = cellWidth * QCHAR_WIDTH;
    if (u64(FONT_DATA) + u64(w) * h > size) { reason = "font data is outside the lump"; return false; }
    img.w = w; img.h = h;
    img.pixels.assign(p + FONT_DATA, p + FONT_DATA + size_t(w) * h);
    if (!embeddedPalette(p, size, u64(FONT_DATA) + u64(w) * h, img.palette)) { reason = "font has no 256-colour palette after its pixels"; return false; }
    img.transparent = true;
    img.kind = "font";
    return true;
}
static bool decodePalette(const u8* p, u32 size, Image& img, string& reason) {
    if (size < 768) { reason = "palette lump is shorter than 768 bytes"; return false; }
    img.w = 16; img.h = 16;
    img.pixels.resize(256);
    for (u32 i = 0; i < 256; ++i) img.pixels[i] = u8(i);
    img.palette.assign(p, p + 768);
    img.kind = "palette";
    return true;
}
// Quake's gfx.wad keeps CONCHARS as bare 128x128 pixels, with no header.
static bool decodeRawConchars(const u8* p, const vector<u8>& external, Image& img, string& reason) {
    img.w = 128; img.h = 128;
    img.pixels.assign(p, p + 128 * 128);
    if (!usePalette(img.palette, external, "font", reason)) return false;
    img.transparent = true;
    img.kind = "font";
    return true;
}

// The directory of a WAD2/WAD3 already read into memory.
static bool readDirectory(const vector<u8>& data, string& magic, vector<Lump>& lumps, string& reason) {
    if (data.size() < 12 || (std::memcmp(data.data(), "WAD2", 4) && std::memcmp(data.data(), "WAD3", 4))) {
        reason = "invalid WAD header (expected WAD2/WAD3)"; return false;
    }
    magic.assign(reinterpret_cast<const char*>(data.data()), 4);
    u32 count = rd32(data.data() + 4), dir = rd32(data.data() + 8);
    if (count > 1000000 || u64(dir) + u64(count) * 32 > data.size()) { reason = "invalid WAD directory"; return false; }
    lumps.clear();
    for (u32 i = 0; i < count; ++i) {
        const u8* d = data.data() + dir + size_t(i) * 32;
        Lump l;
        l.pos = rd32(d); l.diskSize = rd32(d+4); l.size = rd32(d+8);
        l.type = d[12]; l.compression = d[13]; l.name = lumpName(d+16, 16);
        lumps.push_back(l);
    }
    return true;
}
// The first usable PALETTE lump of a WAD, if it has one.
static bool wadPalette(const vector<u8>& data, const vector<Lump>& lumps, vector<u8>& palette) {
    for (const Lump& l : lumps)
        if (l.type == TYP_PALETTE && !l.compression && l.diskSize >= 768 && u64(l.pos) + l.diskSize <= data.size()) {
            palette.assign(data.data() + l.pos, data.data() + l.pos + 768);
            return true;
        }
    return false;
}
// A 768-byte palette: a raw .lmp/.pal, or the PALETTE lump of a WAD.
static bool readPaletteFile(const fs::path& path, vector<u8>& palette, string& reason) {
    vector<u8> data;
    if (!readFile(path, data)) { reason = "cannot read " + path.string(); return false; }
    if (data.size() >= 4 && (!std::memcmp(data.data(), "WAD2", 4) || !std::memcmp(data.data(), "WAD3", 4))) {
        string magic; vector<Lump> lumps;
        if (!readDirectory(data, magic, lumps, reason)) return false;
        if (!wadPalette(data, lumps, palette)) { reason = path.string() + " has no PALETTE lump"; return false; }
        return true;
    }
    if (data.size() < 768) { reason = path.string() + " is shorter than a 768-byte palette"; return false; }
    palette.assign(data.begin(), data.begin() + 768);
    return true;
}

static fs::path availablePath(const fs::path& dir, const string& stem, bool overwrite) {
    fs::path p = dir / (stem + ".png");
    if (overwrite || !fs::exists(p)) return p;
    for (unsigned n = 2; ; ++n) {
        p = dir / (stem + "_" + std::to_string(n) + ".png");
        if (!fs::exists(p)) return p;
    }
}
static bool isWad(const fs::path& p) { return _stricmp(p.extension().string().c_str(), ".wad") == 0; }
static vector<fs::path> expandInputs(int argc, char** argv, int first, int last, bool recursive) {
    vector<fs::path> result;
    for (int i = first; i < last; ++i) {
        string arg = argv[i];
        DWORD attrs = GetFileAttributesA(arg.c_str());
        if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            std::error_code ec;
            if (recursive) {
                for (fs::recursive_directory_iterator it(arg, ec), end; it != end; it.increment(ec))
                    if (!ec && it->is_regular_file() && isWad(it->path())) result.push_back(it->path());
            } else {
                for (fs::directory_iterator it(arg, ec), end; it != end; it.increment(ec))
                    if (!ec && it->is_regular_file() && isWad(it->path())) result.push_back(it->path());
            }
            continue;
        }
        if (arg.find_first_of("*?") != string::npos) {
            WIN32_FIND_DATAA fd{}; HANDLE h = FindFirstFileA(arg.c_str(), &fd);
            if (h != INVALID_HANDLE_VALUE) {
                fs::path parent = fs::path(arg).parent_path();
                do {
                    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) result.push_back(parent / fd.cFileName);
                } while (FindNextFileA(h, &fd));
                FindClose(h);
            }
        } else result.emplace_back(arg);
    }
    return result;
}
static const char* typeName(u8 type) {
    switch (type) {
        case 0x40: return "palette";
        case 0x41: return "DDS texture";
        case 0x42: return "picture";
        case 0x43: return "mip texture";
        case 0x44: return "script";
        case 0x45: return "colormap";
        case 0x46: return "font";
        default: return "unknown";
    }
}
static void usage() {
    std::cout <<
        "wad2png - Standalone GoldSrc WAD3 / Quake WAD2 to PNG converter\n\n"
        "Exports mip textures, pictures (gfx.wad), fonts and palettes.\n\n"
        "Usage:\n"
        "  wad2png.exe textures.wad\n"
        "  wad2png.exe one.wad two.wad -o exported\n"
        "  wad2png.exe *.wad --overwrite\n"
        "  wad2png.exe D:\\WADs --recursive\n"
        "  wad2png.exe gfx.wad --palette palette.lmp\n\n"
        "--palette  for WAD2 lumps that carry no palette: a 768-byte .lmp/.pal, or a WAD\n"
        "           with a PALETTE lump. Without it, a WAD2's own PALETTE lump is used.\n\n"
        "Default output: exported\\ beside wad2png.exe\n";
}
int main(int argc, char** argv) {
    if (argc < 2) { usage(); return 2; }
    bool overwrite = false, recursive = false;
    string outputArg, paletteArg;
    vector<string> inputArgs;
    for (int i = 1; i < argc; ++i) {
        string a = argv[i];
        if (a == "--help" || a == "-h" || a == "/?") { usage(); return 0; }
        else if (a == "--overwrite") overwrite = true;
        else if (a == "--recursive") recursive = true;
        else if ((a == "-o" || a == "--output") && i + 1 < argc) outputArg = argv[++i];
        else if (a == "--palette" && i + 1 < argc) paletteArg = argv[++i];
        else if (!a.empty() && a[0] == '-') { std::cerr << "Unknown option: " << a << "\n"; return 2; }
        else inputArgs.push_back(a);
    }
    if (inputArgs.empty()) { usage(); return 2; }

    vector<u8> userPalette;
    if (!paletteArg.empty()) {
        string reason;
        if (!readPaletteFile(paletteArg, userPalette, reason)) { std::cerr << "ERROR: --palette: " << reason << "\n"; return 2; }
    }

    char exe[MAX_PATH] = {};
    GetModuleFileNameA(nullptr, exe, MAX_PATH);
    fs::path exeDir = fs::path(exe).parent_path();
    fs::path outDir = outputArg.empty() ? exeDir / "exported" : fs::path(outputArg);
    std::error_code ec;
    fs::create_directories(outDir, ec);
    if (ec) { std::cerr << "ERROR: Cannot create output folder: " << outDir.string() << "\n"; return 2; }

    vector<fs::path> inputs;
    for (const auto& a : inputArgs) {
        char* av[1] = { const_cast<char*>(a.c_str()) };
        // Expand wildcard / directory inputs using the same helper.
        vector<fs::path> one = expandInputs(1, av, 0, 1, recursive);
        inputs.insert(inputs.end(), one.begin(), one.end());
    }
    if (inputs.empty()) { std::cerr << "ERROR: No input WAD files found.\n"; return 2; }

    unsigned converted = 0, skipped = 0, failed = 0;
    for (const auto& path : inputs) {
        std::cout << "\n[" << path.string() << "]\n";
        vector<u8> data;
        if (!readFile(path, data)) { std::cout << "  ERROR: cannot read file\n"; ++failed; continue; }
        string magic, reason;
        vector<Lump> lumps;
        if (!readDirectory(data, magic, lumps, reason)) { std::cout << "  ERROR: " << reason << "\n"; ++failed; continue; }
        std::cout << "  Format: " << magic << " | lumps: " << lumps.size() << "\n";
        bool wad2 = magic == "WAD2";

        // WAD2 lumps take the user's palette, or else the archive's own PALETTE lump.
        vector<u8> external = userPalette;
        if (external.empty()) wadPalette(data, lumps, external);

        for (const Lump& l : lumps) {
            string name = l.name;
            if (u64(l.pos) + l.diskSize > data.size()) { std::cout << "  SKIP " << name << ": lump outside file\n"; ++skipped; continue; }
            if (l.compression) { std::cout << "  SKIP " << name << ": compressed lump not supported\n"; ++skipped; continue; }
            const u8* p = data.data() + l.pos;
            Image img;
            bool ok;
            reason.clear();
            if (l.type == TYP_MIPTEX || (wad2 && l.type == TYP_WAD2_MIPTEX)) {
                if (wad2 && lower(name) == "conchars" && l.diskSize == 128 * 128) ok = decodeRawConchars(p, external, img, reason);
                else ok = decodeMiptex(p, l.diskSize, external, img, name, reason);
            } else if (l.type == TYP_QPIC) ok = decodeQpic(p, l.diskSize, external, name, img, reason);
            else if (l.type == TYP_FONT) ok = decodeFont(p, l.diskSize, img, reason);
            else if (l.type == TYP_PALETTE) ok = decodePalette(p, l.diskSize, img, reason);
            else {
                char hex[8]; std::snprintf(hex, sizeof hex, "0x%02X", unsigned(l.type));
                std::cout << "  SKIP " << name << ": not an image (type " << hex << ", " << typeName(l.type) << ")\n";
                ++skipped; continue;
            }
            if (!ok) { std::cout << "  SKIP " << name << ": " << reason << "\n"; ++skipped; continue; }

            string stem = cleanName(path.stem().string()) + "_" + name;
            fs::path outPath = availablePath(outDir, stem, overwrite);
            if (!writePng(outPath, img.w, img.h, img.pixels, img.palette, img.transparent)) {
                std::cout << "  SKIP " << name << ": could not write PNG\n"; ++skipped; continue;
            }
            std::cout << "  OK   " << name << " (" << img.kind << ", " << img.w << "x" << img.h << ") -> " << outPath.filename().string() << "\n";
            ++converted;
        }
    }
    std::cout << "\n----------------------------------------\nConverted: " << converted
              << "\nSkipped:   " << skipped << "\nFailed WADs: " << failed
              << "\nOutput:    " << outDir.string() << "\n";
    return failed ? 1 : 0;
}
