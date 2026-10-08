cmake_minimum_required(VERSION 3.20)
project(trivo_webcam_helper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the helper must run on a station with no VC++ redistributable installed.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
if(NOT WIN32)
  message(FATAL_ERROR "trivo-webcam-helper targets Windows x64 only")
endif()

add_compile_definitions(UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
add_compile_options(/W4 /WX /GS /guard:cf /permissive- /utf-8)
add_link_options(/DYNAMICBASE /NXCOMPAT /guard:cf)

# The protocol engine, strict JSON, validators, JPEG verifier and process host are shared with the Sony helper (they are
# camera-agnostic; only the driver behind ICameraDriver differs). This project compiles them unchanged.
set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../sony-helper)
add_library(helper_core STATIC ${CORE}/json.cpp ${CORE}/validate.cpp ${CORE}/jpeg.cpp ${CORE}/engine.cpp ${CORE}/host.cpp)
target_include_directories(helper_core PUBLIC ${CORE})

add_library(webcam_driver STATIC webcam_util.cpp webcam_driver.cpp)
target_include_directories(webcam_driver PUBLIC ${CORE} ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(webcam_driver PUBLIC helper_core mfplat mf mfreadwrite mfuuid windowscodecs ole32 bcrypt)

add_executable(trivo-webcam-helper main.cpp)
target_link_libraries(trivo-webcam-helper webcam_driver)

# Test-only (never shipped).
add_executable(webcam_tests tests/webcam_tests.cpp)
target_link_libraries(webcam_tests webcam_driver)

enable_testing()
add_test(NAME webcam_tests COMMAND webcam_tests)
