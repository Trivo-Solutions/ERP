// trivo-webcam-helper.exe — production entry point. Speaks protocol v1 (docs/WEBCAM_HELPER_PROTOCOL.md) over stdin/stdout and
// drives the machine's Windows cameras through Media Foundation. It knows only cameras: no ERP URL, token, ticket, company, tag
// or storage. Accepted arguments: exactly `--out-dir <dir>`.
#include <windows.h>
#include <cstdio>
#include "host.h"
#include "webcam_driver.h"

int wmain(int argc, wchar_t** argv) {
  std::wstring outDir;
  if (!trivo::parseArgs(argc, argv, outDir, false)) {
    fputs("usage: trivo-webcam-helper --out-dir <dir>\n", stderr);
    return 2;
  }
  trivo::WebcamDriver d;
  return trivo::runHelper(d, outDir, L"webcam-shots", "trivo-webcam-helper");
}
