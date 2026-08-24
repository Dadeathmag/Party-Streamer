/**
 * @file fileReceiver — assembles a host-streamed file on the guest side.
 *
 * Handshake counterpart to fileSender.js. Two playback modes, chosen by the
 * delivery flag on FILE_OFFER:
 *   - 'mse'  (delivery 'progressive') — fMP4/WebM: chunks append straight
 *             into a MediaSource attached to the guest's <video>; playback
 *             starts early and memory stays flat (chunks are NOT retained).
 *   - 'blob' (delivery 'full')        — every chunk is retained until
 *             FILE_COMPLETE assembles a Blob → object URL. Nothing plays
 *             until the whole file has arrived.
 *
 * There is deliberately NO fallback between them: the host's "full
 * transfer" streaming mode IS the alternative. If MSE can't ingest the
 * format — up front or mid-stream — a progressive transfer ABORTS with an
 * actionable message pointing at full-transfer mode instead of silently
 * degrading.
 */

import { MSG, DELIVERY } from './roomProtocol.js'
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

  /** @param {{ type: string, name?: string, size?: number, mimeType?: string, delivery?: string, reason?: string }} msg */
  handleControlMessage(msg) {
    switch (msg.type) {
      case MSG.FILE_OFFER: {
        // A new offer supersedes any previous/partial transfer.
        this.reset(false)
        this.offer = {
          name: String(msg.name || 'video'),
          size: Number(msg.size) || 0,
          mimeType: String(msg.mimeType || ''),
          delivery: msg.delivery === DELIVERY.FULL ? DELIVERY.FULL : DELIVERY.PROGRESSIVE,
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
    this.receivedBytes += buffer.byteLength
    if (this.offer.size > 0) {
      this.onProgress?.((this.receivedBytes / this.offer.size) * 100)
    }
    if (this.mode === 'mse') {
      // Progressive: bytes go straight into the SourceBuffer — nothing is
      // retained, so memory stays flat regardless of file size.
      this.mse.append(buffer)
    } else {
      // Full transfer: retain every chunk until FILE_COMPLETE.
      this.chunks.push(buffer)
    }
  }

  /**
   * Decide playback mode, wire the player, then green-light the sender.
   * delivery === 'full' skips MSE entirely: nothing is playable until the
   * whole file has arrived and FILE_COMPLETE assembles the Blob. A
   * progressive offer MSE can't handle aborts instead of degrading.
   */
  async _startPipeline() {
    const { mimeType } = this.offer
    if (this.offer.delivery === DELIVERY.FULL) {
      this.mode = 'blob'
      this.sendControl(MSG.FILE_ACCEPT)
      return
    }
    try {
      this.mse = await createMsePlayer(this.videoEl, mimeType, () => {
        // Mid-stream decode failure — progressive has no fallback.
        if (this.mode === 'mse' && !this.finished) {
          this.mse = null
          this._failProgressive('Playback failed mid-stream')
        }
      })
      this.mode = 'mse'
    } catch {
      this._failProgressive('This browser cannot progressively play that format')
      return
    }
    this.sendControl(MSG.FILE_ACCEPT)
  }

  /**
   * Abort a progressive transfer that MSE cannot carry, tell the host why,
   * and surface an actionable error to the guest UI.
   * @param {string} why short human-readable cause
   */
  _failProgressive(why) {
    const name = this.offer?.name || 'the video'
    const err = new Error(
      `${why} ("${name}") — host can switch streaming to "Full transfer"`,
    )
    this.reset(false)
    this.sendControl(MSG.FILE_ABORT, { reason: why })
    this.onFailed?.(err)
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
