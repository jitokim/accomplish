import * as pty from 'node-pty';
import { app, shell } from 'electron';
import { getOpenCodeCliPath } from './electron-options';
import { generateOpenCodeConfig } from './config-generator';
import {
  stripAnsi,
  quoteForShell,
  getPlatformShell,
  getShellArgs,
  waitForPortRelease,
} from '@accomplish_ai/agent-core';

export type BrowserAuthProvider = 'openai' | 'google';

export type BrowserAuthState =
  | 'idle'
  | 'waiting_browser_auth'
  | 'polling'
  | 'success'
  | 'failed'
  | 'timeout';

export interface BrowserAuthProgress {
  state: BrowserAuthState;
  provider: BrowserAuthProvider;
  message?: string;
  url?: string;
}

interface BrowserAuthStartOptions {
  provider?: BrowserAuthProvider;
  timeoutMs?: number;
  autoOpenUrl?: boolean;
  onProgress?: (progress: BrowserAuthProgress) => void;
}

interface LoginResult {
  openedUrl?: string;
  detectedUrl?: string;
}

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;
const PROVIDER_SELECTION_HINTS = ['select provider', 'provider?'];
const LOGIN_METHOD_HINTS = ['login method', 'authentication method'];
const POLLING_HINTS = ['waiting for authentication', 'polling', 'checking login', 'verifying'];
const SUCCESS_HINTS = ['successfully logged in', 'authenticated', 'login complete'];

function normalizePtyChunk(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function hasAnyHint(haystack: string, hints: readonly string[]): boolean {
  return hints.some((hint) => haystack.includes(hint));
}

function sanitizeUrl(url: string): string {
  return url.replace(/[),.;:'"\]]+$/g, '');
}

function looksCompleteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0;
  } catch {
    return false;
  }
}

function extractUrls(text: string, allowUnterminatedAtBufferEnd = false): string[] {
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    const rawUrl = match[0];
    const matchEndIndex = match.index + rawUrl.length;

    const sanitized = sanitizeUrl(rawUrl);

    if (
      !allowUnterminatedAtBufferEnd &&
      matchEndIndex === text.length &&
      !looksCompleteUrl(sanitized)
    ) {
      continue;
    }

    urls.push(sanitized);
  }

  return urls;
}

export class OAuthBrowserFlow {
  private activePty: pty.IPty | null = null;
  private isDisposed = false;
  private activeProgressEmitter: ((progress: BrowserAuthProgress) => void) | null = null;
  private activeProvider: BrowserAuthProvider = 'openai';

  isInProgress(): boolean {
    return this.activePty !== null && !this.isDisposed;
  }

  async start(options: BrowserAuthStartOptions = {}): Promise<LoginResult> {
    const provider = options.provider ?? 'openai';
    const timeoutMs = options.timeoutMs ?? 180_000;
    const autoOpenUrl = options.autoOpenUrl ?? true;
    const onProgress = options.onProgress;

    if (this.isInProgress()) {
      console.log('[OAuthBrowserFlow] Cancelling previous flow before starting new one');
      await this.cancel();
      try {
        await waitForPortRelease(1455, 2000);
        console.log('[OAuthBrowserFlow] Port 1455 released');
      } catch {
        console.warn('[OAuthBrowserFlow] Port 1455 still in use after 2000ms');
      }
    }

    await generateOpenCodeConfig();

    const { command, args: baseArgs } = getOpenCodeCliPath();
    const allArgs = [...baseArgs, 'auth', 'login'];

    const fullCommand = [command, ...allArgs].map(quoteForShell).join(' ');
    const shellCmd = getPlatformShell(app.isPackaged);
    const shellArgs = getShellArgs(fullCommand);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    if (process.env.OPENCODE_CONFIG) {
      env.OPENCODE_CONFIG = process.env.OPENCODE_CONFIG;
    }

    const safeCwd = app.getPath('temp');

    return new Promise((resolve, reject) => {
      let openedUrl: string | undefined;
      let detectedUrl: string | undefined;
      let hasSelectedProvider = false;
      let hasSelectedLoginMethod = false;
      let hasEnteredPolling = false;
      let completed = false;
      let buffer = '';

      const emitProgress = (progress: BrowserAuthProgress) => {
        onProgress?.(progress);
      };

      this.activeProvider = provider;
      this.activeProgressEmitter = emitProgress;
      emitProgress({
        state: 'idle',
        provider,
        message: 'Preparing browser authentication...',
      });

      const proc = pty.spawn(shellCmd, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: safeCwd,
        env,
      });

      this.activePty = proc;

      const cleanup = () => {
        this.activePty = null;
        this.activeProgressEmitter = null;
      };

      const tryOpenExternal = async (url: string) => {
        if (openedUrl) return;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
          openedUrl = url;
          if (autoOpenUrl) {
            await shell.openExternal(url);
          }
        } catch {
          // intentionally empty
        }
      };

      const timeoutHandle = setTimeout(() => {
        if (completed) {
          return;
        }

        completed = true;
        emitProgress({
          state: 'timeout',
          provider,
          url: detectedUrl,
          message: 'Authentication timed out. Retry or open the URL manually.',
        });

        try {
          proc.write('\x03');
          proc.kill();
        } catch {
          // intentionally empty
        }

        cleanup();
        reject(new Error('OpenCode auth login timed out before completion'));
      }, timeoutMs);

      emitProgress({
        state: 'waiting_browser_auth',
        provider,
        message: 'Waiting for login URL from OpenCode CLI...',
      });

      proc.onData((data) => {
        const clean = normalizePtyChunk(stripAnsi(data));
        buffer += clean;
        if (buffer.length > 20_000) buffer = buffer.slice(-20_000);

        const lowerBuffer = buffer.toLowerCase();

        if (!hasSelectedProvider && hasAnyHint(lowerBuffer, PROVIDER_SELECTION_HINTS)) {
          hasSelectedProvider = true;
          const providerLabel = provider === 'google' ? 'Google' : 'OpenAI';
          proc.write(providerLabel);
          proc.write('\r');
        }

        if (
          hasSelectedProvider &&
          !hasSelectedLoginMethod &&
          hasAnyHint(lowerBuffer, LOGIN_METHOD_HINTS)
        ) {
          hasSelectedLoginMethod = true;
          proc.write('\r');
        }

        const urls = extractUrls(buffer);
        if (!detectedUrl && urls.length > 0) {
          const firstUrl = urls[0];
          detectedUrl = firstUrl;
          emitProgress({
            state: 'waiting_browser_auth',
            provider,
            url: firstUrl,
            message: 'Open the browser and complete sign in.',
          });
          void tryOpenExternal(firstUrl);
        }

        if (!hasEnteredPolling && hasAnyHint(lowerBuffer, POLLING_HINTS)) {
          hasEnteredPolling = true;
          emitProgress({
            state: 'polling',
            provider,
            url: detectedUrl,
            message: 'Waiting for browser authentication confirmation...',
          });
        }

        if (hasAnyHint(lowerBuffer, SUCCESS_HINTS)) {
          emitProgress({
            state: 'success',
            provider,
            url: detectedUrl,
            message: 'Authentication completed successfully.',
          });
        }
      });

      proc.onExit(({ exitCode, signal }) => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timeoutHandle);
        cleanup();

        if (exitCode === 0) {
          if (!detectedUrl) {
            const urls = extractUrls(buffer, true);
            detectedUrl = urls[0];
          }

          emitProgress({
            state: 'success',
            provider,
            url: detectedUrl,
            message: 'Authentication completed successfully.',
          });
          resolve({ openedUrl, detectedUrl });
          return;
        }

        emitProgress({
          state: 'failed',
          provider,
          url: detectedUrl,
          message: 'Authentication failed. Retry or open the URL manually.',
        });

        const tail = buffer.trim().split('\n').slice(-15).join('\n');
        const redacted = tail
          .replace(/https?:\/\/\S+/g, '[url]')
          .replace(/sk-(?:ant-|or-)?[A-Za-z0-9_-]+/g, 'sk-[redacted]');
        reject(
          new Error(
            `OpenCode auth login failed (exit ${exitCode}, signal ${signal ?? 'none'})` +
              (redacted ? `\n\nOutput:\n${redacted}` : ''),
          ),
        );
      });
    });
  }

  async cancel(): Promise<void> {
    if (!this.activePty) {
      console.log('[OAuthBrowserFlow] No active flow to cancel');
      return;
    }

    console.log('[OAuthBrowserFlow] Cancelling active OAuth flow');

    const ptyProcess = this.activePty;

    ptyProcess.write('\x03');

    if (process.platform === 'win32') {
      await this.delay(100);
      ptyProcess.write('Y\n');
    }

    const gracefulExited = await this.waitForExit(ptyProcess, 1000);

    if (!gracefulExited && this.activePty === ptyProcess) {
      console.log('[OAuthBrowserFlow] Force killing after graceful timeout');
      try {
        ptyProcess.kill();
      } catch (err) {
        console.warn('[OAuthBrowserFlow] Error during force kill:', err);
      }
    }

    this.activeProgressEmitter?.({
      state: 'failed',
      provider: this.activeProvider,
      message: 'Authentication was cancelled. Retry to continue.',
    });

    this.activePty = null;
    this.activeProgressEmitter = null;
  }

  dispose(): void {
    if (this.isDisposed) return;

    console.log('[OAuthBrowserFlow] Disposing');
    this.isDisposed = true;

    if (this.activePty) {
      try {
        this.activePty.kill();
      } catch (err) {
        console.warn('[OAuthBrowserFlow] Error killing PTY during dispose:', err);
      }
      this.activePty = null;
    }

    this.activeProgressEmitter = null;
  }

  private async waitForExit(proc: pty.IPty, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const onExit = () => {
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      };

      proc.onExit(onExit);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const oauthBrowserFlow = new OAuthBrowserFlow();

export async function loginOpenAiWithChatGpt(): Promise<LoginResult> {
  return oauthBrowserFlow.start({ provider: 'openai' });
}

export async function loginWithBrowser(
  options: BrowserAuthStartOptions = {},
): Promise<LoginResult> {
  return oauthBrowserFlow.start(options);
}
