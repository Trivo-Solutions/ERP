// Pure helpers for the webcam driver: nothing here touches Media Foundation or any device. Unit-tested without hardware.
#pragma once
#include <string>

namespace trivo {

// Windows reports a camera's friendly name as arbitrary UTF-16. The protocol only carries [A-Za-z0-9._ -]{1,40}, so anything
// else is replaced by a space, runs of spaces collapse, the result is trimmed and cut to 40; an empty result becomes "Camera".
std::string sanitizeCameraName(const std::wstring& friendly);

// Conservative name heuristic: true only when the name itself says the camera is part of the machine ("Integrated Camera",
// "Built-in", "Internal", "FaceTime"). Never claims a camera is external — an unrecognised name stays unclassified.
bool looksIntegrated(const std::string& sanitizedName);

// Infrared / Windows Hello sensors enumerate as ordinary video-capture devices but produce a monochrome IR image, never a
// usable product photo. They are not offered as cameras.
bool looksInfrared(const std::wstring& friendly);

// Stable camera identity: "cam-" + 24 hex of SHA-256(lowercased device symbolic link). The link is the OS's own per-device
// identity (it survives reboot and enumeration order, and differs for two otherwise identical webcams). Never an array index.
// Returns "" if hashing is unavailable.
std::string stableCameraId(const std::wstring& symbolicLink);

// "usb" if the link is a USB device path, otherwise "local" (virtual / other bus). The helper has no network cameras.
std::string connectionOf(const std::wstring& symbolicLink);

}  // namespace trivo
