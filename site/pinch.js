// Two-finger pinch zoom for Plotly plots. Plotly itself only handles pinch on map
// traces (plotly/plotly.js#1858, open since 2017), so a pinch is mapped onto the
// public Plotly.relayout: 2D axis ranges zoom around the pinch centre and follow it,
// a 3D camera moves towards or away from its centre. One-finger gestures stay with
// Plotly. Reads a few Plotly internals (marked below); after a Plotly update, check
// pinch zoom.

const MIN_FINGER_DISTANCE = 1;

function fingers(touches) {
  const [a, b] = touches;
  return {
    mid: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
    dist: Math.max(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), MIN_FINGER_DISTANCE),
  };
}

export function enablePinchZoom(el) {
  let start = null;
  let frame = 0;
  let pending = null;

  // Data coordinates of a client position, from the plot area at gesture start.
  const toData = (s, [px, py]) => [
    s.x[0] + (px - s.left) / s.width * (s.x[1] - s.x[0]),
    s.y[1] - (py - s.top) / s.height * (s.y[1] - s.y[0]),
  ];

  function rangeUpdate(s, now) {
    const scale = s.dist / now.dist;
    const [cx, cy] = s.centre;
    const w = (s.x[1] - s.x[0]) * scale, h = (s.y[1] - s.y[0]) * scale;
    const x0 = cx - (now.mid[0] - s.left) / s.width * w;
    const y1 = cy + (now.mid[1] - s.top) / s.height * h;
    return { 'xaxis.range': [x0, x0 + w], 'yaxis.range': [y1 - h, y1] };
  }

  function cameraUpdate(s, now) {
    const scale = s.dist / now.dist;
    const { eye, center, up } = s.camera;
    const moved = Object.fromEntries(['x', 'y', 'z'].map(k => [k, center[k] + (eye[k] - center[k]) * scale]));
    return { 'scene.camera': { eye: moved, center, up } };
  }

  function begin(touches) {
    const layout = el._fullLayout;
    start = null;
    if (!layout) return;
    const f = fingers(touches);
    if (layout.scene) {
      // Internal: the live camera; _fullLayout only catches up on mouseup/wheel, so
      // after a one-finger rotation it would be stale.
      const camera = layout.scene._scene?.getCamera?.() ?? layout.scene.camera;
      if (camera?.eye && camera?.center) start = { dist: f.dist, camera };
    } else {
      const size = layout._size; // Internal: the plot area in pixels.
      const x = el.layout?.xaxis?.range ?? layout.xaxis?.range;
      const y = el.layout?.yaxis?.range ?? layout.yaxis?.range;
      if (!size?.w || !size?.h || !x || !y) return;
      const rect = el.getBoundingClientRect();
      start = {
        dist: f.dist, x: [...x], y: [...y],
        left: rect.left + size.l, top: rect.top + size.t, width: size.w, height: size.h,
      };
      start.centre = toData(start, f.mid);
    }
  }

  function apply() {
    frame = 0;
    const update = pending;
    pending = null;
    // The plot may have been purged or replaced since the move was scheduled.
    if (update && el._fullLayout && update.layout === el._fullLayout) Plotly.relayout(el, update.changes);
  }

  // Capture phase on the container, so two-finger touches never reach Plotly's own
  // drag handlers; preventDefault keeps the browser from zooming the page.
  el.addEventListener('touchstart', e => {
    if (e.touches.length < 2) { start = null; return; }
    e.preventDefault();
    e.stopPropagation();
    // A third finger pauses the pinch until it is lifted again (see end).
    if (e.touches.length > 2) { start = null; return; }
    // Internal: a one-finger pan or rotate may already be under way. Clearing the
    // flag makes Plotly's drag end without replaying it over the pinch.
    el._dragging = false;
    el._dragged = false;
    begin(e.touches);
  }, { capture: true, passive: false });

  el.addEventListener('touchmove', e => {
    if (e.touches.length < 2) return;
    // Also while paused by a third finger, so Plotly's drag never sees these moves.
    e.preventDefault();
    e.stopPropagation();
    if (!start || e.touches.length !== 2) return;
    const now = fingers(e.touches);
    pending = { layout: el._fullLayout, changes: start.camera ? cameraUpdate(start, now) : rangeUpdate(start, now) };
    if (!frame) frame = requestAnimationFrame(apply);
  }, { capture: true, passive: false });

  const end = e => {
    if (frame) { cancelAnimationFrame(frame); apply(); }
    // Back to exactly two fingers (e.g. from three): continue with that pair.
    if (e.touches.length === 2) begin(e.touches);
    else start = null;
  };
  el.addEventListener('touchend', end, { capture: true });
  el.addEventListener('touchcancel', end, { capture: true });
}
