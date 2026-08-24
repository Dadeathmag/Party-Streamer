/**
 * @file fileSender — streams one local File to one peer over a DataChannel.
 *
 * Handshake: FILE_OFFER (JSON) → guest prepares its player → FILE_ACCEPT →
 * sequential ArrayBuffer chunks → FILE_COMPLETE. The pump waits for
 * FILE_ACCEPT because the guest's MediaSource setup (`sourceopen`) is async.
 * Chunks are sliced lazily (`file.slice(...).arrayBuffer()`) so a multi-GB
 * file never sits in RAM on the host. Backpressure: pause above
 * HIGH_WATER_MARK queued bytes, resume via the channel's `bufferedamountlow`
 * event at LOW_WATER_MARK.
 *
 * One FileSender per peer channel at a time; `abort()` cancels the loop and
 * tells the guest why (peer left, new video picked, …).
 */

import Peer from './peer.js' // eslint-disable-line no-unused-vars -- JSDoc type
import {
  MSG,
  DELIVERY,
  encodeMessage,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
} from './roomProtocol.js'

const ACCEPT_TIMEOUT_MS = 10000

export default class FileSender {
  /**
   * @param {object} opts
   * @param {Peer} opts.peer            connected peer (channel must be open)
   * @param {File} opts.file            the video file selected by the host
   * @param {string} [opts.delivery]    'progressive' (default) or 'full'
   * @param {(pct: number) => void} [opts.onProgress]
   * @param {(info: { name: string }) => void} [opts.onComplete]
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ peer, file, delivery = DELIVERY.PROGRESSIVE, onProgress, onComplete, onError }) {
    this.peer = peer
    this.file = file
    this.delivery = delivery
    this.onProgress = onProgress
    this.onComplete = onComplete
    this.onError = onError

    this.sentBytes = 0
    this.accepted = false
    this.aborted = false
    this.finished = false

    this._acceptTimer = setTimeout(() => {
      this._fail(new Error('Guest did not accept the transfer'))
    }, ACCEPT_TIMEOUT_MS)
  }

  /** Kick off the handshake. Safe to call once the channel is open. */
  start() {
    if (this.aborted || !this.peer.isOpen) return
    this._sendControl(MSG.FILE_OFFER, {
      name: this.file.name,
      size: this.file.size,
      mimeType: this.file.type || 'video/mp4',
      delivery: this.delivery,
    })
  }

  /**
   * Stop the transfer and notify the guest.
   * @param {string} [reason]
   */
  abort(reason = 'cancelled') {
    if (this.aborted || this.finished) return
    this.aborted = true
    clearTimeout(this._acceptTimer)
    this._sendControl(MSG.FILE_ABORT, { reason })
  }

  /** Route decoded JSON control frames from the owning peer into here. */
  handleControlMessage(msg) {
    if (this.aborted || this.finished) return
    switch (msg.type) {
      case MSG.FILE_ACCEPT:
        clearTimeout(this._acceptTimer)
        if (!this.accepted && !this.aborted) {
          this.accepted = true
          this._pump()
        }
        break
      case MSG.FILE_ABORT:
        // Guest bailed (player error it could not recover from).
        this.aborted = true
        clearTimeout(this._acceptTimer)
        this.onError?.(new Error(msg.reason || 'Guest aborted the transfer'))
        break
    }
  }

  /** The streaming loop: slice → await drain capacity → send → repeat. */
  async _pump() {
    try {
      while (!this.aborted && this.peer.isOpen) {
        const chunkSize = Math.min(this.peer.maxMessageSize, this.file.size - this.sentBytes)

        if (chunkSize <= 0) {
          this.finished = true
          this._sendControl(MSG.FILE_COMPLETE, {})
          this.onComplete?.({ name: this.file.name })
          return
        }

        if (this.peer.channel.bufferedAmount > HIGH_WATER_MARK) {
          await this.peer.waitUntilDrained(LOW_WATER_MARK)
          continue // re-check open/aborted state after waiting
        }

        const buffer = await this.file.slice(this.sentBytes, this.sentBytes + chunkSize).arrayBuffer()
        if (this.aborted || !this.peer.isOpen) return

        this.peer.sendBinary(buffer)
        this.sentBytes += buffer.byteLength
        this.onProgress?.((this.sentBytes / this.file.size) * 100)
      }
      this._fail(new Error('Connection lost during transfer'))
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)))
    }
  }

  _sendControl(type, payload) {
    this.peer.sendText(encodeMessage(type, payload))
  }

  _fail(err) {
    if (this.aborted || this.finished) return
    this.aborted = true
    clearTimeout(this._acceptTimer)
    this._sendControl(MSG.FILE_ABORT, { reason: err.message })
    this.onError?.(err)
  }
}
