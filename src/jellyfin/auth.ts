import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { JellyfinClient } from './client';
import type { AuthResult } from './types';

const SECRET_ACCESS_TOKEN = 'jellyfin.accessToken';
const STATE_USER_ID = 'jellyfin.userId';
const STATE_DEVICE_ID = 'jellyfin.deviceId';
const STATE_USER_NAME = 'jellyfin.userDisplayName';

function validateServerUrl(value: string): string | undefined {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? undefined : 'The URL must start with http:// or https://';
  } catch {
    return 'Enter a full URL, e.g. http://192.168.1.10:8096';
  }
}

export class AuthManager {
  private accessToken: string | undefined;
  private client: JellyfinClient;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires when the signed-in user or the server changes. */
  readonly onDidChange = this.changeEmitter.event;

  /** Runs while the old session is still valid, so playback can be saved to the server it belongs to. */
  onWillChange: (() => Promise<void>) | undefined;

  private constructor(
    private context: vscode.ExtensionContext,
    private deviceId: string,
    private serverUrl: string,
  ) {
    this.client = new JellyfinClient(serverUrl, deviceId, () => this.accessToken);
  }

  static async create(context: vscode.ExtensionContext): Promise<AuthManager> {
    let deviceId = context.globalState.get<string>(STATE_DEVICE_ID);
    if (!deviceId) {
      deviceId = randomUUID();
      await context.globalState.update(STATE_DEVICE_ID, deviceId);
    }
    const serverUrl = vscode.workspace.getConfiguration('jellyfin').get<string>('serverUrl') ?? '';
    const manager = new AuthManager(context, deviceId, serverUrl);
    manager.accessToken = await context.secrets.get(SECRET_ACCESS_TOKEN);
    return manager;
  }

  getClient(): JellyfinClient {
    return this.client;
  }

  isSignedIn(): boolean {
    return Boolean(this.accessToken && this.getUserId());
  }

  getUserId(): string | undefined {
    return this.context.globalState.get<string>(STATE_USER_ID);
  }

  getUserDisplayName(): string | undefined {
    return this.context.globalState.get<string>(STATE_USER_NAME);
  }

  /** "user on host", for showing which account is in use. */
  describeAccount(): string {
    if (!this.isSignedIn()) {
      return '';
    }
    let host = this.serverUrl;
    try {
      host = new URL(this.serverUrl).host;
    } catch {
      // Keep the raw setting.
    }
    return `${this.getUserDisplayName() ?? 'Signed in'} on ${host}`;
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  /** Re-reads the configured server URL. A token is only valid for the server that issued it, so a change signs out. */
  async refreshServerUrl(): Promise<void> {
    const serverUrl = vscode.workspace.getConfiguration('jellyfin').get<string>('serverUrl') ?? '';
    if (serverUrl !== this.serverUrl) {
      await this.onWillChange?.();
      this.setServerUrl(serverUrl);
      await this.clearSession();
      this.changeEmitter.fire();
    }
  }

  private setServerUrl(serverUrl: string): void {
    this.serverUrl = serverUrl;
    this.client = new JellyfinClient(serverUrl, this.deviceId, () => this.accessToken);
  }

  /**
   * Prompts for whatever is missing (or, when switching, for the server and user again) and
   * signs in. The current session is only replaced once the new sign-in has succeeded.
   */
  async signIn(change: { server?: boolean; user?: boolean } = {}): Promise<boolean> {
    await this.refreshServerUrl();
    const config = vscode.workspace.getConfiguration('jellyfin');

    let serverUrl = this.serverUrl;
    if (!serverUrl || change.server) {
      const input = await vscode.window.showInputBox({
        prompt: 'Jellyfin server URL',
        placeHolder: 'http://192.168.1.10:8096',
        value: serverUrl,
        ignoreFocusOut: true,
        validateInput: validateServerUrl,
      });
      if (!input) {
        return false;
      }
      serverUrl = input.trim();
    }

    let username = config.get<string>('username') ?? '';
    if (!username || change.server || change.user) {
      const input = await vscode.window.showInputBox({
        prompt: 'Jellyfin username',
        value: username,
        ignoreFocusOut: true,
      });
      if (!input) {
        return false;
      }
      username = input;
    }

    const password = await vscode.window.showInputBox({
      prompt: `Jellyfin password for ${username}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      return false;
    }

    let result: AuthResult;
    try {
      result = await new JellyfinClient(serverUrl, this.deviceId, () => undefined).authenticateByName(username, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Jellyfin sign-in failed: ${message}`);
      return false;
    }

    await this.onWillChange?.();
    // Set before saving so the configuration listener doesn't see this as a server switch.
    this.setServerUrl(serverUrl);
    this.accessToken = result.AccessToken;
    await config.update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
    await config.update('username', username, vscode.ConfigurationTarget.Global);
    await this.context.secrets.store(SECRET_ACCESS_TOKEN, result.AccessToken);
    await this.context.globalState.update(STATE_USER_ID, result.User.Id);
    await this.context.globalState.update(STATE_USER_NAME, result.User.Name);
    this.changeEmitter.fire();
    return true;
  }

  async signOut(): Promise<void> {
    await this.onWillChange?.();
    await this.clearSession();
    this.changeEmitter.fire();
  }

  private async clearSession(): Promise<void> {
    this.accessToken = undefined;
    await this.context.secrets.delete(SECRET_ACCESS_TOKEN);
    await this.context.globalState.update(STATE_USER_ID, undefined);
    await this.context.globalState.update(STATE_USER_NAME, undefined);
  }
}
