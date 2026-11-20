//
// CamDroid exported C API for the Electron host process.
//
// CdVcamCreate  - creates and starts the "CamDroid" virtual camera for the
//                 current user/session via MFCreateVirtualCamera.
// CdVcamDestroy - stops and removes the virtual camera.
// CdVcamIsActive- reports whether the virtual camera is currently created.
//
#include "pch.h"
#include <mfvirtualcamera.h>
#include <thread>

namespace
{
    winrt::slim_mutex g_apiLock;
    // Separate lock for the frame path so publishing frames never blocks on
    // (and is never blocked by) the blocking MFCreateVirtualCamera/Start calls.
    winrt::slim_mutex g_frameLock;
    IMFVirtualCamera* g_pVirtualCamera = nullptr;
    bool g_bMFStarted = false;

    // Shared-memory frame mapping owned by the host (Electron) process.
    HANDLE g_hFrameMap = nullptr;
    BYTE* g_pFrameView = nullptr;
    uint32_t g_frameId = 0;
    std::thread g_startThread;

    // HRESULT MFCreateVirtualCamera(MFVirtualCameraType, MFVirtualCameraLifetime,
    //     MFVirtualCameraAccess, LPCWSTR, LPCWSTR, const GUID*, ULONG, IMFVirtualCamera**)
    // All three enums are int-sized; resolve at runtime for down-level safety.
    typedef HRESULT(WINAPI* PFN_MFCreateVirtualCamera)(
        int type,
        int lifetime,
        int access,
        LPCWSTR friendlyName,
        LPCWSTR sourceId,
        const GUID* categories,
        ULONG categoryCount,
        IMFVirtualCamera** virtualCamera);

    PFN_MFCreateVirtualCamera _ResolveMFCreateVirtualCamera()
    {
        // Preferred: mfplat.dll, fallback mf.dll. On modularized MF builds
        // (e.g. Windows 11 26100.9278+) the export lives in mfsensorgroup.dll.
        const wchar_t* candidates[] = { L"mfplat.dll", L"mf.dll", L"mfsensorgroup.dll" };
        for (const wchar_t* name : candidates)
        {
            HMODULE hMod = GetModuleHandleW(name);
            if (hMod == nullptr)
            {
                hMod = LoadLibraryW(name);
            }
            if (hMod != nullptr)
            {
                auto pfn = reinterpret_cast<PFN_MFCreateVirtualCamera>(
                    GetProcAddress(hMod, "MFCreateVirtualCamera"));
                if (pfn != nullptr)
                {
                    return pfn;
                }
            }
        }
        return nullptr;
    }
}

extern "C" __declspec(dllexport) HRESULT __cdecl CdVcamCreate(const wchar_t* friendlyName)
{
    winrt::slim_lock_guard lock(g_apiLock);

    if (g_pVirtualCamera != nullptr)
    {
        return S_OK; // already created
    }

    if (friendlyName == nullptr || friendlyName[0] == L'\0')
    {
        friendlyName = VIRTUALCAMERAMEDIASOURCE_FRIENDLYNAME;
    }

    HRESULT hr = MFStartup(MF_VERSION);
    if (FAILED(hr))
    {
        return hr;
    }
    g_bMFStarted = true;

    PFN_MFCreateVirtualCamera pfnCreate = _ResolveMFCreateVirtualCamera();
    if (pfnCreate == nullptr)
    {
        MFShutdown();
        g_bMFStarted = false;
        return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    }

    IMFVirtualCamera* pCamera = nullptr;
    hr = pfnCreate(
        0 /*MFVirtualCameraType_SoftwareCameraSource*/,
        0 /*MFVirtualCameraLifetime_Session*/,
        0 /*MFVirtualCameraAccess_CurrentUser*/,
        friendlyName,
        VIRTUALCAMERAMEDIASOURCE_CLSID,
        nullptr /*categories*/,
        0 /*categoryCount*/,
        &pCamera);
    if (FAILED(hr) || pCamera == nullptr)
    {
        MFShutdown();
        g_bMFStarted = false;
        return FAILED(hr) ? hr : E_UNEXPECTED;
    }

    // Start asynchronously: IMFVirtualCamera::Start blocks while the Frame
    // Server initializes the media source and waits for the host's first frame.
    // Running it on a worker thread lets the caller's thread publish frames
    // immediately (in Electron both run on the main thread), so the stream
    // negotiates the host's real resolution instead of timing out to 720p.
    g_pVirtualCamera = pCamera;
    g_startThread = std::thread([pCamera]() {
        HRESULT hrStart = pCamera->Start(nullptr);
        if (FAILED(hrStart))
        {
            CamDroidFrame::DbgLog("IMFVirtualCamera::Start failed hr=0x%08X", (unsigned)hrStart);
            winrt::slim_lock_guard lock(g_apiLock);
            if (g_pVirtualCamera == pCamera)
            {
                pCamera->Remove();
                pCamera->Release();
                g_pVirtualCamera = nullptr;
            }
        }
        else
        {
            CamDroidFrame::DbgLog("IMFVirtualCamera::Start ok");
        }
    });
    return S_OK;
}

extern "C" __declspec(dllexport) void __cdecl CdVcamDestroy()
{
    // Join the async Start worker before taking the API lock (it may take the
    // lock on failure), avoiding a deadlock.
    if (g_startThread.joinable())
    {
        g_startThread.join();
    }

    winrt::slim_lock_guard lock(g_apiLock);

    if (g_pVirtualCamera != nullptr)
    {
        g_pVirtualCamera->Stop();
        g_pVirtualCamera->Remove();
        g_pVirtualCamera->Release();
        g_pVirtualCamera = nullptr;
    }

    if (g_bMFStarted)
    {
        MFShutdown();
        g_bMFStarted = false;
    }
}

extern "C" __declspec(dllexport) int __cdecl CdVcamIsActive()
{
    winrt::slim_lock_guard lock(g_apiLock);
    return g_pVirtualCamera != nullptr ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Frame input. The host calls CdVcamWriteFrame with tightly packed top-down
// RGBA8888 pixels. The mapping is created lazily at the full 4K size so the
// media source can negotiate any resolution up to 3840x2160 without restart.
// Returns 1 on success, 0 on invalid input or mapping failure.
extern "C" __declspec(dllexport) int __cdecl CdVcamWriteFrame(const void* rgba, uint32_t width, uint32_t height)
{
    winrt::slim_lock_guard lock(g_frameLock);

    if (rgba == nullptr || width < 2 || height < 2 ||
        width > CamDroidFrame::MaxWidth || height > CamDroidFrame::MaxHeight)
    {
        return 0;
    }

    if (g_pFrameView == nullptr)
    {
        // The media source (Frame Server service) creates the global mapping;
        // the host only opens it for writing. It exists once the camera is being
        // activated. Until then, frames are dropped and retried next call.
        g_hFrameMap = OpenFileMappingW(FILE_MAP_WRITE, FALSE, CamDroidFrame::MappingName);
        if (g_hFrameMap == nullptr)
        {
            return 0;
        }
        g_pFrameView = reinterpret_cast<BYTE*>(
            MapViewOfFile(g_hFrameMap, FILE_MAP_WRITE, 0, 0, 0));
        if (g_pFrameView == nullptr)
        {
            CloseHandle(g_hFrameMap);
            g_hFrameMap = nullptr;
            return 0;
        }
        g_frameId = 0;
        CamDroidFrame::DbgLog("CdVcamWriteFrame opened global mapping");
    }

    volatile uint32_t* hdr = reinterpret_cast<volatile uint32_t*>(g_pFrameView);
    const size_t pixels = static_cast<size_t>(width) * height * 4;
    memcpy(g_pFrameView + CamDroidFrame::HeaderSize, rgba, pixels);
    hdr[0] = CamDroidFrame::Magic;
    hdr[1] = width;
    hdr[2] = height;
    hdr[3] = ++g_frameId; // publish last: readers see a complete frame
    return 1;
}

extern "C" __declspec(dllexport) void __cdecl CdVcamCloseFrame()
{
    winrt::slim_lock_guard lock(g_frameLock);
    if (g_pFrameView != nullptr)
    {
        // Invalidate the header so consumers fall back to black frames.
        reinterpret_cast<volatile uint32_t*>(g_pFrameView)[0] = 0;
        UnmapViewOfFile(g_pFrameView);
        g_pFrameView = nullptr;
    }
    if (g_hFrameMap != nullptr)
    {
        CloseHandle(g_hFrameMap);
        g_hFrameMap = nullptr;
    }
    g_frameId = 0;
}