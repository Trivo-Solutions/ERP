// Windows camera driver (Media Foundation capture + WIC JPEG encode) behind the shared ICameraDriver seam.
//
// The camera is NOT held open between shots: connect() only records which device (by stable id) the session is for, and each
// shoot() activates it, lets auto-exposure settle, grabs ONE frame, encodes a JPEG and releases the device again. That keeps the
// capture light off between photos, lets other apps use the camera, and means a hung device can only ever hurt one shot
// (the bridge kills the process on timeout - nothing needs to survive).
#pragma once
#include <string>
#include <vector>
#include "driver.h"

namespace trivo {

class WebcamDriver : public ICameraDriver {
 public:
  WebcamDriver() = default;
  ~WebcamDriver() override;
  Failure list(std::vector<Device>& out) override;
  Failure connect(const std::string& deviceId) override;
  Failure shoot(const std::wstring& path) override;
  void close() override;
  bool pollDisconnected() override;

 private:
  struct Found { std::string id, model, connection, placement; std::wstring link; };
  bool ensureInit();
  bool enumerate(std::vector<Found>& out, void* activates /* optional: std::vector<ComPtr<IMFActivate>>* (shoot only) */);

  bool init_ = false, comOwned_ = false;
  bool connected_ = false, lostReported_ = false;
  std::string connectedId_;
  std::wstring connectedLink_;
  unsigned long long lastPoll_ = 0;
};

}  // namespace trivo
