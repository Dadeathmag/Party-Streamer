import { MessageIcon, XIcon, SendIcon } from './Icons.jsx'

/**
 * @file Live chat sidebar: header, scrolling message list and the input row.
 *
 * Chat is currently local-only (messages never leave the browser); wiring it
 * to Socket.IO later only requires passing messages from useSocket state.
 */

/**
 * @param {object} props
 * @param {boolean} props.collapsed            whether the sidebar is hidden
 * @param {() => void} props.onToggleCollapse
 * @param {Array<{ id: number, user: string, text: string, system?: boolean, isOwn?: boolean }>} props.messages
 * @param {React.RefObject} props.chatEndRef   sentinel scrolled into view on new messages
 * @param {string} props.chatInput
 * @param {(v: string) => void} props.onChatInput
 * @param {() => void} props.onSend
 */
export default function ChatPanel({
  collapsed,
  onToggleCollapse,
  messages,
  chatEndRef,
  chatInput,
  onChatInput,
  onSend,
}) {
  return (
    <aside className={`room__chat ${collapsed ? 'room__chat--collapsed' : ''}`}>
      <button
        className="room__chat-toggle"
        id="btn-toggle-chat"
        onClick={onToggleCollapse}
        title={collapsed ? 'Open chat' : 'Close chat'}
      >
        {collapsed ? <MessageIcon size={18} /> : <XIcon size={18} />}
      </button>

      {!collapsed && (
        <>
          <div className="room__chat-header">
            <h2 className="room__chat-title">Live Chat</h2>
            <span className="room__chat-live-dot" />
          </div>

          <div className="room__chat-messages" id="chat-messages">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`room__chat-msg ${msg.system ? 'room__chat-msg--system' : ''} ${
                  msg.isOwn ? 'room__chat-msg--own' : ''
                }`}
              >
                {!msg.system && <span className="room__chat-user">{msg.user}</span>}
                <span className="room__chat-text">{msg.text}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="room__chat-input-area">
            <input
              className="room__chat-input"
              id="input-chat"
              type="text"
              placeholder="Type a message…"
              value={chatInput}
              onChange={(e) => onChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSend()}
              maxLength={200}
            />
            <button
              className="room__chat-send"
              id="btn-send-chat"
              onClick={onSend}
              disabled={!chatInput.trim()}
              title="Send"
            >
              <SendIcon size={18} />
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
