/**
 * server_reference.js
 *
 * Self-provisioning backend for PVCam (PVC Studio) JSON -> FBX conversion.
 * No manual Blender installation required: on startup, this server
 * looks for a usable Blender binary and, if none is found, downloads
 * and installs a headless copy automatically into a local directory.
 *
 * Provisioning order:
 *   1. BLENDER_BIN env var, if set and executable
 *   2. `blender` already on PATH
 *   3. A previously auto-installed copy in ./vendor/blender/
 *   4. Auto-download the official Linux tarball from download.blender.org,
 *      extract it into ./vendor/blender/, and use that
 *
 * Requirements on the host:
 *   - Linux x86_64 (the auto-installer targets the official Linux tarball;
 *     see "Other platforms" note below if you're on macOS/Windows)
 *   - Node 18+
 *   - `tar` on PATH (standard on virtually every Linux server/container)
 *   - Outbound internet access on first run only, to reach
 *     download.blender.org
 *
 * Install:
 *   npm install express
 *
 * Run:
 *   node server_reference.js
 *
 * First run will print progress while it downloads (~350MB) and
 * extracts Blender. Subsequent runs reuse the installed copy and start
 * instantly.
 *
 * Other platforms: on macOS or Windows dev machines, either install
 * Blender normally and set BLENDER_BIN, or just run this backend
 * inside a Linux container (the auto-install path is designed for
 * exactly that: a fresh container with nothing pre-installed).
 */

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json({ limit: '25mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CONVERT_SCRIPT = path.join(__dirname, 'camtrack_to_fbx.py');
const VENDOR_DIR = path.join(__dirname, 'vendor', 'blender');

// Pinned to the 4.2 LTS line — long-term-support, most predictable for
// a headless server. Override with BLENDER_VERSION/BLENDER_SERIES env
// vars if you want a newer release.
const BLENDER_SERIES = process.env.BLENDER_SERIES || '4.2';
const BLENDER_VERSION = process.env.BLENDER_VERSION || '4.2.10';
const BLENDER_TARBALL = `blender-${BLENDER_VERSION}-linux-x64.tar.xz`;
const BLENDER_URL = `https://download.blender.org/release/Blender${BLENDER_SERIES}/${BLENDER_TARBALL}`;

let resolvedBlenderBin = null; // cached path once resolved

/* ---------------------------------------------------------------- */
/* Provisioning                                                      */
/* ---------------------------------------------------------------- */

function which(bin) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]);
  if (result.status === 0) {
    return result.stdout.toString().trim().split('\n')[0];
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExistingBlender() {
  // 1. Explicit override
  if (process.env.BLENDER_BIN && isExecutable(process.env.BLENDER_BIN)) {
    return process.env.BLENDER_BIN;
  }

  // 2. Already on PATH
  const onPath = which('blender');
  if (onPath && isExecutable(onPath)) {
    return onPath;
  }

  // 3. Previously auto-installed copy
  const localBin = path.join(VENDOR_DIR, 'blender');
  if (isExecutable(localBin)) {
    return localBin;
  }

  return null;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return resolve(downloadFile(res.headers.location, destPath, onProgress));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function autoInstallBlender() {
  console.log(`[pvcam] No Blender found. Auto-installing Blender ${BLENDER_VERSION} (Linux x64)...`);
  console.log(`[pvcam] Source: ${BLENDER_URL}`);

  await fsp.mkdir(VENDOR_DIR, { recursive: true });
  const tarballPath = path.join(VENDOR_DIR, BLENDER_TARBALL);

  let lastPct = -1;
  await downloadFile(BLENDER_URL, tarballPath, (received, total) => {
    const pct = Math.floor((received / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      console.log(`[pvcam] Downloading Blender... ${pct}%`);
      lastPct = pct;
    }
  });
  console.log('[pvcam] Download complete. Extracting...');

  // Extract with strip-components so ./vendor/blender/ directly contains
  // the binary, not an extra nested versioned folder.
  const extract = spawnSync('tar', [
    '-xJf', tarballPath,
    '-C', VENDOR_DIR,
    '--strip-components=1',
  ]);

  if (extract.status !== 0) {
    throw new Error(
      `Extraction failed: ${extract.stderr?.toString() || 'unknown error'}. ` +
      `Make sure 'tar' is installed on this host.`
    );
  }

  await fsp.unlink(tarballPath).catch(() => {});

  const binPath = path.join(VENDOR_DIR, 'blender');
  if (!isExecutable(binPath)) {
    // ensure exec bit in case the tarball permissions didn't survive
    fs.chmodSync(binPath, 0o755);
  }
  if (!isExecutable(binPath)) {
    throw new Error('Extraction succeeded but blender binary is not executable/found.');
  }

  console.log(`[pvcam] Blender installed at ${binPath}`);
  return binPath;
}

async function resolveBlenderBin() {
  if (resolvedBlenderBin) return resolvedBlenderBin;

  const existing = await findExistingBlender();
  if (existing) {
    console.log(`[pvcam] Using existing Blender: ${existing}`);
    resolvedBlenderBin = existing;
    return existing;
  }

  if (process.platform !== 'linux') {
    throw new Error(
      `Auto-install only supports Linux x64 hosts. Detected platform: ${process.platform}. ` +
      `Install Blender manually and set BLENDER_BIN, or run this backend inside a Linux container.`
    );
  }

  const installed = await autoInstallBlender();
  resolvedBlenderBin = installed;
  return installed;
}

/* Sanity-check the resolved binary actually runs headless before we
   ever accept a real conversion request. */
async function verifyBlender(binPath) {
  const result = spawnSync(binPath, ['--background', '--version'], { timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(
      `Blender at ${binPath} failed to run in background mode: ` +
      `${result.stderr?.toString() || result.error?.message || 'unknown error'}`
    );
  }
  const versionLine = result.stdout.toString().split('\n')[0];
  console.log(`[pvcam] Verified: ${versionLine}`);
}

/* Provision once at startup so the first real request isn't slow/blocked
   behind a ~350MB download. */
let provisioningPromise = null;
function ensureProvisioned() {
  if (!provisioningPromise) {
    provisioningPromise = resolveBlenderBin()
      .then(async (binPath) => {
        await verifyBlender(binPath);
        return binPath;
      })
      .catch((err) => {
        // reset so a later request can retry rather than being stuck
        // on a permanently rejected promise
        provisioningPromise = null;
        throw err;
      });
  }
  return provisioningPromise;
}

/* ---------------------------------------------------------------- */
/* Conversion endpoint                                                */
/* ---------------------------------------------------------------- */

app.post('/convert-to-fbx', async (req, res) => {
  const payload = req.body;

  if (!payload || !Array.isArray(payload.keyframes) || payload.keyframes.length === 0) {
    return res.status(400).json({ error: 'Payload must include a non-empty "keyframes" array.' });
  }

  let blenderBin;
  try {
    blenderBin = await ensureProvisioned();
  } catch (e) {
    return res.status(503).json({
      error: 'Blender is not available and auto-install failed.',
      detail: String(e.message || e),
    });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `camtrack_${jobId}.json`);
  const outputPath = path.join(tmpDir, `camtrack_${jobId}.fbx`);

  try {
    fs.writeFileSync(inputPath, JSON.stringify(payload));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write temp input file.', detail: String(e) });
  }

  const args = ['--background', '--python', CONVERT_SCRIPT, '--', inputPath, outputPath];
  const proc = spawn(blenderBin, args, { timeout: 60_000 });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', () => {});

  proc.on('close', (code) => {
    cleanup(inputPath);

    if (code !== 0) {
      cleanup(outputPath);
      return res.status(500).json({
        error: 'Blender conversion failed.',
        code,
        detail: stderr.slice(-2000),
      });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Blender exited cleanly but no FBX was produced.' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="pvcam_camera.fbx"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => cleanup(outputPath));
  });

  proc.on('error', (err) => {
    cleanup(inputPath);
    cleanup(outputPath);
    res.status(500).json({ error: 'Failed to launch Blender.', detail: String(err) });
  });
});

app.get('/health', async (req, res) => {
  try {
    const binPath = await ensureProvisioned();
    res.json({ status: 'ok', blender: binPath });
  } catch (e) {
    res.status(503).json({ status: 'unavailable', detail: String(e.message || e) });
  }
});

function cleanup(filePath) {
  fs.unlink(filePath, () => {});
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`[pvcam] Conversion backend listening on :${PORT}`);
  console.log('[pvcam] Provisioning Blender in the background...');
  ensureProvisioned()
    .then((bin) => console.log(`[pvcam] Ready. Blender: ${bin}`))
    .catch((e) => console.error(`[pvcam] Startup provisioning failed (will retry on first request): ${e.message}`));
});
