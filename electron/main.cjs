const { app, BrowserWindow, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'io.github.samshs.prensa';
const smokeMode =
  process.argv.includes('--release-smoke') || process.env.PRENSA_RELEASE_SMOKE === '1';

app.setAppUserModelId(APP_ID);

function writeSmokeResult(value) {
  if (!smokeMode) return;
  const output = process.env.PRENSA_SMOKE_OUTPUT || path.join(process.cwd(), 'release-smoke.json');
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createWindow() {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  const allowedPage = pathToFileURL(indexPath).href;
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  const win = new BrowserWindow({
    title: 'PRENSA',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#090705',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
  });

  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedPage)) event.preventDefault();
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.once('ready-to-show', () => {
    if (!smokeMode) {
      win.maximize();
      win.show();
    }
  });

  try {
    await win.loadFile(indexPath, smokeMode ? { query: { debug: '1' } } : undefined);
  } catch (error) {
    writeSmokeResult({ ok: false, stage: 'loadFile', error: String(error) });
    if (!smokeMode) dialog.showErrorBox('PRENSA não conseguiu iniciar', String(error));
    app.exit(2);
    return;
  }

  if (!smokeMode) return;

  await new Promise((resolve) => setTimeout(resolve, 1800));
  try {
    const result = await win.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('#view');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return {
        ok: document.title === 'PRENSA' && Boolean(canvas) && Boolean(gl) && Boolean(window.prensa),
        title: document.title,
        canvas: Boolean(canvas),
        webgl: Boolean(gl),
        game: Boolean(window.prensa),
        size: canvas ? [canvas.width, canvas.height] : null
      };
    })()`);
    writeSmokeResult(result);
    app.exit(result.ok ? 0 : 3);
  } catch (error) {
    writeSmokeResult({ ok: false, stage: 'executeJavaScript', error: String(error) });
    app.exit(4);
  }
}

app.whenReady().then(createWindow).catch((error) => {
  writeSmokeResult({ ok: false, stage: 'appReady', error: String(error) });
  if (!smokeMode) dialog.showErrorBox('PRENSA não conseguiu iniciar', String(error));
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
