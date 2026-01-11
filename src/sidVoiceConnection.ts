/**
 * SimpliDev Browser Extension
 * 
 * SignalR connection to Sid Voice server for remote browser control.
 * This enables voice commands to control the user's browser.
 */

import * as signalR from '@microsoft/signalr';
import { debugLog } from './relayConnection';

// Sid Voice server endpoints
const VOICE_SERVER_PROD = 'https://simplidev.dev.simpligov.com';
const VOICE_SERVER_STAGE = 'https://simplidev-stage.dev.simpligov.com';

export interface BrowserCommand {
  type: 'navigate' | 'click' | 'type' | 'snapshot' | 'screenshot' | 'getTabs' | 'selectTab';
  url?: string;
  selector?: string;
  text?: string;
  tabId?: number;
}

export interface BrowserResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export class SidVoiceConnection {
  private _connection: signalR.HubConnection | null = null;
  private _email: string = '';
  private _debuggee: chrome.debugger.Debuggee = {};
  private _connectedTabId: number | null = null;
  private _eventListener: ((source: chrome.debugger.DebuggerSession, method: string, params: unknown) => void) | null = null;
  private _serverUrl: string = VOICE_SERVER_PROD;

  onStatusChange?: (connected: boolean, email?: string) => void;
  onError?: (error: string) => void;

  constructor() {
    // Load saved configuration
    this._loadConfig();
  }

  private async _loadConfig(): Promise<void> {
    const result = await chrome.storage.local.get(['sidVoiceEmail', 'sidVoiceServer']);
    if (result.sidVoiceEmail) {
      this._email = result.sidVoiceEmail;
    }
    if (result.sidVoiceServer) {
      this._serverUrl = result.sidVoiceServer;
    }
  }

  async connect(email: string, useStaging: boolean = false): Promise<void> {
    this._email = email;
    this._serverUrl = useStaging ? VOICE_SERVER_STAGE : VOICE_SERVER_PROD;

    // Save configuration
    await chrome.storage.local.set({
      sidVoiceEmail: email,
      sidVoiceServer: this._serverUrl,
    });

    debugLog(`Connecting to Sid Voice at ${this._serverUrl} as ${email}`);

    try {
      this._connection = new signalR.HubConnectionBuilder()
        .withUrl(`${this._serverUrl}/browser-hub`, {
          headers: {
            'X-Simplidev-Email': email,
          },
        })
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: (retryContext) => {
            // Exponential backoff: 0, 2, 4, 8, 16, 30, 30, 30...
            const delay = Math.min(Math.pow(2, retryContext.previousRetryCount) * 1000, 30000);
            debugLog(`Reconnecting in ${delay}ms (attempt ${retryContext.previousRetryCount + 1})`);
            return delay;
          },
        })
        .configureLogging(signalR.LogLevel.Information)
        .build();

      // Handle incoming commands from Sid Voice
      this._connection.on('BrowserCommand', async (command: BrowserCommand) => {
        debugLog('Received browser command:', command);
        const response = await this._handleCommand(command);
        await this._connection?.invoke('BrowserResponse', response);
      });

      // Handle connection state changes
      this._connection.onreconnecting((error) => {
        debugLog('Reconnecting to Sid Voice...', error);
        this.onStatusChange?.(false);
      });

      this._connection.onreconnected(() => {
        debugLog('Reconnected to Sid Voice');
        this.onStatusChange?.(true, this._email);
      });

      this._connection.onclose((error) => {
        debugLog('Disconnected from Sid Voice', error);
        this.onStatusChange?.(false);
        this._cleanup();
      });

      await this._connection.start();
      debugLog('Connected to Sid Voice');
      this.onStatusChange?.(true, this._email);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog('Failed to connect to Sid Voice:', message);
      this.onError?.(message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this._connection) {
      await this._connection.stop();
      this._connection = null;
    }
    this._cleanup();
    this.onStatusChange?.(false);
  }

  private _cleanup(): void {
    if (this._eventListener) {
      chrome.debugger.onEvent.removeListener(this._eventListener);
      this._eventListener = null;
    }
    if (this._debuggee.tabId) {
      chrome.debugger.detach(this._debuggee).catch(() => {});
      this._debuggee = {};
    }
    this._connectedTabId = null;
  }

  private async _handleCommand(command: BrowserCommand): Promise<BrowserResponse> {
    try {
      switch (command.type) {
        case 'navigate':
          return await this._navigate(command.url!);
        case 'getTabs':
          return await this._getTabs();
        case 'selectTab':
          return await this._selectTab(command.tabId!);
        case 'click':
          return await this._click(command.selector!);
        case 'type':
          return await this._type(command.selector!, command.text!);
        case 'snapshot':
          return await this._getSnapshot();
        case 'screenshot':
          return await this._getScreenshot();
        default:
          return { success: false, error: `Unknown command: ${command.type}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  private async _navigate(url: string): Promise<BrowserResponse> {
    debugLog('Navigating to:', url);
    
    // Create or update tab
    if (this._connectedTabId) {
      await chrome.tabs.update(this._connectedTabId, { url, active: true });
    } else {
      const tab = await chrome.tabs.create({ url, active: true });
      this._connectedTabId = tab.id!;
    }

    return { success: true, data: { tabId: this._connectedTabId } };
  }

  private async _getTabs(): Promise<BrowserResponse> {
    const tabs = await chrome.tabs.query({});
    const filteredTabs = tabs
      .filter(tab => tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)))
      .map(tab => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
      }));
    
    return { success: true, data: { tabs: filteredTabs, connectedTabId: this._connectedTabId } };
  }

  private async _selectTab(tabId: number): Promise<BrowserResponse> {
    debugLog('Selecting tab:', tabId);
    
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      return { success: false, error: 'Tab not found' };
    }

    this._connectedTabId = tabId;
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    return { success: true, data: { tabId } };
  }

  private async _click(selector: string): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { success: false, error: 'No tab connected' };
    }

    debugLog('Clicking:', selector);
    
    // Use Chrome debugger to execute click
    await this._ensureDebuggerAttached();
    
    await chrome.debugger.sendCommand(this._debuggee, 'Runtime.evaluate', {
      expression: `document.querySelector('${selector}')?.click()`,
      userGesture: true,
    });

    return { success: true };
  }

  private async _type(selector: string, text: string): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { success: false, error: 'No tab connected' };
    }

    debugLog('Typing into:', selector, text);
    
    await this._ensureDebuggerAttached();
    
    await chrome.debugger.sendCommand(this._debuggee, 'Runtime.evaluate', {
      expression: `
        const el = document.querySelector('${selector}');
        if (el) {
          el.value = '${text.replace(/'/g, "\\'")}';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `,
      userGesture: true,
    });

    return { success: true };
  }

  private async _getSnapshot(): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { success: false, error: 'No tab connected' };
    }

    await this._ensureDebuggerAttached();
    
    // Get accessibility tree
    const result = await chrome.debugger.sendCommand(this._debuggee, 'Accessibility.getFullAXTree') as { nodes: unknown[] };
    
    return { success: true, data: { snapshot: result.nodes } };
  }

  private async _getScreenshot(): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { success: false, error: 'No tab connected' };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab();
    
    return { success: true, data: { screenshot: dataUrl } };
  }

  private async _ensureDebuggerAttached(): Promise<void> {
    if (!this._connectedTabId) {
      throw new Error('No tab connected');
    }

    if (this._debuggee.tabId === this._connectedTabId) {
      return; // Already attached
    }

    // Detach from old tab if needed
    if (this._debuggee.tabId) {
      await chrome.debugger.detach(this._debuggee).catch(() => {});
    }

    this._debuggee = { tabId: this._connectedTabId };
    await chrome.debugger.attach(this._debuggee, '1.3');

    // Set up event listener
    if (!this._eventListener) {
      this._eventListener = (source, method, params) => {
        if (source.tabId === this._connectedTabId) {
          debugLog('CDP Event:', method, params);
        }
      };
      chrome.debugger.onEvent.addListener(this._eventListener);
    }
  }

  get isConnected(): boolean {
    return this._connection?.state === signalR.HubConnectionState.Connected;
  }

  get email(): string {
    return this._email;
  }

  get connectedTabId(): number | null {
    return this._connectedTabId;
  }
}
