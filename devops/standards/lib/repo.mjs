// What a family repo is, read once: its files, package.json, standards
// config, profile and package manager. Every check reads from this, so a
// check never shells out for a fact another check already read.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG = '.inite/standards.json';
export const PROFILES = ['next', 'node', 'python'];

export function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'ignore'], ...opts });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function detectProfile(root, pkg) {
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return deps.next ? 'next' : 'node';
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(root, f)))) return 'python';
  return 'node';
}

export function detectPm(root, pkg) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  const declared = pkg?.packageManager?.split('@')[0];
  return declared || 'npm';
}

export function loadRepo(root = process.cwd()) {
  root = path.resolve(root);
  let files = [];
  try {
    files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    files = [];
  }
  const pkg = readJson(path.join(root, 'package.json'));
  const configRaw = fs.existsSync(path.join(root, CONFIG)) ? fs.readFileSync(path.join(root, CONFIG), 'utf8') : null;
  let config = null;
  let configError = null;
  if (configRaw !== null) {
    try {
      config = JSON.parse(configRaw);
    } catch (err) {
      configError = err.message;
    }
  }
  const profile = config?.profile && PROFILES.includes(config.profile) ? config.profile : detectProfile(root, pkg);
  const fileSet = new Set(files);
  return {
    root,
    files,
    pkg,
    config: config ?? {},
    hasConfig: configRaw !== null,
    configError,
    profile,
    pm: detectPm(root, pkg),
    has: (p) => fileSet.has(p) || fs.existsSync(path.join(root, p)),
    tracked: (p) => fileSet.has(p),
    read: (p) => {
      try {
        return fs.readFileSync(path.join(root, p), 'utf8');
      } catch {
        return null;
      }
    },
    /** The file as `ref` has it, or null. */
    readAt: (ref, p) => {
      try {
        return git(root, ['show', `${ref}:${p}`]);
      } catch {
        return null;
      }
    },
  };
}

/** The command a gate step runs: the repo's override, else the profile's default. */
export function stepCommand(repo, step) {
  const override = repo.config.commands?.[step];
  if (override !== undefined) return override ?? '';
  if (repo.profile === 'python') {
    return { lint: 'ruff check .', typecheck: 'mypy', test: 'python -m pytest -q', build: '' }[step] ?? '';
  }
  const pm = repo.pm === 'npm' ? 'npm' : repo.pm;
  if (step === 'build' || step === 'e2e') return repo.pkg?.scripts?.[step] ? `${pm} run ${step}` : '';
  return `${pm} run ${step}`;
}

/** The deploy workflows the release moves: config, else the deploy*.yml files present. */
export function deployWorkflows(repo) {
  const listed = repo.config.deploy?.workflows;
  if (Array.isArray(listed) && listed.length) return listed;
  const found = repo.files.filter((f) => /^\.github\/workflows\/deploy[^/]*\.ya?ml$/.test(f)).map((f) => path.basename(f));
  return found.length ? found : ['deploy.yml'];
}
