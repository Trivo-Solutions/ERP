// trivo-sony-helper.exe — production entry point. Links NO test code. The Sony SDK adapter plugs in at `makeDriver()`;
// until it is built (see README.md) the helper reports DRIVER_UNAVAILABLE, exactly what the bridge expects with no SDK.
#include <windows.h>
#include <cstdio>
#include "host.h"

#ifdef TRIVO_WITH_SONY_SDK
trivo::ICameraDriver* makeSonyDriver();  // implemented in SonyDriver.cpp (compiled only when CRSDK_DIR is configured)
#endif

int wmain(int argc, wchar_t** argv) {
  std::wstring outDir;
  if (!trivo::parseArgs(argc, argv, outDir, false)) {
    fputs("usage: trivo-sony-helper --out-dir <dir>\n", stderr);
    return 2;
  }
#ifdef TRIVO_WITH_SONY_SDK
  trivo::ICameraDriver* d = makeSonyDriver();
  return trivo::runHelper(*d, outDir);
#else
  trivo::NullDriver d;
  return trivo::runHelper(d, outDir);
#endif
}
