CPP = gcc
BASEFLAGS = -Dstricmp=strcasecmp -Dstrcmpi=strcasecmp
CPPFLAGS = ${BASEFLAGS} -m386 -O2 -w -I. -I../engine -I../common -I../../metamod

OBJ = config.o dllapi.o h_export.o sdk_util.o stripper2_api.o

stripper2_mm_i386.so: ${OBJ}
	${CPP} -fPIC -shared -o $@ ${OBJ}

clean:
	-rm -f *.o
	-rm -f *.so	

%.o:	%.cpp
	${CPP} ${CPPFLAGS} -c $< -o $@

%.o:	%.c
	${CPP} ${CPPFLAGS} -c $< -o $@

