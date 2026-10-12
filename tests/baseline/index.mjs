// language: JavaScript, file: tests/baseline/index.mjs
//
// The baseline PERF.md measures against: plain Electron showing the same Discord
// web app, with the same window size, the same GPU flag and no mods at all - no
// preload, no plugin host, no control-server client, and no Hypercord surface of
// any kind in the page (the rail is gone, and the settings pages only exist while
// somebody is looking at them, which this baseline never is). "Added cost" is
// this subtracted from Hypercord's own idle numbers, because Discord itself
// dominates the total either way.
//
//   npx electron tests/baseline --perf=25
import { app, BrowserWindow } from "electron";

app.commandLine.appendSwitch("enable-features", "CalculateNativeWinOcclusion");

function liveTimers() {
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    return handles.filter((h) => h && h.constructor && h.constructor.name === "Timeout").length;
  } catch {
    return -1;
  }
}

function snapshot(label) {
  return {
    label,
    at: new Date().toISOString(),
    timers: liveTimers(),
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Number((m.cpu && m.cpu.percentCPUUsage) || 0),
      memMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
    })),
  };
}

app.whenReady().then(() => {
  const flag = process.argv.find((arg) => arg.startsWith("--perf"));
  const seconds = Math.max(5, Number(String(flag || "").split("=")[1]) || 25);
  // the same idle window knob Hypercord's own perf mode honours, so the two can
  // be interleaved at an identical shape
  const windowMs = Math.max(5000, Number(process.env.HYPERCORD_PERF_WINDOW) || 20000);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: "#1e1f22",
    title: "Hypercord baseline",
    webPreferences: {
      partition: "persist:hypercord-baseline",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  win.webContents.on("will-prevent-unload", (event) => event.preventDefault());
  win.loadURL("https://discord.com/app").catch((err) => console.log("[baseline] discord did not load: " + String((err && err.message) || err)));
  // the same shape as Hypercord's own measurement: settle, prime the CPU delta,
  // then read over one 20 second idle window
  app.getAppMetrics();
  (async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(seconds * 1000);
    app.getAppMetrics();
    await wait(windowMs);
    console.log("BASELINE_PERF " + JSON.stringify(snapshot("discord-only-idle")));
    app.exit(0);
  })();
});
