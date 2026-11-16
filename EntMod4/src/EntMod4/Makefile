# EntMod4 (reconstructed) -- 32-bit Linux Metamod plugin. Build in WSL/Linux: make
# Windows build is the MSVC project (added later). Output: EntMod_i386.so (matches the shipped name).
HLSDK   = include/hlsdk
METAMOD = include/metamod
H9DIR   = ../h9
NAME    = EntMod
OUT     = $(NAME)_i386.so
CXX     = g++

# HAVOC9 build: the faithful EntMod sources (minus h9_hooks_null.cpp, the pure-build seam stub)
# plus the H9 layer in src/h9. For a pure upstream-identical build, drop H9_SRCS and keep
# h9_hooks_null.cpp instead (one of the two supplies the H9 seam symbols; never both).
BASE_SRCS = $(filter-out h9_hooks_null.cpp,$(wildcard *.cpp))
H9_SRCS   = $(wildcard $(H9DIR)/*.cpp)
SRCS = $(BASE_SRCS) $(H9_SRCS)
OBJS = $(SRCS:.cpp=.o)

INCLUDE = -I. -I$(H9DIR) -I$(HLSDK)/common -I$(HLSDK)/dlls -I$(HLSDK)/engine \
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
