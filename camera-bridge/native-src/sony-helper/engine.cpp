#include "engine.h"
#include <windows.h>
#include <algorithm>
#include "jpeg.h"
#include "json.h"
#include "validate.h"

namespace trivo {

const char* failureCode(Failure f) {
  switch (f) {
    case Failure::DRIVER_UNAVAILABLE: return "DRIVER_UNAVAILABLE";
    case Failure::NO_CAMERA_FOUND: return "NO_CAMERA_FOUND";
    case Failure::MULTIPLE_CAMERAS: return "MULTIPLE_CAMERAS";
    case Failure::CONNECT_REJECTED: return "CONNECT_REJECTED";
    case Failure::CAMERA_BUSY: return "CAMERA_BUSY";
    case Failure::DEVICE_LOST: return "DEVICE_LOST";
    case Failure::SHUTTER_FAILED: return "SHUTTER_FAILED";
    case Failure::TRANSFER_FAILED: return "TRANSFER_FAILED";
    case Failure::TIMEOUT: return "TIMEOUT";
    default: return "PROTOCOL_ERROR";  // None never reaches the wire as a failure; anything unmapped is a protocol error
  }
}

namespace {
std::string fail(long long id, Failure f) {
  return "{\"id\":" + std::to_string(id) + ",\"ok\":false,\"failure\":\"" + failureCode(f) + "\"}";
}
std::string ok(long long id) { return "{\"id\":" + std::to_string(id) + ",\"ok\":true}"; }


bool onlyKeys(const JsonObject& o, std::initializer_list<const char*> allowed) {
  for (const auto& m : o.members) {
    bool found = false;
    for (const char* a : allowed) if (m.first == a) { found = true; break; }
    if (!found) return false;
  }
  return true;
}
}  // namespace

std::string Engine::readyEvent() { return "{\"event\":\"ready\",\"protocol\":" + std::to_string(kProtocol) + "}"; }

std::vector<std::string> Engine::oversize() {
  exit_ = true;
  return {fail(0, Failure::PROTOCOL_ERROR)};
}

void Engine::shutdown() {
  if (connected_ || listed_) drv_.close();
  connected_ = listed_ = false;
}

std::vector<std::string> Engine::tick() {
  if (connected_ && drv_.pollDisconnected()) {
    connected_ = false;
    drv_.close();
    return {"{\"event\":\"disconnected\"}"};
  }
  return {};
}

std::vector<std::string> Engine::handleLine(const std::string& line) {
  try {
    JsonObject o;
    if (!parseFlatObject(line, o)) return {fail(0, Failure::PROTOCOL_ERROR)};
    const JsonValue* idv = o.find("id");
    if (!idv || idv->type != JsonValue::Int || idv->i < 1 || idv->i > 2147483647LL) return {fail(0, Failure::PROTOCOL_ERROR)};
    const long long id = idv->i;
    const JsonValue* opv = o.find("op");
    if (!opv || opv->type != JsonValue::Str) return {fail(id, Failure::PROTOCOL_ERROR)};
    const std::string& op = opv->s;

    if (op == "list") {
      if (!onlyKeys(o, {"id", "op"})) return {fail(id, Failure::PROTOCOL_ERROR)};
      if (connected_) return {fail(id, Failure::CAMERA_BUSY)};
      std::vector<Device> raw;
      Failure f = drv_.list(raw);
      if (f != Failure::None) { listed_ = false; ids_.clear(); return {fail(id, f)}; }
      std::string body;
      ids_.clear();
      for (const Device& d : raw) {
        // SDK-provided strings are untrusted: anything outside the strict charsets is dropped, never forwarded.
        if (!deviceIdOk(d.id) || !deviceModelOk(d.model) || (d.connection != "usb" && d.connection != "network" && d.connection != "local")) continue;
        if (!d.placement.empty() && d.placement != "integrated") continue;
        if (std::find(ids_.begin(), ids_.end(), d.id) != ids_.end()) continue;  // duplicate ids would make selection ambiguous
        if (ids_.size() >= 32) break;
        if (!body.empty()) body += ",";
        body += "{\"id\":" + jsonString(d.id) + ",\"model\":" + jsonString(d.model) + ",\"connection\":\"" + d.connection + "\"" + (d.placement.empty() ? "" : ",\"placement\":\"" + d.placement + "\"") + "}";
        ids_.push_back(d.id);
      }
      listed_ = true;
      return {"{\"id\":" + std::to_string(id) + ",\"ok\":true,\"devices\":[" + body + "]}"};
    }

    if (op == "connect") {
      if (!onlyKeys(o, {"id", "op", "deviceId"})) return {fail(id, Failure::PROTOCOL_ERROR)};
      const JsonValue* dv = o.find("deviceId");
      if (!dv || dv->type != JsonValue::Str || !deviceIdOk(dv->s)) return {fail(id, Failure::PROTOCOL_ERROR)};
      if (!listed_) return {fail(id, Failure::PROTOCOL_ERROR)};
      if (connected_) return {fail(id, Failure::CAMERA_BUSY)};
      if (std::find(ids_.begin(), ids_.end(), dv->s) == ids_.end()) return {fail(id, Failure::NO_CAMERA_FOUND)};
      Failure f = drv_.connect(dv->s);
      if (f != Failure::None) return {fail(id, f)};
      connected_ = true;
      return {ok(id)};
    }

    if (op == "shoot") {
      if (!onlyKeys(o, {"id", "op", "file"})) return {fail(id, Failure::PROTOCOL_ERROR)};
      const JsonValue* fv = o.find("file");
      if (!fv || fv->type != JsonValue::Str || !shotFileNameOk(fv->s)) return {fail(id, Failure::PROTOCOL_ERROR)};
      if (!connected_) return {fail(id, Failure::PROTOCOL_ERROR)};
      if (!outDirOk(outDir_, leaf_.c_str())) return {fail(id, Failure::TRANSFER_FAILED)};
      std::wstring dir = outDir_;
      if (dir.back() == L'\\') dir.pop_back();
      const std::wstring full = dir + L"\\" + std::wstring(fv->s.begin(), fv->s.end());
      if (GetFileAttributesW(full.c_str()) != INVALID_FILE_ATTRIBUTES) return {fail(id, Failure::PROTOCOL_ERROR)};  // never overwrite

      Failure f = drv_.shoot(full);  // exactly one call, ever, per request: no retry on any outcome
      if (f != Failure::None) {
        DeleteFileW(full.c_str());  // a partial file must not linger
        if (f == Failure::DEVICE_LOST) connected_ = false;
        return {fail(id, f)};
      }
      int w = 0, h = 0;
      if (!verifyJpegFile(full, w, h)) {
        DeleteFileW(full.c_str());
        return {fail(id, Failure::TRANSFER_FAILED)};
      }
      return {"{\"id\":" + std::to_string(id) + ",\"ok\":true,\"file\":" + jsonString(fv->s) + ",\"width\":" + std::to_string(w) +
              ",\"height\":" + std::to_string(h) + "}"};
    }

    if (op == "close") {
      if (!onlyKeys(o, {"id", "op"})) return {fail(id, Failure::PROTOCOL_ERROR)};
      drv_.close();
      connected_ = listed_ = false;
      exit_ = true;
      return {ok(id)};
    }

    return {fail(id, Failure::PROTOCOL_ERROR)};  // unknown operation
  } catch (...) {
    return {fail(0, Failure::PROTOCOL_ERROR)};  // nothing escapes: no exception text, no crash
  }
}

}  // namespace trivo
