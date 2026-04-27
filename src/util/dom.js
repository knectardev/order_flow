const priceCanvas = document.getElementById('priceChart');

const flowCanvas  = document.getElementById('flowChart');

const pctx = priceCanvas.getContext('2d');

const fctx = flowCanvas.getContext('2d');

function resizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  c.width  = Math.max(1, Math.floor(r.width  * dpr));
  c.height = Math.max(1, Math.floor(r.height * dpr));
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: r.width, h: r.height };
}

export { priceCanvas, flowCanvas, pctx, fctx, resizeCanvas };
