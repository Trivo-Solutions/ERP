// Protocol v1 engine: parses one request line, validates it independently of the caller, drives an ICameraDriver, and
// returns the reply lines. No I/O, no threads, no SDK types — fully testable in-process.
#pragma once
#include <string>
#include <vector>
#include "driver.h"

namespace trivo {

constexpr int kProtocol = 1;

class Engine {
 public:
  Engine(ICameraDriver& driver, std::wstring outDir, std::wstring leaf = L"sony-shots") : drv_(driver), outDir_(std::move(outDir)), leaf_(std::move(leaf)) {}

  // Reply lines (without the trailing newline) for one request line. Never throws.
  std::vector<std::string> handleLine(const std::string& line);
  // Poll for unsolicited events (device loss). Emits "disconnected" at most once per session.
  std::vector<std::string> tick();
  // Called when the input line exceeded the bound: one error reply, then the host must exit.
  std::vector<std::string> oversize();

  bool wantsExit() const { return exit_; }
  void shutdown();  // stdin closed / fatal: release the session

  static std::string readyEvent();

 private:
  ICameraDriver& drv_;
  std::wstring outDir_;
  std::wstring leaf_;
  bool listed_ = false, connected_ = false, exit_ = false;
  std::vector<std::string> ids_;
};

}  // namespace trivo
