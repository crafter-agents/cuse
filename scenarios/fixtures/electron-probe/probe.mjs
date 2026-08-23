import { app, BrowserWindow, screen } from "electron";

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    await win.loadURL("data:text/html,<html><body style='height:3000px'></body></html>");
    const dpr = await win.webContents.executeJavaScript("window.devicePixelRatio");
    const scroll = await win.webContents.executeJavaScript(
      "({scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight})",
    );
    const display = screen.getPrimaryDisplay();
    const result = {
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      requestedDpr: dpr,
      observedDpr: display.scaleFactor,
      viewport: win.getBounds(),
      scrollGeometry: scroll,
      ownsWindow: !win.isDestroyed(),
    };
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(String(error));
    app.exit(1);
  }
});
