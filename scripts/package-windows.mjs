import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const projectDir = process.cwd();
const dirOnly = process.argv.includes('--dir');
const tempOutput = path.join(os.tmpdir(), `prensa-builder-${randomUUID()}`);
const releaseDir = path.join(projectDir, 'release');
const smokeFile = path.join(projectDir, 'release-smoke.json');
const builder = path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js');

fs.mkdirSync(tempOutput, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

const args = ['--win'];
if (dirOnly) args.push('dir');
args.push('--x64', '--publish', 'never', `--config.directories.output=${tempOutput}`);

console.log(`Empacotando fora de Documents para evitar bloqueios do Windows: ${tempOutput}`);
const packed = spawnSync(process.execPath, [builder, ...args], {
  cwd: projectDir,
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true,
});
if (packed.error) throw packed.error;
if (packed.status !== 0) process.exit(packed.status ?? 1);

const unpackedExe = path.join(tempOutput, 'win-unpacked', 'PRENSA.exe');
if (!fs.existsSync(unpackedExe)) throw new Error(`Executável de teste não encontrado: ${unpackedExe}`);

// Alguns ambientes de automação definem isto para usar Electron como Node.
// Um PC normal não define, e o smoke precisa reproduzir esse lançamento real.
const smokeEnv = {
  ...process.env,
  PRENSA_RELEASE_SMOKE: '1',
  PRENSA_SMOKE_OUTPUT: smokeFile,
};
delete smokeEnv.ELECTRON_RUN_AS_NODE;

function verifyExecutable(executable, label, timeout) {
  fs.rmSync(smokeFile, { force: true });
  console.log(`Testando ${label} (HTML, JavaScript e WebGL)...`);
  const smoke = spawnSync(executable, [], {
    cwd: projectDir,
    encoding: 'utf8',
    env: smokeEnv,
    windowsHide: true,
    timeout,
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0 || !fs.existsSync(smokeFile)) {
    throw new Error(`Smoke de ${label} falhou (código ${String(smoke.status)}).`);
  }
  const result = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
  if (!result.ok) throw new Error(`Smoke de ${label} falhou: ${JSON.stringify(result)}`);
  console.log(`${label} validado: WebGL ${result.webgl ? 'OK' : 'FALHOU'}, ${result.size.join('×')}`);
  fs.rmSync(smokeFile, { force: true });
}

verifyExecutable(unpackedExe, 'executável empacotado', 45_000);

if (dirOnly) {
  console.log(`Build descompactado validado em: ${path.join(tempOutput, 'win-unpacked')}`);
  process.exit(0);
}

const artifacts = fs
  .readdirSync(tempOutput)
  .filter((name) => /^PRENSA-(Instalador|Portatil)-.*\.exe$/i.test(name));
if (artifacts.length < 2) {
  throw new Error(`Instalador e portátil não foram gerados: ${artifacts.join(', ') || 'nenhum'}`);
}
const portable = artifacts.find((name) => /Portatil/i.test(name));
if (!portable) throw new Error('Executável portátil não encontrado para validação.');
verifyExecutable(path.join(tempOutput, portable), 'executável portátil', 120_000);
for (const name of artifacts) {
  fs.copyFileSync(path.join(tempOutput, name), path.join(releaseDir, name));
  console.log(`Copiado para release: ${name}`);
}

try {
  fs.rmSync(tempOutput, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
} catch (error) {
  console.warn(`O Windows manteve arquivos temporários em ${tempOutput}: ${String(error)}`);
}
