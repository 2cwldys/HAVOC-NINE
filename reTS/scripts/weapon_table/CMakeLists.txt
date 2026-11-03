cmake_minimum_required(VERSION 3.10)
project(dumptable CXX)
# Prints the weapon table the game builds: links the real dlls/ts_weapon_info.cpp, which has no engine dependencies.
add_executable(dump dump.cpp ${CMAKE_CURRENT_LIST_DIR}/../../dlls/ts_weapon_info.cpp)
target_include_directories(dump PRIVATE ${CMAKE_CURRENT_LIST_DIR}/../../dlls)
