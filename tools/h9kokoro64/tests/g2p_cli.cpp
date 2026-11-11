// g2p_cli -- the helper's G2P on a file of lines, for the parity test against the Python prototype and for looking at what a line becomes.
//
//   g2p_cli <g2p folder (tokens.txt, en_us.h9lex, en_us.h9lt)> <lines.txt> [oov]     one line of UTF-8 text per line; prints the phonemes (UTF-8) per line
//
// With "oov" the out-of-dictionary chain is on (clitics, letter-to-sound trees, spelling); without it a word the lexicon cannot do says nothing.

#include <stdio.h>
#include <stdlib.h>

#include <string>
#include <vector>

#include "g2p_text.h"
#include "oov.h"

static bool ReadFileBytes(const std::string& path, std::vector<uint8_t>& out)
{
	FILE* f = fopen(path.c_str(), "rb");
	if (!f)
		return false;
	out.clear();
	uint8_t buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		out.insert(out.end(), buf, buf + n);
	fclose(f);
	return true;
}

int main(int argc, char** argv)
{
	if (argc < 3)
	{
		fprintf(stderr, "usage: g2p_cli <g2p folder> <lines.txt> [oov]\n");
		return 2;
	}
	const std::string dir = argv[1];
	std::vector<uint8_t> lexBytes, tokBytes, ltBytes;
	if (!ReadFileBytes(dir + "\\en_us.h9lex", lexBytes) || !ReadFileBytes(dir + "\\tokens.txt", tokBytes))
	{
		fprintf(stderr, "cannot read the g2p files in %s\n", dir.c_str());
		return 2;
	}
	std::string err;
	h9k::Vocab vocab;
	if (!vocab.Load(std::string((const char*)tokBytes.data(), tokBytes.size()), &err))
	{
		fprintf(stderr, "tokens: %s\n", err.c_str());
		return 2;
	}
	h9k::Lexicon lex;
	if (!lex.Load(lexBytes.data(), lexBytes.size(), &err))
	{
		fprintf(stderr, "lexicon: %s\n", err.c_str());
		return 2;
	}
	const bool useOov = argc > 3 && std::string(argv[3]) == "oov";
	h9k::G2P g2p(lex, vocab, nullptr);
	h9k::LtsOov oov(g2p.P());
	if (useOov)
	{
		if (ReadFileBytes(dir + "\\en_us.h9lt", ltBytes))
			oov.LoadTrees(ltBytes.data(), ltBytes.size(), &err);
		g2p.SetOov(&oov);
	}
	FILE* in = fopen(argv[2], "rb");
	if (!in)
		return 2;
	std::string line;
	int c;
	for (;;)
	{
		line.clear();
		while ((c = fgetc(in)) != EOF && c != '\n')
			line += (char)c;
		if (c == EOF && line.empty())
			break;
		if (!line.empty() && line[line.size() - 1] == '\r')
			line.erase(line.size() - 1);
		const h9k::Ps ps = g2p.Phonemize(line);
		printf("%s\n", vocab.ToUtf8(ps).c_str());
	}
	fclose(in);
	return 0;
}
