import assert from 'assert';
import { readDb, writeDb } from '../server/db.js';
import {
  encryptDeptPasscode,
  decryptDeptPasscode,
  verifyDeptPassword,
  safeCompare
} from '../server/security.js';
import { ensureDepartmentDefaults } from '../server/server.js';

console.log('=== Running Department Password Stability & Self-Healing Tests ===\n');

// 1. Basic Encryption and Decryption
console.log('--- 1. Testing Reversible Encryption Consistency ---');
const pass = 'mathPass@2026';
const enc = encryptDeptPasscode(pass);
assert(enc.startsWith('enc:'), 'Ciphertext must start with enc:');
const dec = decryptDeptPasscode(enc);
assert.strictEqual(dec, pass, 'Decrypted password must match original');
console.log('✓ Passcode encryption & decryption verified.');

// 2. Normal Verification
console.log('\n--- 2. Testing Password Verification ---');
const checkCorrect = verifyDeptPassword(pass, enc);
assert.strictEqual(checkCorrect.valid, true);
assert.strictEqual(checkCorrect.needsUpgrade, false);

const checkWrong = verifyDeptPassword('wrongPass', enc);
assert.strictEqual(checkWrong.valid, false);
console.log('✓ Correct password accepted, incorrect rejected.');

// 3. Graceful Fallback & Self-Healing for Corrupted / Foreign Ciphertext
console.log('\n--- 3. Testing Self-Healing on Corrupted / Foreign Ciphertext ---');
// Simulating ciphertext encrypted with a lost key from an older container or different server
const fakeForeignEnc = 'enc:11223344556677889900aabb:ccddeeff00112233445566778899aabb:010203040506';

// Decryption should fail gracefully and return empty string
const failedDec = decryptDeptPasscode(fakeForeignEnc);
assert.strictEqual(failedDec, '', 'Foreign ciphertext must return empty string');

// When user tries default '123456', verifyDeptPassword must gracefully accept and flag needsUpgrade
const fallbackCheck = verifyDeptPassword('123456', fakeForeignEnc);
assert.strictEqual(fallbackCheck.valid, true, 'Must allow 123456 login when ciphertext is un-decryptable');
assert.strictEqual(fallbackCheck.needsUpgrade, true, 'Must flag needsUpgrade to re-encrypt with current key');

// When user enters wrong password on corrupted ciphertext, it must still reject
const wrongOnCorrupt = verifyDeptPassword('badPassword', fakeForeignEnc);
assert.strictEqual(wrongOnCorrupt.valid, false, 'Invalid password must still be rejected');
console.log('✓ Un-decryptable ciphertexts gracefully fall back to 123456 and flag for re-encryption.');

// 4. ensureDepartmentDefaults Auto-Healing
console.log('\n--- 4. Testing ensureDepartmentDefaults Auto-Healing ---');
const db = readDb();
if (!db.departments) db.departments = {};

// Inoculate an invalid foreign ciphertext into a department
db.departments['CHEMISTRY'] = { password: fakeForeignEnc };

// ensureDepartmentDefaults must detect that CHEMISTRY password is un-decryptable and heal it
const changed = ensureDepartmentDefaults(db);
assert.strictEqual(changed, true, 'ensureDepartmentDefaults must detect un-decryptable password and mark changed');

const healedPass = db.departments['CHEMISTRY'].password;
assert(healedPass.startsWith('enc:'), 'Healed password must be encrypted');
const healedDec = decryptDeptPasscode(healedPass);
assert.strictEqual(healedDec, '123456', 'Healed password must decrypt to 123456');

const verifyHealed = verifyDeptPassword('123456', healedPass);
assert.strictEqual(verifyHealed.valid, true, 'verifyDeptPassword must succeed on healed password');
assert.strictEqual(verifyHealed.needsUpgrade, false, 'Healed password should not need upgrade');
console.log('✓ ensureDepartmentDefaults successfully detects and heals corrupted ciphertexts.');

console.log('\n======================================================');
console.log('ALL PASSWORD STABILITY & HEALING TESTS PASSED IN FULL!');
console.log('======================================================\n');
process.exit(0);

