cmake_minimum_required(VERSION 3.20)
project(trivo_sony_helper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the helper must run on a station with no VC++ redistributable installed.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
if(NOT WIN32)
  message(FATAL_ERROR "trivo-sony-helper targets Windows x64 only")
endif()

add_compile_definitions(UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
add_compile_options(/W4 /WX /GS /guard:cf /permissive- /utf-8)
add_link_options(/DYNAMICBASE /NXCOMPAT /guard:cf)

add_library(helper_core STATIC json.cpp validate.cpp jpeg.cpp engine.cpp host.cpp)

# The Sony SDK adapter is opt-in and requires the licensed SDK installed locally; NOTHING from the SDK is in this repo.
#   cmake -DCRSDK_DIR="C:/path/to/CrSDK_v2.02.00_..._Win64" ...   (and write SonyDriver.cpp — see README.md)
set(CRSDK_DIR "" CACHE PATH "Path of the locally installed Sony Camera Remote SDK (optional)")

add_executable(trivo-sony-helper main.cpp)
target_link_libraries(trivo-sony-helper helper_core)
if(CRSDK_DIR)
  if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/SonyDriver.cpp")
    message(FATAL_ERROR "CRSDK_DIR set but SonyDriver.cpp has not been written yet (see README.md)")
  endif()
  target_sources(trivo-sony-helper PRIVATE SonyDriver.cpp)
  target_compile_definitions(trivo-sony-helper PRIVATE TRIVO_WITH_SONY_SDK)
  target_include_directories(trivo-sony-helper PRIVATE "${CRSDK_DIR}/app/CRSDK")
endif()

# Test-only artefacts (never shipped): the hardware-free unit suite, and the real native process driven by FakeDriver.
add_executable(trivo-sony-helper-fake fake_main.cpp)
target_link_libraries(trivo-sony-helper-fake helper_core)

add_executable(native_tests tests/native_tests.cpp)
target_link_libraries(native_tests helper_core)

enable_testing()
add_test(NAME native_tests COMMAND native_tests)
