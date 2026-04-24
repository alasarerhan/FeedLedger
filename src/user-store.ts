import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';

export type UserRole = 'admin' | 'user';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

interface UserFile {
  version: number;
  users: UserRecord[];
}

interface CreateUserInput {
  username: string;
  displayName?: string;
  role?: UserRole;
  password: string;
}

interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
}

const USERS_FILE = join(config.dataDir, 'users.json');
const FILE_VERSION = 1;

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,32}$/;

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDisplayName(value: string, fallback: string): string {
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean || fallback;
}

function parseUserFile(raw: unknown): UserFile {
  if (!raw || typeof raw !== 'object') {
    return { version: FILE_VERSION, users: [] };
  }

  const source = raw as Partial<UserFile>;
  const users = Array.isArray(source.users) ? source.users : [];

  const normalizedUsers: UserRecord[] = users
    .filter(Boolean)
    .map((item: any) => {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const username = typeof item.username === 'string' ? normalizeUsername(item.username) : '';
      const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : username;
      const role: UserRole = item.role === 'admin' ? 'admin' : 'user';
      const passwordHash = typeof item.passwordHash === 'string' ? item.passwordHash : '';
      const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now();
      const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : Date.now();

      return {
        id,
        username,
        displayName,
        role,
        passwordHash,
        createdAt,
        updatedAt,
      } satisfies UserRecord;
    })
    .filter(user => user.id && user.username && user.passwordHash && USERNAME_REGEX.test(user.username));

  return {
    version: FILE_VERSION,
    users: normalizedUsers,
  };
}

function loadUserFile(): UserFile {
  try {
    if (!existsSync(USERS_FILE)) {
      return { version: FILE_VERSION, users: [] };
    }
    const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf-8')) as unknown;
    return parseUserFile(parsed);
  } catch {
    return { version: FILE_VERSION, users: [] };
  }
}

function saveUserFile(file: UserFile): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, USERS_FILE);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPasswordHash(password: string, encoded: string): boolean {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = parts[1];
  const expectedHex = parts[2];
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'utf-8');
  const expected = Buffer.from(expectedHex, 'utf-8');

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function ensureAdminExists(file: UserFile, adminPassword: string): UserFile {
  const users = [...file.users];
  const now = Date.now();
  const admin = users.find(user => user.id === 'admin' || user.username === 'admin');

  if (admin) {
    if (!admin.id) admin.id = 'admin';
    if (admin.id !== 'admin' && !users.find(user => user.id === 'admin')) {
      admin.id = 'admin';
    }
    if (admin.role !== 'admin') {
      admin.role = 'admin';
      admin.updatedAt = now;
    }
    if (!admin.passwordHash && adminPassword.trim()) {
      admin.passwordHash = hashPassword(adminPassword.trim());
      admin.updatedAt = now;
    }
    return { ...file, users };
  }

  if (!adminPassword.trim()) {
    throw new Error('ADMIN_PANEL_PASSWORD is required to bootstrap admin user');
  }

  users.push({
    id: 'admin',
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    passwordHash: hashPassword(adminPassword.trim()),
    createdAt: now,
    updatedAt: now,
  });

  return {
    ...file,
    users,
  };
}

function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
}

function validateUsername(username: string): void {
  if (!USERNAME_REGEX.test(username)) {
    throw new Error('Username must be 3-32 chars and can include letters, numbers, dot, dash, underscore');
  }
}

let cachedUsers: UserRecord[] = [];

export function initializeUserStore(adminPassword: string): UserRecord[] {
  const file = ensureAdminExists(loadUserFile(), adminPassword);
  saveUserFile(file);
  cachedUsers = file.users;
  return cachedUsers;
}

function loadUsers(): UserRecord[] {
  if (cachedUsers.length > 0) return cachedUsers;
  const file = loadUserFile();
  cachedUsers = file.users;
  return cachedUsers;
}

function persistUsers(users: UserRecord[]): void {
  cachedUsers = [...users];
  saveUserFile({ version: FILE_VERSION, users: cachedUsers });
}

export function listUsers(): Array<Omit<UserRecord, 'passwordHash'>> {
  return loadUsers()
    .map(({ passwordHash: _passwordHash, ...rest }) => rest)
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
}

export function listUserIds(): string[] {
  return loadUsers().map(user => user.id);
}

export function getUserById(id: string): UserRecord | undefined {
  return loadUsers().find(user => user.id === id);
}

export function authenticateUser(usernameInput: string, password: string): Omit<UserRecord, 'passwordHash'> | null {
  const username = normalizeUsername(usernameInput);
  const user = loadUsers().find(item => item.username === username);
  if (!user) return null;
  if (!verifyPasswordHash(password, user.passwordHash)) return null;
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export function createUser(input: CreateUserInput): Omit<UserRecord, 'passwordHash'> {
  const username = normalizeUsername(input.username);
  validateUsername(username);
  validatePassword(input.password);

  const users = [...loadUsers()];
  if (users.some(user => user.username === username)) {
    throw new Error('Username already exists');
  }

  const now = Date.now();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  const id = `u_${now.toString(36)}${randomBytes(3).toString('hex')}`;
  const user: UserRecord = {
    id,
    username,
    displayName: normalizeDisplayName(input.displayName || '', username),
    role,
    passwordHash: hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };

  users.push(user);
  persistUsers(users);

  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export function updateUser(userId: string, input: UpdateUserInput): Omit<UserRecord, 'passwordHash'> {
  const users = [...loadUsers()];
  const index = users.findIndex(user => user.id === userId);
  if (index === -1) throw new Error('User not found');

  const user = users[index];
  const nextRole: UserRole = input.role === 'admin' ? 'admin' : 'user';
  const adminCount = users.filter(item => item.role === 'admin').length;

  if (user.role === 'admin' && nextRole === 'user' && adminCount <= 1) {
    throw new Error('At least one admin user is required');
  }

  users[index] = {
    ...user,
    displayName: input.displayName ? normalizeDisplayName(input.displayName, user.username) : user.displayName,
    role: nextRole,
    updatedAt: Date.now(),
  };

  persistUsers(users);
  const { passwordHash: _passwordHash, ...safe } = users[index];
  return safe;
}

export function setUserPassword(userId: string, nextPassword: string): void {
  validatePassword(nextPassword);
  const users = [...loadUsers()];
  const index = users.findIndex(user => user.id === userId);
  if (index === -1) throw new Error('User not found');

  users[index] = {
    ...users[index],
    passwordHash: hashPassword(nextPassword),
    updatedAt: Date.now(),
  };
  persistUsers(users);
}

export function deleteUser(userId: string): void {
  const users = [...loadUsers()];
  const user = users.find(item => item.id === userId);
  if (!user) throw new Error('User not found');
  if (user.id === 'admin') throw new Error('Default admin cannot be deleted');

  if (user.role === 'admin') {
    const adminCount = users.filter(item => item.role === 'admin').length;
    if (adminCount <= 1) throw new Error('At least one admin user is required');
  }

  persistUsers(users.filter(item => item.id !== userId));
}
