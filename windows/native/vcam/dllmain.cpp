//
// Copyright (C) Microsoft Corporation. All rights reserved.
// Adapted for CamDroid: adds DllRegisterServer/DllUnregisterServer so regsvr32
// can register the fixed media source CLSID (the original sample registers the
// virtual camera at runtime through MFCreateVirtualCamera instead).
//
#include "pch.h"
#include "VirtualCameraMediaSourceActivate.h"

HINSTANCE g_hInst = nullptr;

BOOL APIENTRY DllMain(HMODULE hModule,
    DWORD ul_reason_for_call,
    LPVOID lpReserved
)
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        g_hInst = hModule;
        break;
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
        break;
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}

bool __stdcall winrt_can_unload_now() noexcept
{
    if (winrt::get_module_lock())
    {
        return false;
    }

    winrt::clear_factory_cache();
    return true;
}

int32_t __stdcall WINRT_CanUnloadNow() noexcept
{
#ifdef _WRL_MODULE_H_
    if (!::Microsoft::WRL::Module<::Microsoft::WRL::InProc>::GetModule().Terminate())
    {
        return 1;
    }
#endif

    return winrt_can_unload_now() ? 0 : 1;
}

HRESULT __stdcall DllGetClassObject(GUID const& clsid, GUID const& iid, void** result)
{
    try
    {
        *result = nullptr;

        if (clsid == __uuidof(winrt::WindowsSample::implementation::VirtualCameraMediaSourceActivate))
        {
            return winrt::make_self<VirtualCameraMediaSourceActivateFactory>()->QueryInterface(iid, result);
        }

#ifdef _WRL_MODULE_H_
        return ::Microsoft::WRL::Module<::Microsoft::WRL::InProc>::GetModule().GetClassObject(clsid, iid, result);
#else
        return winrt::hresult_class_not_available().to_abi();
#endif
    }
    catch (...)
    {
        return winrt::to_hresult();
    }
}

////////////////////////////////////////////////////////////////////////////////
// regsvr32 support: COM registration of the media source CLSID.
//
// Writes:
//   HKCR\CLSID\{7B3E9A21-C4D5-4F6E-8A1B-2C9D0E5F7A3B}
//       (Default) = "CamDroid"
//   HKCR\CLSID\{7B3E9A21-C4D5-4F6E-8A1B-2C9D0E5F7A3B}\InprocServer32
//       (Default)        = <full DLL path>
//       ThreadingModel   = "Both"
//
// The virtual camera device itself is created at runtime by CdVcamCreate
// (MFCreateVirtualCamera, session lifetime), matching the sample's approach.

static HRESULT _WriteRegString(HKEY hKey, LPCWSTR valueName, LPCWSTR data)
{
    return HRESULT_FROM_WIN32(RegSetValueExW(
        hKey,
        valueName,
        0,
        REG_SZ,
        reinterpret_cast<const BYTE*>(data),
        static_cast<DWORD>((wcslen(data) + 1) * sizeof(WCHAR))));
}

HRESULT STDAPICALLTYPE DllRegisterServer()
{
    WCHAR dllPath[MAX_PATH] = {};
    if (GetModuleFileNameW(g_hInst, dllPath, MAX_PATH) == 0 || dllPath[0] == L'\0')
    {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    WCHAR clsidKey[128] = {};
    RETURN_IF_FAILED(StringCbPrintfW(clsidKey, sizeof(clsidKey), L"CLSID\\%s", VIRTUALCAMERAMEDIASOURCE_CLSID));

    WCHAR inprocKey[160] = {};
    RETURN_IF_FAILED(StringCbPrintfW(inprocKey, sizeof(inprocKey), L"%s\\InprocServer32", clsidKey));

    HKEY hClsid = nullptr;
    LSTATUS status = RegCreateKeyExW(HKEY_CLASSES_ROOT, clsidKey, 0, nullptr,
        REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hClsid, nullptr);
    if (status != ERROR_SUCCESS)
    {
        return HRESULT_FROM_WIN32(status);
    }
    HRESULT hr = _WriteRegString(hClsid, nullptr, VIRTUALCAMERAMEDIASOURCE_FRIENDLYNAME);
    RegCloseKey(hClsid);
    RETURN_IF_FAILED(hr);

    HKEY hInproc = nullptr;
    status = RegCreateKeyExW(HKEY_CLASSES_ROOT, inprocKey, 0, nullptr,
        REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hInproc, nullptr);
    if (status != ERROR_SUCCESS)
    {
        return HRESULT_FROM_WIN32(status);
    }
    hr = _WriteRegString(hInproc, nullptr, dllPath);
    if (SUCCEEDED(hr))
    {
        hr = _WriteRegString(hInproc, L"ThreadingModel", L"Both");
    }
    RegCloseKey(hInproc);
    RETURN_IF_FAILED(hr);

    return S_OK;
}

HRESULT STDAPICALLTYPE DllUnregisterServer()
{
    WCHAR clsidKey[128] = {};
    RETURN_IF_FAILED(StringCbPrintfW(clsidKey, sizeof(clsidKey), L"CLSID\\%s", VIRTUALCAMERAMEDIASOURCE_CLSID));

    WCHAR inprocKey[160] = {};
    RETURN_IF_FAILED(StringCbPrintfW(inprocKey, sizeof(inprocKey), L"%s\\InprocServer32", clsidKey));

    LSTATUS status = RegDeleteTreeW(HKEY_CLASSES_ROOT, inprocKey);
    if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND)
    {
        return HRESULT_FROM_WIN32(status);
    }

    // Remove the CLSID key only when nothing else remains under it.
    status = RegDeleteKeyW(HKEY_CLASSES_ROOT, clsidKey);
    if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND)
    {
        return HRESULT_FROM_WIN32(status);
    }

    return S_OK;
}