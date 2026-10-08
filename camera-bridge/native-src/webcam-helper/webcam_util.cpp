#include "webcam_util.h"
#include <windows.h>
#include <bcrypt.h>
#include <cwctype>
#include <vector>

namespace trivo {

static std::wstring lowerW(std::wstring s) { for (auto& c : s) c = (wchar_t)towlower(c); return s; }
static std::string lowerA(std::string s) { for (auto& c : s) if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a'); return s; }

std::string sanitizeCameraName(const std::wstring& friendly) {
  std::string out;
  bool lastSpace = true;  // swallows leading spaces
  for (wchar_t c : friendly) {
    bool ok = (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || c == L'.' || c == L'_' || c == L'-';
    if (ok) { out += (char)c; lastSpace = false; }
    else if (!lastSpace) { out += ' '; lastSpace = true; }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  if (out.size() > 40) { out.resize(40); while (!out.empty() && out.back() == ' ') out.pop_back(); }
  return out.empty() ? "Camera" : out;
}

bool looksIntegrated(const std::string& name) {
  const std::string n = lowerA(name);
  for (const char* k : {"integrated", "built-in", "builtin", "internal", "facetime"}) if (n.find(k) != std::string::npos) return true;
  return false;
}

bool looksInfrared(const std::wstring& friendly) {
  const std::wstring n = L" " + lowerW(friendly) + L" ";
  return n.find(L"infrared") != std::wstring::npos || n.find(L" ir ") != std::wstring::npos || n.find(L"windows hello") != std::wstring::npos;
}

std::string stableCameraId(const std::wstring& link) {
  if (link.empty()) return "";
  const std::wstring l = lowerW(link);
  BCRYPT_ALG_HANDLE alg = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return "";
  std::vector<UCHAR> digest(32);
  const NTSTATUS st = BCryptHash(alg, nullptr, 0, (PUCHAR)l.data(), (ULONG)(l.size() * sizeof(wchar_t)), digest.data(), (ULONG)digest.size());
  BCryptCloseAlgorithmProvider(alg, 0);
  if (st < 0) return "";
  static const char* hex = "0123456789abcdef";
  std::string id = "cam-";
  for (int i = 0; i < 12; ++i) { id += hex[digest[i] >> 4]; id += hex[digest[i] & 15]; }
  return id;
}

std::string connectionOf(const std::wstring& link) {
  return lowerW(link).rfind(L"\\\\?\\usb#", 0) == 0 ? "usb" : "local";
}

}  // namespace trivo
