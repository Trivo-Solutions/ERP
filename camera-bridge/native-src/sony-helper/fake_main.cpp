// trivo-sony-helper-fake.exe — TEST-ONLY. The real native binary + real protocol/validation code, driven by FakeDriver, so the
// Node bridge can be exercised against a genuine native process with no camera. Never shipped.
//   args: --out-dir <dir> [--scenario=<name>] [--log=<file>]
#include <cstdio>
#include <string>
#include "fake_driver.h"
#include "host.h"

int wmain(int argc, wchar_t** argv) {
  std::wstring outDir, scenario = L"ok", log;
  if (!trivo::parseArgs(argc, argv, outDir, true)) return 2;
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    if (a.rfind(L"--scenario=", 0) == 0) scenario = a.substr(11);
    if (a.rfind(L"--log=", 0) == 0) log = a.substr(6);
  }
  std::string sc;
  for (wchar_t c : scenario) sc += (c < 0x80) ? (char)c : (char)63;
  trivo::FakeDriver d(sc, log);
  return trivo::runHelper(d, outDir);
}
