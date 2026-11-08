// 음성인식 결과를 대본 위치에 맞추는 로직. 화면 코드와 분리해 단독으로 시험할 수 있다.
(function (root) {
  const TAIL = 14;      // 들린 말 중 마지막 몇 글자를 비교할지
  const LOOKAHEAD = 45; // 현재 위치에서 몇 글자 앞까지 찾을지

  function normalize(text) {
    return String(text).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  }

  function distance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // script: normalize된 대본, pos: 지금까지 읽은 글자 수, heard: normalize된 들린 말
  // 반환: 새 위치. 뒤로는 가지 않는다 (되돌리기는 글자를 눌러서).
  function follow(script, pos, heard) {
    const tail = heard.slice(-TAIL);
    if (tail.length < 3) return pos;
    // 짧게 들렸을 때는 우연히 맞을 수 있어 더 엄격하게, 더 가까운 곳만 본다.
    const short = tail.length < 6;
    const threshold = short ? 0.8 : 0.62;
    const reach = short ? 10 : LOOKAHEAD;
    const last = Math.min(script.length, pos + reach);

    let best = pos;
    let bestScore = -1;
    for (let end = pos + 1; end <= last; end++) {
      const len = Math.min(tail.length, end);
      const piece = script.slice(end - len, end);
      const similarity = 1 - distance(tail.slice(-len), piece) / tail.length;
      if (similarity < threshold) continue;
      const score = similarity - (end - pos) * 0.002; // 같은 말이 반복되면 가까운 쪽
      if (score > bestScore) { bestScore = score; best = end; }
    }
    return best;
  }

  // 대본을 한 줄에 들어가는 짧은 덩어리로 끊는다. 문장부호를 먼저, 그다음 띄어쓰기를 기준으로.
  function splitChunks(text, max) {
    const out = [];
    for (const line of String(text).split(/\n+/)) {
      const parts = line.trim().replace(/([.,!?…]["'”’)]*)\s+/g, '$1\n').split('\n');
      for (const part of parts) {
        const pieces = [];
        let cur = '';
        for (let word of part.split(/\s+/).filter(Boolean)) {
          while (word.length > max) {
            if (cur) { pieces.push(cur); cur = ''; }
            pieces.push(word.slice(0, max));
            word = word.slice(max);
          }
          if (cur && (cur + ' ' + word).length > max) { pieces.push(cur); cur = word; }
          else cur = cur ? cur + ' ' + word : word;
        }
        if (cur) pieces.push(cur);
        // 마지막 줄에 한두 글자만 남지 않게 앞줄의 마지막 낱말을 내려 준다.
        const n = pieces.length;
        if (n > 1 && pieces[n - 1].length <= 3 && pieces[n - 2].includes(' ')) {
          const at = pieces[n - 2].lastIndexOf(' ');
          const moved = pieces[n - 2].slice(at + 1) + ' ' + pieces[n - 1];
          if (moved.length <= max) { pieces[n - 1] = moved; pieces[n - 2] = pieces[n - 2].slice(0, at); }
        }
        out.push(...pieces);
      }
    }
    return out.filter(c => normalize(c));
  }

  const api = { normalize, follow, splitChunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
