import fs from 'node:fs';
import path from 'node:path';
import { sanitizeExtensionArtifacts } from './html-artifacts.mjs';
import { root } from './project-root.mjs';

const sourceDir = path.join(root, 'myhtml');
const liveDir = path.join(root, 'leave-system-live-copy');
const cachedAssetDir = path.join(root, 'scripts', 'assets');

const pages = [
  '步骤1登录.html',
  '步骤2进入首页.html',
  '步骤3点击进出申请进去外出申请.html',
  '步骤4点击外出申请进入申请页.html',
  '步骤3-5进入我的申请查看申请记录等.html',
];

const aliases = new Map([
  ['步骤1登录.html', 'index.html'],
  ['步骤2进入首页.html', 'home.html'],
  ['步骤3点击进出申请进去外出申请.html', 'out.html'],
  ['步骤4点击外出申请进入申请页.html', 'apply.html'],
  ['步骤3-5进入我的申请查看申请记录等.html', 'records.html'],
]);

const sharedResourceAssets = [
  'iconfont-68600351.woff2',
  'iconfont-565904e9.woff',
  'iconfont-b1e08be4.ttf',
  'login_bg2-b3af8c34.jpg',
  'uniicons-89ed7d6d.ttf',
];

const externalDirName = '_external';
const externalAssets = [
  {
    file: 'shadow-grey.png',
    fallbackBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  },
  {
    file: 'font_2225171_8kdcwk4po24.ttf',
    fallbackPath: path.join(cachedAssetDir, 'font_2225171_8kdcwk4po24.ttf'),
  },
];

function copyFresh() {
  fs.rmSync(liveDir, { recursive: true, force: true });
  fs.mkdirSync(liveDir, { recursive: true });
  fs.cpSync(sourceDir, liveDir, { recursive: true, preserveTimestamps: true });
}

function resourceDirName(page) {
  return page.replace(/\.html$/u, '_files');
}

function resourceDirs() {
  return pages.map((page) => path.join(liveDir, resourceDirName(page)));
}

function copySharedResourceAssets() {
  for (const dir of resourceDirs()) {
    for (const assetName of sharedResourceAssets) {
      const sourcePath = path.join(cachedAssetDir, assetName);
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, path.join(dir, assetName));
      }
    }
  }
}

function writeExternalFallbackAssets() {
  const externalDir = path.join(liveDir, externalDirName);
  fs.mkdirSync(externalDir, { recursive: true });

  for (const asset of externalAssets) {
    const outputPath = path.join(externalDir, asset.file);
    if (asset.fallbackPath && fs.existsSync(asset.fallbackPath)) {
      fs.copyFileSync(asset.fallbackPath, outputPath);
      continue;
    }

    if (asset.fallbackBase64) {
      fs.writeFileSync(outputPath, Buffer.from(asset.fallbackBase64, 'base64'));
    }
  }
}

function removeSavedFromComment(html) {
  return html.replace(/<!-- saved from url=\([\s\S]*?\) -->\r?\n?/gi, '');
}

function localizeRemoteAssetRefs(html, page) {
  const dirName = resourceDirName(page);
  return html.replace(/(["'])https?:\/\/esp\.qmxy\.com\/assets\/([^"']+)\1/gi, (_match, quote, fileName) => {
    return `${quote}./${dirName}/${fileName}${quote}`;
  });
}

function injectLiveGuard(html) {
  const script = '<script src="./live-guard.js"></script>';
  if (html.includes(script)) {
    return html;
  }

  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}\n</body>`);
  }

  return `${html}\n${script}\n`;
}

function normalizeLiveHtml(html, page) {
  return injectLiveGuard(localizeRemoteAssetRefs(sanitizeExtensionArtifacts(removeSavedFromComment(html)), page));
}

function createAliasPages(pageHtmlByName) {
  for (const [sourcePage, aliasPage] of aliases.entries()) {
    fs.writeFileSync(path.join(liveDir, aliasPage), pageHtmlByName.get(sourcePage), 'utf8');
  }
}

function localizeStylesheets() {
  const cssFiles = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.css')) {
        cssFiles.push(fullPath);
      }
    }
  }

  walk(liveDir);

  for (const filePath of cssFiles) {
    let css = fs.readFileSync(filePath, 'utf8');
    css = css
      .replaceAll('https://cdn.dcloud.net.cn/img/shadow-grey.png', `../${externalDirName}/shadow-grey.png`)
      .replaceAll('https://at.alicdn.com/t/font_2225171_8kdcwk4po24.ttf', `../${externalDirName}/font_2225171_8kdcwk4po24.ttf`);
    fs.writeFileSync(filePath, css, 'utf8');
  }
}

function createLiveGuard() {
  const guard = `(() => {
  window.__leaveSystemLiveCopy = {
    backendStatus: 'local-json-active',
    recordsEndpoint: '/api/records',
    applicationsEndpoint: '/api/applications',
    submitEndpoint: '/api-general/ScBusinessFormSubmit/submitForm',
    myApplyEndpoint: '/api-general/approvalCenter/getMyApply',
  };
})();
`;

  fs.writeFileSync(path.join(liveDir, 'live-guard.js'), guard, 'utf8');
}

copyFresh();
copySharedResourceAssets();
writeExternalFallbackAssets();

const pageHtmlByName = new Map();

for (const page of pages) {
  const filePath = path.join(liveDir, page);
  const html = normalizeLiveHtml(fs.readFileSync(filePath, 'utf8'), page);
  fs.writeFileSync(filePath, html, 'utf8');
  pageHtmlByName.set(page, html);
}

localizeStylesheets();
createAliasPages(pageHtmlByName);
createLiveGuard();

console.log(`Generated live proxy copy at ${liveDir}`);
