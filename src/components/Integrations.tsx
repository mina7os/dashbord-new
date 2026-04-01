import { useState, useEffect, useRef } from 'react';
import { Database, MessageSquare, CheckCircle, RefreshCw, X, WifiOff, Smartphone, Send, Bot, Settings } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../lib/supabase';

interface Props {
  user: any;
  token: string;
  onConnectGoogle: () => void;
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
  role: 'manager' | 'cfo' | 'admin' | 'viewer';
  accessibleSheets: Array<{ user_id: string; email: string; role: string; sheetId: string; url: string }>;
  // Shared persistent states
  googleConnected: boolean;
  sheetUrl: string | null;
  whatsappStatus: 'disconnected' | 'connecting' | 'qr' | 'loading' | 'authenticated' | 'ready' | 'initializing' | 'cleaning';
  whatsappStatusPayload: any;
  qrCode: string | null;
  onConnectWhatsApp: () => void;
  onDisconnectWhatsApp: () => void;
}

export default function Integrations(props: Props) {
  const { 
    user, token, onConnectGoogle, onToast, role, accessibleSheets,
    googleConnected, sheetUrl, whatsappStatus, whatsappStatusPayload, qrCode,
    onConnectWhatsApp, onDisconnectWhatsApp
  } = props;
  const isManager = role === 'manager';

  type ChatMessage = {
    id: string;
    chatId: string;
    body: string;
    fromMe: boolean;
    senderName: string;
    timestamp: string | null;
    hasMedia: boolean;
  };

  const [availableChats, setAvailableChats] = useState<any[]>([]);
  const [monitoredChatIds, setMonitoredChatIds] = useState<string[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [selectedInboxChatId, setSelectedInboxChatId] = useState<string>('');
  const selectedInboxChatIdRef = useRef<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);

  useEffect(() => {
    if (!isManager) return;
    // Sync monitored chats on mount
    const loadMonitored = async () => {
      const { data: chats } = await supabase.from('whatsapp_connected_chats').select('chat_id').eq('user_id', user.id).eq('is_active', true);
      if (chats) setMonitoredChatIds(chats.map((c: any) => c.chat_id));
    };
    loadMonitored();
  }, [isManager, user.id]);

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchChats = async () => {
    setDiscoveryLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/chats?userId=${user.id}`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch chats');
      setAvailableChats(data.chats);
    } catch (err: any) {
      onToast('Failed to load chats: ' + err.message, 'error');
    } finally {
      setDiscoveryLoading(false);
    }
  };

  const activeChatOptions = availableChats.filter(chat => monitoredChatIds.includes(chat.id));

  const handleBackfill = async (lookbackMinutes = 120) => {
    if (monitoredChatIds.length === 0) {
      onToast('Please configure at least one source chat first.', 'error');
      return;
    }
    setBackfillLoading(true);
    onToast(`Processing last ${lookbackMinutes} min from ${monitoredChatIds.length} chat(s)...`, 'info');
    try {
      for (const chatId of monitoredChatIds) {
        const res = await fetch('/api/whatsapp/backfill', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ chatId, lookbackMinutes, userId: user.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Backfill failed');
      }
    } catch (err: any) {
      setBackfillLoading(false);
      onToast('Backfill error: ' + err.message, 'error');
    }
    // Note: backfill_complete socket event is handled in App.tsx typically, 
    // but here we just stop the loading spinner locally for simplicity or expect a re-fetch.
    setBackfillLoading(false);
  };

  const loadMessages = async (chatId: string) => {
    if (!chatId) return;
    setMessagesLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/messages?chatId=${encodeURIComponent(chatId)}&limit=40`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch messages');
      setMessages(data.messages || []);
    } catch (err: any) {
      onToast('Failed to load messages: ' + err.message, 'error');
    } finally {
      setMessagesLoading(false);
    }
  };

  const openInbox = async () => {
    if (availableChats.length === 0) {
      await fetchChats();
    }

    const firstChatId = selectedInboxChatId || monitoredChatIds[0];
    setShowInbox(true);

    if (firstChatId) {
      setSelectedInboxChatId(firstChatId);
      selectedInboxChatIdRef.current = firstChatId;
      await loadMessages(firstChatId);
    }
  };

  const sendMessage = async () => {
    const text = messageDraft.trim();
    if (!selectedInboxChatId || !text) return;

    setSendingMessage(true);
    try {
      const res = await fetch('/api/whatsapp/messages', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ chatId: selectedInboxChatId, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send message');
      setMessages(prev => [...prev, data.message]);
      setMessageDraft('');
      onToast('Message sent to WhatsApp.', 'success');
    } catch (err: any) {
      onToast('Send failed: ' + err.message, 'error');
    } finally {
      setSendingMessage(false);
    }
  };

  const toggleChat = async (chat: any) => {
    const isActive = monitoredChatIds.includes(chat.id);
    const newIds = isActive
      ? monitoredChatIds.filter(id => id !== chat.id)
      : [...monitoredChatIds, chat.id];
    setMonitoredChatIds(newIds);

    if (isActive) {
      await supabase.from('whatsapp_connected_chats')
        .update({ is_active: false }).eq('user_id', user.id).eq('chat_id', chat.id);
    } else {
      await supabase.from('whatsapp_connected_chats').upsert({
        user_id: user.id, chat_id: chat.id,
        chat_name: chat.name, chat_type: chat.isGroup ? 'group' : 'contact', is_active: true,
      }, { onConflict: 'user_id,chat_id' });
    }
  };

  const setupDatabase = async () => {
    setSettingUp(true);
    try {
      const res = await fetch('/api/integrations/setup-database', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ userId: user.id }),
      });
      const result = await res.json();
      if (result.status === 'success') {
        onToast('Google Sheets database initialized!', 'success');
      } else {
        onToast('Setup failed: ' + result.error, 'error');
      }
    } catch (err: any) {
      onToast('An error occurred during setup.', 'error');
    } finally {
      setSettingUp(false);
    }
  };

  const resetIntegration = async () => {
    if (!confirm('Are you sure? This will disconnect Google and reset your message queue for a fresh start.')) return;
    setSettingUp(true);
    try {
      const res = await fetch('/api/integrations/reset', {
        method: 'POST', headers: authHeaders
      });
      const result = await res.json();
      if (res.ok) {
        onToast('Integration reset! Please reconnect Google.', 'success');
        window.location.reload(); // Hard refresh to clear state
      } else {
        throw new Error(result.error || 'Reset failed');
      }
    } catch (err: any) {
      onToast(err.message, 'error');
    } finally {
      setSettingUp(false);
    }
  };

  return (
    <div className="integrations-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

      {/* Google Sheets */}
      <div className="stat-card glass animate-fade-in" style={{ animationDelay: '0.1s' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ padding: '10px', background: 'rgba(52,168,83,0.1)', borderRadius: '12px' }}>
            <Database size={24} color="#34A853" />
          </div>
          <div>
            <h3>Google Sheets Database</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Auto-synced transaction storage</p>
          </div>
        </div>

        {googleConnected ? (
          <div style={{ background: 'rgba(52,168,83,0.05)', border: '1px solid rgba(52,168,83,0.2)', borderRadius: '12px', padding: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#34A853', marginBottom: '0.75rem' }}>
              <CheckCircle size={16} /> <strong>Google Connected</strong>
            </div>
            {sheetUrl && (
              <a href={sheetUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', fontSize: '0.8rem', color: 'var(--accent)', marginBottom: '0.75rem', textDecoration: 'none' }}>
                📊 Open Spreadsheet ↗
              </a>
            )}
            {googleConnected && !sheetUrl && (
              <div style={{ 
                marginTop: '1rem', 
                padding: '0.75rem', 
                background: 'rgba(239,68,68,0.1)', 
                border: '1px solid rgba(239,68,68,0.2)', 
                borderRadius: '8px',
                fontSize: '0.8rem',
                color: '#ef4444'
              }}>
                <strong>⚠️ Permissions Missing:</strong> Your Google account is connected, but we don't have permission to create the spreadsheet.
                <button 
                  onClick={onConnectGoogle} 
                  style={{ 
                    display: 'block', 
                    marginTop: '0.5rem', 
                    background: '#ef4444', 
                    color: 'white', 
                    border: 'none', 
                    padding: '4px 8px', 
                    borderRadius: '4px', 
                    cursor: 'pointer' 
                  }}
                >
                  Reconnect & Check All Boxes
                </button>
              </div>
            )}
            {isManager && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button
                  onClick={setupDatabase} disabled={settingUp}
                  className="badge badge-completed"
                  style={{ flex: 2, padding: '10px', cursor: 'pointer', border: 'none' }}
                >
                  {settingUp ? <><RefreshCw size={12} className="spinner" style={{ display: 'inline', marginRight: '6px' }} />Setting up...</> : 'Reinitialize Database'}
                </button>
                <button
                  onClick={resetIntegration} disabled={settingUp}
                  className="badge badge-pending"
                  style={{ flex: 1, padding: '10px', cursor: 'pointer', border: 'none', background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
                  title="Wipe integration and restart"
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '1rem' }}>
            <p style={{ fontSize: '0.9rem', marginBottom: '1rem', color: 'var(--muted)' }}>
              {isManager ? 'Connect your Google account to create your transaction database.' : 'Google Sheet access is managed by the manager account.'}
            </p>
            {isManager && (
              <button onClick={onConnectGoogle} className="badge badge-pending"
                style={{ padding: '10px 20px', cursor: 'pointer', border: 'none' }}>
                Connect Google Account
              </button>
            )}
          </div>
        )}

        {accessibleSheets.length > 0 && (
          <div style={{ marginTop: '1rem', background: 'var(--surface2)', borderRadius: '12px', padding: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>
              {role === 'manager' || role === 'cfo' ? 'Accessible Sheets' : 'Your Sheet'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {accessibleSheets.map(sheet => (
                <a
                  key={`${sheet.user_id}-${sheet.sheetId}`}
                  href={sheet.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    textDecoration: 'none',
                    color: 'var(--text)',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border)',
                    borderRadius: '10px',
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{sheet.email || sheet.sheetId}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{sheet.role.toUpperCase()}</div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* WhatsApp */}
      <div className="stat-card glass animate-fade-in" style={{ position: 'relative', animationDelay: '0.2s', minHeight: (showInbox || showSelector) ? '600px' : 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ padding: '10px', background: 'rgba(37,211,102,0.1)', borderRadius: '12px' }}>
            <MessageSquare size={24} color="#25D366" />
          </div>
          <div>
            <h3>WhatsApp Ingestion</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Real-time message & media capture</p>
          </div>
        </div>

        {!isManager && (
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            WhatsApp controls are manager-only. Other roles work from dashboard data and their assigned Google Sheets.
          </div>
        )}

        {isManager && whatsappStatus === 'disconnected' && (
          <div className="whatsapp-disconnected z-in">
            <p style={{ color: 'var(--text)', marginBottom: '1.5rem', opacity: 0.8 }}>
              Authorize our system to ingest data from your WhatsApp chats.
            </p>
            <button className="primary-button" onClick={onConnectWhatsApp}>
              <Smartphone size={20} />
              Connect your WhatsApp
            </button>
          </div>
        )}

        {isManager && whatsappStatus === 'ready' && (
          <div className="whatsapp-connected z-in">
            <div className="flex items-center space-x-4 mb-4">
              <div className="status-indicator">
                <span className="dot pulse"></span>
                WhatsApp Connected
              </div>
            </div>
            <p className="text-sm opacity-80 mb-6 max-w-lg" style={{ color: 'var(--text)', margin: '1rem 0' }}>
              We are actively monitoring your WhatsApp connection. Select the specific private chats or groups below that contain incoming receipts and references.
            </p>
            
            <div className="integration-buttons-row">
              <button className="primary-button" style={{ flex: 1 }} onClick={() => { setShowSelector(true); fetchChats(); }}>
                <Settings size={18} />
                Configure Sources
              </button>
              <button
                className="primary-button"
                style={{ flex: 1 }}
                onClick={openInbox}
                disabled={monitoredChatIds.length === 0}
                title={monitoredChatIds.length === 0 ? 'Select at least one active source first' : 'Open inbox for active source chats'}
              >
                <Bot size={18} />
                Agent Inbox
              </button>
              <button
                className="primary-button"
                style={{ flex: 1, background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
                onClick={() => handleBackfill(120)}
                disabled={backfillLoading || monitoredChatIds.length === 0}
                title="Re-process all photos, PDFs, and media from the last 2 hours"
              >
                {backfillLoading ? <RefreshCw size={18} className="spinner" /> : <RefreshCw size={18} />}
                {backfillLoading ? 'Processing...' : '2 Hours'}
              </button>
              <button
                className="primary-button"
                style={{ flex: 1, background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
                onClick={() => handleBackfill(1440)}
                disabled={backfillLoading || monitoredChatIds.length === 0}
                title="Re-process all photos, PDFs, and media from the last 24 hours"
              >
                {backfillLoading ? <RefreshCw size={18} className="spinner" /> : <RefreshCw size={18} />}
                {backfillLoading ? 'Processing...' : '24 Hours'}
              </button>
              <button className="danger-button" onClick={onDisconnectWhatsApp} title="Disconnect WhatsApp">
                <WifiOff size={18} />
                Disconnect
              </button>
            </div>
          </div>
        )}

        {isManager && whatsappStatus === 'qr' && qrCode && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ padding: '0.75rem', background: 'rgba(255,193,7,0.1)', borderRadius: '12px', marginBottom: '1rem', border: '1px solid rgba(255,193,7,0.2)' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--yellow)', margin: 0 }}>
                <strong>How to Scan:</strong><br />
                Open WhatsApp → <strong>Settings</strong> → <strong>Linked Devices</strong> → <strong>Link a Device</strong>
              </p>
            </div>
            <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', display: 'inline-block' }}>
              <QRCodeSVG value={qrCode} size={180} />
            </div>
            <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
              <RefreshCw size={14} className="spinner" /> <strong>Waiting for Scan...</strong>
            </div>
          </div>
        )}

        {isManager && (whatsappStatus === 'connecting' || whatsappStatus === 'initializing' || whatsappStatus === 'loading' || whatsappStatus === 'authenticated' || whatsappStatus === 'cleaning') && (
          <div style={{ textAlign: 'center', padding: '2rem', background: 'rgba(255,255,255,0.05)', borderRadius: '16px', border: '1px solid var(--border)' }}>
            <RefreshCw size={32} className="spinner" color="var(--primary)" />
            <p style={{ marginTop: '1.25rem', fontWeight: 500, color: 'white' }}>
              {whatsappStatus === 'initializing' ? 'Initializing Core Engine...' : 
               whatsappStatus === 'authenticated' ? 'Authentication Accepted' :
               whatsappStatus === 'cleaning' ? 'Cleaning up stale process...' :
               whatsappStatus === 'loading' ? (whatsappStatusPayload?.message || 'Loading WhatsApp Data...') : 
               'Connecting to WhatsApp...'}
            </p>
            {whatsappStatusPayload?.percent > 0 && (
              <div style={{ width: '100%', maxWidth: '200px', margin: '1rem auto', background: 'rgba(255,255,255,0.1)', height: '4px', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${whatsappStatusPayload.percent}%`, background: 'var(--primary)', height: '100%', transition: 'width 0.3s ease' }}></div>
              </div>
            )}
            <p style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
              {whatsappStatusPayload?.reason || 'This can take up to 60 seconds.'}
            </p>
          </div>
        )}

        {/* Chat Selector Modal Overlay */}
        {isManager && showSelector && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'var(--surface)', zIndex: 10, borderRadius: '16px',
            display: 'flex', flexDirection: 'column', padding: '1rem',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h4 style={{ margin: 0 }}>Select Sources</h4>
              <button onClick={() => setShowSelector(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem' }}>
              {discoveryLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem' }}>
                  <RefreshCw size={24} className="spinner" />
                  <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Loading chats...</p>
                </div>
              ) : availableChats.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                  No chats found. Make sure WhatsApp is connected.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {availableChats.map(chat => (
                    <label key={chat.id} style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '8px 12px', background: 'var(--surface2)',
                      borderRadius: '8px', cursor: 'pointer',
                      border: monitoredChatIds.includes(chat.id)
                        ? '1px solid var(--accent)' : '1px solid transparent',
                    }}>
                      <input type="checkbox" checked={monitoredChatIds.includes(chat.id)}
                        onChange={() => toggleChat(chat)} style={{ width: '18px', height: '18px' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{chat.name || 'Unknown'}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                          {chat.isGroup ? 'Group' : 'Direct'} · {chat.id.split('@')[0]}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => { setShowSelector(false); onToast('Chat sources saved.', 'success'); }}
              className="badge badge-completed" style={{ width: '100%', padding: '10px', cursor: 'pointer', border: 'none' }}>
              Save Configuration
            </button>
          </div>
        )}

        {isManager && showInbox && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'var(--surface)', zIndex: 11, borderRadius: '16px',
            display: 'flex', flexDirection: 'column', padding: '1rem',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div>
                <h4 style={{ margin: 0 }}>Agent Inbox</h4>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--muted)' }}>
                  Manage conversations inside active source chats from the dashboard.
                </p>
              </div>
              <button onClick={() => setShowInbox(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>

            {activeChatOptions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
                Select at least one active source in Configure Sources before opening the inbox.
              </div>
            ) : (
              <>
                <select
                  value={selectedInboxChatId}
                  onChange={async (e) => {
                    const nextChatId = e.target.value;
                    setSelectedInboxChatId(nextChatId);
                    selectedInboxChatIdRef.current = nextChatId;
                    await loadMessages(nextChatId);
                  }}
                  style={{
                    marginBottom: '1rem',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: '10px',
                    padding: '10px 12px',
                    color: 'var(--text)',
                  }}
                >
                  {activeChatOptions.map(chat => (
                    <option key={chat.id} value={chat.id}>
                      {chat.name || 'Unknown Chat'}
                    </option>
                  ))}
                </select>

                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: '14px',
                  padding: '0.75rem',
                  marginBottom: '1rem',
                }}>
                  {messagesLoading ? (
                    <div style={{ textAlign: 'center', padding: '2rem' }}>
                      <RefreshCw size={24} className="spinner" />
                      <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Loading conversation...</p>
                    </div>
                  ) : messages.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                      No recent messages in this chat.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {messages.map(message => (
                        <div
                          key={message.id}
                          style={{
                            alignSelf: message.fromMe ? 'flex-end' : 'flex-start',
                            maxWidth: '85%',
                            background: message.fromMe ? 'rgba(37,211,102,0.14)' : 'var(--surface2)',
                            border: `1px solid ${message.fromMe ? 'rgba(37,211,102,0.35)' : 'var(--border)'}`,
                            borderRadius: '14px',
                            padding: '10px 12px',
                          }}
                        >
                          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.35rem' }}>
                            {message.senderName}
                            {message.timestamp ? ` · ${new Date(message.timestamp).toLocaleString()}` : ''}
                          </div>
                          <div style={{ fontSize: '0.85rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{message.body}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <textarea
                    value={messageDraft}
                    onChange={e => setMessageDraft(e.target.value)}
                    placeholder="Send an instruction, ask for clarification, or coordinate extraction handling..."
                    rows={3}
                    style={{
                      flex: 1,
                      resize: 'none',
                      background: 'var(--surface2)',
                      border: '1px solid var(--border)',
                      borderRadius: '12px',
                      padding: '10px 12px',
                      color: 'var(--text)',
                    }}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={sendingMessage || !messageDraft.trim() || !selectedInboxChatId}
                    className="primary-button"
                    style={{ alignSelf: 'flex-end' }}
                  >
                    {sendingMessage ? <RefreshCw size={16} className="spinner" /> : <Send size={16} />}
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
