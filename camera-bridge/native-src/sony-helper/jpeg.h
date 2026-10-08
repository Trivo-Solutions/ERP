#pragma once
#include <string>

namespace trivo {

constexpr unsigned long long kMaxImageBytes = 120ull * 1024 * 1024;

// Verifies `path` is a regular (non-reparse) file, 4 B..120 MB, FF D8 FF ... FF D9 (within the last 64 bytes), and reads
// width/height from the JPEG's own SOF marker (1..100000). Pure file inspection; never trusts any SDK-reported size.
bool verifyJpegFile(const std::wstring& path, int& width, int& height);

// Exposed for tests: dimensions from an in-memory prefix (false if no SOF before the scan).
bool jpegDimensions(const unsigned char* d, size_t n, int& w, int& h);

}  // namespace trivo
