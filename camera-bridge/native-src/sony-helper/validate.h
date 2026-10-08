#pragma once
#include <string>

namespace trivo {

// Pure string rules (no filesystem): see docs/SONY_HELPER_PROTOCOL.md "Out dir".
bool outDirSyntaxOk(const std::wstring& dir);
// Syntax + filesystem: exists, directory, not a reparse point, canonical path == given path, leaf == `leaf`.
// `leaf` is the required final directory name (the bridge-owned temp area): "sony-shots" for the Sony helper, "webcam-shots" for the webcam helper.
bool outDirOk(const std::wstring& dir, const wchar_t* leaf = L"sony-shots");
// Exactly shot-<36 of [0-9a-f-]>.jpg
bool shotFileNameOk(const std::string& name);
bool deviceIdOk(const std::string& s);
bool deviceModelOk(const std::string& s);

}  // namespace trivo
