const { spawn } = require('child_process');
const waitOn = require('wait-on');
const net = require('net');
const http = require('http');

function spawnCmd(command, name) {
  const proc = spawn(command, { shell: true, stdio: 'inherit' });
  proc.on('error', (err) => console.error(`${name} error:`, err));
  proc.on('exit', (code, sig) => console.log(`${name} exited with ${code || sig}`));
  return proc;
}

function isPortOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      resolved = true;
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(false); }
    });
    socket.once('error', () => {
      if (!resolved) { resolved = true; resolve(false); }
    });
    socket.connect(port, host);
  });
}

async function main() {
  console.log('Starting Prism mocks (iot:4010, vision:4011) if not already running...');
  const resources = ['http://localhost:4010/health', 'http://localhost:4011/health'];

  // Fast-check: if both resources already available, skip spawning
  try {
    await waitOn({ resources, timeout: 2000 });
    console.log('Mocks already running.');
    return runNewman();
  } catch (e) {
    // continue to start missing mocks
  }

  // Determine healthy endpoints or spawn mocks
  const procs = [];
  let iotUrl = 'http://localhost:4010';
  let visionUrl = 'http://localhost:4011';

  const iotPortOpen = await isPortOpen(4010);
  if (iotPortOpen) {
    const ok = await checkHealth(iotUrl);
    if (!ok) {
      console.log('Port 4010 in use but /health not responding; finding alternate port for IoT mock');
      const alt = await findFreePort(4020);
      iotUrl = `http://localhost:${alt}`;
      procs.push(spawnCmd(`npx prism mock contracts/iot-ingestion.openapi.yaml -p ${alt} --host 0.0.0.0`, 'prism-iot'));
    } else {
      console.log('IoT mock healthy at', iotUrl);
    }
  } else {
    procs.push(spawnCmd('npx prism mock contracts/iot-ingestion.openapi.yaml -p 4010 --host 0.0.0.0', 'prism-iot'));
  }

  const visionPortOpen = await isPortOpen(4011);
  if (visionPortOpen) {
    const ok = await checkHealth(visionUrl);
    if (!ok) {
      console.log('Port 4011 in use but /health not responding; finding alternate port for Vision mock');
      const alt = await findFreePort(4021);
      visionUrl = `http://localhost:${alt}`;
      procs.push(spawnCmd(`npx prism mock contracts/ai-vision.openapi.yaml -p ${alt} --host 0.0.0.0`, 'prism-vision'));
    } else {
      console.log('AI Vision mock healthy at', visionUrl);
    }
  } else {
    procs.push(spawnCmd('npx prism mock contracts/ai-vision.openapi.yaml -p 4011 --host 0.0.0.0', 'prism-vision'));
  }

  // Wait for whichever health endpoints we need
  const waitResources = [];
  waitResources.push(`${iotUrl}/health`);
  waitResources.push(`${visionUrl}/health`);

  try {
    console.log('Waiting for mock servers to become available (GET /health)...');
    const ok = await waitForHealthy(waitResources, 30000, 500);
    if (!ok) throw new Error('timed out');
  } catch (err) {
    console.error('Timed out waiting for mocks:', err);
    procs.forEach(p => { try { p.kill(); } catch (e) {} });
    process.exit(1);
  }

  return runNewman(procs, iotUrl, visionUrl);
}

async function waitForHealthy(urls, timeoutMs = 30000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const checks = await Promise.all(urls.map(u => checkHealth(u).catch(() => false)));
    if (checks.every(Boolean)) return true;
    // wait
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

function checkHealth(url, timeout = 1000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        resolve(res.statusCode === 200);
      });
      req.setTimeout(timeout, () => { req.abort(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch (e) { resolve(false); }
  });
}

async function findFreePort(start = 4020, end = 65000) {
  for (let p = start; p <= end; p++) {
    /* eslint-disable no-await-in-loop */
    const open = await isPortOpen(p);
    if (!open) return p;
  }
  throw new Error('No free ports found');
}


async function runNewman(procs = [], iotUrl = 'http://localhost:4010', visionUrl = 'http://localhost:4011') {
  console.log('Mocks are ready — running Newman collections');

  const collections = [
  "postman/collections/FIT4110_lab03_iot_ingestion.postman_collection.json"
];

  const envFile = 'postman/environments/FIT4110_lab03_mock.postman_environment.json';
  let finalExit = 0;

  for (const col of collections) {
    // run sequentially
    // eslint-disable-next-line no-await-in-loop
    const code = await runNewmanOnce(col, envFile, { baseUrl: iotUrl, aiVisionMockUrl: visionUrl });
    if (code !== 0) finalExit = code;
  }

  procs.forEach(p => { try { p.kill(); } catch (e) {} });
  process.exit(finalExit);
}

function runNewmanOnce(collectionPath, envFile, vars = {}) {
  return new Promise((resolve) => {
    const envVarsArgs = Object.entries(vars).map(([k, v]) => `--env-var ${k}=${v}`).join(' ');
    const outXml = `reports/newman-${collectionPath.split('/').pop().replace(/\.postman_collection.json$/, '')}.xml`;
    const cmd = `npx newman run ${collectionPath} -e ${envFile} ${envVarsArgs} --reporters cli,junit --reporter-junit-export ${outXml}`;
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

main();
