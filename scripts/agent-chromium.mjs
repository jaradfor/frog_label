import { access, chmod, copyFile, mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function agentChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const { chromium: playwrightChromium } = await import('@playwright/test');
  const installed = playwrightChromium.executablePath();
  if (await exists(installed)) return installed;

  // tar-fs restores archive ownership when uid=0. Managed agent filesystems often
  // reject chown, so extraction must behave like an unprivileged local install.
  const realGetuid = process.getuid;
  if (realGetuid?.() === 0) process.getuid = () => 1000;
  try {
    const { default: serverlessChromium } = await import('@sparticuz/chromium');
    return await serverlessChromium.executablePath();
  } finally {
    if (realGetuid) process.getuid = realGetuid;
  }
}

export async function prepareAgentPlaywrightTools(root) {
  const browsers = JSON.parse(
    await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'),
  );
  const ffmpeg = browsers.browsers.find((entry) => entry.name === 'ffmpeg');
  if (!ffmpeg?.revision) throw new Error('Playwright FFmpeg revision is unavailable');
  const toolsRoot = path.join(root, '.cache/playwright-agent-tools');
  const targetDirectory = path.join(toolsRoot, `ffmpeg-${ffmpeg.revision}`);
  const target = path.join(targetDirectory, 'ffmpeg-linux');
  if (!(await exists(target))) {
    const source = process.env.FROGLABEL_FFMPEG_EXECUTABLE_PATH || '/usr/bin/ffmpeg';
    if (!(await exists(source))) {
      throw new Error(`System FFmpeg is unavailable at ${source}`);
    }
    await mkdir(targetDirectory, { recursive: true });
    try {
      await symlink(source, target);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        await copyFile(source, target);
        await chmod(target, 0o755);
      }
    }
  }
  return toolsRoot;
}
