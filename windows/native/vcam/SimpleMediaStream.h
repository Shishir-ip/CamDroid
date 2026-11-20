//
// Copyright (C) Microsoft Corporation. All rights reserved.
// Adapted for CamDroid: dynamic stream size from shared memory and
// 30fps work-queue timer pacing of sample delivery.
//

#ifndef SIMPLEMEDIASTREAM_H
#define SIMPLEMEDIASTREAM_H

#include "SimpleMediaSource.h"
#include "VirtualCameraMediaSource.h"

namespace winrt::WindowsSample::implementation
{
    struct SimpleMediaStream : winrt::implements<SimpleMediaStream, IMFMediaStream2>
    {
        friend struct SimpleMediaSource;

    public:
        // IMFMediaEventGenerator
        IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* pCallback, IUnknown* punkState) override;
        IFACEMETHODIMP EndGetEvent(IMFAsyncResult* pResult, IMFMediaEvent** ppEvent) override;
        IFACEMETHODIMP GetEvent(DWORD dwFlags, IMFMediaEvent** ppEvent) override;
        IFACEMETHODIMP QueueEvent(MediaEventType met, REFGUID guidExtendedType, HRESULT hrStatus, const PROPVARIANT* pvValue) override;

        // IMFMediaStream
        IFACEMETHODIMP GetMediaSource(IMFMediaSource** ppMediaSource) override;
        IFACEMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** ppStreamDescriptor) override;
        IFACEMETHODIMP RequestSample(IUnknown* pToken) override;

        // IMFMediaStream2
        IFACEMETHODIMP SetStreamState(_In_ MF_STREAM_STATE state) override;
        IFACEMETHODIMP GetStreamState(_Out_ MF_STREAM_STATE* pState) override;

        // Non-interface methods.
        HRESULT Initialize(_In_ SimpleMediaSource* pSource, _In_ DWORD streamId, _In_ MFSampleAllocatorUsage allocatorUsage);
        HRESULT Start(_In_ IMFMediaType* pMediaType);
        HRESULT Stop(_In_ bool fSendEvent);
        HRESULT Shutdown();
        HRESULT SetSampleAllocator(_In_ IMFVideoSampleAllocator* pAllocator);

        // Work-queue timer callback: delivers one paced frame (30fps).
        void OnFrameTimer(_In_ IMFAsyncResult* pResult);

        DWORD Id() const { return m_dwStreamId; }
        MFSampleAllocatorUsage SampleAlloactorUsage() const { return m_allocatorUsage; }

        void SetRGBMask(uint32_t rgbMask) { winrt::slim_lock_guard lock(m_Lock);  m_rgbMask = rgbMask; }
        uint32_t GetRGBMask() { winrt::slim_lock_guard lock(m_Lock);  return m_rgbMask; }

    private:
        _Requires_lock_held_(m_Lock) HRESULT _CheckShutdownRequiresLock();
        _Requires_lock_held_(m_Lock) HRESULT _SetStreamAttributes(IMFAttributes* pAttributeStore);
        _Requires_lock_held_(m_Lock) HRESULT _SetStreamDescriptorAttributes(IMFAttributes* pAttributeStore);

        _Requires_lock_held_(m_Lock) HRESULT StartInternal(bool bSendEvent, IMFMediaType* pNewMediaType);
        _Requires_lock_held_(m_Lock) HRESULT StopInternal(bool bSendEvent);
        _Requires_lock_held_(m_Lock) HRESULT _ScheduleFrameDelivery();
        _Requires_lock_held_(m_Lock) HRESULT _DeliverFrame();
        _Requires_lock_held_(m_Lock) void _CancelPendingDelivery();

        winrt::slim_mutex  m_Lock;

        wil::com_ptr_nothrow<IMFMediaSource> m_parent;
        wil::com_ptr_nothrow<IMFMediaEventQueue> m_spEventQueue;
        wil::com_ptr_nothrow<IMFAttributes> m_spAttributes;
        wil::com_ptr_nothrow<IMFStreamDescriptor> m_spStreamDesc;
        wil::com_ptr_nothrow<IMFVideoSampleAllocator> m_spSampleAllocator;
        wistd::unique_ptr<SimpleFrameGenerator> m_spFrameGenerator;
        wil::com_ptr_nothrow<IMFMediaType> m_spMediaType;

        bool m_bIsShutdown = false;
        bool m_bSelected = false;
        MF_STREAM_STATE m_streamState = MF_STREAM_STATE_STOPPED;
        uint32_t m_rgbMask = KSPROPERTY_SIMPLEMEDIASOURCE_CUSTOMCONTROL_COLORMODE_BLUE;

        DWORD m_dwStreamId = 0;
        MFSampleAllocatorUsage m_allocatorUsage;

        // 30fps pacing: RequestSample stores the token and schedules a work
        // item on a serial MF work queue, delayed so deliveries are >=33ms apart.
        static constexpr LONGLONG FrameInterval100ns = 333333; // ~30fps
        DWORD m_dwWorkQueue = 0;
        wil::com_ptr_nothrow<IMFAsyncResult> m_spFrameTimerResult;
        wil::com_ptr_nothrow<IUnknown> m_spPendingToken;
        bool m_bDeliveryPending = false;
        MFWORKITEM_KEY m_workKey = 0;
        LONGLONG m_llLastDeliveryTime = 0;
    };
}

#endif