// Hardware-free tests of the webcam driver's pure helpers and of the shared validators with the webcam leaf, plus a read-only
// live enumeration (reports what this machine has; asserts only invariants that hold for any machine, including "no camera").
#include <windows.h>
#include <cstdio>
#include <cwctype>
#include <functional>
#include <set>
#include <string>
#include <vector>
#include "validate.h"
#include "webcam_driver.h"
#include "webcam_util.h"

using namespace trivo;

static int g_pass = 0, g_fail = 0;
#define CHECK(c) do { if (c) ++g_pass; else { ++g_fail; std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)
static std::vector<std::pair<std::string, std::function<void()>>>& tests() { static std::vector<std::pair<std::string, std::function<void()>>> t; return t; }
struct Reg { Reg(const char* n, std::function<void()> f) { tests().emplace_back(n, std::move(f)); } };
#define TEST(name) static void name(); static Reg reg_##name(#name, name); static void name()

TEST(sanitize_name) {
  CHECK(sanitizeCameraName(L"Integrated Camera") == "Integrated Camera");
  CHECK(sanitizeCameraName(L"Logi (R) Webcam C920") == "Logi R Webcam C920");  // punctuation dropped, spaces collapsed
  CHECK(sanitizeCameraName(L"  HD  Pro  ") == "HD Pro");
  CHECK(sanitizeCameraName(L"") == "Camera");
  CHECK(sanitizeCameraName(L"\u6444\u50cf\u5934") == "Camera");               // nothing representable
  CHECK(sanitizeCameraName(L"a\"b\\c\n<d>") == "a b c d");                    // quotes / backslash / control / angle brackets never survive
  CHECK(sanitizeCameraName(std::wstring(100, L'x')).size() == 40);
  CHECK(deviceModelOk(sanitizeCameraName(L"Weird / Name: v2 [x]")));          // always passes the protocol's own model rule
}
TEST(integrated_heuristic) {
  CHECK(looksIntegrated("Integrated Camera"));
  CHECK(looksIntegrated("Built-in FaceTime HD"));
  CHECK(!looksIntegrated("Logitech C920"));
  CHECK(!looksIntegrated("USB Camera"));
}
TEST(infrared_filter) {
  CHECK(looksInfrared(L"Integrated IR Camera"));
  CHECK(looksInfrared(L"Windows Hello Face Software Device"));
  CHECK(looksInfrared(L"HP Infrared Camera"));
  CHECK(!looksInfrared(L"Integrated Camera"));
  CHECK(!looksInfrared(L"Girl Cam"));  // "ir" inside a word is not the IR sensor
}
TEST(stable_id) {
  const std::wstring a = L"\\\\?\\usb#vid_5986&pid_1198&mi_00#7&1165a14b&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global";
  const std::string id = stableCameraId(a);
  CHECK(id.size() == 28 && id.rfind("cam-", 0) == 0);
  CHECK(deviceIdOk(id));
  CHECK(stableCameraId(a) == id);                                   // deterministic
  std::wstring upper = a; for (auto& c : upper) c = (wchar_t)towupper(c);
  CHECK(stableCameraId(upper) == id);                               // case-insensitive (Windows paths)
  CHECK(stableCameraId(L"\\\\?\\usb#vid_046d&pid_0825&mi_00#6&2&0&1#{e5323777}\\global") != id);  // a different device differs
  CHECK(stableCameraId(L"").empty());
}
TEST(connection_kind) {
  CHECK(connectionOf(L"\\\\?\\USB#VID_1&PID_2#x#{y}\\global") == "usb");
  CHECK(connectionOf(L"\\\\?\\root#camera#0000#{y}\\global") == "local");
}
TEST(webcam_out_dir_leaf) {
  CHECK(outDirSyntaxOk(L"C:\\Data\\webcam-shots"));
  wchar_t t[MAX_PATH]; GetTempPathW(MAX_PATH, t);
  wchar_t lp[MAX_PATH]; GetLongPathNameW(t, lp, MAX_PATH);
  std::wstring base = std::wstring(lp) + L"trivo-webcam-test-" + std::to_wstring(GetCurrentProcessId());
  CreateDirectoryW(base.c_str(), nullptr);
  std::wstring good = base + L"\\webcam-shots", wrong = base + L"\\sony-shots";
  CreateDirectoryW(good.c_str(), nullptr); CreateDirectoryW(wrong.c_str(), nullptr);
  CHECK(outDirOk(good, L"webcam-shots"));
  CHECK(!outDirOk(good));                          // default leaf is still sony-shots
  CHECK(!outDirOk(wrong, L"webcam-shots"));        // the leaf is exact
  CHECK(!outDirOk(base, L"webcam-shots"));
  CHECK(!outDirOk(base + L"\\..\\webcam-shots", L"webcam-shots"));       // traversal
  CHECK(!outDirOk(L"\\\\server\\share\\webcam-shots", L"webcam-shots")); // UNC
  RemoveDirectoryW(good.c_str()); RemoveDirectoryW(wrong.c_str()); RemoveDirectoryW(base.c_str());
}
TEST(live_enumeration_invariants) {
  WebcamDriver d;
  std::vector<Device> devs;
  Failure f = d.list(devs);
  CHECK(f == Failure::None || f == Failure::DRIVER_UNAVAILABLE);
  std::printf("  (live) list -> %s, %zu camera(s)\n", failureCode(f), devs.size());
  std::set<std::string> ids;
  for (const Device& x : devs) {
    std::printf("  (live) id=%s model=\"%s\" connection=%s placement=%s\n", x.id.c_str(), x.model.c_str(), x.connection.c_str(), x.placement.c_str());
    CHECK(deviceIdOk(x.id) && deviceModelOk(x.model));
    CHECK(ids.insert(x.id).second);
  }
  std::vector<Device> again;
  if (f == Failure::None) {
    d.list(again);
    CHECK(again.size() == devs.size());
    for (size_t i = 0; i < again.size() && i < devs.size(); ++i) CHECK(again[i].id == devs[i].id);  // ids stable across calls
  }
  CHECK(f != Failure::None || d.connect("cam-000000000000000000000000") == Failure::NO_CAMERA_FOUND);
  CHECK(d.shoot(L"C:\\nowhere\\x.jpg") == Failure::PROTOCOL_ERROR);        // shoot before connect is a sequence error, never a capture
}

int main() {
  int failedTests = 0;
  for (auto& t : tests()) {
    int before = g_fail;
    std::printf("[ RUN ] %s\n", t.first.c_str());
    t.second();
    if (g_fail != before) { ++failedTests; std::printf("[ FAIL ] %s\n", t.first.c_str()); }
  }
  std::printf("\n%zu tests, %d checks passed, %d failed checks, %d failed tests\n", tests().size(), g_pass, g_fail, failedTests);
  return g_fail ? 1 : 0;
}
