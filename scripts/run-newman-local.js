const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const collections = [
  "postman/collections/FIT4110_lab03_iot_ingestion.postman_collection.json"
];

const envFile = 'postman/environments/FIT4110_lab03_local.postman_environment.json';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8000';
const aiVisionUrl = process.env.AI_VISION_URL || 'http://127.0.0.1:4011';

async function runAll() {
  const procs = [];
  try {
    await ensureLocalServers(procs);
    let finalExit = 0;
    for (const col of collections) {
      // eslint-disable-next-line no-await-in-loop
      const code = await runOnce(col);
      if (code !== 0) finalExit = code;
    }
    process.exit(finalExit);
  } finally {
    cleanup(procs);
  }
}

async function ensureLocalServers(procs) {
  const backendHealthUrl = `${baseUrl}/health`;
  const aiVisionHealthUrl = `${aiVisionUrl}/health`;

  const backendHealthy = await checkHealth(backendHealthUrl);
  const aiVisionHealthy = await checkHealth(aiVisionHealthUrl);

  if (backendHealthy && aiVisionHealthy) {
    console.log('Local backend and AI Vision mock are already healthy.');
    return;
  }

  if (!aiVisionHealthy) {
    if (await portIsOpen(4011)) {
      console.log('Port 4011 is in use; assuming AI Vision mock is running and waiting for health.');
    } else {
      console.log('Starting AI Vision mock on port 4011...');
      const vision = spawn('npx prism mock contracts/ai-vision.openapi.yaml -p 4011 --host 0.0.0.0', {
        shell: true,
        stdio: 'inherit',
      });
      procs.push(vision);
    }
  }

  if (!backendHealthy) {
    if (await portIsOpen(8000)) {
      console.log('Port 8000 is in use; waiting for backend health endpoint.');
    } else {
      console.log('Starting local backend on port 8000...');
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const backend = spawn(`${pythonCmd} -m uvicorn main:app --host 127.0.0.1 --port 8000`, {
        shell: true,
        stdio: 'inherit',
      });
      procs.push(backend);
    }
  }

  console.log('Waiting for local servers to become ready...');
  await waitForHealthy([backendHealthUrl, aiVisionHealthUrl], 30000, 500);
}

function portIsOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isOpen = false;
    socket.setTimeout(500);
    socket.on('connect', () => {
      isOpen = true;
      socket.destroy();
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => resolve(isOpen));
    socket.connect(port, host);
  });
}

function checkHealth(url, timeout = 2000) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(timeout, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(urls, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const results = await Promise.all(urls.map((url) => checkHealth(url)));
    if (results.every(Boolean)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for health endpoints: ${urls.join(', ')}`);
}

function cleanup(procs) {
  procs.forEach((proc) => {
    if (!proc || proc.killed) return;
    try {
      proc.kill();
    } catch (err) {
      console.warn('Failed to kill process:', err);
    }
  });
}

function runOnce(collectionPath) {
  return new Promise((resolve) => {
    const name = collectionPath.split('/').pop().replace(/\.postman_collection.json$/, '');
    const outXml = `reports/newman-local-${name}.xml`;
    const cmd = `npx newman run ${collectionPath} -e ${envFile} --env-var baseUrl=${baseUrl} --reporters cli,junit --reporter-junit-export ${outXml}`;
    console.log('Running:', cmd);
    const proc = spawn(cmd, { shell: true, stdio: 'inherit' });
    proc.on('exit', (code) => {
      console.log(`${collectionPath} finished with code`, code);
      resolve(code === null ? 0 : code);
    });
    proc.on('error', (err) => {
      console.error('Newman error:', err);
      resolve(1);
    });
  });
}

runAll();
