# HookMod (reconstructed, metamod-only) -- 32-bit Linux Metamod plugin. Build in WSL/Linux: make
# The shipped original is Windows-only (HookMod_MM.dll); this produces the NEW Linux .so.
# Windows build is the MSVC project. Output: HookMod_i386.so.
HLSDK   = include/hlsdk
METAMOD = include/metamod
OUT     = HookMod_i386.so
CXX     = g++

SRCS = $(wildcard *.cpp)
OBJS = $(SRCS:.cpp=.o)

INCLUDE = -I. -I$(HLSDK)/common -I$(HLSDK)/dlls -I$(HLSDK)/engine \
          -I$(HLSDK)/game_shared -I$(HLSDK)/pm_shared -I$(HLSDK)/public -I$(METAMOD)

CXXFLAGS = -O2 -m32 -fPIC -fno-stack-protector -Dlinux -D__linux__ -D__USE_GNU \
           -std=gnu++11 -Wno-write-strings -Wno-unused-result -w
LDFLAGS  = -m32 -shared -ldl

all: $(OUT)

$(OUT): $(OBJS)
	$(CXX) $(CXXFLAGS) $(OBJS) $(LDFLAGS) -o $(OUT)

%.o: %.cpp
	$(CXX) $(INCLUDE) $(CXXFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS) $(OUT)

.PHONY: all clean
