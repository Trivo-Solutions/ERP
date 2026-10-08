#include "jpeg.h"
#include <windows.h>
#include <vector>

namespace trivo {

bool jpegDimensions(const unsigned char* d, size_t n, int& w, int& h) {
  if (n < 4 || d[0] != 0xFF || d[1] != 0xD8) return false;
  size_t pos = 2;
  while (pos + 4 <= n) {
    if (d[pos] != 0xFF) return false;
    while (pos + 1 < n && d[pos + 1] == 0xFF) ++pos;  // fill bytes
    if (pos + 4 > n) return false;
    unsigned char m = d[pos + 1];
    if (m == 0x01 || (m >= 0xD0 && m <= 0xD8)) { pos += 2; continue; }  // standalone markers
    if (m == 0xD9 || m == 0xDA) return false;                            // end / scan before any frame header
    size_t len = ((size_t)d[pos + 2] << 8) | d[pos + 3];
    if (len < 2) return false;
    bool sof = m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC;
    if (sof) {
      if (pos + 9 > n || len < 8) return false;
      h = ((int)d[pos + 5] << 8) | d[pos + 6];
      w = ((int)d[pos + 7] << 8) | d[pos + 8];
      return w >= 1 && h >= 1 && w <= 100000 && h <= 100000;
    }
    pos += 2 + len;
  }
  return false;
}

bool verifyJpegFile(const std::wstring& path, int& width, int& height) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  struct Closer { HANDLE h; ~Closer() { CloseHandle(h); } } closer{f};
  BY_HANDLE_FILE_INFORMATION bi;
  if (!GetFileInformationByHandle(f, &bi)) return false;
  if (bi.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  unsigned long long size = ((unsigned long long)bi.nFileSizeHigh << 32) | bi.nFileSizeLow;
  if (size < 4 || size > kMaxImageBytes) return false;

  std::vector<unsigned char> head((size_t)(size < (4u << 20) ? size : (4u << 20)));
  DWORD got = 0;
  if (!ReadFile(f, head.data(), (DWORD)head.size(), &got, nullptr) || got != head.size()) return false;
  if (head[0] != 0xFF || head[1] != 0xD8 || head[2] != 0xFF) return false;

  unsigned char tail[64];
  DWORD tn = (DWORD)(size < 64 ? size : 64);
  LARGE_INTEGER off; off.QuadPart = (LONGLONG)(size - tn);
  if (!SetFilePointerEx(f, off, nullptr, FILE_BEGIN)) return false;
  if (!ReadFile(f, tail, tn, &got, nullptr) || got != tn) return false;
  bool eoi = false;
  for (DWORD i = 0; i + 1 < tn; ++i) if (tail[i] == 0xFF && tail[i + 1] == 0xD9) { eoi = true; break; }
  if (!eoi) return false;

  return jpegDimensions(head.data(), head.size(), width, height);
}

}  // namespace trivo
