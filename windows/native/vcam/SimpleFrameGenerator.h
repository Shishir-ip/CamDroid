//
// CamDroid frame generator: reads RGBA frames from the CamDroid shared-memory
// mapping and converts them to the negotiated MF video format (NV12 / RGB32).
// Replaces the test-pattern generator of the Microsoft sample.
//
#pragma once
#ifndef SIMPLE_FRAME_GENERATOR_H
#define SIMPLE_FRAME_GENERATOR_H

class SimpleFrameGenerator
{
public:
    SimpleFrameGenerator() = default;
    ~SimpleFrameGenerator();

    HRESULT Initialize(_In_ IMFMediaType* pMediaType);

    HRESULT CreateFrame(
        _Inout_updates_bytes_(len) BYTE* pBuf,
        _In_ DWORD len,
        _In_ LONG pitch,
        _In_ ULONG rgbMask);

private:
    bool EnsureMapping();
    void RefreshCache();
    void WriteBlackFrame(BYTE* pBuf, DWORD len, LONG pitch);
    void WriteNV12Frame(BYTE* pBuf, DWORD len, LONG pitch);
    void WriteRGB32Frame(BYTE* pBuf, DWORD len, LONG pitch);

    static BYTE ClampByte(int v)
    {
        return static_cast<BYTE>(v < 0 ? 0 : (v > 255 ? 255 : v));
    }

    // BT.601 limited range, integer approximation of:
    // Y = 16 + 0.257R + 0.504G + 0.098B
    // U = 128 - 0.148R - 0.291G + 0.439B
    // V = 128 + 0.439R - 0.368G - 0.071B
    static BYTE RgbToY(int r, int g, int b)
    {
        return ClampByte(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
    }
    static BYTE RgbToU(int r, int g, int b)
    {
        return ClampByte(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
    }
    static BYTE RgbToV(int r, int g, int b)
    {
        return ClampByte(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }

    UINT32 m_width = 0;
    UINT32 m_height = 0;
    GUID m_subType = GUID_NULL;

    CamDroidFrame::Mapping m_mapping;
    uint32_t m_lastFrameId = 0;

    // Latest frame converted/scaled to the negotiated size, RGBA top-down.
    // Zero-initialized => black until the first valid frame arrives.
    wil::unique_cotaskmem_ptr<BYTE[]> m_rgbaCache;
};

#endif