/**
 * SimpliDev Browser Extension
 * 
 * Forked from Playwright MCP Bridge.
 * Adds SignalR connection for Sid Voice remote browser control.
 * 
 * Copyright (c) Microsoft Corporation (original Playwright MCP code)
 * Copyright (c) SimpliGov (SignalR additions)
 *
 * Licensed under the Apache License, Version 2.0
 */

import { RelayConnection, debugLog } from './relayConnection';
import { SidVoiceConnection } from './sidVoiceConnection';

type PageMessage = {
  type: 'connectToMCPRelay';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  tabId?: number;
  windowId?: number;
  mcpRelayUrl: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
} | {
  // Sid Voice specific messages
  type: 'connectToSidVoice';
  email: string;
  useStaging?: boolean;
} | {
  type: 'disconnectFromSidVoice';
} | {
  type: 'getSidVoiceStatus';
};

class TabShareExtension {
  // Original Playwright MCP connection
  private _activeConnection: RelayConnection | undefined;
  private _connectedTabId: number | null = null;
  private _pendingTabSelection = new Map<number, { connection: RelayConnection, timerId?: number }>();

  // Sid Voice connection
  private _sidVoiceConnection: SidVoiceConnection;

  constructor() {
    // Initialize Sid Voice connection
    this._sidVoiceConnection = new SidVoiceConnection();
    this._sidVoiceConnection.onStatusChange = (connected, email) => {
      debugLog(`Sid Voice status: ${connected ? 'connected' : 'disconnected'}${email ? ` as ${email}` : ''}`);
      // Notify any open status pages
      chrome.runtime.sendMessage({ 
        type: 'sidVoiceStatusUpdate', 
        connected, 
        email 
      }).catch(() => {});
    };
    this._sidVoiceConnection.onError = (error) => {
      debugLog('Sid Voice error:', error);
    };

    // Auto-connect if we have saved credentials
    this._autoConnectSidVoice();

    // Set up listeners
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
  }

  private async _autoConnectSidVoice(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['sidVoiceEmail', 'sidVoiceServer', 'sidVoiceAutoConnect']);
      if (result.sidVoiceEmail && result.sidVoiceAutoConnect !== false) {
        debugLog('Auto-connecting to Sid Voice...');
        await this._sidVoiceConnection.connect(
          result.sidVoiceEmail,
          result.sidVoiceServer?.includes('stage')
        );
      }
    } catch (error) {
      debugLog('Auto-connect failed:', error);
    }
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) {
    switch (message.type) {
      // =========================================
      // Original Playwright MCP messages
      // =========================================
      case 'connectToMCPRelay':
        this._connectToRelay(sender.tab!.id!, message.mcpRelayUrl).then(
            () => sendResponse({ success: true }),
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab':
        const tabId = message.tabId || sender.tab?.id!;
        const windowId = message.windowId || sender.tab?.windowId!;
        this._connectTab(sender.tab!.id!, tabId, windowId, message.mcpRelayUrl!).then(
            () => sendResponse({ success: true }),
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getConnectionStatus':
        sendResponse({
          connectedTabId: this._connectedTabId,
          // Include Sid Voice status
          sidVoice: {
            connected: this._sidVoiceConnection.isConnected,
            email: this._sidVoiceConnection.email,
            connectedTabId: this._sidVoiceConnection.connectedTabId,
          }
        });
        return false;
      case 'disconnect':
        this._disconnect().then(
            () => sendResponse({ success: true }),
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;

      // =========================================
      // Sid Voice specific messages
      // =========================================
      case 'connectToSidVoice':
        this._sidVoiceConnection.connect(message.email, message.useStaging).then(
            () => {
              // Save auto-connect preference
              chrome.storage.local.set({ sidVoiceAutoConnect: true });
              sendResponse({ success: true });
            },
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'disconnectFromSidVoice':
        chrome.storage.local.set({ sidVoiceAutoConnect: false });
        this._sidVoiceConnection.disconnect().then(
            () => sendResponse({ success: true }),
            (error: Error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getSidVoiceStatus':
        sendResponse({
          connected: this._sidVoiceConnection.isConnected,
          email: this._sidVoiceConnection.email,
          connectedTabId: this._sidVoiceConnection.connectedTabId,
        });
        return false;
    }
    return false;
  }

  // =========================================
  // Original Playwright MCP methods
  // =========================================

  private async _connectToRelay(selectorTabId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog('Connection closed');
        this._pendingTabSelection.delete(selectorTabId);
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      debugLog(`Connected to MCP relay`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`Failed to connect to MCP relay: ${message}`);
      throw new Error(`Failed to connect to MCP relay: ${message}`);
    }
  }

  private async _connectTab(selectorTabId: number, tabId: number, windowId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);
      try {
        this._activeConnection?.close('Another connection is requested');
      } catch (error) {
        debugLog(`Error closing active connection:`, error);
      }
      await this._setConnectedTabId(null);

      this._activeConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
      if (!this._activeConnection)
        throw new Error('No active MCP relay connection');
      this._pendingTabSelection.delete(selectorTabId);

      this._activeConnection.setTabId(tabId);
      this._activeConnection.onclose = () => {
        debugLog('MCP connection closed');
        this._activeConnection = undefined;
        void this._setConnectedTabId(null);
      };

      await Promise.all([
        this._setConnectedTabId(tabId),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true }),
      ]);
      debugLog(`Connected to MCP bridge`);
    } catch (error) {
      await this._setConnectedTabId(null);
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`Failed to connect tab ${tabId}:`, message);
      throw error;
    }
  }

  private async _setConnectedTabId(tabId: number | null): Promise<void> {
    const oldTabId = this._connectedTabId;
    this._connectedTabId = tabId;
    if (oldTabId && oldTabId !== tabId)
      await this._updateBadge(oldTabId, { text: '' });
    if (tabId)
      await this._updateBadge(tabId, { text: '✓', color: '#4CAF50', title: 'Connected to MCP client' });
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || '' });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch {
      // Ignore errors as the tab may be closed already.
    }
  }

  private async _onTabRemoved(tabId: number): Promise<void> {
    const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close('Browser tab closed');
      return;
    }
    if (this._connectedTabId !== tabId)
      return;
    this._activeConnection?.close('Browser tab closed');
    this._activeConnection = undefined;
    this._connectedTabId = null;
  }

  private _onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = undefined;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close('Tab has been inactive for 5 seconds');
            chrome.tabs.sendMessage(tabId, { type: 'connectionTimeout' });
          }
        }, 5000) as unknown as number;
        return;
      }
    }
  }

  private _onTabUpdated(tabId: number, _changeInfo: chrome.tabs.TabChangeInfo, _tab: chrome.tabs.Tab) {
    if (this._connectedTabId === tabId)
      void this._setConnectedTabId(tabId);
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }

  private async _disconnect(): Promise<void> {
    this._activeConnection?.close('User disconnected');
    this._activeConnection = undefined;
    await this._setConnectedTabId(null);
  }
}

new TabShareExtension();
