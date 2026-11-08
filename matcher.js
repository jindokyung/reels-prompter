// 음성인식 결과를 대본 위치에 맞추는 로직. 화면 코드와 분리해 단독으로 시험할 수 있다.
(function (root) {
  const TAIL = 14;      // 들린 말 중 마지막 몇 글자를 비교할지
  const LOOKAHEAD = 45; // 현재 위치에서 몇 글자 앞까지 찾을지

  function normalize(text) {
    return String(text).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  }

  // 숫자를 읽는 소리로 바꾼다. 대본의 "3가지"와 받아쓴 "세 가지"가 같아진다.
  const NATIVE1 = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
  const NATIVE10 = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
  const SINO = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const COUNTER = /^\s*(가지|개|번|명|살|시|달|마리|잔|장|병|군데)/;
  const native = n => (n === 20 ? '스무' : NATIVE10[Math.floor(n / 10)] + NATIVE1[n % 10]);
  function sinoSmall(n) {
    let out = '';
    [[1000, '천'], [100, '백'], [10, '십']].forEach(([unit, name]) => {
      const d = Math.floor(n / unit) % 10;
      if (d) out += (d > 1 ? SINO[d] : '') + name;
    });
    return out + SINO[n % 10];
  }
  function sino(n) {
    if (n === 0) return '영';
    const eok = Math.floor(n / 1e8), man = Math.floor((n % 1e8) / 1e4);
    return (eok ? sinoSmall(eok) + '억' : '') + (man ? (man === 1 ? '' : sinoSmall(man)) + '만' : '') + sinoSmall(n % 1e4);
  }
  function spoken(text) {
    const read = String(text).replace(/%/g, '퍼센트').replace(/\d[\d,]*(\.\d+)?/g, (match, dec, offset, all) => {
      const n = parseInt(match.replace(/,/g, ''), 10);
      if (!Number.isSafeInteger(n)) return match;
      if (dec) return sino(n) + '점' + [...dec.slice(1)].map(d => SINO[+d] || '영').join('');
      const after = all.slice(offset + match.length);
      if (n > 0 && n < 100 && /^\s*번째/.test(after)) return n === 1 ? '첫' : native(n);
      if (n > 0 && n < 100 && COUNTER.test(after)) return native(n);
      return sino(n);
    });
    return normalize(read);
  }

  // 받아쓰기는 비슷한 소리로 틀리는 일이 많아, 소리가 가까우면 작은 차이로만 친다.
  const CHO = [0, 0, 2, 3, 3, 5, 6, 7, 7, 9, 9, 11, 12, 12, 12, 0, 3, 7, 18];
  const JUNG = [0, 1, 2, 3, 4, 1, 6, 3, 8, 9, 10, 10, 12, 13, 14, 10, 16, 17, 18, 19, 20];
  const JONG = [0, 1, 1, 1, 4, 4, 4, 7, 8, 1, 16, 8, 8, 8, 17, 8, 16, 17, 17, 7, 7, 21, 7, 7, 1, 7, 17, 7];
  function soundCost(a, b) {
    if (a === b) return 0;
    const x = a.charCodeAt(0) - 0xAC00, y = b.charCodeAt(0) - 0xAC00;
    if (x < 0 || x > 11171 || y < 0 || y > 11171) return 1;
    const part = (u, v, group, near, far) => (u === v ? 0 : group[u] === group[v] ? near : far);
    const cost =
      part(Math.floor(x / 588), Math.floor(y / 588), CHO, 0.12, 0.45) +
      part(Math.floor((x % 588) / 28), Math.floor((y % 588) / 28), JUNG, 0.1, 0.4) +
      part(x % 28, y % 28, JONG, 0.05, 0.2);
    return Math.min(1, cost);
  }

  function distance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + soundCost(a[i - 1], b[j - 1]));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function scan(script, pos, tail, reach, need) {
    const last = Math.min(script.length, pos + reach);
    let best = pos, bestScore = -1;
    // 지금 자리(end = pos)도 후보에 넣는다. 같은 말이 다시 들어와도 한 글자씩 밀려가지 않는다.
    for (let end = Math.max(pos, 3); end <= last; end++) {
      const len = Math.min(tail.length, end);
      const similarity = 1 - distance(tail.slice(-len), script.slice(end - len, end)) / len;
      if (similarity < need(end - pos)) continue;
      const score = similarity - (end - pos) * 0.002; // 같은 말이 반복되면 가까운 쪽
      if (score > bestScore) { bestScore = score; best = end; }
    }
    return best;
  }

  // script: normalize된 대본, pos: 지금까지 읽은 글자 수, heard: normalize된 들린 말
  // 반환: 새 위치. 뒤로는 가지 않는다.
  function follow(script, pos, heard) {
    const tail = heard.slice(-TAIL);
    if (tail.length < 3) return pos;
    // 짧게 들렸을 때는 우연히 맞을 수 있어 더 엄격하게, 더 가까운 곳만 본다.
    if (tail.length < 6) return scan(script, pos, tail, 10, () => 0.8);
    // 멀리 건너뛸수록 더 확실해야 한다.
    const found = scan(script, pos, tail, LOOKAHEAD, d => 0.62 + Math.max(0, d - 12) * 0.006);
    if (found > pos || tail.length < 10) return found;
    // 앞부분을 잘못 받아써서 안 맞을 때는 마지막 말만으로 가까운 곳을 본다.
    return scan(script, pos, tail.slice(-8), 14, () => 0.78);
  }

  // 잘못 맞은 결과 하나로 대본이 건너뛰지 않게, 멀리 움직일 때는 다음 결과까지 맞아야 움직인다.
  function createTracker(script) {
    const NEAR = 14, BACK = 30, BACK_MIN = 6;
    let confirmed = 0, pending = null;
    const agrees = at => pending !== null && Math.abs(at - pending) <= NEAR;
    const settle = at => { confirmed = at; pending = null; return true; };
    function behind(heard) { // 앞서 잘못 건너뛰었거나 다시 읽을 때 되돌아갈 자리
      const tail = heard.slice(-TAIL);
      if (tail.length < 10) return -1;
      let best = -1, bestSim = 0.85;
      for (let end = confirmed - BACK_MIN - 1; end >= Math.max(tail.length, confirmed - BACK); end--) {
        const sim = 1 - distance(tail, script.slice(end - tail.length, end)) / tail.length;
        if (sim > bestSim) { bestSim = sim; best = end; }
      }
      return best;
    }
    return {
      hear(heard) {
        const next = follow(script, confirmed, heard);
        if (next > confirmed) {
          if (next - confirmed <= NEAR || agrees(next)) return settle(next);
          pending = next;
          return false;
        }
        const back = behind(heard);
        if (back < 0) return false;
        if (agrees(back)) return settle(back);
        pending = back;
        return false;
      },
      jump(at) { confirmed = at; pending = null; },
      get pos() { return confirmed; },
    };
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

  // 마이크 소리 크기(dB)만으로 말하는지와 말 빠르기를 읽는다. 한국어는 음절 하나가 글자 하나라 음절 수로 따라갈 수 있다.
  function createPacer() {
    const DIP = 2, MIN_GAP = 0.09, HANG = 0.22, RECENT_PEAK = 2.5, WINDOW = 2;
    let floor = null, smooth = null, now = 0, voiced = 0;
    let quietFor = 0, speaking = false, lastPeak = -10;
    let up = true, maxV = -100, minV = 0, rate = 6;
    const peaks = [];

    return function step(db, dt) {
      now += dt;
      if (floor === null) { floor = db; smooth = db; }
      smooth += (db - smooth) * 0.5;
      const on = floor + 8, off = floor + 5;
      const recent = now - lastPeak < RECENT_PEAK;

      if (db < floor) floor += (db - floor) * 0.2;
      else if (!recent) floor += dt * 1.5; // 일정한 소음에는 적응한다

      if (smooth > on) { speaking = true; quietFor = 0; }
      else if (smooth < off) { quietFor += dt; if (quietFor >= HANG) speaking = false; }

      if (up) {
        if (smooth > maxV) maxV = smooth;
        if (smooth < maxV - DIP) {
          if (maxV > on && now - lastPeak >= MIN_GAP) {
            lastPeak = now;
            peaks.push(voiced);
          }
          up = false; minV = smooth;
        }
      } else {
        if (smooth < minV) minV = smooth;
        if (smooth > minV + DIP) { up = true; maxV = smooth; }
      }

      const talking = speaking && now - lastPeak < RECENT_PEAK;
      if (talking) {
        voiced += dt;
        while (peaks.length && peaks[0] < voiced - WINDOW) peaks.shift();
        if (voiced > 0.6) {
          const measured = peaks.length / Math.min(WINDOW, voiced);
          const target = Math.min(9, Math.max(4, measured));
          rate += (target - rate) * Math.min(1, dt * 1.5);
        }
      }
      return { advance: talking ? rate * dt : 0, talking, quietFor };
    };
  }

  // 말을 멈춘 순간은 대개 줄이 끝난 곳이다. 가까운 줄 경계로 맞춰 쌓인 오차를 없앤다.
  function snapToBoundary(chunks, pos) {
    let best = pos, bestDist = Infinity;
    for (const c of chunks) {
      const tolerance = Math.max(3, Math.ceil((c.end - c.start) * 0.4));
      const dist = Math.abs(c.end - pos);
      if (dist <= tolerance && dist < bestDist) { best = c.end; bestDist = dist; }
    }
    return best;
  }

  const api = { normalize, spoken, follow, createTracker, splitChunks, createPacer, snapToBoundary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
