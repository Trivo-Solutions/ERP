// TEST-ONLY driver (never linked into trivo-sony-helper.exe). Scenarios simulate cameras and SDK failure modes.
#pragma once
#include <windows.h>
#include <cstdio>
#include <string>
#include "driver.h"

namespace trivo {

// Structurally valid JPEG (SOI, SOF0 16x8, SOS, EOI): enough for the helper's verifier, not meant to decode.
inline const unsigned char* fakeJpeg(size_t& n) {
  static const unsigned char j[] = {0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00,
                                    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x10, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
                                    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x12, 0x34,
                                    0xFF, 0xD9};
  n = sizeof j;
  return j;
}

class FakeDriver : public ICameraDriver {
 public:
  explicit FakeDriver(std::string scenario = "ok", std::wstring shotLog = L"") : sc_(std::move(scenario)), log_(std::move(shotLog)) {}
  int listCalls = 0, connectCalls = 0, shootCalls = 0, closeCalls = 0;
  bool lostFlag = false;

  Failure list(std::vector<Device>& out) override {
    ++listCalls;
    if (sc_ == "driver_unavailable") return Failure::DRIVER_UNAVAILABLE;
    if (sc_ == "nocam") return Failure::None;
    out.push_back({"A1", "ILCE-7RM5", "usb"});
    if (sc_ == "multi") out.push_back({"B2", "ILCE-7RM5", "usb"});
    if (sc_ == "dirtyids") {  // hostile / sloppy SDK strings: must be filtered, never forwarded
      out.clear();
      out.push_back({"bad id\"with quote", "ILCE-7RM5", "usb"});
      out.push_back({"C:\\secret\\path", "ILCE-7RM5", "usb"});
      out.push_back({"SDKERR0x8704", "model\nnewline", "usb"});
      out.push_back({"GOOD1", "ILCE-7RM5", "wifi"});
      out.push_back({"OK9", "ILCE-7RM5", "network"});
      out.push_back({"OK9", "ILCE-7RM5", "network"});  // duplicate id
    }
    return Failure::None;
  }
  Failure connect(const std::string&) override {
    ++connectCalls;
    if (sc_ == "connectreject") return Failure::CONNECT_REJECTED;
    return Failure::None;
  }
  Failure shoot(const std::wstring& path) override {
    ++shootCalls;
    if (!log_.empty()) { FILE* f = _wfopen(log_.c_str(), L"ab"); if (f) { fputs("shot\n", f); fclose(f); } }
    if (sc_ == "shutterfail") return Failure::SHUTTER_FAILED;
    if (sc_ == "busy") return Failure::CAMERA_BUSY;
    if (sc_ == "lostonshoot") return Failure::DEVICE_LOST;
    if (sc_ == "timeout") return Failure::TIMEOUT;
    if (sc_ == "hang") { Sleep(60000); return Failure::TIMEOUT; }
    if (sc_ == "noimage") return Failure::None;                         // SDK claims success, nothing written
    if (sc_ == "partialthenfail") { write(path, "\xFF\xD8\xFF\xE0", 4); return Failure::SHUTTER_FAILED; }
    if (sc_ == "notjpeg") { write(path, "hello world", 11); return Failure::None; }
    if (sc_ == "noeoi") { size_t n; const unsigned char* j = fakeJpeg(n); write(path, (const char*)j, n - 2); return Failure::None; }
    if (sc_ == "nosof") { const unsigned char j[] = {0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9}; write(path, (const char*)j, sizeof j); return Failure::None; }
    size_t n; const unsigned char* j = fakeJpeg(n);
    write(path, (const char*)j, n);
    return Failure::None;
  }
  void close() override { ++closeCalls; }
  bool pollDisconnected() override { return sc_ == "lost" && lostFlag; }

 private:
  static void write(const std::wstring& p, const char* d, size_t n) {
    FILE* f = _wfopen(p.c_str(), L"wb");
    if (f) { fwrite(d, 1, n, f); fclose(f); }
  }
  std::string sc_;
  std::wstring log_;
};

}  // namespace trivo
