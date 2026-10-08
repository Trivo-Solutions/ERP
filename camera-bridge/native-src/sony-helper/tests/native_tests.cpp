// Hardware-free native tests: the protocol engine, validators and JPEG verifier, driven by FakeDriver. No camera, no SDK.
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>
#include "../engine.h"
#include "../fake_driver.h"
#include "../jpeg.h"
#include "../json.h"
#include "../validate.h"

using namespace trivo;

static int g_pass = 0, g_fail = 0;
#define CHECK(c) do { if (c) ++g_pass; else { ++g_fail; std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)
static std::vector<std::pair<std::string, std::function<void()>>>& tests() { static std::vector<std::pair<std::string, std::function<void()>>> t; return t; }
struct Reg { Reg(const char* n, std::function<void()> f) { tests().emplace_back(n, std::move(f)); } };
#define TEST(name) static void name(); static Reg reg_##name(#name, name); static void name()

static const char* kGoodFile = "shot-123e4567-e89b-12d3-a456-426614174000.jpg";
static const char* kGoodFile2 = "shot-123e4567-e89b-12d3-a456-426614174001.jpg";

static std::wstring g_tmp;  // <temp>\trivo-native-test-<pid>\sony-shots
static std::wstring mkOut() {
  wchar_t t[MAX_PATH];
  GetTempPathW(MAX_PATH, t);
  wchar_t lp[MAX_PATH];
  GetLongPathNameW(t, lp, MAX_PATH);  // canonical (no 8.3 aliasing) so outDirOk's canonical-path rule is satisfied
  std::wstring base = std::wstring(lp) + L"trivo-native-test-" + std::to_wstring(GetCurrentProcessId());
  CreateDirectoryW(base.c_str(), nullptr);
  static int n = 0;
  std::wstring sub = base + L"\\" + std::to_wstring(++n);  // a fresh, empty directory per call
  CreateDirectoryW(sub.c_str(), nullptr);
  std::wstring out = sub + L"\\sony-shots";
  CreateDirectoryW(out.c_str(), nullptr);
  g_tmp = base;
  return out;
}
static bool exists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
static std::string req(int id, const std::string& rest) { return "{\"id\":" + std::to_string(id) + "," + rest + "}"; }
static std::string one(Engine& e, const std::string& line) { auto r = e.handleLine(line); return r.empty() ? "" : r[0]; }
static bool has(const std::string& s, const char* sub) { return s.find(sub) != std::string::npos; }
static bool isFail(const std::string& s, const char* code) { return has(s, "\"ok\":false") && has(s, (std::string("\"failure\":\"") + code + "\"").c_str()); }
static std::wstring W(const std::string& s) { return std::wstring(s.begin(), s.end()); }

// ---- JSON ----
TEST(json_accepts_flat_object) {
  JsonObject o;
  CHECK(parseFlatObject("{\"id\":1,\"op\":\"list\"}", o));
  CHECK(o.find("op") && o.find("op")->s == "list");
  CHECK(parseFlatObject("  { \"id\" : 7 , \"op\" : \"close\" }  ", o));
  CHECK(parseFlatObject("{\"a\":true,\"b\":null}", o));
}
TEST(json_rejects_malformed) {
  JsonObject o;
  const char* bad[] = {"", "{", "}", "[]", "null", "{\"id\":}", "{\"id\":1", "{\"id\":1,}", "{id:1}", "{\"id\":01}", "{\"id\":1.5}",
                       "{\"id\":1e3}", "{\"id\":\"x\\q\"}", "{\"id\":{\"a\":1}}", "{\"id\":[1]}", "{\"id\":1}{\"id\":2}", "{\"id\":1} x",
                       "{\"a\":\"unterminated}", "{\"a\":\"\\u0000\"}", "{\"a\":\"\\u00e9\"}", "{\"a\":1,\"a\":2}", "\xEF\xBB\xBF{\"a\":1}"};
  for (const char* b : bad) CHECK(!parseFlatObject(b, o));
  std::string raw = "{\"a\":\"caf\xC3\xA9\"}";
  CHECK(!parseFlatObject(raw, o));  // non-ASCII bytes
  std::string big = "{\"a\":\"" + std::string(70000, 'x') + "\"}";
  CHECK(!parseFlatObject(big, o));
}

// ---- validators ----
TEST(shot_filename_validation) {
  CHECK(shotFileNameOk(kGoodFile));
  const char* bad[] = {"", "shot.jpg", "../shot-123e4567-e89b-12d3-a456-426614174000.jpg", "shot-123e4567-e89b-12d3-a456-426614174000.JPG",
                       "shot-123e4567-e89b-12d3-a456-426614174000.jpg.exe", "shot-123e4567-e89b-12d3-a456-42661417400g.jpg",
                       "C:\\shot-123e4567-e89b-12d3-a456-426614174000.jpg", "shot-123e4567-e89b-12d3-a456-42661417400.jpg",
                       "a/shot-123e4567-e89b-12d3-a456-426614174000.jpg", "shot-123e4567-e89b-12d3-a456-426614174000.jpg\\..\\x",
                       "shot-123E4567-e89b-12d3-a456-426614174000.jpg"};
  for (const char* b : bad) CHECK(!shotFileNameOk(b));
}
TEST(device_string_validation) {
  CHECK(deviceIdOk("A1")); CHECK(deviceIdOk("ILCE-7RM5:0123456789"));
  CHECK(!deviceIdOk("")); CHECK(!deviceIdOk("a b")); CHECK(!deviceIdOk("a\"b")); CHECK(!deviceIdOk("..\\x")); CHECK(!deviceIdOk(std::string(65, 'a')));
  CHECK(deviceModelOk("ILCE-7RM5")); CHECK(!deviceModelOk("m\nx")); CHECK(!deviceModelOk(std::string(41, 'a')));
}
TEST(outdir_syntax_rejects_traversal_unc_and_oddities) {
  CHECK(outDirSyntaxOk(L"C:\\Data\\sony-shots"));
  CHECK(outDirSyntaxOk(L"C:\\Data\\sony-shots\\"));
  const wchar_t* bad[] = {L"", L"sony-shots", L"C:sony-shots", L"C:\\", L"\\\\server\\share\\sony-shots", L"\\\\?\\C:\\Data\\sony-shots",
                          L"\\\\.\\C:\\Data\\sony-shots", L"C:\\Data\\..\\sony-shots", L"C:\\Data\\.\\sony-shots", L"C:\\Data\\sony-shots\\..",
                          L"C:\\Data\\sony-shots:stream", L"C:\\Da<ta\\sony-shots", L"C:\\Data\\so*ny-shots", L"C:\\Data\\sony?shots",
                          L"C:/Data/sony-shots", L"C:\\Data\\\\sony-shots", L"C:\\Data \\sony-shots", L"C:\\Data.\\sony-shots",
                          L"C:\\Data\\sony\x01shots", L"1:\\Data\\sony-shots", L"C:\\C:\\sony-shots"};
  for (const wchar_t* b : bad) CHECK(!outDirSyntaxOk(b));
  CHECK(!outDirSyntaxOk(L"C:\\" + std::wstring(300, L'a') + L"\\sony-shots"));
}
TEST(outdir_filesystem_rules) {
  std::wstring out = mkOut();
  CHECK(outDirOk(out));
  CHECK(outDirOk(out + L"\\"));
  CHECK(!outDirOk(g_tmp));                              // exists but wrong leaf name
  CHECK(!outDirOk(g_tmp + L"\\does-not-exist\\sony-shots"));  // missing
  // a regular FILE named sony-shots
  std::wstring fdir = g_tmp + L"\\f";
  CreateDirectoryW(fdir.c_str(), nullptr);
  HANDLE h = CreateFileW((fdir + L"\\sony-shots").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  CHECK(!outDirOk(fdir + L"\\sony-shots"));
  // a junction named sony-shots pointing at a real directory
  std::wstring real = g_tmp + L"\\real", jd = g_tmp + L"\\j";
  CreateDirectoryW(real.c_str(), nullptr);
  CreateDirectoryW(jd.c_str(), nullptr);
  std::wstring cmd = L"cmd /c mklink /J \"" + jd + L"\\sony-shots\" \"" + real + L"\" >nul 2>nul";
  _wsystem(cmd.c_str());
  if (exists(jd + L"\\sony-shots")) CHECK(!outDirOk(jd + L"\\sony-shots"));  // reparse point refused
  else std::printf("  (junction could not be created here; reparse check not exercised)\n");
  // parent is a junction: <junction>\sony-shots is a real dir but its canonical path differs
  CreateDirectoryW((real + L"\\sony-shots").c_str(), nullptr);
  std::wstring pj = g_tmp + L"\\pj";
  _wsystem((L"cmd /c mklink /J \"" + pj + L"\" \"" + real + L"\" >nul 2>nul").c_str());
  if (exists(pj + L"\\sony-shots")) CHECK(!outDirOk(pj + L"\\sony-shots"));
}

// ---- JPEG ----
TEST(jpeg_dimensions_and_verification) {
  size_t n; const unsigned char* j = fakeJpeg(n);
  int w = 0, h = 0;
  CHECK(jpegDimensions(j, n, w, h) && w == 16 && h == 8);
  CHECK(!jpegDimensions(j, 3, w, h));
  unsigned char zero[] = {0xFF, 0xD8, 0xFF, 0xC0, 0, 0x11, 8, 0, 0, 0, 0, 3};
  CHECK(!jpegDimensions(zero, sizeof zero, w, h));  // 0x0 rejected
  std::wstring out = mkOut();
  FILE* f = _wfopen((out + L"\\a.jpg").c_str(), L"wb"); fwrite(j, 1, n, f); fclose(f);
  CHECK(verifyJpegFile(out + L"\\a.jpg", w, h) && w == 16 && h == 8);
  CHECK(!verifyJpegFile(out + L"\\missing.jpg", w, h));
  CHECK(!verifyJpegFile(out, w, h));  // a directory
}

// ---- engine ----
struct Rig {
  std::wstring out = mkOut();
  FakeDriver d;
  Engine e;
  explicit Rig(const char* sc = "ok") : d(sc), e(d, out) {}
  std::string list() { return one(e, req(1, "\"op\":\"list\"")); }
  std::string connect(const char* id = "A1") { return one(e, req(2, std::string("\"op\":\"connect\",\"deviceId\":\"") + id + "\"")); }
  std::string shoot(const char* f = kGoodFile, int id = 3) { return one(e, req(id, std::string("\"op\":\"shoot\",\"file\":\"") + f + "\"")); }
};

TEST(engine_ready_event) { CHECK(Engine::readyEvent() == "{\"event\":\"ready\",\"protocol\":1}"); }

TEST(engine_happy_path_list_connect_shoot_close) {
  Rig r;
  std::string l = r.list();
  CHECK(has(l, "\"ok\":true") && has(l, "\"devices\":[{\"id\":\"A1\",\"model\":\"ILCE-7RM5\",\"connection\":\"usb\"}]"));
  CHECK(r.connect() == "{\"id\":2,\"ok\":true}");
  std::string s = r.shoot();
  CHECK(s == std::string("{\"id\":3,\"ok\":true,\"file\":\"") + kGoodFile + "\",\"width\":16,\"height\":8}");
  CHECK(exists(r.out + L"\\" + W(kGoodFile)));
  CHECK(r.d.shootCalls == 1);
  std::string c = one(r.e, req(4, "\"op\":\"close\""));
  CHECK(c == "{\"id\":4,\"ok\":true}" && r.e.wantsExit() && r.d.closeCalls >= 1);
}
TEST(engine_malformed_and_unknown) {
  Rig r;
  CHECK(isFail(one(r.e, "not json"), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, ""), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, "{}"), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, "{\"op\":\"list\"}"), "PROTOCOL_ERROR"));                    // missing id
  CHECK(isFail(one(r.e, "{\"id\":0,\"op\":\"list\"}"), "PROTOCOL_ERROR"));            // id out of range
  CHECK(isFail(one(r.e, "{\"id\":-3,\"op\":\"list\"}"), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, "{\"id\":2147483648,\"op\":\"list\"}"), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, "{\"id\":\"1\",\"op\":\"list\"}"), "PROTOCOL_ERROR"));         // id must be an integer
  CHECK(isFail(one(r.e, "{\"id\":1}"), "PROTOCOL_ERROR"));                             // missing op
  CHECK(isFail(one(r.e, "{\"id\":1,\"op\":5}"), "PROTOCOL_ERROR"));
  std::string u = one(r.e, req(9, "\"op\":\"format-disk\""));
  CHECK(isFail(u, "PROTOCOL_ERROR") && has(u, "\"id\":9"));                              // unknown op echoes the id
  CHECK(isFail(one(r.e, req(1, "\"op\":\"list\",\"extra\":1")), "PROTOCOL_ERROR"));      // unknown key
  CHECK(isFail(one(r.e, req(1, "\"op\":\"close\",\"cmd\":\"calc\"")), "PROTOCOL_ERROR"));
  CHECK(!r.e.wantsExit());                                                               // none of that stopped or crashed it
  CHECK(r.d.listCalls == 0 && r.d.shootCalls == 0);
}
TEST(engine_sequence_rules) {
  Rig r;
  CHECK(isFail(r.connect(), "PROTOCOL_ERROR"));        // connect before list
  CHECK(isFail(r.shoot(), "PROTOCOL_ERROR"));          // shoot before connect
  r.list();
  CHECK(isFail(r.shoot(), "PROTOCOL_ERROR"));          // listed, not connected
  CHECK(has(r.connect(), "\"ok\":true"));
  CHECK(isFail(r.connect(), "CAMERA_BUSY"));           // already connected
  CHECK(isFail(r.list(), "CAMERA_BUSY"));
  CHECK(r.d.shootCalls == 0 && r.d.connectCalls == 1);
}
TEST(engine_device_selection_is_by_stable_id) {
  Rig z("nocam");
  CHECK(has(z.list(), "\"devices\":[]"));
  CHECK(isFail(z.connect("A1"), "NO_CAMERA_FOUND"));
  Rig m("multi");
  std::string l = m.list();
  CHECK(has(l, "\"id\":\"A1\"") && has(l, "\"id\":\"B2\""));
  CHECK(has(m.connect("B2"), "\"ok\":true"));          // picks B2, not "first"
  Rig m2("multi");
  m2.list();
  CHECK(isFail(m2.connect("0"), "NO_CAMERA_FOUND"));   // an index is not an id
  CHECK(isFail(m2.connect("ZZ"), "NO_CAMERA_FOUND"));  // configured id not present
  CHECK(isFail(m2.connect("a1"), "NO_CAMERA_FOUND"));  // exact match only
  CHECK(m2.d.connectCalls == 0);
  CHECK(isFail(one(m2.e, req(2, "\"op\":\"connect\"")), "PROTOCOL_ERROR"));                       // missing deviceId
  CHECK(isFail(one(m2.e, req(2, "\"op\":\"connect\",\"deviceId\":5")), "PROTOCOL_ERROR"));        // wrong type
  CHECK(isFail(one(m2.e, req(2, "\"op\":\"connect\",\"deviceId\":\"A1\\\\..\\\\x\"")), "PROTOCOL_ERROR"));
}
TEST(engine_driver_failures_are_normalized) {
  Rig u("driver_unavailable");
  CHECK(isFail(u.list(), "DRIVER_UNAVAILABLE"));
  Rig c("connectreject");
  c.list();
  CHECK(isFail(c.connect(), "CONNECT_REJECTED"));
  CHECK(isFail(c.shoot(), "PROTOCOL_ERROR"));          // a rejected connect leaves the session closed
}
TEST(engine_dirty_sdk_strings_never_forwarded) {
  Rig r("dirtyids");
  std::string l = r.list();
  CHECK(has(l, "\"ok\":true"));
  CHECK(!has(l, "secret") && !has(l, "SDKERR") && !has(l, "quote") && !has(l, "newline") && !has(l, "wifi") && !has(l, "GOOD1"));
  CHECK(has(l, "\"id\":\"OK9\""));
  size_t first = l.find("OK9");
  CHECK(l.find("OK9", first + 1) == std::string::npos);  // duplicate id dropped
}
TEST(engine_shoot_rejects_bad_file_names_without_firing) {
  Rig r;
  r.list(); r.connect();
  const char* bad[] = {"x.jpg", "../shot-123e4567-e89b-12d3-a456-426614174000.jpg", "C:\\\\Windows\\\\x.jpg",
                       "shot-123e4567-e89b-12d3-a456-426614174000.png", "\\\\\\\\host\\\\share\\\\a.jpg", ""};
  for (const char* b : bad) CHECK(isFail(r.shoot(b), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, req(5, "\"op\":\"shoot\"")), "PROTOCOL_ERROR"));
  CHECK(isFail(one(r.e, req(5, std::string("\"op\":\"shoot\",\"file\":\"") + kGoodFile + "\",\"outDir\":\"C:\\\\x\"")), "PROTOCOL_ERROR"));
  CHECK(r.d.shootCalls == 0);  // the shutter was never fired for any of them
}
TEST(engine_shoot_refuses_overwrite) {
  Rig r;
  r.list(); r.connect();
  CHECK(has(r.shoot(), "\"ok\":true"));
  CHECK(isFail(r.shoot(kGoodFile), "PROTOCOL_ERROR"));   // same name again: refused before the shutter
  CHECK(r.d.shootCalls == 1);
  CHECK(has(r.shoot(kGoodFile2, 4), "\"ok\":true"));
  CHECK(r.d.shootCalls == 2);
}
TEST(engine_shutter_failure_is_single_shot_and_cleans_up) {
  for (const char* sc : {"shutterfail", "busy", "timeout", "partialthenfail"}) {
    Rig r(sc);
    r.list(); r.connect();
    std::string s = r.shoot();
    CHECK(has(s, "\"ok\":false"));
    CHECK(!has(s, "SDK") && !has(s, "0x"));
    CHECK(r.d.shootCalls == 1);                              // no automatic retry
    CHECK(!exists(r.out + L"\\" + W(kGoodFile)));            // partial file removed
  }
  Rig t("timeout");
  t.list(); t.connect();
  CHECK(isFail(t.shoot(), "TIMEOUT"));
  CHECK(t.d.shootCalls == 1);
}
TEST(engine_sdk_success_without_valid_image_is_transfer_failed) {
  for (const char* sc : {"noimage", "notjpeg", "noeoi", "nosof"}) {
    Rig r(sc);
    r.list(); r.connect();
    CHECK(isFail(r.shoot(), "TRANSFER_FAILED"));
    CHECK(!exists(r.out + L"\\" + W(kGoodFile)));            // invalid output deleted
    CHECK(r.d.shootCalls == 1);
  }
}
TEST(engine_device_loss) {
  Rig r("lostonshoot");
  r.list(); r.connect();
  CHECK(isFail(r.shoot(), "DEVICE_LOST"));
  CHECK(isFail(r.shoot(kGoodFile2, 4), "PROTOCOL_ERROR"));  // session is gone; needs a fresh list/connect
  CHECK(r.d.shootCalls == 1);

  Rig l("lost");
  CHECK(l.e.tick().empty());                  // not connected: no event
  l.list(); l.connect();
  CHECK(l.e.tick().empty());                  // connected and healthy
  l.d.lostFlag = true;
  auto ev = l.e.tick();
  CHECK(ev.size() == 1 && ev[0] == "{\"event\":\"disconnected\"}");
  CHECK(l.e.tick().empty());                  // at most once
  CHECK(isFail(l.shoot(), "PROTOCOL_ERROR"));
}
TEST(engine_oversize_and_shutdown) {
  Rig r;
  auto o = r.e.oversize();
  CHECK(o.size() == 1 && isFail(o[0], "PROTOCOL_ERROR") && r.e.wantsExit());
  Rig s;
  s.list(); s.connect();
  s.e.shutdown();
  CHECK(s.d.closeCalls >= 1);
}
TEST(engine_out_dir_vanishing_blocks_shoot) {
  Rig r;
  r.list(); r.connect();
  RemoveDirectoryW(r.out.c_str());
  CHECK(isFail(r.shoot(), "TRANSFER_FAILED"));
  CHECK(r.d.shootCalls == 0);
}

int main() {
  int failedTests = 0;
  for (auto& t : tests()) {
    int before = g_fail;
    std::printf("[ RUN ] %s\n", t.first.c_str());
    t.second();
    if (g_fail != before) { ++failedTests; std::printf("[ FAIL ] %s\n", t.first.c_str()); }
  }
  if (!g_tmp.empty()) { std::wstring c = L"cmd /c rmdir /s /q \"" + g_tmp + L"\" >nul 2>nul"; _wsystem(c.c_str()); }
  std::printf("\n%zu tests, %d checks passed, %d failed checks, %d failed tests\n", tests().size(), g_pass, g_fail, failedTests);
  return g_fail ? 1 : 0;
}
