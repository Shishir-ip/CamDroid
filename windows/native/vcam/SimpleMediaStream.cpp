//
// Copyright (C) Microsoft Corporation. All rights reserved.
// Adapted for CamDroid:
//  - stream size negotiated from the CamDroid shared-memory frame header
//  - frames read from shared memory (SimpleFrameGenerator)
//  - sample delivery paced at 30fps through an MF serial work queue timer
//

#include "pch.h"

namespace winrt::WindowsSample::implementation
{
    // Timer callback holding a strong reference to the stream so a work item
    // still in flight after Shutdown cannot use a destroyed object. The cycle
    // stream -> async result -> callback -> stream is broken in Shutdown().
    struct FrameTimerCallback : winrt::implements<FrameTimerCallback, IMFAsyncCallback>
    {
        FrameTimerCallback(_In_ SimpleMediaStream* pParent, DWORD dwQueue)
            : m_dwQueue(dwQueue)
        {
            m_parent.copy_from(pParent);
        }

        IFACEMETHODIMP GetParameters(DWORD* pdwFlags, DWORD* pdwQueue) override
        {
            *pdwFlags = 0;
            *pdwQueue = m_dwQueue;
            return S_OK;
        }

        IFACEMETHODIMP Invoke(IMFAsyncResult* pAsyncResult) override
        {
            m_parent->OnFrameTimer(pAsyncResult);
            return S_OK;
        }

    private:
        winrt::com_ptr<SimpleMediaStream> m_parent;
        DWORD m_dwQueue;
    };

    HRESULT SimpleMediaStream::Initialize(
            _In_ SimpleMediaSource* pSource,
            _In_ DWORD dwStreamId,
            _In_ MFSampleAllocatorUsage allocatorUsage
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        wil::com_ptr_nothrow<IMFMediaTypeHandler> spTypeHandler;
        wil::com_ptr_nothrow<IMFAttributes> attrs;

        RETURN_HR_IF_NULL(E_INVALIDARG, pSource);
        m_parent = pSource;

        m_dwStreamId = dwStreamId;
        m_allocatorUsage = allocatorUsage;

        // CamDroid: the service creates the global frame mapping (the host can
        // only open it), then waits briefly for the host's first frame so the
        // stream negotiates the host's actual resolution. Falls back to 720p.
        uint32_t imageWidth = 0, imageHeight = 0;
        HANDLE hFrameMap = CamDroidFrame::EnsureMappingCreated();
        CamDroidFrame::WaitForFirstFrame(hFrameMap, 3000);
        CamDroidFrame::GetNegotiatedSize(imageWidth, imageHeight);
        DEBUG_MSG(L"CamDroid negotiated stream size: %ux%u", imageWidth, imageHeight);

        const uint32_t NUM_MEDIATYPES = 2;
        wil::unique_cotaskmem_array_ptr<wil::com_ptr_nothrow<IMFMediaType>> mediaTypeList = wilEx::make_unique_cotaskmem_array<wil::com_ptr_nothrow<IMFMediaType>>(NUM_MEDIATYPES);

        // Initialize media type and set the video output media type.
        // NV12 is preferred (index 0), RGB32 is the fallback (index 1).
        wil::com_ptr_nothrow<IMFMediaType> spMediaType;
        RETURN_IF_FAILED(MFCreateMediaType(&spMediaType));
        spMediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        spMediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
        spMediaType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        spMediaType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
        MFSetAttributeSize(spMediaType.get(), MF_MT_FRAME_SIZE, imageWidth, imageHeight);
        MFSetAttributeRatio(spMediaType.get(), MF_MT_FRAME_RATE, 30, 1);
        // frame size * pixel bit size * framerate
        uint32_t bitrate = (uint32_t)(imageWidth * 1.5 * imageHeight * 8 * 30);
        spMediaType->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
        MFSetAttributeRatio(spMediaType.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        mediaTypeList[0] = spMediaType.detach();

        RETURN_IF_FAILED(MFCreateMediaType(&spMediaType));
        spMediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        spMediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        spMediaType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        spMediaType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
        MFSetAttributeSize(spMediaType.get(), MF_MT_FRAME_SIZE, imageWidth, imageHeight);
        MFSetAttributeRatio(spMediaType.get(), MF_MT_FRAME_RATE, 30, 1);
        // frame size * pixel bit size * framerate
        bitrate = (uint32_t)(imageWidth * imageHeight * 4 * 8 * 30);
        spMediaType->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
        MFSetAttributeRatio(spMediaType.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        mediaTypeList[1] = spMediaType.detach();

        RETURN_IF_FAILED(MFCreateAttributes(&m_spAttributes, 10));
        RETURN_IF_FAILED(_SetStreamAttributes(m_spAttributes.get()));

        RETURN_IF_FAILED(MFCreateEventQueue(&m_spEventQueue));

        // Initialize stream descriptors
        RETURN_IF_FAILED(MFCreateStreamDescriptor(m_dwStreamId /*StreamId*/, NUM_MEDIATYPES /*MT count*/, mediaTypeList.get(), &m_spStreamDesc));

        RETURN_IF_FAILED(m_spStreamDesc->GetMediaTypeHandler(&spTypeHandler));
        RETURN_IF_FAILED(spTypeHandler->SetCurrentMediaType(mediaTypeList[0]));
        RETURN_IF_FAILED(_SetStreamDescriptorAttributes(m_spStreamDesc.get()));

        return S_OK;
    }

    // IMFMediaEventGenerator
    IFACEMETHODIMP SimpleMediaStream::BeginGetEvent(
            _In_ IMFAsyncCallback* pCallback,
            _In_ IUnknown* punkState
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());
        RETURN_IF_FAILED(m_spEventQueue->BeginGetEvent(pCallback, punkState));

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::EndGetEvent(
            _In_ IMFAsyncResult* pResult,
            _COM_Outptr_ IMFMediaEvent** ppEvent
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());
        RETURN_IF_FAILED(m_spEventQueue->EndGetEvent(pResult, ppEvent));

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::GetEvent(
            _In_ DWORD dwFlags,
            _COM_Outptr_ IMFMediaEvent** ppEvent
        )
    {
        // NOTE:
        // GetEvent can block indefinitely, so we don't hold the lock.
        // This requires some juggling with the event queue pointer.

        wil::com_ptr_nothrow<IMFMediaEventQueue> spQueue;

        {
            winrt::slim_lock_guard lock(m_Lock);

            RETURN_IF_FAILED(_CheckShutdownRequiresLock());
            spQueue = m_spEventQueue;
        }

        // Now get the event.
        RETURN_IF_FAILED(spQueue->GetEvent(dwFlags, ppEvent));

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::QueueEvent(
            _In_ MediaEventType eventType,
            _In_ REFGUID guidExtendedType,
            _In_ HRESULT hrStatus,
            _In_opt_ PROPVARIANT const* pvValue
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());
        RETURN_IF_FAILED(m_spEventQueue->QueueEventParamVar(eventType, guidExtendedType, hrStatus, pvValue));

        return S_OK;
    }

    // IMFMediaStream
    IFACEMETHODIMP SimpleMediaStream::GetMediaSource(
            _COM_Outptr_ IMFMediaSource** ppMediaSource
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_HR_IF_NULL(E_POINTER, ppMediaSource);
        *ppMediaSource = nullptr;

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());
        RETURN_IF_FAILED(m_parent.copy_to(ppMediaSource));

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::GetStreamDescriptor(
            _COM_Outptr_ IMFStreamDescriptor** ppStreamDescriptor
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_HR_IF_NULL(E_POINTER, ppStreamDescriptor);
        *ppStreamDescriptor = nullptr;

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        if (m_spStreamDesc != nullptr)
        {
            RETURN_IF_FAILED(m_spStreamDesc.copy_to(ppStreamDescriptor));
        }
        else
        {
            return E_UNEXPECTED;
        }

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::RequestSample(
            _In_ IUnknown* pToken
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        if (m_streamState != MF_STREAM_STATE_RUNNING)
        {
            RETURN_HR_MSG(MF_E_INVALIDREQUEST, "Stream is not in running state, state:%d, selected: %d", m_streamState, m_bSelected);
        }

        // CamDroid: remember the request token and pace delivery at 30fps on
        // the serial work queue instead of generating the frame synchronously.
        m_spPendingToken = pToken;
        return _ScheduleFrameDelivery();
    }

    //////////////////////////////////////////////////////////////////////////////////////////
    // IMFMediaStream2
    IFACEMETHODIMP SimpleMediaStream::SetStreamState(MF_STREAM_STATE state)
    {
        winrt::slim_lock_guard lock(m_Lock);
        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        if (m_streamState == state)
        {
            return S_OK;
        }

        switch (state)
        {
        case MF_STREAM_STATE_PAUSED:
            if (m_streamState != MF_STREAM_STATE_RUNNING)
            {
                return MF_E_INVALID_STATE_TRANSITION;
            }
            m_streamState = MF_STREAM_STATE_PAUSED;
            break;

        case MF_STREAM_STATE_RUNNING:
            RETURN_IF_FAILED(StartInternal(false, nullptr));
            break;

        case MF_STREAM_STATE_STOPPED:
            RETURN_IF_FAILED(StopInternal(false));

            break;

        default:
            return MF_E_INVALID_STATE_TRANSITION;
            break;
        }

        return S_OK;
    }

    IFACEMETHODIMP SimpleMediaStream::GetStreamState(
            _Out_ MF_STREAM_STATE* pState
        )
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        RETURN_HR_IF_NULL(E_INVALIDARG, pState);
        *pState = m_streamState;

        return S_OK;
    }

    //////////////////////////////////////////////////////////////////////////////////////////
    // Public methods
    HRESULT SimpleMediaStream::Start(_In_ IMFMediaType* pMediaType)
    {
        // Set stream seleted state to true, and update current mediatype.
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_HR_IF_NULL(E_INVALIDARG, pMediaType);
        if (m_spMediaType == nullptr)
        {
            m_spMediaType = pMediaType;
        }
        m_bSelected = true;

        // Change Stream state to running.
        RETURN_IF_FAILED(StartInternal(true, pMediaType));

        return S_OK;
    }

    _Requires_lock_held_(m_Lock)
    HRESULT SimpleMediaStream::Stop(_In_ bool bSendEvent)
    {
        winrt::slim_lock_guard lock(m_Lock);

        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        m_bSelected = false;

        RETURN_IF_FAILED(StopInternal(bSendEvent));
        return S_OK;
    }

    HRESULT SimpleMediaStream::Shutdown()
    {
        winrt::slim_lock_guard lock(m_Lock);

        m_bIsShutdown = true;
        _CancelPendingDelivery();
        m_spFrameTimerResult.reset();
        m_parent.reset();

        if (m_spEventQueue != nullptr)
        {
            m_spEventQueue->Shutdown();
            m_spEventQueue.reset();
        }

        m_spAttributes.reset();
        m_spStreamDesc.reset();
        m_spFrameGenerator.reset();
        m_spSampleAllocator.reset();

        m_streamState = MF_STREAM_STATE_STOPPED;

        return S_OK;
    }

    HRESULT SimpleMediaStream::SetSampleAllocator(IMFVideoSampleAllocator* pAllocator)
    {
        winrt::slim_lock_guard lock(m_Lock);
        RETURN_IF_FAILED(_CheckShutdownRequiresLock());

        if (m_streamState == MF_STREAM_STATE_RUNNING)
        {
            RETURN_HR_MSG(MF_E_INVALIDREQUEST, "Cannot update allocator when the stream is streaming");
        }
        m_spSampleAllocator.reset();
        m_spSampleAllocator = pAllocator;

        return S_OK;
    }

    //////////////////////////////////////////////////////////////////////////////////////////
    // 30fps work-queue pacing

    _Requires_lock_held_(m_Lock)
    HRESULT SimpleMediaStream::_ScheduleFrameDelivery()
    {
        if (m_bDeliveryPending)
        {
            return S_OK; // a delivery is already scheduled; it will use the latest token
        }
        RETURN_HR_IF_NULL(E_UNEXPECTED, m_spFrameTimerResult);

        const LONGLONG now = MFGetSystemTime();
        LONGLONG delay100ns = FrameInterval100ns - (now - m_llLastDeliveryTime);
        const INT64 delayMs = (delay100ns > 0) ? (delay100ns / 10000) : 0;

        RETURN_IF_FAILED(MFScheduleWorkItemEx(m_spFrameTimerResult.get(), delayMs, &m_workKey));
        m_bDeliveryPending = true;
        return S_OK;
    }

    void SimpleMediaStream::OnFrameTimer(_In_ IMFAsyncResult* /*pResult*/)
    {
        winrt::slim_lock_guard lock(m_Lock);

        m_bDeliveryPending = false;

        if (FAILED(_CheckShutdownRequiresLock()) || m_streamState != MF_STREAM_STATE_RUNNING)
        {
            m_spPendingToken.reset();
            return;
        }

        const HRESULT hr = _DeliverFrame();
        if (FAILED(hr))
        {
            DEBUG_MSG(L"CamDroid frame delivery failed hr=0x%08x", hr);
            (void)m_spEventQueue->QueueEventParamVar(MEError, GUID_NULL, hr, nullptr);
        }
    }

    _Requires_lock_held_(m_Lock)
    HRESULT SimpleMediaStream::_DeliverFrame()
    {
        wil::com_ptr_nothrow<IMFSample> sample;
        wil::com_ptr_nothrow<IMFMediaBuffer> outputBuffer;
        LONG pitch = 0;
        BYTE* bufferStart = nullptr; // not used
        DWORD bufferLength = 0;
        BYTE* pbuf = nullptr;
        wil::com_ptr_nothrow<IMF2DBuffer2> buffer2D;

        RETURN_IF_FAILED(m_spSampleAllocator->AllocateSample(&sample));
        RETURN_IF_FAILED(sample->GetBufferByIndex(0, &outputBuffer));
        RETURN_IF_FAILED(outputBuffer->QueryInterface(IID_PPV_ARGS(&buffer2D)));
        RETURN_IF_FAILED(buffer2D->Lock2DSize(MF2DBuffer_LockFlags_Write,
            &pbuf,
            &pitch,
            &bufferStart,
            &bufferLength));

        RETURN_IF_FAILED(m_spFrameGenerator->CreateFrame(pbuf, bufferLength, pitch, m_rgbMask));
        RETURN_IF_FAILED(buffer2D->Unlock2D());

        RETURN_IF_FAILED(sample->SetSampleTime(MFGetSystemTime()));
        RETURN_IF_FAILED(sample->SetSampleDuration(FrameInterval100ns));
        if (m_spPendingToken != nullptr)
        {
            RETURN_IF_FAILED(sample->SetUnknown(MFSampleExtension_Token, m_spPendingToken.get()));
        }
        RETURN_IF_FAILED(m_spEventQueue->QueueEventParamUnk(MEMediaSample,
            GUID_NULL,
            S_OK,
            sample.get()));

        m_llLastDeliveryTime = MFGetSystemTime();
        m_spPendingToken.reset();

        return S_OK;
    }

    _Requires_lock_held_(m_Lock)
    void SimpleMediaStream::_CancelPendingDelivery()
    {
        if (m_bDeliveryPending)
        {
            (void)MFCancelWorkItem(m_workKey);
            m_bDeliveryPending = false;
        }
        m_spPendingToken.reset();
    }

    //////////////////////////////////////////////////////////////////////////////////////////
    // Private methods

    HRESULT SimpleMediaStream::_CheckShutdownRequiresLock()
    {
        if (m_bIsShutdown)
        {
            return MF_E_SHUTDOWN;
        }

        if (m_spEventQueue == nullptr)
        {
            return E_UNEXPECTED;

        }
        return S_OK;
    }

    HRESULT SimpleMediaStream::_SetStreamAttributes(
            _In_ IMFAttributes* pAttributeStore
        )
    {
        RETURN_HR_IF_NULL(E_INVALIDARG, pAttributeStore);

        RETURN_IF_FAILED(pAttributeStore->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_STREAM_ID, m_dwStreamId));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes::MFFrameSourceTypes_Color));

        return S_OK;
    }

    HRESULT SimpleMediaStream::_SetStreamDescriptorAttributes(
            _In_ IMFAttributes* pAttributeStore
        )
    {
        RETURN_HR_IF_NULL(E_INVALIDARG, pAttributeStore);

        RETURN_IF_FAILED(pAttributeStore->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_STREAM_ID, m_dwStreamId));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
        RETURN_IF_FAILED(pAttributeStore->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes::MFFrameSourceTypes_Color));

        return S_OK;
    }

    _Requires_lock_held_(m_Lock)
    HRESULT SimpleMediaStream::StartInternal(bool bSendEvent, IMFMediaType* pNewMediaType)
    {
        BOOL bMatch = FALSE;
        if (m_spMediaType && pNewMediaType)
        {
            (void)m_spMediaType->Compare(pNewMediaType, MF_ATTRIBUTES_MATCH_ALL_ITEMS, &bMatch);

            if (!bMatch)
            {
                // update media type
                m_spMediaType = pNewMediaType;
            }
        }

        if ((m_streamState != MF_STREAM_STATE_RUNNING) || !bMatch)
        {
            // Create the allocator if one doesn't exist
            if (m_allocatorUsage == MFSampleAllocatorUsage_UsesProvidedAllocator)
            {
                RETURN_HR_IF_NULL_MSG(E_POINTER, m_spSampleAllocator, "Sample allocator is not set");
            }
            else
            {
                RETURN_IF_FAILED(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&m_spSampleAllocator)));
            }

            UINT32 width, height;
            GUID subType;
            RETURN_IF_FAILED(m_spMediaType->GetGUID(MF_MT_SUBTYPE, &subType));
            MFGetAttributeSize(m_spMediaType.get(), MF_MT_FRAME_SIZE, &width, &height);

            DEBUG_MSG(L"Initialize sample allocator for mediatype: %s, %dx%d ", winrt::to_hstring(subType).data(), width, height);
            RETURN_IF_FAILED(m_spSampleAllocator->InitializeSampleAllocator(10, m_spMediaType.get()));
            if (m_spFrameGenerator == nullptr)
            {
                m_spFrameGenerator = wil::make_unique_nothrow<SimpleFrameGenerator>();
                RETURN_IF_NULL_ALLOC_MSG(m_spFrameGenerator, "Fail to create SimpleFrameGenerator");
            }
            RETURN_IF_FAILED(m_spFrameGenerator->Initialize(m_spMediaType.get()));
        }

        // CamDroid: set up the serial work queue + timer result used to pace
        // sample delivery at 30fps (created once per stream lifetime).
        if (m_spFrameTimerResult == nullptr)
        {
            if (m_dwWorkQueue == 0)
            {
                RETURN_IF_FAILED(MFAllocateSerialWorkQueue(MFASYNC_CALLBACK_QUEUE_STANDARD, &m_dwWorkQueue));
            }
            auto callback = winrt::make_self<FrameTimerCallback>(this, m_dwWorkQueue);
            RETURN_IF_FAILED(MFCreateAsyncResult(nullptr, callback.get(), nullptr, &m_spFrameTimerResult));
            m_llLastDeliveryTime = 0;
            m_bDeliveryPending = false;
        }

        if (bSendEvent)
        {
            // Post MEStreamStarted event to signal stream has started
            RETURN_IF_FAILED(m_spEventQueue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
        }

        // Set stream state
        m_streamState = MF_STREAM_STATE_RUNNING;

        return S_OK;
    }

    _Requires_lock_held_(m_Lock)
    HRESULT SimpleMediaStream::StopInternal(bool bSendEvent)
    {
        // Set stream state
        m_streamState = MF_STREAM_STATE_STOPPED;

        // Flush any pending paced delivery.
        _CancelPendingDelivery();

        // NOTE: if implementation has sampleRequestQueue or sampleQueue, it must flush the queue on stopped.
        if (bSendEvent)
        {
            // Post MEStreamStopped event to signal stream has stopped
            RETURN_IF_FAILED(m_spEventQueue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
        }

        return S_OK;
    }
}