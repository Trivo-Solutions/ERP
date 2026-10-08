#pragma once
#include <string>
#include "driver.h"

namespace trivo {

// Parses argv: exactly `--out-dir <dir>` is accepted (extra `--name=value` args are allowed only when `allowExtra` is set,
// for the test-only fake exe). Returns false on anything else.
bool parseArgs(int argc, wchar_t** argv, std::wstring& outDir, bool allowExtra);

// Applies the DLL-search restriction, validates outDir, then speaks protocol v1 on stdin/stdout until EOF/close.
// Returns the process exit code (0 clean, 2 bad arguments/out dir).
// `leaf` = required out-dir leaf name; `name` = the executable name used in the one fixed stderr diagnostic.
int runHelper(ICameraDriver& driver, const std::wstring& outDir, const wchar_t* leaf = L"sony-shots", const char* name = "trivo-sony-helper");

}  // namespace trivo
