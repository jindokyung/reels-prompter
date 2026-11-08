// 촬영본 자동 편집: 자를 곳과 자막 시간을 계산하고, 폰 안에서 영상을 다시 만든다.
(function (root) {
  const PAD = 0.15;         // 말 앞뒤로 남겨 둘 여유 (초)
  const MIN_SILENCE = 0.5;  // 이보다 긴 침묵만 자른다 (초)
  const MIN_KEEP = 0.2;     // 이보다 짧게 남는 조각은 버린다 (초)

  function envelope(samples, rate, frameSec = 0.02) {
    const size = Math.max(1, Math.round(rate * frameSec));
    const out = new Float32Array(Math.floor(samples.length / size));
    for (let f = 0; f < out.length; f++) {
      let sum = 0;
      for (let i = 0; i < size; i++) { const v = samples[f * size + i]; sum += v * v; }
      out[f] = Math.sqrt(sum / size);
    }
    return out;
  }

  function findSilences(env, frameSec) {
    if (!env || !env.length) return [];
    const db = Array.from(env, v => 20 * Math.log10(Math.max(v, 1e-6)));
    const sorted = [...db].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)];
    const loud = sorted[Math.floor(sorted.length * 0.95)];
    if (loud - floor < 12) return []; // 말과 배경이 구분되지 않으면 자르지 않는다
    const threshold = floor + (loud - floor) * 0.35;
    const total = env.length * frameSec;
    const cuts = [];
    let run = -1;
    for (let f = 0; f <= db.length; f++) {
      const quiet = f < db.length && db[f] < threshold;
      if (quiet && run < 0) run = f;
      if (!quiet && run >= 0) {
        const s = run * frameSec, e = f * frameSec;
        if (e - s >= MIN_SILENCE) {
          const from = run === 0 ? 0 : s + PAD;
          const to = f === db.length ? total : e - PAD;
          if (to > from) cuts.push({ start: from, end: to });
        }
        run = -1;
      }
    }
    return cuts;
  }

  // 윗줄을 눌러 다시 읽었다면, 앞선 시도를 NG로 보고 잘라 낸다.
  function resolveTakes(timeline) {
    const kept = [], cuts = [];
    for (const entry of timeline) {
      let from = null;
      while (kept.length && kept[kept.length - 1].i >= entry.i) from = kept.pop().t;
      if (from !== null && entry.t > from) cuts.push({ start: from, end: entry.t });
      kept.push(entry);
    }
    return { kept, cuts };
  }

  function complement(cuts, duration) {
    const sorted = cuts
      .map(c => ({ start: Math.max(0, c.start), end: Math.min(duration, c.end) }))
      .filter(c => c.end > c.start)
      .sort((a, b) => a.start - b.start);
    const keep = [];
    let at = 0;
    for (const c of sorted) {
      if (c.start > at) keep.push({ start: at, end: c.start });
      at = Math.max(at, c.end);
    }
    if (at < duration) keep.push({ start: at, end: duration });
    return keep.filter(k => k.end - k.start >= MIN_KEEP);
  }

  const lengthOf = keep => keep.reduce((sum, k) => sum + k.end - k.start, 0);

  function mapTime(t, keep) {
    let out = 0;
    for (const k of keep) {
      if (t <= k.start) return out;
      if (t < k.end) return out + t - k.start;
      out += k.end - k.start;
    }
    return out;
  }

  function planEdit({ env, frameSec = 0.02, duration, timeline, texts, cut, captions }) {
    let entries = timeline;
    let keep = [{ start: 0, end: duration }];
    if (cut) {
      const takes = resolveTakes(timeline);
      entries = takes.kept;
      const withSilence = complement([...takes.cuts, ...findSilences(env, frameSec)], duration);
      const noSilence = complement(takes.cuts, duration);
      // 소리를 잘못 읽어 거의 다 잘릴 것 같으면 침묵 자르기는 포기한다.
      keep = lengthOf(withSilence) >= Math.max(1, lengthOf(noSilence) * 0.15) ? withSilence : noSilence;
      if (!keep.length) keep = [{ start: 0, end: duration }];
    }
    const outDuration = lengthOf(keep);
    const list = [];
    if (captions) {
      entries.forEach((e, n) => {
        const next = entries[n + 1];
        const start = mapTime(e.t, keep);
        const end = mapTime(next ? next.t : duration, keep);
        if (end - start >= 0.2 && texts[e.i]) list.push({ start, end, text: texts[e.i] });
      });
    }
    return { keep, captions: list, duration: outDuration };
  }

  /* 여기부터 브라우저 전용 */

  // 아이폰은 버튼을 누른 그 순간에만 소리 재생을 허락하므로, 버튼 처리 첫머리에서 부른다.
  // 플레이어를 둘 두고 번갈아 쓴다. 다음 구간을 미리 찾아 두면 녹화를 끊지 않아 화면과 소리가 어긋나지 않는다.
  function prepare(url) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const ctx = new Ctx();
    ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const players = [0, 1].map(() => {
      const video = document.createElement('video');
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      video.src = url;
      video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.append(video);
      ctx.createMediaElementSource(video).connect(dest);
      return video;
    });
    const unlocked = Promise.all(players.map(v => v.play().catch(() => {}).then(() => v.pause())));
    return { ctx, players, dest, unlocked };
  }

  function dispose(job) {
    job.players.forEach(v => { v.pause(); v.removeAttribute('src'); v.remove(); });
    job.ctx.close().catch(() => {});
  }

  function once(target, name, ms) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); target.removeEventListener(name, done); resolve(); };
      const timer = setTimeout(done, ms);
      target.addEventListener(name, done);
    });
  }

  const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  function fit(g, text, weight, size, maxWidth) {
    g.font = `${weight} ${size}px ${FONT}`;
    const width = g.measureText(text).width;
    if (width > maxWidth) {
      size = Math.floor(size * maxWidth / width);
      g.font = `${weight} ${size}px ${FONT}`;
    }
    return size;
  }

  function drawOverlay(g, W, H, caption, title) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (title) {
      const size = fit(g, title, 800, Math.round(W * 0.052), W * 0.84);
      const barW = g.measureText(title).width + size * 1.4;
      const barH = size * 1.9;
      const y = H * 0.19;
      g.fillStyle = '#000';
      g.fillRect((W - barW) / 2, y - barH / 2, barW, barH);
      g.fillStyle = '#fff';
      g.fillText(title, W / 2, y);
    }
    if (caption) {
      const size = fit(g, caption, 800, Math.round(W * 0.07), W * 0.88);
      const y = H * 0.62;
      g.lineJoin = 'round';
      g.lineWidth = size * 0.2;
      g.strokeStyle = 'rgba(0,0,0,.92)';
      g.strokeText(caption, W / 2, y);
      g.fillStyle = '#FFF3B0';
      g.fillText(caption, W / 2, y);
    }
  }

  async function render({ job, canvas, plan, title, format, onProgress, signal }) {
    const { players, dest } = job;
    await job.unlocked;
    await Promise.all(players.map(v => (v.readyState >= 1 ? null : once(v, 'loadedmetadata', 8000))));
    const first = players[0];
    if (!first.videoWidth) throw new Error('video not readable');

    const scale = Math.min(1, 1920 / Math.max(first.videoWidth, first.videoHeight));
    const W = canvas.width = Math.round(first.videoWidth * scale);
    const H = canvas.height = Math.round(first.videoHeight * scale);
    const g = canvas.getContext('2d');

    const tracks = [...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()];
    const recorder = new MediaRecorder(new MediaStream(tracks), { ...(format ? { mimeType: format } : {}), videoBitsPerSecond: 8000000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });

    const seek = (video, t) => { video.currentTime = t; return once(video, 'seeked', 4000); };
    const keep = plan.keep;
    let active = first, done = 0, segStart = keep[0].start, running = false;
    const draw = () => {
      if (active.readyState >= 2) g.drawImage(active, 0, 0, W, H);
      const t = done + (running ? Math.max(0, active.currentTime - segStart) : 0);
      const current = plan.captions.find(c => t >= c.start && t < c.end);
      drawOverlay(g, W, H, current && current.text, title);
      onProgress(Math.min(1, t / plan.duration));
    };
    // 구간마다 "찾아 두기"를 미리 걸어 둔다. 다음 구간은 지금 구간을 재생하는 동안 준비된다.
    const ready = [seek(first, keep[0].start)];
    if (keep[1]) ready[1] = seek(players[1], keep[1].start);
    await ready[0];
    draw();
    const ticker = setInterval(draw, 30);

    try {
      recorder.start(1000);
      for (let k = 0; k < keep.length && !signal.aborted; k++) {
        const cur = players[k % 2], nxt = players[(k + 1) % 2];
        const seg = keep[k];
        await ready[k];
        active = cur; segStart = seg.start; running = true;
        await cur.play();
        await new Promise(resolve => {
          const check = setInterval(() => {
            if (cur.currentTime >= seg.end - 0.02 || cur.ended || signal.aborted) { clearInterval(check); resolve(); }
          }, 10);
        });
        cur.pause();
        running = false;
        done += seg.end - seg.start;
        active = nxt; // 다음 구간의 첫 장면으로 바로 넘긴다
        if (keep[k + 2]) ready[k + 2] = seek(cur, keep[k + 2].start);
      }
    } finally {
      clearInterval(ticker);
      if (recorder.state !== 'inactive') recorder.stop();
    }
    await stopped;
    tracks.forEach(t => t.stop());
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!chunks.length) throw new Error('empty result');
    return new Blob(chunks, { type: recorder.mimeType || format || 'video/mp4' });
  }

  const api = { envelope, findSilences, resolveTakes, mapTime, planEdit, prepare, render, dispose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
