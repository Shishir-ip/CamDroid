//
// CamDroid frame generator implementation (shared-memory input).
//
#include "pch.h"

SimpleFrameGenerator::~SimpleFrameGenerator()
{
    m_mapping.Close();
}

HRESULT SimpleFrameGenerator::Initialize(_In_ IMFMediaType* pMediaType)
{
    RETURN_HR_IF_NULL(E_INVALIDARG, pMediaType);

    RETURN_IF_FAILED(pMediaType->GetGUID(MF_MT_SUBTYPE, &m_subType));
    if (m_subType != MFVideoFormat_RGB32 && m_subType != MFVideoFormat_NV12)
    {
        RETURN_HR_MSG(MF_E_UNSUPPORTED_FORMAT, "Unsupported format: %s", winrt::to_hstring(m_subType).data());
    }
    RETURN_IF_FAILED(MFGetAttributeSize(pMediaType, MF_MT_FRAME_SIZE, &m_width, &m_height));
    RETURN_HR_IF(E_INVALIDARG, m_width < 2 || m_height < 2);

    const size_t cacheBytes = static_cast<size_t>(m_width) * m_height * 4;
    m_rgbaCache = wil::make_unique_cotaskmem_nothrow<BYTE[]>(cacheBytes);
    RETURN_IF_NULL_ALLOC(m_rgbaCache.get());
    ZeroMemory(m_rgbaCache.get(), cacheBytes);
    m_lastFrameId = 0;

    // Lazily open the shared frame mapping at stream start. When the Electron
    // app has not created it yet, CreateFrame retries and delivers black frames.
    m_mapping.Open();

    return S_OK;
}

bool SimpleFrameGenerator::EnsureMapping()
{
    if (m_mapping.IsOpen())
    {
        return true;
    }
    return m_mapping.Open();
}

// Copy the latest shared-memory frame into the RGBA cache, nearest-neighbor
// scaling when the shared-memory size differs from the negotiated size.
void SimpleFrameGenerator::RefreshCache()
{
    CamDroidFrame::Header hdr = {};
    if (!m_mapping.ReadHeader(hdr))
    {
        return;
    }
    if (hdr.frameId == 0 || hdr.frameId == m_lastFrameId)
    {
        return; // no new frame: reuse previous cache content
    }

    const BYTE* src = m_mapping.Pixels();
    BYTE* dst = m_rgbaCache.get();
    const uint32_t srcW = hdr.width;
    const uint32_t srcH = hdr.height;

    if (srcW == m_width && srcH == m_height)
    {
        memcpy(dst, src, static_cast<size_t>(m_width) * m_height * 4);
    }
    else
    {
        for (uint32_t y = 0; y < m_height; y++)
        {
            const uint32_t sy = static_cast<uint32_t>((static_cast<uint64_t>(y) * srcH) / m_height);
            const BYTE* srow = src + static_cast<size_t>(sy) * srcW * 4;
            BYTE* drow = dst + static_cast<size_t>(y) * m_width * 4;
            for (uint32_t x = 0; x < m_width; x++)
            {
                const uint32_t sx = static_cast<uint32_t>((static_cast<uint64_t>(x) * srcW) / m_width);
                const BYTE* sp = srow + static_cast<size_t>(sx) * 4;
                BYTE* dp = drow + static_cast<size_t>(x) * 4;
                dp[0] = sp[0];
                dp[1] = sp[1];
                dp[2] = sp[2];
                dp[3] = sp[3];
            }
        }
    }
    m_lastFrameId = hdr.frameId;
}

HRESULT SimpleFrameGenerator::CreateFrame(
    _Inout_updates_bytes_(len) BYTE* pBuf,
    _In_ DWORD len,
    _In_ LONG pitch,
    _In_ ULONG /*rgbMask*/)
{
    RETURN_HR_IF_NULL(E_INVALIDARG, pBuf);
    RETURN_HR_IF(E_INVALIDARG, pitch == 0);

    if (m_subType == MFVideoFormat_RGB32)
    {
        RETURN_HR_IF(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER), len < static_cast<DWORD>(abs(pitch)) * m_height);
    }
    else if (m_subType == MFVideoFormat_NV12)
    {
        RETURN_HR_IF(HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER), len < static_cast<DWORD>(abs(pitch)) * m_height * 3 / 2);
    }
    else
    {
        return MF_E_UNSUPPORTED_FORMAT;
    }

    if (!EnsureMapping())
    {
        WriteBlackFrame(pBuf, len, pitch);
        return S_OK;
    }

    CamDroidFrame::Header hdr = {};
    if (!m_mapping.ReadHeader(hdr))
    {
        // Mapping present but contents invalid: deliver black, never crash.
        WriteBlackFrame(pBuf, len, pitch);
        return S_OK;
    }

    RefreshCache();

    if (m_subType == MFVideoFormat_RGB32)
    {
        WriteRGB32Frame(pBuf, len, pitch);
    }
    else
    {
        WriteNV12Frame(pBuf, len, pitch);
    }

    return S_OK;
}

void SimpleFrameGenerator::WriteBlackFrame(BYTE* pBuf, DWORD /*len*/, LONG pitch)
{
    const LONG stride = abs(pitch);
    if (m_subType == MFVideoFormat_RGB32)
    {
        for (UINT32 r = 0; r < m_height; r++)
        {
            memset(pBuf + static_cast<size_t>(r) * stride, 0, static_cast<size_t>(m_width) * 4);
        }
    }
    else
    {
        for (UINT32 r = 0; r < m_height; r++)
        {
            memset(pBuf + static_cast<size_t>(r) * stride, 16, m_width);
        }
        for (UINT32 r = 0; r < m_height / 2; r++)
        {
            memset(pBuf + static_cast<size_t>(m_height + r) * stride, 128, m_width);
        }
    }
}

// NV12, top-down. Y plane: height rows; interleaved UV plane: height/2 rows,
// chroma averaged over 2x2 blocks. Row stride = pitch for both planes.
void SimpleFrameGenerator::WriteNV12Frame(BYTE* pBuf, DWORD /*len*/, LONG pitch)
{
    const LONG stride = abs(pitch);
    const BYTE* cache = m_rgbaCache.get();

    for (UINT32 y = 0; y < m_height; y++)
    {
        const BYTE* srow = cache + static_cast<size_t>(y) * m_width * 4;
        BYTE* drow = pBuf + static_cast<size_t>(y) * stride;
        for (UINT32 x = 0; x < m_width; x++)
        {
            const BYTE* p = srow + static_cast<size_t>(x) * 4;
            drow[x] = RgbToY(p[0], p[1], p[2]);
        }
    }

    for (UINT32 y = 0; y < m_height / 2; y++)
    {
        const BYTE* srow0 = cache + static_cast<size_t>(2 * y) * m_width * 4;
        const BYTE* srow1 = srow0 + static_cast<size_t>(m_width) * 4;
        BYTE* drow = pBuf + static_cast<size_t>(m_height + y) * stride;
        for (UINT32 x = 0; x < m_width / 2; x++)
        {
            const BYTE* p00 = srow0 + static_cast<size_t>(2 * x) * 4;
            const BYTE* p01 = p00 + 4;
            const BYTE* p10 = srow1 + static_cast<size_t>(2 * x) * 4;
            const BYTE* p11 = p10 + 4;
            const int r = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
            const int g = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
            const int b = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
            drow[2 * x] = RgbToU(r, g, b);
            drow[2 * x + 1] = RgbToV(r, g, b);
        }
    }
}

// MF RGB32 samples are bottom-up DIB order: memory row 0 is the bottom image
// row, so flip rows when writing. Pixel layout is 0x00RRGGBB (memory B,G,R,X),
// while the shared-memory cache is RGBA, so swap R/B as well. NV12 is top-down.
void SimpleFrameGenerator::WriteRGB32Frame(BYTE* pBuf, DWORD /*len*/, LONG pitch)
{
    const LONG stride = abs(pitch);
    const BYTE* cache = m_rgbaCache.get();

    for (UINT32 r = 0; r < m_height; r++)
    {
        const UINT32 srcRow = m_height - 1 - r;
        const BYTE* srow = cache + static_cast<size_t>(srcRow) * m_width * 4;
        BYTE* drow = pBuf + static_cast<size_t>(r) * stride;
        for (UINT32 x = 0; x < m_width; x++)
        {
            const BYTE* s = srow + static_cast<size_t>(x) * 4;
            BYTE* d = drow + static_cast<size_t>(x) * 4;
            d[0] = s[2]; // B
            d[1] = s[1]; // G
            d[2] = s[0]; // R
            d[3] = 0;    // X
        }
    }
}