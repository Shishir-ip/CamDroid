// End-to-end test: create the MF virtual camera, verify it is enumerated by
// Windows, activate it (through the Frame Server) and check that a red frame
// written via CdVcamWriteFrame actually arrives (not black).
#include <initguid.h>
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mferror.h>
#include <mfreadwrite.h>
#include <cstdio>
#include <cstdint>

typedef HRESULT(__cdecl* PFN_Create)(const wchar_t*);
typedef void(__cdecl* PFN_Destroy)();
typedef int(__cdecl* PFN_Write)(const void*, uint32_t, uint32_t);
typedef int(__cdecl* PFN_IsActive)();
typedef void(__cdecl* PFN_CloseFrame)();

#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { printf("FAIL %s hr=0x%08X line %d\n", #x, (unsigned)hr_, __LINE__); return 1; } } while (0)

int wmain(int argc, wchar_t** argv)
{
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) { printf("usage: itest <dllpath>\n"); return 2; }
    HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx hr=0x%08X\n", (unsigned)hrCo);
    CHECK(MFStartup(MF_VERSION));
    HMODULE h = LoadLibraryW(argv[1]);
    if (!h) { printf("LoadLibrary failed gle=%lu\n", GetLastError()); return 1; }
    auto create = (PFN_Create)GetProcAddress(h, "CdVcamCreate");
    auto destroy = (PFN_Destroy)GetProcAddress(h, "CdVcamDestroy");
    auto write = (PFN_Write)GetProcAddress(h, "CdVcamWriteFrame");
    auto isActive = (PFN_IsActive)GetProcAddress(h, "CdVcamIsActive");
    auto closeFrame = (PFN_CloseFrame)GetProcAddress(h, "CdVcamCloseFrame");

    static uint8_t frame[640 * 480 * 4];
    for (int i = 0; i < 640 * 480; i++) { frame[i*4] = 255; frame[i*4+1] = 0; frame[i*4+2] = 0; frame[i*4+3] = 255; }

    // Continuously publish frames (like the Electron render loop) so the media
    // source negotiates the host's actual resolution when a consumer opens it.
    struct WriterCtx { PFN_Write fn; volatile bool* stop; volatile long* ok; };
    static WriterCtx ctx;
    volatile bool stopWriter = false;
    volatile long okWrites = 0;
    ctx.fn = write; ctx.stop = &stopWriter; ctx.ok = &okWrites;
    HANDLE writer = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
        WriterCtx* c = (WriterCtx*)p;
        while (!*c->stop) { if (c->fn(frame, 640, 480)) InterlockedIncrement(c->ok); Sleep(20); }
        return 0;
    }, &ctx, 0, nullptr);

    printf("CdVcamWriteFrame -> %d\n", write(frame, 640, 480));

    HRESULT hr = create(L"CamDroid");
    printf("CdVcamCreate hr=0x%08X isActive=%d\n", (unsigned)hr, isActive());
    if (FAILED(hr)) { MFShutdown(); return 1; }
    Sleep(800); // allow async Start to complete (host frames publish immediately)

    IMFAttributes* attrs = nullptr;
    CHECK(MFCreateAttributes(&attrs, 1));
    CHECK(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
    IMFActivate** devices = nullptr; UINT32 count = 0;
    CHECK(MFEnumDeviceSources(attrs, &devices, &count));
    int idx = -1;
    for (UINT32 i = 0; i < count; i++) {
        WCHAR* name = nullptr; UINT32 len = 0;
        devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
        printf("device[%u]: %ls\n", i, name ? name : L"(null)");
        if (name && wcsstr(name, L"CamDroid") != nullptr) idx = (int)i;
        CoTaskMemFree(name);
    }
    if (idx < 0) { printf("RESULT: CamDroid NOT enumerated\n"); destroy(); MFShutdown(); return 2; }
    printf("RESULT: CamDroid enumerated OK\n");

    IMFMediaSource* src = nullptr;
    hr = devices[idx]->ActivateObject(IID_PPV_ARGS(&src));
    printf("ActivateObject hr=0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) { destroy(); MFShutdown(); return 1; }

    // Consume via IMFSourceReader — the path real apps use through Frame Server.
    IMFSourceReader* reader = nullptr;
    hr = MFCreateSourceReaderFromMediaSource(src, nullptr, &reader);
    printf("CreateSourceReader hr=0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) { destroy(); MFShutdown(); return 1; }
    CHECK(reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE));
    CHECK(reader->SetStreamSelection(0, TRUE));
    IMFMediaType* mt = nullptr;
    CHECK(MFCreateMediaType(&mt));
    CHECK(mt->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    CHECK(mt->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12));
    hr = reader->SetCurrentMediaType(0, nullptr, mt);
    printf("SetCurrentMediaType(NV12) hr=0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) { destroy(); MFShutdown(); return 1; }

    // Diagnostics: what does the shared mapping header actually contain?
    {
        HANDLE hm = OpenFileMappingW(FILE_MAP_READ, FALSE, L"Global\\CamDroidVCamFrame");
        if (hm) {
            uint32_t* hv = (uint32_t*)MapViewOfFile(hm, FILE_MAP_READ, 0, 0, 0);
            if (hv) { printf("DBG header magic=%08X w=%u h=%u frameId=%u okWrites=%ld\n", hv[0], hv[1], hv[2], hv[3], okWrites); UnmapViewOfFile(hv); }
            CloseHandle(hm);
        } else { printf("DBG cannot open mapping gle=%lu okWrites=%ld\n", GetLastError(), okWrites); }
    }

    // Write a fresh red frame, then read a few samples.
    write(frame, 640, 480);
    int Y = -1, U = -1, V = -1; UINT32 w = 0, hh = 0;
    for (int i = 0; i < 30; i++) {
        DWORD flags = 0; IMFSample* sample = nullptr;
        hr = reader->ReadSample(0, 0, nullptr, &flags, nullptr, &sample);
        if (FAILED(hr)) { printf("ReadSample hr=0x%08X\n", (unsigned)hr); break; }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { printf("EOS\n"); if (sample) sample->Release(); break; }
        if (!sample) continue;
        IMFMediaBuffer* buf = nullptr;
        if (SUCCEEDED(sample->GetBufferByIndex(0, &buf))) {
            IMF2DBuffer2* buf2d = nullptr;
            if (SUCCEEDED(buf->QueryInterface(IID_PPV_ARGS(&buf2d)))) {
                BYTE* pb = nullptr; LONG pitch = 0; BYTE* start = nullptr; DWORD len = 0;
                if (SUCCEEDED(buf2d->Lock2DSize(MF2DBuffer_LockFlags_Read, &pb, &pitch, &start, &len))) {
                    IMFMediaType* cur = nullptr;
                    reader->GetCurrentMediaType(0, &cur);
                    MFGetAttributeSize(cur, MF_MT_FRAME_SIZE, &w, &hh);
                    Y = pb[0]; U = pb[(size_t)hh * pitch]; V = pb[(size_t)hh * pitch + 1];
                    buf2d->Unlock2D();
                    cur->Release();
                    buf2d->Release(); buf->Release(); sample->Release();
                    if (Y != 16) break; // got a non-black frame
                    continue;
                }
                buf2d->Release();
            }
            buf->Release();
        }
        sample->Release();
    }
    printf("sample %ux%u NV12 Y=%d U=%d V=%d (red=82/90/240, black=16/128/128)\n", w, hh, Y, U, V);
    bool red = (Y == 82 && U == 90 && V == 240);
    printf(red ? "RESULT: FRAME DATA OK (shared memory visible to consumer)\n"
               : "RESULT: BLACK/NO FRAME (shared memory NOT visible across process boundary)\n");
    printf(w == 640 && hh == 480 ? "RESULT: RESOLUTION FOLLOWS HOST (640x480)\n"
                                 : "RESULT: resolution did NOT follow host (got %ux%u)\n", w, hh);
    stopWriter = true;
    WaitForSingleObject(writer, 1000);
    CloseHandle(writer);
    reader->Release();
    mt->Release();
    src->Shutdown();
    destroy();
    closeFrame();
    MFShutdown();
    return red ? 0 : 3;
}