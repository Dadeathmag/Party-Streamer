/**
 * @file msePlayer — minimal MediaSource wrapper for progressive playback of
 * a file being streamed into a <video> element.
 *
 * Works with fMP4 and WebM byte streams: the MSE spec's segment parsing
 * keeps state across appendBuffer calls, so chunks split at arbitrary byte
 * offsets can be appended sequentially without demuxing. Anything else
 * (.mkv/.avi/moov-at-end MP4s in strict browsers) fails here — callers
 * detect via canStreamWithMse()/onError and fall back to Blob assembly.
 *
 * Failure contract: setup failures reject the returned promise; failures
 * AFTER setup (mid-stream decode/append errors) are reported via onError.
 * The handle owns its object URL; destroy() revokes it.
 */

const SOURCEOPEN_TIMEOUT_MS = 5000

/**
 * True when this browser can ingest `mimeType` through MediaSource.
 * @param {string} mimeType
 */
export function canStreamWithMse(mimeType) {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaSource === 'function' &&
    !!mimeType &&
    MediaSource.isTypeSupported(mimeType)
  )
}

/**
 * Attach a fresh MediaSource to a video element.
 * @param {HTMLVideoElement} video
 * @param {string} mimeType e.g. "video/mp4; codecs=avc1.42E01E,mp4a.40.2"
 * @param {(err: Error) => void} onError fatal failures after successful setup
 * @returns {Promise<{ append: (b: ArrayBuffer) => void, endOfStream: () => void,
 *                     destroy: () => void }>}
 */
export function createMsePlayer(video, mimeType, onError) {
  return new Promise((resolve, reject) => {
    if (!canStreamWithMse(mimeType)) {
      reject(new Error(`MSE cannot play "${mimeType}"`))
      return
    }

    const mediaSource = new MediaSource()
    const url = URL.createObjectURL(mediaSource)

    /** @type {{ append: (b: ArrayBuffer) => void, endOfStream: () => void,
     *          destroy: () => void } | null} */
    let handle = null
    let sourceBuffer = null
    let settled = false
    /** @type {ArrayBuffer[]} waiting to be appended */
    const pending = []

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(openTimer)
      mediaSource.removeEventListener('error', onMsError)
      URL.revokeObjectURL(url)
      if (handle) {
        // Post-setup failure (decode error mid-stream): async notification.
        handle = null
        setTimeout(() => onError(err), 0)
      } else {
        reject(err) // setup failure
      }
    }

    const openTimer = setTimeout(() => {
      fail(new Error('MediaSource never opened'))
    }, SOURCEOPEN_TIMEOUT_MS)

    const onMsError = () => fail(new Error('MediaSource reported a decode error'))
    mediaSource.addEventListener('error', onMsError)

    const tryNext = () => {
      if (!handle || !sourceBuffer || sourceBuffer.updating || pending.length === 0) return
      const next = pending.shift()
      try {
        sourceBuffer.appendBuffer(next)
      } catch {
        fail(new Error('appendBuffer failed'))
      }
    }

    mediaSource.addEventListener('sourceopen', () => {
      clearTimeout(openTimer)
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType)
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
        return
      }
      sourceBuffer.addEventListener('error', onMsError)
      sourceBuffer.addEventListener('updateend', tryNext)
      settled = true
      handle = {
        append(buffer) {
          if (!handle) return
          pending.push(buffer)
          tryNext()
        },
        endOfStream() {
          if (!handle || mediaSource.readyState === 'ended') return
          // Wait out any queued appends before closing the stream.
          const flushWhenIdle = () => {
            if (!handle) return
            if (pending.length > 0 || (sourceBuffer && sourceBuffer.updating)) {
              setTimeout(flushWhenIdle, 25)
              return
            }
            try {
              mediaSource.endOfStream()
            } catch {
              /* already ended */
            }
          }
          flushWhenIdle()
        },
        destroy() {
          if (!handle) return
          handle = null
          mediaSource.removeEventListener('error', onMsError)
          try {
            if (sourceBuffer && mediaSource.readyState === 'open') sourceBuffer.abort()
          } catch {
            /* ignore */
          }
          URL.revokeObjectURL(url)
        },
      }
      resolve(handle)
    })

    video.src = url
  })
}
