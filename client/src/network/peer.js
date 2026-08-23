/**
 * @file peer.js — one RTCPeerConnection toward one room member.
 *
 * The host is always the offerer (fixed roles ⇒ no glare handling needed);
 * guests answer and consume the host's DataChannel. Signaling (offer /
 * answer / ICE) is relayed through the existing Socket.IO `signal:*` events
 * via the injected `sendSignal` callback — this module has no transport of
 * its own.
 *
 * The channel is reliable + ordered (WebRTC defaults), which file transfer
 * depends on: chunks arrive exactly once, in order, so no ack bookkeeping.
 */

import { CHUNK_SIZE } from './roomProtocol.js'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const CHANNEL_LABEL = 'party-stream'

/** Connection states surfaced via onStateChange. */
export const PEER_STATE = {
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
  FAILED: 'failed',
}

/**
 * @param {object} opts
 * @param {string} opts.peerId          remote socket id
 * @param {boolean} opts.isOfferer      true for the host side
 * @param {(kind: 'offer'|'answer'|'ice-candidate', payload: any) => void}
 *        opts.sendSignal               deliver a signal to this peer
 * @param {(data: string|ArrayBuffer) => void} opts.onMessage
 * @param {(state: string) => void} [opts.onStateChange]
 */
export default class Peer {
  constructor({ peerId, isOfferer, sendSignal, onMessage, onStateChange }) {
    this.peerId = peerId
    this.isOfferer = isOfferer
    this.sendSignal = sendSignal
    this.onMessage = onMessage
    this.onStateChange = onStateChange

    /** @type {RTCDataChannel|null} */
    this.channel = null
    /** Largest chunk we may put in a single channel.send(). */
    this.maxMessageSize = CHUNK_SIZE
    this.closedByUs = false
    /** @type {RTCIceCandidateInit[]} queued until remote description lands */
    this.pendingCandidates = []
    /** Resolvers of in-flight waitUntilDrained calls, released on close(). */
    this.drainWaiters = []

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal('ice-candidate', e.candidate.toJSON())
    }
    // Note: pc 'connected' ≠ DataChannel open — the OPEN state is emitted
    // exclusively by the channel's onopen handler below.
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this._emitState(PEER_STATE.FAILED)
    }

    if (isOfferer) {
      this.channel = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true })
      this._wireChannel(this.channel)
      this._negotiate()
    } else {
      this.pc.ondatachannel = (e) => {
        this.channel = e.channel
        this._wireChannel(this.channel)
      }
    }
  }

  /** Host side: create + local-apply the offer, then send it off. */
  async _negotiate() {
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.sendSignal('offer', this.pc.localDescription.toJSON())
    } catch (err) {
      console.warn(`[peer] negotiation with ${this.peerId} failed:`, err)
      this._emitState(PEER_STATE.FAILED)
    }
  }

  _wireChannel(channel) {
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => {
      const max = channel.sctp?.maxMessageSize
      if (typeof max === 'number' && max > 0) {
        this.maxMessageSize = Math.min(CHUNK_SIZE, max)
      }
      this._emitState(PEER_STATE.OPEN)
    }
    channel.onclose = () => this._emitState(PEER_STATE.CLOSED)
    channel.onerror = () => this._emitState(PEER_STATE.FAILED)
    channel.onmessage = (e) => this.onMessage(e.data)
  }

  /**
   * Apply an incoming signaling message from the remote peer.
   * @param {'offer'|'answer'|'ice-candidate'} kind
   * @param {any} payload SDP description or RTCIceCandidateInit
   */
  async handleSignal(kind, payload) {
    try {
      if (kind === 'offer') {
        await this.pc.setRemoteDescription(payload)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.sendSignal('answer', this.pc.localDescription.toJSON())
      } else if (kind === 'answer') {
        if (this.pc.signalingState !== 'have-local-offer') return
        await this.pc.setRemoteDescription(payload)
      } else if (kind === 'ice-candidate') {
        if (!this.pc.remoteDescription) {
          this.pendingCandidates.push(payload)
          return
        }
        await this.pc.addIceCandidate(payload)
      }
      if (this.pc.remoteDescription && this.pendingCandidates.length > 0) {
        const queued = this.pendingCandidates.splice(0)
        for (const c of queued) {
          try {
            await this.pc.addIceCandidate(c)
          } catch {
            /* stale candidate */
          }
        }
      }
    } catch (err) {
      console.warn(`[peer] signal (${kind}) from ${this.peerId} failed:`, err)
    }
  }

  /** True while the DataChannel can carry traffic. */
  get isOpen() {
    return this.channel?.readyState === 'open'
  }

  /** Queue a JSON control message. */
  sendText(str) {
    if (this.isOpen) this.channel.send(str)
  }

  /** Queue one binary chunk. Caller owns backpressure (see waitUntilDrained). */
  sendBinary(buffer) {
    if (this.isOpen) this.channel.send(buffer)
  }

  /**
   * Resolve once the channel's send queue drains below `lowWater` bytes,
   * or immediately if it already is. Must not be called concurrently from
   * multiple senders (one active file sender per channel by design).
   * close() releases any pending waiters so senders never hang forever.
   * @param {number} lowWater
   * @returns {Promise<void>}
   */
  waitUntilDrained(lowWater) {
    return new Promise((resolve) => {
      const channel = this.channel
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this.drainWaiters = this.drainWaiters.filter((w) => w !== done)
        channel.removeEventListener('bufferedamountlow', done)
        resolve()
      }
      this.drainWaiters.push(done)
      // Register BEFORE checking: the event fires when bufferedAmount drops
      // to/below the threshold, so late registration could miss it.
      channel.bufferedAmountLowThreshold = lowWater
      channel.addEventListener('bufferedamountlow', done)
      if (channel.readyState !== 'open' || channel.bufferedAmount <= lowWater) done()
    })
  }

  /** Tear down connection and channel idempotently. */
  close() {
    this.closedByUs = true
    const waiters = this.drainWaiters.splice(0)
    for (const done of waiters) done() // unblock any paused sender loop
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.onopen = null
      this.channel.onclose = null
      this.channel.onerror = null
      try {
        this.channel.close()
      } catch {
        /* already closing */
      }
      this.channel = null
    }
    try {
      this.pc.close()
    } catch {
      /* already closed */
    }
    this._emitState(PEER_STATE.CLOSED)
  }

  _emitState(state) {
    this.onStateChange?.(state)
  }
}
