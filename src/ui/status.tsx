/**
 * SimpliDev Browser Extension - Status Page
 * 
 * Shows connection status for both MCP (Cursor) and Sid Voice.
 * 
 * Copyright (c) Microsoft Corporation (original Playwright MCP code)
 * Copyright (c) SimpliGov (Sid Voice additions)
 *
 * Licensed under the Apache License, Version 2.0
 */

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TabItem } from './tabItem';

import type { TabInfo } from './tabItem';
import { AuthTokenSection } from './authToken';

interface SidVoiceStatus {
  connected: boolean;
  email?: string;
  connectedTabId?: number | null;
}

interface ConnectionStatus {
  isConnected: boolean;
  connectedTabId: number | null;
  connectedTab?: TabInfo;
  sidVoice: SidVoiceStatus;
}

const StatusApp: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>({
    isConnected: false,
    connectedTabId: null,
    sidVoice: { connected: false }
  });
  const [email, setEmail] = useState('');
  const [useStaging, setUseStaging] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadStatus();
    void loadSavedEmail();

    // Listen for Sid Voice status updates
    const listener = (message: { type: string; connected?: boolean; email?: string }) => {
      if (message.type === 'sidVoiceStatusUpdate') {
        setStatus(prev => ({
          ...prev,
          sidVoice: {
            connected: message.connected || false,
            email: message.email
          }
        }));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const loadSavedEmail = async () => {
    const result = await chrome.storage.local.get(['sidVoiceEmail', 'sidVoiceServer']);
    if (result.sidVoiceEmail) {
      setEmail(result.sidVoiceEmail);
    }
    if (result.sidVoiceServer?.includes('stage')) {
      setUseStaging(true);
    }
  };

  const loadStatus = async () => {
    // Get current connection status from background script
    const response = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    const { connectedTabId, sidVoice } = response;
    
    if (connectedTabId) {
      try {
        const tab = await chrome.tabs.get(connectedTabId);
        setStatus({
          isConnected: true,
          connectedTabId,
          connectedTab: {
            id: tab.id!,
            windowId: tab.windowId!,
            title: tab.title!,
            url: tab.url!,
            favIconUrl: tab.favIconUrl
          },
          sidVoice: sidVoice || { connected: false }
        });
      } catch {
        setStatus({
          isConnected: false,
          connectedTabId: null,
          sidVoice: sidVoice || { connected: false }
        });
      }
    } else {
      setStatus({
        isConnected: false,
        connectedTabId: null,
        sidVoice: sidVoice || { connected: false }
      });
    }
  };

  const openConnectedTab = async () => {
    if (!status.connectedTabId)
      return;
    await chrome.tabs.update(status.connectedTabId, { active: true });
    window.close();
  };

  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: 'disconnect' });
    void loadStatus();
  };

  const connectToSidVoice = async () => {
    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'connectToSidVoice',
        email: email.trim(),
        useStaging
      });

      if (!response.success) {
        setError(response.error || 'Failed to connect');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
      void loadStatus();
    }
  };

  const disconnectFromSidVoice = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'disconnectFromSidVoice' });
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
    void loadStatus();
  };

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {/* Header */}
        <div style={{ marginBottom: '24px', textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#1f2328' }}>
            SimpliDev Browser Extension
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#656d76' }}>
            Control your browser with Sid Voice
          </p>
        </div>

        {/* Sid Voice Section */}
        <div className='auth-token-section' style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ 
              width: '10px', 
              height: '10px', 
              borderRadius: '50%', 
              backgroundColor: status.sidVoice.connected ? '#2da44e' : '#cf222e',
              marginRight: '8px'
            }} />
            <strong style={{ fontSize: '14px' }}>Sid Voice</strong>
          </div>

          {status.sidVoice.connected ? (
            <div>
              <div style={{ marginBottom: '12px', fontSize: '13px', color: '#1f2328' }}>
                Connected as <strong>{status.sidVoice.email}</strong>
              </div>
              <p className='auth-token-description'>
                Sid can now control your browser via voice commands. Try saying "Show me SID-262" or "Open Jira".
              </p>
              <Button variant='reject' onClick={disconnectFromSidVoice}>
                Disconnect
              </Button>
            </div>
          ) : (
            <div>
              <p className='auth-token-description'>
                Connect to Sid Voice to enable voice control of your browser. Sid can navigate to Jira tickets, 
                click buttons, fill forms, and more.
              </p>
              
              <div style={{ marginBottom: '12px' }}>
                <input
                  type='email'
                  placeholder='Your SimpliGov email'
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connectToSidVoice()}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '14px',
                    border: '1px solid #d0d7de',
                    borderRadius: '6px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: '13px', cursor: 'pointer' }}>
                  <input
                    type='checkbox'
                    checked={useStaging}
                    onChange={(e) => setUseStaging(e.target.checked)}
                    style={{ marginRight: '8px' }}
                  />
                  Use staging server
                </label>
              </div>

              {error && (
                <div style={{ 
                  padding: '8px 12px', 
                  marginBottom: '12px',
                  backgroundColor: '#ffebe9', 
                  color: '#cf222e',
                  borderRadius: '6px',
                  fontSize: '13px'
                }}>
                  {error}
                </div>
              )}

              <Button 
                variant='primary' 
                onClick={connectToSidVoice}
                disabled={connecting}
              >
                {connecting ? 'Connecting...' : 'Connect to Sid Voice'}
              </Button>
            </div>
          )}
        </div>

        {/* MCP Connection Section */}
        <div style={{ marginBottom: '16px' }}>
          <div className='tab-section-title' style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
            Cursor MCP Connection
          </div>
          
          {status.isConnected && status.connectedTab ? (
            <div>
              <TabItem
                tab={status.connectedTab}
                button={
                  <Button variant='default' onClick={disconnect}>
                    Disconnect
                  </Button>
                }
                onClick={openConnectedTab}
              />
            </div>
          ) : (
            <div className='status-banner'>
              No MCP clients are currently connected.
            </div>
          )}
        </div>

        {/* Auth Token Section (for MCP) */}
        <AuthTokenSection />
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<StatusApp />);
}
