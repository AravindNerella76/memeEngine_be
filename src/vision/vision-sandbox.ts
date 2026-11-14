/**
 * Sandbox settings for the Antigravity CLI (agy) when it is used as a vision model.
 *
 * Findings from live probes of agy 1.5.8 (headless --print mode), which this module encodes:
 *  - Images in a prompt are read by the model's own read_file tool, so read_file cannot simply
 *    be denied; it has to be CONFINED to the run's private workspace folder.
 *  - Permission rules are path-prefix strings and are sensitive to path spelling ("C:\", "C:/",
 *    "c:\", "/C:/..."). Deny always beats allow, so confinement is built by denying every other
 *    drive and every sibling folder along the path from the drive root down to the workspace,
 *    in every spelling. A bare "read_file(/)" rule must NOT be used: file:/// image links are
 *    checked as "/C:/..." and would be blocked.
 *  - command / write_file / read_url / execute_url / mcp / unsandboxed are denied outright.
 *  - The CLI runs with an isolated, per-run USERPROFILE so the user's own CLI configuration
 *    (installed Google Drive/Docs/Calendar plugins, global always-allow grants) is never loaded.
 *    Sign-in still works because the CLI keeps credentials in the OS credential store.
 */
import * as fs from 'fs';
import * as path from 'path';

const BS = '\\';

export const DENIED_TOOL_RULES = [
  'command(*)',
  'write_file(*)',
  'read_url(*)',
  'execute_url(*)',
  'mcp(*)',
  'unsandboxed(*)'
];

/** Safety cap so a pathological folder cannot produce an unbounded rule list. */
const MAX_SIBLINGS_PER_LEVEL = 1500;

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p);

/** All spellings of a path that the CLI's prefix matcher may see. */
export function pathVariants(p: string): string[] {
  if (!isWindowsPath(p)) return [p];
  const win = p.split('/').join(BS);
  const fwd = p.split(BS).join('/');
  const out = new Set<string>();
  for (const v of [win, fwd]) {
    out.add(v);
    out.add(v.charAt(0).toLowerCase() + v.slice(1));
    out.add(v.charAt(0).toUpperCase() + v.slice(1));
  }
  for (const v of Array.from(out)) out.add('/' + v.split(BS).join('/'));
  return Array.from(out);
}

export interface ConfinementResult {
  rules: string[];
  truncatedLevels: string[];
}

/**
 * Deny rules that leave only `workspace` (and everything inside it) readable.
 * Siblings are listed from the filesystem at call time.
 */
export function buildReadConfinementRules(workspace: string): ConfinementResult {
  const abs = path.resolve(workspace);
  const rules = new Set<string>();
  const truncatedLevels: string[] = [];
  const parsed = path.parse(abs);

  if (isWindowsPath(abs)) {
    const ownDrive = parsed.root.charAt(0).toUpperCase();
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c);
      if (d === ownDrive) continue;
      for (const v of pathVariants(`${d}:${BS}`)) rules.add(`read_file(${v})`);
    }
  }

  const parts = abs.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    let children: string[] = [];
    try {
      children = fs.readdirSync(current);
    } catch {
      children = [];
    }
    if (children.length > MAX_SIBLINGS_PER_LEVEL) {
      truncatedLevels.push(current);
      children = children.slice(0, MAX_SIBLINGS_PER_LEVEL);
    }
    for (const child of children) {
      if (child.toLowerCase() === part.toLowerCase()) continue;
      for (const v of pathVariants(path.join(current, child))) rules.add(`read_file(${v})`);
    }
    current = path.join(current, part);
  }
  return { rules: Array.from(rules), truncatedLevels };
}

export interface CliSessionSettings {
  permissions: { deny: string[] };
  agentMode: string;
}

/** Complete --settings document for one sandboxed run. agentMode "" = Default mode (not Auto). */
export function buildCliSettings(workspace: string): { settings: CliSessionSettings; truncatedLevels: string[] } {
  const { rules, truncatedLevels } = buildReadConfinementRules(workspace);
  return {
    settings: { permissions: { deny: [...DENIED_TOOL_RULES, ...rules] }, agentMode: '' },
    truncatedLevels
  };
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|MONGO|_CX$|DATABASE_URL|AUTH)/i;

/**
 * Environment for the CLI child process: the parent environment minus anything that looks like a
 * secret, with the user profile redirected to an isolated per-run folder.
 */
export function buildChildEnv(isolatedHome: string, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  const home = path.resolve(isolatedHome);
  env.USERPROFILE = home;
  env.HOME = home;
  if (isWindowsPath(home)) {
    env.HOMEDRIVE = home.slice(0, 2);
    env.HOMEPATH = home.slice(2);
  }
  return env;
}
