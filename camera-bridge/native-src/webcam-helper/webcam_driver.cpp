#include "webcam_driver.h"
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include "jpeg.h"
#include "webcam_util.h"

using Microsoft::WRL::ComPtr;

namespace trivo {

namespace {
constexpr ULONGLONG kShotBudgetMs = 10000;   // whole shoot(); the bridge's own (authoritative) kill timer is separate
constexpr ULONGLONG kWarmupMinMs = 400;      // let auto-exposure / white balance settle...
constexpr int kWarmupMinFrames = 6;          // ...over at least this many frames
constexpr ULONGLONG kWarmupMaxMs = 1500;     // ...but never wait longer than this for a camera that streams slowly
constexpr UINT32 kMaxPixels = 64u * 1000 * 1000;
constexpr ULONGLONG kPollMs = 3000;

Failure mapActivate(HRESULT hr) {
  if (hr == HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION)) return Failure::CAMERA_BUSY;
  if (hr == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || hr == HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED) ||
      hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return Failure::DEVICE_LOST;
  if (hr == E_ACCESSDENIED) return Failure::CONNECT_REJECTED;  // e.g. camera access blocked by Windows privacy settings
  return Failure::SHUTTER_FAILED;
}

Failure mapRead(HRESULT hr) {
  if (hr == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || hr == MF_E_HW_MFT_FAILED_START_STREAMING) return Failure::DEVICE_LOST;
  return Failure::SHUTTER_FAILED;
}

// Holds the cross-process "one physical capture at a time" mutex for the duration of a shoot().
struct ShootLock {
  HANDLE h = nullptr;
  bool held = false;
  ShootLock() {
    h = CreateMutexW(nullptr, FALSE, L"Local\\TrivoWebcamHelperShoot");
    if (h) { DWORD r = WaitForSingleObject(h, 0); held = (r == WAIT_OBJECT_0 || r == WAIT_ABANDONED); }
  }
  ~ShootLock() { if (h) { if (held) ReleaseMutex(h); CloseHandle(h); } }
  ShootLock(const ShootLock&) = delete;
  ShootLock& operator=(const ShootLock&) = delete;
};

struct Frame { UINT32 w = 0, h = 0; std::vector<BYTE> bgrx; };  // top-down, 4 bytes/pixel

bool copyFrame(IMFSample* sample, UINT32 w, UINT32 h, LONG defaultStride, Frame& out) {
  if (w == 0 || h == 0 || (unsigned long long)w * h > kMaxPixels) return false;
  ComPtr<IMFMediaBuffer> buf;
  if (FAILED(sample->ConvertToContiguousBuffer(&buf))) return false;
  out.w = w; out.h = h; out.bgrx.assign((size_t)w * h * 4, 0);
  BYTE* scan0 = nullptr; LONG pitch = 0;
  ComPtr<IMF2DBuffer> b2;
  if (SUCCEEDED(buf.As(&b2)) && SUCCEEDED(b2->Lock2D(&scan0, &pitch))) {
    bool ok = scan0 != nullptr && std::labs(pitch) >= (LONG)(w * 4);
    if (ok) for (UINT32 y = 0; y < h; ++y) std::memcpy(&out.bgrx[(size_t)y * w * 4], scan0 + (LONGLONG)y * pitch, (size_t)w * 4);
    b2->Unlock2D();
    return ok;
  }
  BYTE* data = nullptr; DWORD maxLen = 0, curLen = 0;
  if (FAILED(buf->Lock(&data, &maxLen, &curLen))) return false;
  const LONG stride = defaultStride ? defaultStride : (LONG)(w * 4);
  const size_t absStride = (size_t)std::labs(stride);
  bool ok = absStride >= (size_t)w * 4 && absStride * h <= curLen;
  if (ok) for (UINT32 y = 0; y < h; ++y) {
    const BYTE* row = stride < 0 ? data + (size_t)(h - 1 - y) * absStride : data + (size_t)y * absStride;  // negative stride = bottom-up
    std::memcpy(&out.bgrx[(size_t)y * w * 4], row, (size_t)w * 4);
  }
  buf->Unlock();
  return ok;
}

bool encodeJpeg(const Frame& f, std::vector<BYTE>& jpeg) {
  ComPtr<IWICImagingFactory> wic;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic)))) return false;
  ComPtr<IWICBitmap> bmp;
  if (FAILED(wic->CreateBitmapFromMemory(f.w, f.h, GUID_WICPixelFormat32bppBGR, f.w * 4, (UINT)f.bgrx.size(), const_cast<BYTE*>(f.bgrx.data()), &bmp))) return false;
  ComPtr<IStream> mem;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &mem))) return false;
  ComPtr<IWICBitmapEncoder> enc;
  if (FAILED(wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc)) || FAILED(enc->Initialize(mem.Get(), WICBitmapEncoderNoCache))) return false;
  ComPtr<IWICBitmapFrameEncode> frame; ComPtr<IPropertyBag2> props;
  if (FAILED(enc->CreateNewFrame(&frame, &props))) return false;
  PROPBAG2 opt = {}; opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
  VARIANT v; VariantInit(&v); v.vt = VT_R4; v.fltVal = 0.92f;
  props->Write(1, &opt, &v);
  WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
  if (FAILED(frame->Initialize(props.Get())) || FAILED(frame->SetSize(f.w, f.h)) || FAILED(frame->SetPixelFormat(&pf)) ||
      FAILED(frame->WriteSource(bmp.Get(), nullptr)) || FAILED(frame->Commit()) || FAILED(enc->Commit())) return false;
  STATSTG st = {};
  if (FAILED(mem->Stat(&st, STATFLAG_NONAME)) || st.cbSize.QuadPart < 4 || st.cbSize.QuadPart > (ULONGLONG)kMaxImageBytes) return false;
  LARGE_INTEGER z = {}; mem->Seek(z, STREAM_SEEK_SET, nullptr);
  jpeg.resize((size_t)st.cbSize.QuadPart);
  ULONG got = 0;
  return SUCCEEDED(mem->Read(jpeg.data(), (ULONG)jpeg.size(), &got)) && got == jpeg.size();
}

// Never overwrites: CREATE_NEW fails if anything exists at `path`.
bool writeNew(const std::wstring& path, const std::vector<BYTE>& bytes) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  size_t off = 0; bool ok = true;
  while (off < bytes.size()) {
    DWORD w = 0;
    if (!WriteFile(h, bytes.data() + off, (DWORD)(bytes.size() - off), &w, nullptr) || w == 0) { ok = false; break; }
    off += w;
  }
  CloseHandle(h);
  if (!ok) DeleteFileW(path.c_str());
  return ok;
}
}  // namespace

WebcamDriver::~WebcamDriver() {
  if (init_) MFShutdown();
  if (comOwned_) CoUninitialize();
}

bool WebcamDriver::ensureInit() {
  if (init_) return true;
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (SUCCEEDED(hr)) comOwned_ = true;
  else if (hr != RPC_E_CHANGED_MODE) return false;
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) return false;
  init_ = true;
  return true;
}

// Enumerates video-capture devices. When `activates` is non-null the matching IMFActivate objects are returned in step with `out`.
bool WebcamDriver::enumerate(std::vector<Found>& out, void* activates) {
  ComPtr<IMFAttributes> attr;
  if (FAILED(MFCreateAttributes(&attr, 1)) || FAILED(attr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID))) return false;
  IMFActivate** devs = nullptr; UINT32 n = 0;
  if (FAILED(MFEnumDeviceSources(attr.Get(), &devs, &n))) return false;
  auto* keep = static_cast<std::vector<ComPtr<IMFActivate>>*>(activates);
  for (UINT32 i = 0; i < n; ++i) {
    WCHAR* name = nullptr; WCHAR* link = nullptr; UINT32 nl = 0, ll = 0;
    devs[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &nl);
    devs[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &link, &ll);
    const std::wstring friendly = name ? name : L"", sl = link ? link : L"";
    if (name) CoTaskMemFree(name);
    if (link) CoTaskMemFree(link);
    Found f;
    f.id = stableCameraId(sl);
    if (!f.id.empty() && !looksInfrared(friendly)) {
      f.model = sanitizeCameraName(friendly);
      f.connection = connectionOf(sl);
      f.placement = looksIntegrated(f.model) ? "integrated" : "";
      f.link = sl;
      out.push_back(f);
      if (keep) keep->push_back(ComPtr<IMFActivate>(devs[i]));  // ComPtr AddRefs; the array's own reference is released below
    }
    devs[i]->Release();
  }
  CoTaskMemFree(devs);
  return true;
}

Failure WebcamDriver::list(std::vector<Device>& out) {
  if (!ensureInit()) return Failure::DRIVER_UNAVAILABLE;
  std::vector<Found> found;
  if (!enumerate(found, nullptr)) return Failure::DRIVER_UNAVAILABLE;
  for (const Found& f : found) out.push_back({f.id, f.model, f.connection, f.placement});
  return Failure::None;
}

Failure WebcamDriver::connect(const std::string& deviceId) {
  if (!ensureInit()) return Failure::DRIVER_UNAVAILABLE;
  std::vector<Found> found;
  if (!enumerate(found, nullptr)) return Failure::DRIVER_UNAVAILABLE;
  for (const Found& f : found) {
    if (f.id == deviceId) {
      connected_ = true; lostReported_ = false; connectedId_ = f.id; connectedLink_ = f.link; lastPoll_ = GetTickCount64();
      return Failure::None;
    }
  }
  return Failure::NO_CAMERA_FOUND;
}

void WebcamDriver::close() { connected_ = false; connectedId_.clear(); connectedLink_.clear(); }

bool WebcamDriver::pollDisconnected() {
  if (!connected_ || lostReported_) return false;
  const ULONGLONG now = GetTickCount64();
  if (now - lastPoll_ < kPollMs) return false;
  lastPoll_ = now;
  std::vector<Found> found;
  if (!enumerate(found, nullptr)) return false;  // an enumeration hiccup is not proof the camera left
  for (const Found& f : found) if (f.id == connectedId_) return false;
  lostReported_ = true;
  return true;
}

Failure WebcamDriver::shoot(const std::wstring& path) {
  if (!connected_ || !ensureInit()) return Failure::PROTOCOL_ERROR;
  ShootLock lock;
  if (!lock.held) return Failure::CAMERA_BUSY;  // another helper process is mid-capture

  const ULONGLONG t0 = GetTickCount64();
  std::vector<Found> found; std::vector<ComPtr<IMFActivate>> acts;
  if (!enumerate(found, &acts)) return Failure::DRIVER_UNAVAILABLE;
  IMFActivate* act = nullptr;
  for (size_t i = 0; i < found.size(); ++i) if (found[i].id == connectedId_) { act = acts[i].Get(); break; }
  if (!act) { connected_ = false; return Failure::DEVICE_LOST; }

  ComPtr<IMFMediaSource> source;
  ComPtr<IMFSourceReader> reader;
  struct Release {
    IMFActivate* a; ComPtr<IMFMediaSource>* s;
    ~Release() { if (*s) (*s)->Shutdown(); a->ShutdownObject(); }
  } guard{act, &source};

  // During bring-up the reader once rejected a freshly activated source (E_INVALIDARG) while an identical second activation
  // worked. Nothing has been captured at this point, so one clean re-activation is safe (no shutter has been released).
  ComPtr<IMFAttributes> ra;
  MFCreateAttributes(&ra, 1);
  ra->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);  // lets the reader convert YUY2 / NV12 / MJPG to RGB32
  HRESULT hr = E_FAIL;
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (source) { source->Shutdown(); source.Reset(); act->ShutdownObject(); }
    hr = act->ActivateObject(IID_PPV_ARGS(&source));
    if (FAILED(hr)) return mapActivate(hr);
    hr = MFCreateSourceReaderFromMediaSource(source.Get(), ra.Get(), &reader);
    if (SUCCEEDED(hr)) break;
  }
  if (FAILED(hr)) return Failure::SHUTTER_FAILED;
  const DWORD stream = (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM;

  // Prefer the camera's largest native mode.
  {
    ComPtr<IMFMediaType> best; UINT64 bestPx = 0;
    for (DWORD i = 0;; ++i) {
      ComPtr<IMFMediaType> t;
      if (FAILED(reader->GetNativeMediaType(stream, i, &t))) break;
      UINT32 w = 0, h = 0;
      if (FAILED(MFGetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, &w, &h)) || !w || !h) continue;
      const UINT64 px = (UINT64)w * h;
      if (px > bestPx && px <= kMaxPixels) { bestPx = px; best = t; }
    }
    if (best) reader->SetCurrentMediaType(stream, nullptr, best.Get());  // best effort: the default mode still works
  }
  ComPtr<IMFMediaType> want;
  if (FAILED(MFCreateMediaType(&want)) || FAILED(want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
      FAILED(want->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32))) return Failure::SHUTTER_FAILED;
  hr = reader->SetCurrentMediaType(stream, nullptr, want.Get());
  if (FAILED(hr)) return Failure::SHUTTER_FAILED;

  UINT32 w = 0, h = 0; LONG stride = 0;
  auto readType = [&]() {
    ComPtr<IMFMediaType> cur;
    if (FAILED(reader->GetCurrentMediaType(stream, &cur)) || FAILED(MFGetAttributeSize(cur.Get(), MF_MT_FRAME_SIZE, &w, &h))) return false;
    UINT32 s = 0; stride = SUCCEEDED(cur->GetUINT32(MF_MT_DEFAULT_STRIDE, &s)) ? (LONG)s : 0;
    return true;
  };
  if (!readType()) return Failure::SHUTTER_FAILED;

  int good = 0;
  for (int reads = 0; reads < 200; ++reads) {
    if (GetTickCount64() - t0 > kShotBudgetMs) return Failure::TIMEOUT;
    DWORD actual = 0, flags = 0; LONGLONG ts = 0; ComPtr<IMFSample> sample;
    hr = reader->ReadSample(stream, 0, &actual, &flags, &ts, &sample);
    if (FAILED(hr)) return mapRead(hr);
    if (flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_ENDOFSTREAM)) return Failure::DEVICE_LOST;
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) { if (!readType()) return Failure::SHUTTER_FAILED; }
    if (!sample) continue;
    ++good;
    const ULONGLONG since = GetTickCount64() - t0;
    const bool settled = (good >= kWarmupMinFrames && since >= kWarmupMinMs) || since >= kWarmupMaxMs;
    if (!settled) continue;
    Frame fr;
    if (!copyFrame(sample.Get(), w, h, stride, fr)) return Failure::TRANSFER_FAILED;
    std::vector<BYTE> jpeg;
    if (!encodeJpeg(fr, jpeg)) return Failure::TRANSFER_FAILED;
    return writeNew(path, jpeg) ? Failure::None : Failure::TRANSFER_FAILED;  // one frame, one file; the shutter is never repeated
  }
  return Failure::TIMEOUT;
}

}  // namespace trivo
