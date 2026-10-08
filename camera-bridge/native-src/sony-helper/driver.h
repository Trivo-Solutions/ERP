// The ONLY seam between the protocol engine and a camera SDK. The engine never sees SDK types, error numbers or strings:
// a driver maps everything to the closed Failure set below.
#pragma once
#include <string>
#include <vector>

namespace trivo {

enum class Failure {
  None, DRIVER_UNAVAILABLE, NO_CAMERA_FOUND, MULTIPLE_CAMERAS, CONNECT_REJECTED, CAMERA_BUSY,
  DEVICE_LOST, SHUTTER_FAILED, TRANSFER_FAILED, TIMEOUT, PROTOCOL_ERROR
};
const char* failureCode(Failure f);

struct Device { std::string id, model, connection, placement; };  // connection: "usb" | "network" | "local"; placement: "" | "integrated" (webcam helper only)

class ICameraDriver {
 public:
  virtual ~ICameraDriver() = default;
  // Initialise the SDK (idempotent) and enumerate. `id` must be a stable camera identity, never an index.
  virtual Failure list(std::vector<Device>& out) = 0;
  // Open exactly this device (id as returned by list()).
  virtual Failure connect(const std::string& deviceId) = 0;
  // Fire the shutter ONCE and leave a JPEG at `path` (absolute, already validated, file does not exist). Must not retry.
  virtual Failure shoot(const std::wstring& path) = 0;
  // Release the session and all native resources. Idempotent.
  virtual void close() = 0;
  // True once if the connected camera has gone away (polled from the main loop; must not block).
  virtual bool pollDisconnected() { return false; }
};

// Used when no SDK adapter is compiled in: every enumeration reports DRIVER_UNAVAILABLE.
class NullDriver : public ICameraDriver {
 public:
  Failure list(std::vector<Device>&) override { return Failure::DRIVER_UNAVAILABLE; }
  Failure connect(const std::string&) override { return Failure::DRIVER_UNAVAILABLE; }
  Failure shoot(const std::wstring&) override { return Failure::DRIVER_UNAVAILABLE; }
  void close() override {}
};

}  // namespace trivo
