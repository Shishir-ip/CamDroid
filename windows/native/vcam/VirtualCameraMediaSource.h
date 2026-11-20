//
// CamDroid virtual camera media source.
// Adapted from Microsoft Windows-Camera sample (Samples/VirtualCamera/VirtualCameraMediaSource).
//
#pragma once
#ifndef VIRTUALCAMERA_MEDIASOURCE_H
#define VIRTUALCAMERA_MEDIASOURCE_H

#include <initguid.h>

// CamDroid fixed media source CLSID: {7B3E9A21-C4D5-4F6E-8A1B-2C9D0E5F7A3B}
DEFINE_GUID(CLSID_VirtualCameraMediaSource,
    0x7b3e9a21, 0xc4d5, 0x4f6e, 0x8a, 0x1b, 0x2c, 0x9d, 0x0e, 0x5f, 0x7a, 0x3b);

static LPCWSTR VIRTUALCAMERAMEDIASOURCE_CLSID = L"{7B3E9A21-C4D5-4F6E-8A1B-2C9D0E5F7A3B}";
static LPCWSTR VIRTUALCAMERAMEDIASOURCE_FRIENDLYNAME = L"CamDroid";

// --> VirtualCameraMediaSource activation attributes:

// {3C31A5F8-2795-4FB9-A0A1-C733A65C0CE8}
DEFINE_GUID(VCAM_DEVICE_INFO,
    0x3c31a5f8, 0x2795, 0x4fb9, 0xa0, 0xa1, 0xc7, 0x33, 0xa6, 0x5c, 0xc, 0xe8);

// {C7F7C57B-DF30-41D0-AFFC-15201CDF920D}
DEFINE_GUID(VCAM_KIND,
    0xc7f7c57b, 0xdf30, 0x41d0, 0xaf, 0xfc, 0x15, 0x20, 0x1c, 0xdf, 0x92, 0xd);

// <-- VirtualCameraMediaSource activation attributes

// Example Custom Property implemented by SimpleMediaSource (kept from sample for
// KS property compatibility; color mask is not applied to shared-memory frames).
//
// {0CE2EF73-4800-4F53-9B8E-8C06790FC0C7}
static const GUID PROPSETID_SIMPLEMEDIASOURCE_CUSTOMCONTROL =
{ 0xce2ef73, 0x4800, 0x4f53, { 0x9b, 0x8e, 0x8c, 0x6, 0x79, 0xf, 0xc0, 0xc7 } };

enum
{
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORING = 0,
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_END  // all ids must be defined before this.
};

enum
{
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_GRAYSCALE = 0x0FFFFFF,
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_RED = 0x0FF0000,
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_GREEN = 0x000FF00,
    KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_BLUE = 0x00000FF
};

typedef struct {
    uint32_t      ColorMode;
} KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_S, * PKSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_S;

// reproduction of the enum defined in VirtualCameraManager.idl
enum class VirtualCameraKind : int32_t
{
    Synthetic = 0, // Refer to SimpleMediaSource
    BasicCameraWrapper = 1,
    AugmentedCameraWrapper = 2,
};

#endif