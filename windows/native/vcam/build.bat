@echo off
rem ===========================================================================
rem CamDroid virtual camera media source - rebuild script
rem Usage: build.bat [x64^|Win32^|all]   (default: all)
rem Requires VS 2022 Build Tools and Windows SDK 10.0.26100.0.
rem ===========================================================================
setlocal EnableExtensions
set "SRC=%~dp0"
set "VS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
set "VENDOR=%SRC%..\..\vendor\vcam"

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=all"

if /i "%ARCH%"=="all" (
    cmd /c ""%SRC%build.bat" x64" || exit /b 1
    cmd /c ""%SRC%build.bat" Win32" || exit /b 1
    exit /b 0
)

if /i "%ARCH%"=="x64" (
    set "VCVARS=%VS%\VC\Auxiliary\Build\vcvars64.bat"
) else if /i "%ARCH%"=="Win32" (
    set "VCVARS=%VS%\VC\Auxiliary\Build\vcvars32.bat"
) else (
    echo Unknown arch: %ARCH%
    exit /b 1
)

set "OBJDIR=%SRC%obj\%ARCH%"
if not exist "%OBJDIR%" mkdir "%OBJDIR%"

call "%VCVARS%" >nul || exit /b 1

cl /nologo /LD /EHsc /O2 /MT /std:c++17 /Zc:__cplusplus ^
    /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
    /DWINAPI_FAMILY=WINAPI_FAMILY_DESKTOP_APP ^
    /DWINAPI_PARTITION_DESKTOP=1 /DWINAPI_PARTITION_SYSTEM=1 ^
    /DWINAPI_PARTITION_APP=1 /DWINAPI_PARTITION_PC_APP=1 ^
    /I"%SRC%third_party" ^
    /I"%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt" ^
    /Fo"%OBJDIR%\\" ^
    "%SRC%pch.cpp" ^
    "%SRC%dllmain.cpp" ^
    "%SRC%winrtCommon.cpp" ^
    "%SRC%EventHandler.cpp" ^
    "%SRC%SimpleFrameGenerator.cpp" ^
    "%SRC%SimpleMediaSource.cpp" ^
    "%SRC%SimpleMediaStream.cpp" ^
    "%SRC%VirtualCameraMediaSourceActivate.cpp" ^
    "%SRC%CdVcamApi.cpp" ^
    /Fe:"%OBJDIR%\CamDroidVCam.dll" ^
    /link /DEF:"%SRC%CamDroidVCam.def" ^
    ole32.lib oleaut32.lib user32.lib advapi32.lib ^
    mfplat.lib mf.lib mfuuid.lib mfsensorgroup.lib ^
    propsys.lib runtimeobject.lib shlwapi.lib || exit /b 1

if not exist "%VENDOR%\%ARCH%" mkdir "%VENDOR%\%ARCH%"
copy /y "%OBJDIR%\CamDroidVCam.dll" "%VENDOR%\%ARCH%\CamDroidVCam.dll" >nul || exit /b 1
echo Built %VENDOR%\%ARCH%\CamDroidVCam.dll
exit /b 0