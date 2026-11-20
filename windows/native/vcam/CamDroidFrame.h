//
// CamDroid shared-memory frame input definitions.
//
// The mapping lives in the GLOBAL namespace so it is visible across sessions:
// the media source runs inside the Frame Server service (session 0,
// LocalService) while the Electron host runs in the user session. A "Local\"
// mapping would be invisible to the service.
//
// Creation requires SeCreateGlobalPrivilege, which service accounts hold but
// standard user processes do not. Therefore the MEDIA SOURCE (service side)
// creates the mapping with a permissive DACL, and the Electron host only
// OPENS it for writing (opening a global mapping needs no privilege).
//
// Layout (little-endian):
//   offset 0 : uint32 magic   = 0x31564443 ("CDV1")
//   offset 4 : uint32 width
//   offset 8 : uint32 height
//   offset 12: uint32 frameId (0 = no frame yet; increments per new frame)
//   offset 16: width*height*4 bytes RGBA8888, top-down, tightly packed rows.
//
#pragma once
#ifndef CAMDROID_FRAME_H
#define CAMDROID_FRAME_H

#include <cstdio>
#include <cstdarg>

namespace CamDroidFrame
{
    constexpr wchar_t MappingName[] = L"Global\\CamDroidVCamFrame";
    constexpr uint32_t Magic = 0x31564443;
    constexpr uint32_t HeaderSize = 16;
    constexpr uint32_t MaxWidth = 3840;
    constexpr uint32_t MaxHeight = 2160;
    constexpr uint32_t DefaultWidth = 1280;
    constexpr uint32_t DefaultHeight = 720;

    struct Header
    {
        uint32_t magic;
        uint32_t width;
        uint32_t height;
        uint32_t frameId;
    };

    // Process-lifetime handle keeping the service-created mapping alive.
    inline HANDLE g_hCreatedMapping = nullptr;

    inline void DbgLog(const char* fmt, ...)
    {
#ifdef CAMDROID_VCAM_DEBUG
        FILE* f = nullptr;
        fopen_s(&f, "C:\\ProgramData\\CamDroid\\vcam-debug.log", "a");
        if (!f) return;
        va_list ap; va_start(ap, fmt);
        fprintf(f, "[pid=%lu t=%lu] ", GetCurrentProcessId(), GetTickCount());
        vfprintf(f, fmt, ap);
        fprintf(f, "\n");
        va_end(ap);
        fclose(f);
#else
        (void)fmt;
#endif
    }

    // Service side: create (or open) the global mapping with a NULL DACL so the
    // user-session host can write into it. Initializes a default header on first
    // creation. Returns the mapping handle (kept in g_hCreatedMapping).
    inline HANDLE EnsureMappingCreated()
    {
        if (g_hCreatedMapping != nullptr)
        {
            return g_hCreatedMapping;
        }
        const uint64_t total = HeaderSize +
            static_cast<uint64_t>(MaxWidth) * MaxHeight * 4;
        SECURITY_DESCRIPTOR sd;
        InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
        SetSecurityDescriptorDacl(&sd, TRUE, nullptr, FALSE); // NULL DACL: everyone full
        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.lpSecurityDescriptor = &sd;
        sa.bInheritHandle = FALSE;
        HANDLE h = CreateFileMappingW(
            INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE,
            static_cast<DWORD>(total >> 32), static_cast<DWORD>(total & 0xFFFFFFFF),
            MappingName);
        const DWORD gle = GetLastError();
        if (h == nullptr)
        {
            DbgLog("EnsureMappingCreated FAILED gle=%lu", gle);
            return nullptr;
        }
        DbgLog("EnsureMappingCreated ok alreadyExists=%d", gle == ERROR_ALREADY_EXISTS);
        if (gle != ERROR_ALREADY_EXISTS)
        {
            BYTE* v = reinterpret_cast<BYTE*>(MapViewOfFile(h, FILE_MAP_WRITE, 0, 0, 0));
            if (v != nullptr)
            {
                volatile uint32_t* hdr = reinterpret_cast<volatile uint32_t*>(v);
                hdr[0] = Magic;
                hdr[1] = DefaultWidth;
                hdr[2] = DefaultHeight;
                hdr[3] = 0;
                UnmapViewOfFile(v);
            }
        }
        g_hCreatedMapping = h;
        return h;
    }

    // Service side: wait until the host publishes its first frame so the stream
    // can negotiate the host's actual resolution. Returns true if a frame arrived.
    inline bool WaitForFirstFrame(HANDLE h, DWORD timeoutMs)
    {
        if (h == nullptr) return false;
        const BYTE* v = reinterpret_cast<const BYTE*>(MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0));
        if (v == nullptr) return false;
        const DWORD start = GetTickCount();
        bool ok = false;
        while (GetTickCount() - start < timeoutMs)
        {
            const volatile uint32_t* hdr = reinterpret_cast<const volatile uint32_t*>(v);
            if (hdr[0] == Magic && hdr[3] > 0) { ok = true; break; }
            Sleep(15);
        }
        UnmapViewOfFile(v);
        DbgLog("WaitForFirstFrame ok=%d", ok);
        return ok;
    }

    // Read-only view of the shared frame mapping.
    struct Mapping
    {
        HANDLE hMap = nullptr;
        const BYTE* pView = nullptr;
        SIZE_T viewSize = 0;

        ~Mapping() { Close(); }

        bool Open()
        {
            Close();
            hMap = OpenFileMappingW(FILE_MAP_READ, FALSE, MappingName);
            if (hMap == nullptr)
            {
                return false;
            }
            pView = reinterpret_cast<const BYTE*>(MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0));
            if (pView == nullptr)
            {
                CloseHandle(hMap);
                hMap = nullptr;
                return false;
            }
            MEMORY_BASIC_INFORMATION mbi = {};
            if (VirtualQuery(pView, &mbi, sizeof(mbi)) != 0)
            {
                viewSize = mbi.RegionSize;
            }
            return true;
        }

        void Close()
        {
            if (pView != nullptr)
            {
                UnmapViewOfFile(pView);
                pView = nullptr;
            }
            if (hMap != nullptr)
            {
                CloseHandle(hMap);
                hMap = nullptr;
            }
            viewSize = 0;
        }

        bool IsOpen() const { return pView != nullptr; }

        // Reads and validates the header. Returns false when the mapping is
        // missing or its contents are not a valid CamDroid frame.
        bool ReadHeader(Header& hdr) const
        {
            if (pView == nullptr || viewSize < HeaderSize)
            {
                return false;
            }
            const volatile uint32_t* p = reinterpret_cast<const volatile uint32_t*>(pView);
            hdr.magic = p[0];
            hdr.width = p[1];
            hdr.height = p[2];
            hdr.frameId = p[3];

            if (hdr.magic != Magic)
            {
                return false;
            }
            if (hdr.width < 2 || hdr.width > MaxWidth || hdr.height < 2 || hdr.height > MaxHeight)
            {
                return false;
            }
            const uint64_t needed = HeaderSize + static_cast<uint64_t>(hdr.width) * hdr.height * 4;
            if (needed > viewSize)
            {
                return false;
            }
            return true;
        }

        const BYTE* Pixels() const { return pView + HeaderSize; }
    };

    // Determine the stream size to negotiate. Uses the current shared-memory
    // frame size when valid, otherwise 1280x720. NV12 requires even dimensions.
    inline void GetNegotiatedSize(uint32_t& width, uint32_t& height)
    {
        width = DefaultWidth;
        height = DefaultHeight;

        Mapping mapping;
        Header hdr = {};
        const bool opened = mapping.Open();
        const bool valid = opened && mapping.ReadHeader(hdr);
        if (valid)
        {
            width = hdr.width;
            height = hdr.height;
        }
        DbgLog("GetNegotiatedSize opened=%d valid=%d hdr=%ux%u frameId=%u -> %ux%u",
            opened, valid, hdr.width, hdr.height, hdr.frameId, width, height);

        width &= ~1u;
        height &= ~1u;
        if (width < 2) width = 2;
        if (height < 2) height = 2;
        if (width > MaxWidth) width = MaxWidth;
        if (height > MaxHeight) height = MaxHeight;
    }
}

#endif