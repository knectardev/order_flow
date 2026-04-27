import { state } from '../state.js';

function getVwapAnchors() {
  // VWAP anchors for real-data mode = the session-open of EVERY loaded day.
  // Returned as a sorted array of epoch-ms numbers so computeAnchoredVWAP
  // can zero its cumulative sum each time a bar's time crosses an anchor —
  // this is what makes VWAP visibly "reset" at every RTH open as the user
  // pans across day boundaries. Synthetic mode returns null → existing
  // rolling-window behavior (anchor = oldest visible bar).
  if (state.replay.mode !== 'real' || !state.replay.sessions.length) return null;
  return state.replay.sessions.map(s => s.sessionStartMs);
}

function computeAnchoredVWAP(barsIn, anchors) {
  if (barsIn.length === 0) return [];
  let cumPV = 0, cumV = 0;
  const points = [];
  const anchorList = Array.isArray(anchors)
    ? anchors
    : (anchors != null
        ? [anchors instanceof Date ? anchors.getTime() : new Date(anchors).getTime()]
        : null);
  let nextAnchorIdx = 0;   // index into anchorList of the next not-yet-crossed anchor

  for (const b of barsIn) {
    const tp = (b.high + b.low + b.close) / 3;
    const barMs = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();

    let segmentStart = false;
    if (anchorList) {
      // Cross every anchor at or before this bar. Each crossing zeros the
      // cumulative sum; the bar that triggers the crossing is the first
      // contributor to the new segment.
      while (nextAnchorIdx < anchorList.length && barMs >= anchorList[nextAnchorIdx]) {
        cumPV = 0;
        cumV = 0;
        nextAnchorIdx++;
        segmentStart = true;
      }
      if (nextAnchorIdx === 0) {
        // Bar predates the very first anchor — placeholder VWAP, no
        // accumulation. (Won't happen in practice for real-data mode since
        // bar 0's time === first session's anchor, but kept for safety.)
        points.push({ time: b.time, vwap: tp, segmentStart: false });
        continue;
      }
    }

    cumPV += tp * b.volume;
    cumV  += b.volume;
    points.push({ time: b.time, vwap: cumV > 0 ? cumPV / cumV : tp, segmentStart });
  }
  return points;
}

export { getVwapAnchors, computeAnchoredVWAP };
