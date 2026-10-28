#!/usr/bin/env node
import 'dotenv/config';
import { getVersionInfo } from '../server/version.js';

async function main() {
  console.log('\n================================================================');
  console.log('   🏫 COLLEGE TIMETABLE SYSTEM - DEPLOYMENT VERSION CHECKER     ');
  console.log('================================================================\n');

  // 1. Get Local Version & Commit Information
  const local = getVersionInfo(true);
  console.log(`📌 Local Repository Status:`);
  console.log(`   - Semantic Version: v${local.version}`);
  console.log(`   - Branch:           ${local.branch}`);
  console.log(`   - Commit Hash:      ${local.commit} (${local.commitFull})`);
  console.log(`   - Commit Date:      ${local.commitDate || 'N/A'}`);
  console.log(`   - Commit Message:   "${local.commitMessage || 'N/A'}"\n`);

  // 2. Determine College Server URL
  const args = process.argv.slice(2);
  let targetUrl = args[0] || process.env.COLLEGE_SERVER_URL || process.env.PRODUCTION_URL || process.env.DEPLOYED_URL;

  if (!targetUrl) {
    console.log('⚠️  No college server URL provided.');
    console.log('   Usage:');
    console.log('     npm run check-deploy <COLLEGE_SERVER_URL>');
    console.log('     (Example: npm run check-deploy http://tt.stthomas.ac.in:8021)');
    console.log('   Or set COLLEGE_SERVER_URL in your .env file:');
    console.log('     COLLEGE_SERVER_URL=http://tt.stthomas.ac.in:8021\n');
    console.log('   Checking local dev server (http://localhost:5000) as fallback...\n');
    targetUrl = 'http://localhost:5000';
  }

  // Normalize URL
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `http://${targetUrl}`;
  }
  targetUrl = targetUrl.replace(/\/+$/, '');
  const versionEndpoint = `${targetUrl}/api/version`;

  console.log(`🌐 Querying Remote Server: ${targetUrl}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let res = null;
    let isVersionRoutePresent = false;
    try {
      res = await fetch(versionEndpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        isVersionRoutePresent = true;
      }
    } catch (e) {
      // Ignore initial failure and check health/root
    }

    if (isVersionRoutePresent && res) {
      clearTimeout(timeout);
      const remote = await res.json();
      console.log('\n📡 Remote Server Response:');
      console.log(`   - Semantic Version: v${remote.version}`);
      console.log(`   - Branch:           ${remote.branch || 'unknown'}`);
      console.log(`   - Commit Hash:      ${remote.commit} (${remote.commitFull || remote.commit})`);
      console.log(`   - Commit Date:      ${remote.commitDate || 'N/A'}`);
      console.log(`   - Commit Message:   "${remote.commitMessage || 'N/A'}"`);
      if (remote.serverUptimeSeconds !== undefined) {
        const hours = Math.floor(remote.serverUptimeSeconds / 3600);
        const mins = Math.floor((remote.serverUptimeSeconds % 3600) / 60);
        console.log(`   - Server Uptime:    ${hours}h ${mins}m`);
      }

      console.log('\n----------------------------------------------------------------');

      const isMatch = (
        (local.commit && remote.commit && (local.commit === remote.commit || local.commitFull === remote.commitFull)) ||
        (local.commitFull && remote.commitFull && local.commitFull.startsWith(remote.commit))
      );

      if (isMatch) {
        console.log('✅ STATUS: COLLEGE SERVER IS 100% UP TO DATE!');
        console.log(`   Both local and college server are running commit [${local.commit}].`);
        console.log('   No deployment or git pull required.\n');
      } else {
        console.log('⚠️  STATUS: COLLEGE SERVER IS OUTDATED! GIT PULL NEEDED!');
        console.log('----------------------------------------------------------------');
        console.log(`   Local HEAD Commit:  ${local.commit} ("${local.commitMessage || ''}")`);
        console.log(`   College Run Commit: ${remote.commit} ("${remote.commitMessage || ''}")`);
        console.log('\n👉 ACTION REQUIRED:');
        console.log('   Please request the College Server Admin to pull updates:');
        console.log('   -------------------------------------------------------------');
        console.log('   1. SSH into the college server:');
        console.log('      cd /path/to/college_time_table');
        console.log('   2. Pull the latest code from GitHub:');
        console.log('      git pull origin main');
        console.log('   3. Restart the service (if using PM2 or systemd):');
        console.log('      pm2 restart all   (or npm start / systemctl restart timetable)');
        console.log('   -------------------------------------------------------------\n');
      }
      return;
    }

    // If /api/version was not found (404), check /health to see if college server is running an older commit
    let healthRes = null;
    try {
      healthRes = await fetch(`${targetUrl}/health`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
    } catch (e) {
      // ignore
    }
    clearTimeout(timeout);

    if (healthRes && healthRes.ok) {
      const healthData = await healthRes.json().catch(() => ({}));
      console.log('\n📡 Remote Server Status:');
      console.log(`   - Connection:       ONLINE (200 OK)`);
      if (healthData.uptime) {
        const hours = Math.floor(healthData.uptime / 3600);
        const mins = Math.floor((healthData.uptime % 3600) / 60);
        console.log(`   - Server Uptime:    ${hours}h ${mins}m active`);
      }
      console.log(`   - Version Endpoint: 404 Not Found (Server is running code prior to this update)`);

      console.log('\n----------------------------------------------------------------');
      console.log('⚠️  STATUS: COLLEGE SERVER IS ONLINE BUT RUNNING AN OLDER COMMIT!');
      console.log('----------------------------------------------------------------');
      console.log(`   The college server at ${targetUrl} is active, but it does`);
      console.log(`   NOT have the latest changes yet.`);
      console.log(`   Local latest commit: ${local.commit} ("${local.commitMessage || ''}")`);
      console.log('\n👉 ACTION REQUIRED:');
      console.log('   The college server needs a git pull to deploy this update:');
      console.log('   -------------------------------------------------------------');
      console.log('   1. Access the college server terminal');
      console.log('   2. Run:');
      console.log('      git pull origin main');
      console.log('   3. Restart node service:');
      console.log('      pm2 restart all   (or npm start / systemctl restart timetable)');
      console.log('   -------------------------------------------------------------\n');
      return;
    }

    // If both failed, try root /
    let rootRes = null;
    try {
      rootRes = await fetch(`${targetUrl}/`);
    } catch (e) {
      // ignore
    }

    if (rootRes && rootRes.ok) {
      console.log('\n📡 Remote Server Status: ONLINE (HTTP 200 on /)');
      console.log('\n----------------------------------------------------------------');
      console.log('⚠️  STATUS: COLLEGE SERVER IS RUNNING AN EARLIER BUILD!');
      console.log('----------------------------------------------------------------');
      console.log('   College server needs a git pull to receive the latest updates.');
      console.log('   Command for college server:');
      console.log('      git pull origin main && pm2 restart all\n');
      return;
    }

    console.log(`\n❌ Could not connect to college server at: ${targetUrl}`);
    console.log('   Ensure the server is running and the port is reachable.');
    process.exit(1);

  } catch (err) {
    console.log(`\n❌ Connection error while contacting: ${targetUrl}`);
    console.log(`   Reason: ${err.message}\n`);
    process.exit(1);
  }
}

main();
