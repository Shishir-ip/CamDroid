// In-process smoke test for CamDroidVCam.dll (no registration, no UAC).
#include <initguid.h>
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mferror.h>
#include <cstdio>
#include <cstdint>
#include "../CamDroidFrame.h"

DEFINE_GUID(CLSID_CamDroidVCam,
    0x7b3e9a21, 0xc4d5, 0x4f6e, 0x8a, 0x1b, 0x2c, 0x9d, 0x0e, 0x5f, 0x7a, 0x3b);

static int g_fail = 0;
#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { printf("FAIL %s hr=0x%08X (line %d)\n", #x, (unsigned)hr_, __LINE__); g_fail++; return 1; } } while (0)
#define EXPECT(cond, msg) do { if (!(cond)) { printf("FAIL %s (line %d)\n", msg, __LINE__); g_fail++; } else { printf("ok   %s\n", msg); } } while (0)

typedef HRESULT(__stdcall* PFN_DllGetClassObject)(REFCLSID, REFIID, void**);
typedef int(__cdecl* PFN_IsActive)();

static PFN_DllGetClassObject pGetClassObject = nullptr;
static PFN_IsActive pIsActive = nullptr;

struct Shm {
    HANDLE h = nullptr;
    uint32_t* p = nullptr;
    void Create(uint32_t w, uint32_t h_) {
        SECURITY_DESCRIPTOR sd; InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
        SetSecurityDescriptorDacl(&sd, TRUE, nullptr, FALSE);
        SECURITY_ATTRIBUTES sa = {}; sa.nLength = sizeof(sa); sa.lpSecurityDescriptor = &sd;
        h = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, 16 + 3840 * 2160 * 4, CamDroidFrame::MappingName);
        if (!h) { printf("shm create failed gle=%lu\n", GetLastError()); return; }
        p = (uint32_t*)MapViewOfFile(h, FILE_MAP_WRITE, 0, 0, 0);
        p[0] = 0x31564443; p[1] = w; p[2] = h_; p[3] = 0;
    }
    void Solid(uint32_t w, uint32_t h_, uint8_t r, uint8_t g, uint8_t b, uint32_t frameId) {
        uint8_t* px = (uint8_t*)(p + 4);
        for (uint32_t i = 0; i < w * h_; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
        p[3] = frameId;
    }
    void Gradient(uint32_t w, uint32_t h_, uint32_t frameId) {
        uint8_t* px = (uint8_t*)(p + 4);
        for (uint32_t y = 0; y < h_; y++) {
            uint8_t r = (uint8_t)(255 * y / (h_ - 1)), b = (uint8_t)(255 - 255 * y / (h_ - 1));
            for (uint32_t x = 0; x < w; x++) { px[(y * w + x) * 4] = r; px[(y * w + x) * 4 + 1] = 0; px[(y * w + x) * 4 + 2] = b; px[(y * w + x) * 4 + 3] = 255; }
        }
        p[3] = frameId;
    }
    void Destroy() { if (p) UnmapViewOfFile(p); if (h) CloseHandle(h); p = nullptr; h = nullptr; }
};

// Runs one full source lifecycle. rgb32=false -> NV12. Returns negotiated size via out params.
static int RunCase(const wchar_t* dllPath, bool rgb32, uint32_t expectW, uint32_t expectH,
    int expectY, int expectU, int expectV, bool checkRgbFlip)
{
    IClassFactory* cf = nullptr;
    IMFActivate* act = nullptr;
    IMFMediaSource* src = nullptr;
    IMFPresentationDescriptor* pd = nullptr;
    IMFStreamDescriptor* sd = nullptr;
    IMFMediaTypeHandler* mh = nullptr;
    IMFMediaType* mt = nullptr;
    IMFMediaEvent* ev = nullptr;
    IMFMediaStream* stream = nullptr;
    IMFSample* sample = nullptr;
    IMFMediaBuffer* buf = nullptr;
    IMF2DBuffer2* buf2d = nullptr;

    CHECK(pGetClassObject(CLSID_CamDroidVCam, IID_PPV_ARGS(&cf)));
    CHECK(cf->CreateInstance(nullptr, IID_PPV_ARGS(&act)));
    CHECK(act->ActivateObject(IID_PPV_ARGS(&src)));
    IMFSampleAllocatorControl* allocCtrl = nullptr;
    IMFVideoSampleAllocator* alloc = nullptr;
    CHECK(src->QueryInterface(IID_PPV_ARGS(&allocCtrl)));
    CHECK(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&alloc)));
    CHECK(allocCtrl->SetDefaultAllocator(0, alloc));
    CHECK(src->CreatePresentationDescriptor(&pd));
    BOOL selected = FALSE;
    CHECK(pd->GetStreamDescriptorByIndex(0, &selected, &sd));
    CHECK(sd->GetMediaTypeHandler(&mh));
    DWORD mtCount = 0;
    CHECK(mh->GetMediaTypeCount(&mtCount));
    EXPECT(mtCount == 2, "two media types offered");
    CHECK(mh->GetMediaTypeByIndex(rgb32 ? 1 : 0, &mt));
    GUID sub = {};
    CHECK(mt->GetGUID(MF_MT_SUBTYPE, &sub));
    EXPECT(rgb32 ? sub == MFVideoFormat_RGB32 : sub == MFVideoFormat_NV12, "subtype order NV12 first, RGB32 second");
    UINT32 w = 0, h = 0;
    CHECK(MFGetAttributeSize(mt, MF_MT_FRAME_SIZE, &w, &h));
    printf("     negotiated %ux%u (expected %ux%u)\n", w, h, expectW, expectH);
    EXPECT(w == expectW && h == expectH, "negotiated size matches expectation");
    UINT32 frNum = 0, frDen = 0;
    CHECK(MFGetAttributeRatio(mt, MF_MT_FRAME_RATE, &frNum, &frDen));
    EXPECT(frNum == 30 && frDen == 1, "30fps");
    if (rgb32) CHECK(mh->SetCurrentMediaType(mt));
    CHECK(pd->SelectStream(0));
    PROPVARIANT var; PropVariantInit(&var);
    CHECK(src->Start(pd, nullptr, &var));
    CHECK(src->GetEvent(0, &ev));
    MediaEventType met = MEUnknown;
    CHECK(ev->GetType(&met));
    EXPECT(met == MENewStream, "MENewStream event");
    PROPVARIANT val; PropVariantInit(&val);
    CHECK(ev->GetValue(&val));
    EXPECT(val.vt == VT_UNKNOWN, "stream in event");
    CHECK(val.punkVal->QueryInterface(IID_PPV_ARGS(&stream)));
    CHECK(stream->RequestSample(nullptr));
    IMFMediaEvent* sev = nullptr;
    for (int i = 0; i < 8; i++) {
        CHECK(stream->GetEvent(0, &sev));
        CHECK(sev->GetType(&met));
        HRESULT sevStatus = S_OK; sev->GetStatus(&sevStatus);
        printf("     stream event type=%d status=0x%08X\n", (int)met, (unsigned)sevStatus);
        if (met == MEMediaSample) break;
        sev->Release(); sev = nullptr;
    }
    EXPECT(met == MEMediaSample, "MEMediaSample delivered");
    if (met != MEMediaSample) { CHECK(E_FAIL); }
    PROPVARIANT sval; PropVariantInit(&sval);
    CHECK(sev->GetValue(&sval));
    CHECK(sval.punkVal->QueryInterface(IID_PPV_ARGS(&sample)));
    CHECK(sample->GetBufferByIndex(0, &buf));
    CHECK(buf->QueryInterface(IID_PPV_ARGS(&buf2d)));
    BYTE* pb = nullptr; LONG pitch = 0; BYTE* start = nullptr; DWORD len = 0;
    CHECK(buf2d->Lock2DSize(MF2DBuffer_LockFlags_Read, &pb, &pitch, &start, &len));
    if (!rgb32) {
        printf("     NV12 Y[0]=%d U[0]=%d V[0]=%d (expected %d/%d/%d) pitch=%ld len=%lu\n",
            pb[0], pb[(size_t)h * pitch], pb[(size_t)h * pitch + 1], expectY, expectU, expectV, pitch, len);
        EXPECT(pb[0] == expectY, "NV12 Y value");
        EXPECT(pb[(size_t)h * pitch] == expectU, "NV12 U value");
        EXPECT(pb[(size_t)h * pitch + 1] == expectV, "NV12 V value");
    } else {
        // top image row is red (255,0,0), bottom row blue (0,0,255).
        // bottom-up DIB: memory row 0 must be blue => bytes B=255,G=0,R=0.
        BYTE* row0 = pb;
        BYTE* rowLast = pb + (size_t)(h - 1) * pitch;
        printf("     RGB32 memrow0=[%d,%d,%d] memrowLast=[%d,%d,%d] pitch=%ld\n",
            row0[0], row0[1], row0[2], rowLast[0], rowLast[1], rowLast[2], pitch);
        if (checkRgbFlip) {
            EXPECT(row0[0] == 0 && row0[1] == 0 && row0[2] == 255, "RGB32 bottom-up flip + BGR order (row0 = bottom = red)");
            EXPECT(rowLast[0] == 255 && rowLast[1] == 0 && rowLast[2] == 0, "RGB32 last memory row = top = blue");
        } else {
            EXPECT(row0[0] == 0 && row0[1] == 0 && row0[2] == 0, "RGB32 black frame");
        }
    }
    CHECK(buf2d->Unlock2D());
    CHECK(src->Stop());
    CHECK(src->Shutdown());

    buf2d->Release(); buf->Release(); sample->Release();
    PropVariantClear(&sval); sev->Release();
    stream->Release(); PropVariantClear(&val); ev->Release();
    PropVariantClear(&var);
    mt->Release(); mh->Release(); sd->Release(); pd->Release();
    alloc->Release(); allocCtrl->Release();
    src->Release(); act->Release(); cf->Release();
    return 0;
}

int wmain(int argc, wchar_t** argv)
{
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) { printf("usage: test <dllpath>\n"); return 2; }
    const wchar_t* dllPath = argv[1];

    CHECK(MFStartup(MF_VERSION));
    HMODULE h = LoadLibraryW(dllPath);
    if (!h) { printf("LoadLibrary failed gle=%lu\n", GetLastError()); return 1; }
    pGetClassObject = (PFN_DllGetClassObject)GetProcAddress(h, "DllGetClassObject");
    pIsActive = (PFN_IsActive)GetProcAddress(h, "CdVcamIsActive");
    EXPECT(pGetClassObject != nullptr, "DllGetClassObject resolved");
    EXPECT(pIsActive != nullptr, "CdVcamIsActive resolved");
    EXPECT(pIsActive && pIsActive() == 0, "CdVcamIsActive()==0 before create");
    EXPECT(GetProcAddress(h, "CdVcamCreate") != nullptr, "CdVcamCreate resolved");
    EXPECT(GetProcAddress(h, "CdVcamDestroy") != nullptr, "CdVcamDestroy resolved");
    EXPECT(GetProcAddress(h, "DllRegisterServer") != nullptr, "DllRegisterServer resolved");
    EXPECT(GetProcAddress(h, "DllUnregisterServer") != nullptr, "DllUnregisterServer resolved");
    EXPECT(GetProcAddress(h, "DllCanUnloadNow") != nullptr, "DllCanUnloadNow resolved");

    printf("--- case 1: no shared memory -> 1280x720 black NV12 ---\n");
    RunCase(dllPath, false, 1280, 720, 16, 128, 128, false);

    printf("--- case 2: 640x480 red frame -> NV12 ---\n");
    Shm shm;
    shm.Create(640, 480);
    shm.Solid(640, 480, 255, 0, 0, 1);
    RunCase(dllPath, false, 640, 480, 82, 90, 240, false);

    printf("--- case 3: 640x480 gradient -> RGB32 flip ---\n");
    shm.Gradient(640, 480, 2);
    RunCase(dllPath, true, 640, 480, 0, 0, 0, true);

    printf("--- case 4: odd size 641x481 -> rounded to 640x480, scaled ---\n");
    shm.Solid(641, 481, 255, 0, 0, 3);
    RunCase(dllPath, false, 640, 480, 82, 90, 240, false);

    shm.Destroy();

    typedef int(__stdcall* PFN_CanUnload)();
    PFN_CanUnload canUnload = (PFN_CanUnload)GetProcAddress(h, "DllCanUnloadNow");
    EXPECT(canUnload && canUnload() == 0, "DllCanUnloadNow()==S_OK after release");

    MFShutdown();
    printf(g_fail == 0 ? "ALL PASS\n" : "FAILURES: %d\n", g_fail);
    return g_fail == 0 ? 0 : 1;
}