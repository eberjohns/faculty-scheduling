import assert from 'assert';
import {
  hashPassword,
  verifyPassword,
  encryptDeptPasscode,
  decryptDeptPasscode,
  verifyDeptPassword,
  generateToken,
  verifyToken,
  sanitizeString,
  sanitizeExcelRows
} from './security.js';

console.log('=== Running Security Module & RBAC Audit Tests ===\n');

// 1. Password Hashing & Legacy Upgrade Tests
console.log('--- 1. Testing Password Hashing & Verification ---');
const plainPass = 'SuperSecret123!';
const hashed = hashPassword(plainPass);
assert(hashed.startsWith('scrypt:'), 'Hash format should start with scrypt:');
assert(hashed.split(':').length === 3, 'Hash should contain scrypt:salt:hash');

// Correct password
const check1 = verifyPassword(plainPass, hashed);
assert.strictEqual(check1.valid, true, 'Valid password check failed');
assert.strictEqual(check1.needsUpgrade, false, 'Scrypt hash should not need upgrade');

// Incorrect password
const check2 = verifyPassword('WrongPassword', hashed);
assert.strictEqual(check2.valid, false, 'Invalid password should fail verification');

// Legacy plain text check & auto-upgrade flag
const legacyCheck = verifyPassword('admin', 'admin');
assert.strictEqual(legacyCheck.valid, true, 'Legacy plain password should match');
assert.strictEqual(legacyCheck.needsUpgrade, true, 'Legacy plain password should trigger needsUpgrade');
console.log('Password Hashing & Legacy Verification: PASSED');

// 2. Department Passcode Reversible Encryption
console.log('\n--- 2. Testing Department Passcode Encryption & Decryption ---');
const originalPasscode = 'deptPass987';
const encrypted = encryptDeptPasscode(originalPasscode);
assert(encrypted.startsWith('enc:'), 'Encrypted passcode should start with enc:');
assert(encrypted !== originalPasscode, 'Encrypted passcode must not be plaintext');

const decrypted = decryptDeptPasscode(encrypted);
assert.strictEqual(decrypted, originalPasscode, 'Decrypted passcode must match original');

const deptVerifyValid = verifyDeptPassword(originalPasscode, encrypted);
assert.strictEqual(deptVerifyValid.valid, true, 'verifyDeptPassword should validate encrypted passcode');
assert.strictEqual(deptVerifyValid.needsUpgrade, false, 'Encrypted passcode should not need upgrade');

// Legacy department plaintext passcode
const deptLegacyVerify = verifyDeptPassword('123456', '123456');
assert.strictEqual(deptLegacyVerify.valid, true, 'verifyDeptPassword should validate legacy plaintext');
assert.strictEqual(deptLegacyVerify.needsUpgrade, true, 'Legacy plaintext should trigger needsUpgrade');
console.log('Department Passcode Encryption & Decryption: PASSED');

// 3. Cryptographic Token Generation & Tamper-Proof Verification
console.log('\n--- 3. Testing Token Generation & Signature Validation ---');
const adminToken = generateToken({ role: 'admin' });
assert(adminToken.startsWith('v1.admin.'), 'Token should have v1.admin prefix');

const verifiedAdmin = verifyToken(adminToken);
assert(verifiedAdmin !== null, 'Token verification failed');
assert.strictEqual(verifiedAdmin.role, 'admin');

const deptToken = generateToken({ role: 'department', departmentName: 'CSE' });
const verifiedDept = verifyToken(deptToken);
assert(verifiedDept !== null, 'Dept token verification failed');
assert.strictEqual(verifiedDept.role, 'department');
assert.strictEqual(verifiedDept.departmentName, 'CSE');

// Tampered token test (modifying role or department)
const tamperedParts = deptToken.split('.');
tamperedParts[1] = 'admin'; // attacker attempts to forge admin token with dept signature
const tamperedToken = tamperedParts.join('.');
const verifiedTampered = verifyToken(tamperedToken);
assert.strictEqual(verifiedTampered, null, 'Tampered token must be rejected');

// Legacy fallback tokens test
assert.deepStrictEqual(verifyToken('admin-token'), { role: 'admin', legacy: true });
assert.deepStrictEqual(verifyToken('dept-token-ECE'), { role: 'department', departmentName: 'ECE', legacy: true });
console.log('Token Generation & Anti-Tamper Signature Verification: PASSED');

// 4. Input Sanitization against Prototype Pollution & Null Bytes
console.log('\n--- 4. Testing Input & Excel Sanitization ---');
const dirtyInput = 'NormalText\0InjectedNullByte';
const cleanInput = sanitizeString(dirtyInput);
assert.strictEqual(cleanInput.includes('\0'), false, 'Null bytes must be stripped');

const dirtyRows = [
  ['__proto__', 'constructor', 'Normal Value\0WithNull'],
  { '__proto__': 'exploit', 'safeKey': 'Value\0Test' }
];
const cleanRows = sanitizeExcelRows(dirtyRows);
assert.strictEqual(cleanRows[0][0], '', '__proto__ must be sanitized to empty');
assert.strictEqual(cleanRows[0][1], '', 'constructor must be sanitized to empty');
assert.strictEqual(cleanRows[0][2], 'Normal ValueWithNull', 'Null bytes must be removed from cells');
assert.strictEqual(cleanRows[1].safeKey, 'ValueTest', 'Null bytes removed from object values');
console.log('Sanitization against Prototype Pollution & Null Bytes: PASSED');

console.log('\n========================================');
console.log('ALL SECURITY VERIFICATION TESTS PASSED!');
console.log('========================================\n');
