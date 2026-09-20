// Explain exactly why this browser cannot run the creator. Pure, so it can be tested
// without a GPU: `facts` is what the page observed, the result is what to tell the visitor.
export function explainSupport({ secure, hasGpu, hasAdapter, hasSubgroups, hasStorage, userAgent = '', mobile = false }) {
  if (hasGpu && hasAdapter && hasSubgroups && hasStorage) return { ok: true };
  const browser = /Firefox\//.test(userAgent) ? 'Firefox'
    : /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari' : 'This browser';
  const version = Number(userAgent.match(/(?:Chrome|Edg)\/(\d+)/)?.[1]);
  const device = mobile ? 'phones and tablets' : browser;
  const desktop = 'Open this page in Chrome or Edge on a desktop or laptop to create a scene.';
  let reason, title, fix = desktop;
  if (!secure) {
    reason = 'insecure-context'; title = 'This page needs HTTPS.';
    fix = 'WebGPU only works on https:// pages or localhost. Open the HTTPS address of this site.';
  } else if (!hasGpu) {
    reason = 'no-webgpu'; title = `${mobile ? 'Phones and tablets' : browser} can’t run the trainer yet.`;
    fix = (browser === 'Chrome' || browser === 'Edge') && !mobile
      ? `WebGPU is switched off or unavailable in this ${browser}${version ? ` ${version}` : ''}. Update the browser and check that hardware acceleration is on in its settings.`
      : `Training runs on WebGPU, which ${device === browser ? `${browser} does` : `${device} do`} not provide here. ${desktop}`;
  } else if (!hasAdapter) {
    reason = 'no-adapter'; title = 'The browser could not reach a GPU.';
    fix = 'WebGPU is present, but no graphics adapter was offered. Turn on hardware acceleration in the browser settings, update your graphics driver, or try another computer.';
  } else if (!hasSubgroups) {
    reason = 'no-subgroups'; title = `${mobile ? 'This device' : browser} is missing one WebGPU feature.`;
    fix = (browser === 'Chrome' || browser === 'Edge') && !mobile
      ? `The trainer needs the WebGPU “subgroups” feature, which this ${browser}${version ? ` ${version}` : ''} or its GPU driver does not expose. Update the browser and graphics driver.`
      : `WebGPU works here, but the trainer needs its “subgroups” feature, which ${device === browser ? `${browser} does` : `${device} do`} not expose yet. ${desktop}`;
  } else {
    reason = 'no-storage'; title = 'Browser file storage is unavailable.';
    fix = 'Frames are kept in private browser storage while training. Leave private/incognito browsing or allow site data for this page.';
  }
  return { ok: false, reason, title, fix, status: `${title} ${fix}` };
}

export async function checkSupport() {
  let adapter = null;
  try { adapter = await navigator.gpu?.requestAdapter(); } catch { /* Treated as no adapter. */ }
  return explainSupport({
    secure: window.isSecureContext, hasGpu: !!navigator.gpu, hasAdapter: !!adapter,
    hasSubgroups: !!adapter?.features.has('subgroups'), hasStorage: !!navigator.storage?.getDirectory,
    userAgent: navigator.userAgent,
    mobile: navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent),
  });
}
