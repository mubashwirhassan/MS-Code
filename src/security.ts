import { ExecutionMode } from './types';

// Catastrophic — always blocked, even in Auto Mode.
const BLOCKED = [
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf\b)\s+\/(\s|$)/,
  /rm\s+-[rf]+\s+\/(home|usr|etc|var|opt|root)(\/|\s|$)/,
  /mkfs(\.\w+)?\b/,
  /dd\s+[^;]*of=\/dev\//,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{[^}]*\};\s*:/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /drop\s+(table|database)\b/i,
  /truncate\s+table\b/i,
  /git\s+push\s+[^;]*--force\b/,
  /curl[^;]*\|\s*(ba|z|fi)?sh\b/,
  /wget[^;]*\|\s*(ba|z|fi)?sh\b/,
  /npm\s+publish\b/,
  /chmod\s+-R\s+777\s+\/(?!home\/)/,
  /aws\s+s3\s+rb\s+--force/,
  /\bformat\s+[a-z]:/i,
];

// Risky — confirmation needed in Hybrid/Safe mode.
const RISKY = [
  /\bsudo\b/,
  /git\s+(push|reset|clean)\b/,
  /\brm\s+-[r,f]/,
  /docker\s+(rm|rmi|system|stop|kill|prune)\b/,
  /\bkill(all|\s+-9|\s+-kill)\b/,
  /(apt|apt-get|yum|dnf|brew)\s+(install|remove|purge)/,
  /pip3?\s+install\s+/,
  /npm\s+(install|uninstall|ci|cache clean)/,
  /yarn\s+(add|remove)/,
  /docker\s+(run|compose)/,
  /\benv\s+-i\b/,
  /git\s+checkout\s+--\s+\./,
];

export type Verdict = 'allow' | 'confirm' | 'deny';

export function classifyCommand(cmd: string, mode: ExecutionMode): Verdict {
  const c = cmd.trim();
  for (const re of BLOCKED) { if (re.test(c)) { return 'deny'; } }
  if (mode === 'auto') { return 'allow'; }
  if (mode === 'hybrid') {
    for (const re of RISKY) { if (re.test(c)) { return 'confirm'; } }
    return 'allow';
  }
  return 'confirm'; // safe mode: confirm everything
}
