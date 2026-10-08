#include "host.h"
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <thread>
#include "engine.h"
#include "json.h"
#include "validate.h"

namespace trivo {

bool parseArgs(int argc, wchar_t** argv, std::wstring& outDir, bool allowExtra) {
  bool have = false;
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    if (a == L"--out-dir") {
      if (have || i + 1 >= argc) return false;
      outDir = argv[++i];
      have = true;
    } else if (allowExtra && a.rfind(L"--", 0) == 0 && a.find(L'=') != std::wstring::npos) {
      continue;
    } else {
      return false;
    }
  }
  return have;
}

namespace {
struct Input {
  std::mutex m;
  std::condition_variable cv;
  std::deque<std::string> lines;
  bool eof = false, oversize = false;
};

void readerThread(Input* in) {
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  std::string cur;
  char buf[4096];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(h, buf, sizeof buf, &n, nullptr) || n == 0) break;
    for (DWORD i = 0; i < n; ++i) {
      if (buf[i] == '\n') {
        std::lock_guard<std::mutex> g(in->m);
        in->lines.push_back(std::move(cur));
        cur.clear();
        in->cv.notify_one();
      } else {
        cur += buf[i];
        if (cur.size() > kMaxLine) {
          std::lock_guard<std::mutex> g(in->m);
          in->oversize = true;
          in->cv.notify_one();
          return;
        }
      }
    }
  }
  std::lock_guard<std::mutex> g(in->m);
  in->eof = true;
  in->cv.notify_one();
}

bool emit(const std::string& line) {
  std::string s = line + "\n";
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  size_t off = 0;
  while (off < s.size()) {
    DWORD w = 0;
    if (!WriteFile(h, s.data() + off, (DWORD)(s.size() - off), &w, nullptr) || w == 0) return false;
    off += w;
  }
  return true;
}
}  // namespace

int runHelper(ICameraDriver& driver, const std::wstring& outDir, const wchar_t* leaf, const char* name) {
  // DLL search: application directory + System32 only — never the current directory or PATH. Done before the SDK is touched.
  SetDllDirectoryW(L"");
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  if (!outDirOk(outDir, leaf)) {
    fprintf(stderr, "%s: invalid --out-dir\n", name);
    return 2;
  }
  Engine eng(driver, outDir, leaf);
  if (!emit(Engine::readyEvent())) return 1;

  Input in;
  std::thread t(readerThread, &in);
  t.detach();  // blocked in ReadFile at exit is fine: the process ends, there is nothing to join

  int code = 0;
  for (;;) {
    std::deque<std::string> batch;
    bool eof = false, oversize = false;
    {
      std::unique_lock<std::mutex> g(in.m);
      in.cv.wait_for(g, std::chrono::milliseconds(200), [&] { return !in.lines.empty() || in.eof || in.oversize; });
      batch.swap(in.lines);
      eof = in.eof;
      oversize = in.oversize;
    }
    for (const std::string& raw : batch) {
      std::string line = raw;
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      for (const auto& r : eng.handleLine(line)) if (!emit(r)) { eng.shutdown(); return 1; }
      if (eng.wantsExit()) break;
    }
    if (!eng.wantsExit()) {
      for (const auto& r : eng.tick()) if (!emit(r)) { eng.shutdown(); return 1; }
    }
    if (oversize) { for (const auto& r : eng.oversize()) emit(r); break; }
    if (eng.wantsExit() || eof) break;
  }
  eng.shutdown();
  return code;
}

}  // namespace trivo
