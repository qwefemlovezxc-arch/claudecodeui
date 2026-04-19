/**
 * Claude CLI Integration (subprocess-based)
 *
 * Spawns the official `claude` binary as a child process and parses its
 * `--output-format stream-json --verbose` stdout. No OAuth tokens are
 * touched — the CLI handles authentication itself. This path is ToS-safe
 * for Pro/Max subscribers (no Agent SDK, no direct api.anthropic.com calls).
 *
 * Public interface preserved 1:1 with the previous SDK-based version so that
 * server/index.js, server/routes/agent.js, and server/routes/git.js need no
 * changes. Sandbox enforcement via WORKSPACES_ROOT env is applied everywhere
 * claude is spawned.
 */

import spawn from 'cross-spawn';
import readline from 'readline';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { claudeAdapter } from './providers/claude/adapter.js';
import { createNormalizedMessage } from './providers/types.js';
import { getStatusChecker } from './providers/registry.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;
const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ? path.resolve(process.env.WORKSPACES_ROOT)
  : null;

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

// Resolve requested cwd, clamping it inside WORKSPACES_ROOT if that env is set.
// Any attempt to escape via absolute paths, `..`, or symlinks is silently
// forced back to the workspace root.
async function resolveSafeCwd(requestedCwd) {
  if (!WORKSPACES_ROOT) {
    return requestedCwd ? path.resolve(requestedCwd) : process.cwd();
  }
  const target = requestedCwd
    ? path.resolve(WORKSPACES_ROOT, path.relative(WORKSPACES_ROOT, path.resolve(requestedCwd)))
    : WORKSPACES_ROOT;
  try {
    const real = await fs.realpath(target);
    if (real === WORKSPACES_ROOT || real.startsWith(WORKSPACES_ROOT + path.sep)) {
      return real;
    }
  } catch {
    // realpath fails if the directory doesn't exist yet — fall through to root
  }
  return WORKSPACES_ROOT;
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) return false;
  if (entry === toolName) return true;

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';
    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }
    if (!command) return false;
    return command.startsWith(allowedPrefix);
  }
  return false;
}

// Translate the options object previously fed to the SDK into command-line
// flags for the `claude` binary. Returns { args, permissionMode, allowedTools,
// disallowedTools } so that the caller can still reason about effective
// settings (e.g. for the canUseTool fallback path).
function buildClaudeArgs(options = {}, promptText) {
  const args = ['-p', promptText, '--output-format', 'stream-json', '--verbose'];

  args.push('--model', options.model || CLAUDE_MODELS.DEFAULT);

  let permissionMode = options.permissionMode;
  const settings = options.toolsSettings || { allowedTools: [], disallowedTools: [], skipPermissions: false };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    permissionMode = 'bypassPermissions';
  }
  if (permissionMode && permissionMode !== 'default') {
    args.push('--permission-mode', permissionMode);
  }

  let allowedTools = [...(settings.allowedTools || [])];
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) allowedTools.push(tool);
    }
  }
  if (allowedTools.length > 0) {
    args.push('--allowed-tools', allowedTools.join(','));
  }

  const disallowedTools = settings.disallowedTools || [];
  if (disallowedTools.length > 0) {
    args.push('--disallowed-tools', disallowedTools.join(','));
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (process.env.MCP_CONFIG_PATH) {
    args.push('--mcp-config', process.env.MCP_CONFIG_PATH);
  }

  // Pin the addressable filesystem to the sandbox root. Any extra --add-dir
  // requests from upstream callers are ignored on purpose.
  if (WORKSPACES_ROOT) {
    args.push('--add-dir', WORKSPACES_ROOT);
  }

  return { args, permissionMode, allowedTools, disallowedTools };
}

function addSession(sessionId, childProcess, tempImagePaths = [], tempDir = null, writer = null) {
  activeSessions.set(sessionId, {
    instance: childProcess,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer
  });
}

function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

function getAllSessions() {
  return Array.from(activeSessions.keys());
}

function transformMessage(sdkMessage) {
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function extractTokenBudget(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];
  if (!modelData) return null;

  const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;

  return { used: totalUsed, total: contextWindow };
}

async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    for (const [index, image] of images.entries()) {
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }
      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) return;
  try {
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Main query function. Spawns `claude -p <prompt> --output-format stream-json`
 * and streams every JSON event through the existing claudeAdapter onto the
 * websocket. Signature and side effects are identical to the previous
 * SDK-based implementation.
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let child = null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const sandboxedCwd = await resolveSafeCwd(options.cwd);

    const imageResult = await handleImages(command, options.images, sandboxedCwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    const { args } = buildClaudeArgs(options, finalCommand);

    console.log(`[claude-subprocess] spawn cwd=${sandboxedCwd} args=${args.slice(0, 8).join(' ')}…`);

    child = spawn(CLAUDE_BIN, args, {
      cwd: sandboxedCwd,
      env: {
        ...process.env,
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '300000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (capturedSessionId) {
      addSession(capturedSessionId, child, tempImagePaths, tempDir, ws);
    }

    const stderrBuffer = [];
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrBuffer.push(chunk);
      console.error('[claude stderr]', chunk.trimEnd());
    });

    child.on('error', (err) => {
      console.error('[claude spawn error]', err);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        console.warn('[claude-subprocess] non-JSON line:', trimmed.slice(0, 200));
        continue;
      }

      if (message.session_id && !capturedSessionId) {
        capturedSessionId = message.session_id;
        addSession(capturedSessionId, child, tempImagePaths, tempDir, ws);

        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: capturedSessionId,
            sessionId: capturedSessionId,
            provider: 'claude'
          }));
        }
      }

      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;
      const normalized = claudeAdapter.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      if (message.type === 'result') {
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: tokenBudgetData,
            sessionId: sid,
            provider: 'claude'
          }));
        }
      }
    }

    const exitCode = await new Promise(resolve => {
      if (child.exitCode != null) {
        resolve(child.exitCode);
      } else {
        child.once('close', (code) => resolve(code ?? 0));
      }
    });

    if (capturedSessionId) removeSession(capturedSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (exitCode !== 0) {
      const stderrText = stderrBuffer.join('').slice(-2000);
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: `Claude CLI exited with code ${exitCode}. ${stderrText}`,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'claude'
      }));
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        error: new Error(`claude exit ${exitCode}`)
      });
      return;
    }

    ws.send(createNormalizedMessage({
      kind: 'complete',
      exitCode,
      isNewSession: !sessionId && !!command,
      sessionId: capturedSessionId,
      provider: 'claude'
    }));
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed'
    });

  } catch (error) {
    console.error('Subprocess query error:', error);

    if (capturedSessionId) removeSession(capturedSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }

    const installed = getStatusChecker('claude')?.checkInstalled() ?? true;
    const errorContent = !installed
      ? 'Claude Code CLI is not installed. Install it: npm install -g @anthropic-ai/claude-code'
      : error.message;

    ws.send(createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      sessionId: capturedSessionId || sessionId || null,
      provider: 'claude'
    }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting subprocess session: ${sessionId}`);
    const child = session.instance;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 3000);
    }

    session.status = 'aborted';
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);
    removeSession(sessionId);
    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
