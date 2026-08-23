/**
 * @file fileReceiver — assembles a host-streamed file on the guest side.
 *
 * Handshake counterpart to fileSender.js. Two playback modes:
 *   - 'mse'  — fMP4/WebM: chunks append progressively into a MediaSource
 *              attached to the guest's <video>; playback starts early.
 *   - 'blob' — anything MSE rejects (or errors on mid-stream): chunks are
 *              retained and assembled into a Blob on FILE_COMPLETE.
 *
 * Chunks are ALWAYS retained until completion so a mid-stream MSE failure
 * degrades transparently into the blob path with zero data loss.
 */

import { MSG } from './roomProtocol.js'
import { createMsePlayer } from '../lib/msePlayer.js'

export default class FileReceiver {
  /**
   * @param {object} opts
   * @param {(type: string, payload?: object) => void} opts.sendControl
   *        reply channel toward the host peer (FILE_ACCEPT / FILE_ABORT)
   * @param {(info: { name: string }) => void} [opts.onStarted]
   * @param {(pct: number) => void} [opts.onProgress]
   * @param {(info: { url: string | null, name: string }) => void} [opts.onComplete]
   *        url is null in MSE mode — the player is already wired to <video>
   * @param {(err: Error) => void} [opts.onFailed]
   */
  constructor({ sendControl, onStarted, onProgress, onComplete, onFailed }) {
    this.sendControl = sendControl
    this.onStarted = onStarted
    this.onProgress = onProgress
    this.onComplete = onComplete
    this.onFailed = onFailed

    /** @type {HTMLVideoElement|null} */
    this.videoEl = null
    /** @type {{ name: string, size: number, mimeType: string } | null} */
    this.offer = null
    /** @type {'mse'|'blob'|null} */
    this.mode = null
    /** @type {Awaited<ReturnType<typeof createMsePlayer>>|null} */
    this.mse = null
    /** @type {ArrayBuffer[]} */
    this.chunks = []
    this.receivedBytes = 0
    this.finished = false
    /** Last object URL we handed out, revoked on reset/destroy. */
    this.blobUrl = null
    /** OFFER that arrived before the video element was registered. */
    this.pendingOffer = false
  }

  /**
   * Give the receiver the guest's <video> element. Must be called before
   * transfers can start; flushes any offer queued while waiting.
   * @param {HTMLVideoElement|null} el
   */
  attachVideo(el) {
    this.videoEl = el
    if (el && this.pendingOffer && this.offer && !this.mode) {
      this.pendingOffer = false
      this._startPipeline()
    }
  }

  /** @param {{ type: string, name?: string, size?: number, mimeType?: string, reason?: string }} msg */
  handleControlMessage(msg) {
    switch (msg.type) {
      case MSG.FILE_OFFER: {
        // A new offer supersedes any previous/partial transfer.
        this.reset(false)
        this.offer = {
          name: String(msg.name || 'video'),
          size: Number(msg.size) || 0,
          mimeType: String(msg.mimeType || ''),
        }
        this.onStarted?.({ name: this.offer.name })
        if (!this.videoEl) {
          this.pendingOffer = true
          return
        }
        this._startPipeline()
        break
      }
      case MSG.FILE_COMPLETE:
        this._finalize()
        break
      case MSG.FILE_ABORT:
        this.reset(false)
        this.onFailed?.(new Error(msg.reason || 'Host cancelled the transfer'))
        break
    }
  }

  /** @param {ArrayBuffer} buffer one sequential chunk of the file */
  handleBinary(buffer) {
    if (!this.offer || this.finished || this.mode === null) return
    this.chunks.push(buffer)
    this.receivedBytes += buffer.byteLength
    if (this.offer.size > 0) {
      this.onProgress?.((this.receivedBytes / this.offer.size) * 100)
    }
    if (this.mode === 'mse' && this.mse) {
      this.mse.append(buffer)
    }
  }

  /** Decide playback mode, wire the player, then green-light the sender. */
  async _startPipeline() {
    const { mimeType } = this.offer
    try {
      this.mse = await createMsePlayer(this.videoEl, mimeType, () => {
        // Mid-stream decode failure → degrade to blob mode, keep counting.
        this.mse = null
        if (this.mode === 'mse' && !this.finished) {
          this.mode = 'blob'
          this._detachMediaSource()
        }
      })
      this.mode = 'mse'
    } catch {
      this.mode = 'blob'
    }
    this.sendControl(MSG.FILE_ACCEPT)
  }

  _detachMediaSource() {
    const el = this.videoEl
    if (!el) return
    el.removeAttribute('src')
    try {
      el.load()
    } catch {
      /* ignore */
    }
  }

  _finalize() {
    if (this.finished || !this.offer) return
    this.finished = true

    if (this.mode === 'mse' && this.mse) {
      this.mse.endOfStream()
      // Whole file lives in the SourceBuffer now — free the raw chunks.
      this.chunks = []
      this.onComplete?.({ url: null, name: this.offer.name })
      return
    }

    const type = this.offer.mimeType.startsWith('video/') ? this.offer.mimeType : 'video/mp4'
    const blob = new Blob(this.chunks, { type })
    this.chunks = []
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
    this.blobUrl = URL.createObjectURL(blob)
    this.onComplete?.({ url: this.blobUrl, name: this.offer.name })
  }

  /**
   * Drop all transfer state.
   * @param {boolean} notifyHost when true (guest-initiated bail), tell the host.
   */
  reset(notifyHost = false) {
    if (notifyHost && this.offer && !this.finished) {
      this.sendControl(MSG.FILE_ABORT, { reason: 'Guest discarded the partial transfer' })
    }
    if (this.mse) {
      this.mse.destroy()
      this.mse = null
      this._detachMediaSource()
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl)
      this.blobUrl = null
    }
    this.offer = null
    this.mode = null
    this.chunks = []
    this.receivedBytes = 0
    this.finished = false
    this.pendingOffer = false
  }

  destroy() {
    this.reset(false)
    this.videoEl = null
  }
}
