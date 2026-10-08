#include "validate.h"
#include <windows.h>
#include <cwctype>

namespace trivo {

bool shotFileNameOk(const std::string& n) {
  static const std::string pre = "shot-", suf = ".jpg";
  if (n.size() != pre.size() + 36 + suf.size()) return false;
  if (n.compare(0, pre.size(), pre) != 0 || n.compare(n.size() - suf.size(), suf.size(), suf) != 0) return false;
  for (size_t i = pre.size(); i < pre.size() + 36; ++i) {
    char c = n[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == '-')) return false;
  }
  return true;
}

static bool asciiAlnum(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

bool deviceIdOk(const std::string& s) {
  if (s.empty() || s.size() > 64) return false;
  for (char c : s) if (!(asciiAlnum(c) || c == '.' || c == '_' || c == ':' || c == '-')) return false;
  return true;
}
bool deviceModelOk(const std::string& s) {
  if (s.empty() || s.size() > 40) return false;
  for (char c : s) if (!(asciiAlnum(c) || c == '.' || c == '_' || c == ' ' || c == '-')) return false;
  return true;
}

static std::wstring lower(std::wstring s) { for (auto& c : s) c = (wchar_t)towlower(c); return s; }

bool outDirSyntaxOk(const std::wstring& d) {
  if (d.size() < 4 || d.size() > 240) return false;
  bool letter = (d[0] >= L'a' && d[0] <= L'z') || (d[0] >= L'A' && d[0] <= L'Z');
  if (!letter || d[1] != L':' || d[2] != L'\\') return false;  // X:\ only (rejects UNC, \\?\, device paths)
  for (size_t i = 0; i < d.size(); ++i) {
    wchar_t c = d[i];
    if (c < 0x20 || c == L'<' || c == L'>' || c == L'"' || c == L'|' || c == L'?' || c == L'*' || c == L'/') return false;
    if (c == L':' && i != 1) return false;  // no alternate data streams
  }
  size_t end = d.size();
  if (d[end - 1] == L'\\') --end;  // tolerate exactly one trailing separator
  size_t pos = 3;
  while (pos < end) {
    size_t nx = d.find(L'\\', pos);
    if (nx == std::wstring::npos || nx > end) nx = end;
    std::wstring seg = d.substr(pos, nx - pos);
    if (seg.empty() || seg == L"." || seg == L"..") return false;
    if (seg.back() == L' ' || seg.back() == L'.') return false;
    pos = nx + 1;
  }
  return true;
}

bool outDirOk(const std::wstring& dir, const wchar_t* leaf) {
  if (!outDirSyntaxOk(dir)) return false;
  std::wstring d = dir;
  if (d.size() > 3 && d.back() == L'\\') d.pop_back();
  size_t cut = d.find_last_of(L'\\');
  if (lower(d.substr(cut + 1)) != lower(leaf)) return false;
  DWORD a = GetFileAttributesW(d.c_str());
  if (a == INVALID_FILE_ATTRIBUTES || !(a & FILE_ATTRIBUTE_DIRECTORY) || (a & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  HANDLE h = CreateFileW(d.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  wchar_t buf[1024];
  DWORD n = GetFinalPathNameByHandleW(h, buf, 1024, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(h);
  if (n == 0 || n >= 1024) return false;
  std::wstring fin(buf, n);
  if (fin.rfind(L"\\\\?\\UNC\\", 0) == 0) return false;
  if (fin.rfind(L"\\\\?\\", 0) == 0) fin = fin.substr(4);
  return lower(fin) == lower(d);  // junction / symlink / subst / 8.3 aliasing in any parent => mismatch => refused
}

}  // namespace trivo
