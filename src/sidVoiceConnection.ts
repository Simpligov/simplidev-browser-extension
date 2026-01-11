/**
 * SimpliDev Browser Extension
 * 
 * WebSocket connection to Sid Voice server for remote browser control.
 * This enables voice commands to control the user's browser.
 */

import { debugLog } from './relayConnection';

// Sid Voice server endpoints (uses wss:// for WebSocket)
const VOICE_SERVER_PROD = 'wss://simplidev.dev.simpligov.com';
const VOICE_SERVER_STAGE = 'wss://simplidev-stage.dev.simpligov.com';

export interface BrowserCommand {
  type: 'navigate' | 'click' | 'type' | 'snapshot' | 'screenshot' | 'getTabs' | 'selectTab';
  id?: string; // Command ID for response correlation
  url?: string;
  selector?: string;
  text?: string;
  tabId?: number;
}

export interface BrowserResponse {
  type: 'response';
  id?: string; // Correlate with command ID
  success: boolean;
  data?: unknown;
  error?: string;
}

export class SidVoiceConnection {
  private _ws: WebSocket | null = null;
  private _email: string = '';
  private _debuggee: chrome.debugger.Debuggee = {};
  private _connectedTabId: number | null = null;
  private _eventListener: ((source: chrome.debugger.DebuggerSession, method: string, params: unknown) => void) | null = null;
  private _serverUrl: string = VOICE_SERVER_PROD;
  private _reconnectAttempts: number = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

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

    return this._doConnect();
  }

  private async _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Connect to the /browser WebSocket endpoint
        const wsUrl = `${this._serverUrl}/browser?email=${encodeURIComponent(this._email)}`;
        this._ws = new WebSocket(wsUrl);

        this._ws.onopen = () => {
          debugLog('Connected to Sid Voice browser endpoint');
          this._reconnectAttempts = 0;
          
          // Send initial handshake
          this._send({
            type: 'register',
            email: this._email,
          });
          
          // Start ping/pong keepalive
          this._startPing();
          
          this.onStatusChange?.(true, this._email);
          resolve();
        };

        this._ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'command') {
              debugLog('Received browser command:', data);
              const response = await this._handleCommand(data as BrowserCommand);
              response.id = data.id;
              this._send(response);
            } else if (data.type === 'pong') {
              // Keepalive response
            } else if (data.type === 'registered') {
              debugLog('Registered with Sid Voice server');
            }
          } catch (error) {
            debugLog('Error parsing message:', error);
          }
        };

        this._ws.onclose = (event) => {
          debugLog('Disconnected from Sid Voice:', event.code, event.reason);
          this._stopPing();
          this.onStatusChange?.(false);
          
          // Attempt reconnect if not intentional disconnect
          if (event.code !== 1000 && this._email) {
            this._scheduleReconnect();
          }
        };

        this._ws.onerror = (error) => {
          debugLog('WebSocket error:', error);
          this.onError?.('Connection error');
          reject(new Error('Connection error'));
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog('Failed to connect to Sid Voice:', message);
        this.onError?.(message);
        reject(error);
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return;
    
    // Exponential backoff: 1, 2, 4, 8, 16, 30, 30, 30...
    const delay = Math.min(Math.pow(2, this._reconnectAttempts) * 1000, 30000);
    this._reconnectAttempts++;
    
    debugLog(`Scheduling reconnect in ${delay}ms (attempt ${this._reconnectAttempts})`);
    
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this._doConnect();
      } catch {
        // Will schedule another reconnect via onclose
      }
    }, delay);
  }

  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._send({ type: 'ping' });
      }
    }, 30000);
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  private _send(data: object): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  async disconnect(): Promise<void> {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopPing();
    
    if (this._ws) {
      this._ws.close(1000, 'User disconnected');
      this._ws = null;
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
          return { type: 'response', success: false, error: `Unknown command: ${command.type}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { type: 'response', success: false, error: message };
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

    return { type: 'response', success: true, data: { tabId: this._connectedTabId } };
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
    
    return { type: 'response', success: true, data: { tabs: filteredTabs, connectedTabId: this._connectedTabId } };
  }

  private async _selectTab(tabId: number): Promise<BrowserResponse> {
    debugLog('Selecting tab:', tabId);
    
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      return { type: 'response', success: false, error: 'Tab not found' };
    }

    this._connectedTabId = tabId;
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    return { type: 'response', success: true, data: { tabId } };
  }

  private async _click(selector: string): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { type: 'response', success: false, error: 'No tab connected' };
    }

    debugLog('Clicking:', selector);
    
    // Use Chrome debugger to execute click
    await this._ensureDebuggerAttached();
    
    await chrome.debugger.sendCommand(this._debuggee, 'Runtime.evaluate', {
      expression: `document.querySelector('${selector}')?.click()`,
      userGesture: true,
    });

    return { type: 'response', success: true };
  }

  private async _type(selector: string, text: string): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { type: 'response', success: false, error: 'No tab connected' };
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

    return { type: 'response', success: true };
  }

  private async _getSnapshot(): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { type: 'response', success: false, error: 'No tab connected' };
    }

    await this._ensureDebuggerAttached();
    
    // Get accessibility tree
    const result = await chrome.debugger.sendCommand(this._debuggee, 'Accessibility.getFullAXTree') as { nodes: unknown[] };
    
    return { type: 'response', success: true, data: { snapshot: result.nodes } };
  }

  private async _getScreenshot(): Promise<BrowserResponse> {
    if (!this._connectedTabId) {
      return { type: 'response', success: false, error: 'No tab connected' };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab();
    
    return { type: 'response', success: true, data: { screenshot: dataUrl } };
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
    return this._ws?.readyState === WebSocket.OPEN;
  }

  get email(): string {
    return this._email;
  }

  get connectedTabId(): number | null {
    return this._connectedTabId;
  }
}
