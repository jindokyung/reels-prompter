// 아이디어·기획·대본을 Claude에게 받아 오는 부분. 키는 폰에만 저장되고 Anthropic으로만 전송된다.
(function (root) {
  const SYSTEM = `너는 뷰티샵 사장님의 인스타 릴스 기획자이자 대본 작가다. 사장님이 카메라를 보고 프롬프터로 직접 읽을 대본을 만든다.

말투와 형식
- 친근한 존댓말 "~해요". 글이 아니라 입으로 말하는 문장으로 쓴다.
- 대본의 한 문장은 25자 안팎으로 짧게 쓰고, 문장마다 줄을 바꾼다.
- 대본은 소리 내어 읽을 말만 쓴다. 괄호 지시, 장면 설명, 이모지, 제목, 번호 표시는 넣지 않는다.
- 첫 문장은 3초 안에 궁금증이나 공감을 만드는 말로 시작하고, 마지막 문장은 저장·댓글·문의 중 하나를 자연스럽게 권한다.
- 대본 길이는 1초에 6글자(띄어쓰기 제외)를 기준으로 요청 길이에 맞춘다.

쓰지 않는 표현
- "결론적으로", "다양한", "~의 세계로 떠나볼까요" 같은 기계적인 문장
- "무조건", "100%", "최고의" 같은 근거 없는 과장
- 통증 없음, 부작용 없음, 효과 보장처럼 시술 결과를 단정하는 말

지어내지 않기
- 샵 정보에 없는 상호, 가격, 위치, 경력, 후기, 숫자는 만들지 않는다. 필요한 자리는 일반적인 표현으로 쓴다.
- 전문 사실이 확실하지 않으면 단정하지 말고 "상담 때 확인해 보세요"처럼 말한다.
- 다른 사람의 저작물(노래 가사, 유행어를 넘어선 대사)을 그대로 쓰지 않는다.`;

  const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const str = { type: 'string' };

  const IDEAS_SCHEMA = obj({
    ideas: { type: 'array', items: obj({ title: str, hook: str, why: str }) },
  });
  const PLAN_SCHEMA = obj({
    title: str,
    goal: str,
    hooks: { type: 'array', items: str },
    scenes: { type: 'array', items: obj({ time: str, screen: str, say: str }) },
    script: str,
  });

  let sdk;
  async function ask(key, prompt, schema, signal) {
    sdk = sdk || (await import('./anthropic.js')).default;
    const client = new sdk({ apiKey: key, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }, { signal });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Friendly('이 주제로는 대본을 만들지 못했어요. 표현을 바꿔서 다시 시도해 주세요.');
    if (message.stop_reason === 'max_tokens') throw new Friendly('내용이 너무 길어져 중간에 끊겼어요. 다시 시도해 주세요.');
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(text);
  }

  class Friendly extends Error {}

  function shopBlock(shop) {
    return shop.trim() ? `샵 정보 (사장님이 직접 적은 내용)\n${shop.trim()}` : '샵 정보: 따로 없음. 특정 샵의 사실을 만들지 말 것.';
  }

  async function getIdeas({ key, topic, shop, seconds, avoid, signal }) {
    const prompt = [
      shopBlock(shop),
      topic.trim() ? `사장님이 다루고 싶은 주제: ${topic.trim()}` : '주제는 정해지지 않았다. 뷰티샵 고객이 궁금해할 만한 주제를 네가 골라라.',
      `영상 길이: ${seconds}초`,
      avoid.length ? `이미 제안한 아이디어 (겹치지 말 것):\n${avoid.join('\n')}` : '',
      '서로 다른 각도의 릴스 아이디어 5개를 제안해라. title은 15자 안팎의 제목, hook은 영상 첫마디로 실제 읽을 문장, why는 이 영상이 왜 저장되거나 문의로 이어질지 한 줄.',
    ].filter(Boolean).join('\n\n');
    const result = await ask(key, prompt, IDEAS_SCHEMA, signal);
    if (!Array.isArray(result.ideas) || !result.ideas.length) throw new Friendly('아이디어를 받지 못했어요. 다시 시도해 주세요.');
    return result.ideas;
  }

  async function writePlan({ key, idea, shop, seconds, previous, revision, signal }) {
    const prompt = [
      shopBlock(shop),
      `선택한 아이디어\n제목: ${idea.title}\n첫마디: ${idea.hook}\n의도: ${idea.why}`,
      `영상 길이: ${seconds}초 (대본은 띄어쓰기 제외 약 ${seconds * 6}자)`,
      previous ? `지금 대본:\n${previous}` : '',
      revision ? `사장님이 고쳐 달라고 한 점: ${revision}` : '',
      'title은 영상 제목, goal은 누구에게 무엇을 전하는 영상인지 한 문장, hooks는 첫 문장 후보 3개, scenes는 시간대별 구성(time 예: 0~3초, screen은 카메라 구도나 보여 줄 것, say는 그 구간의 핵심 말), script는 처음부터 끝까지 읽을 전체 대본이다. script의 첫 문장은 hooks의 첫 번째와 같게 쓴다.',
    ].filter(Boolean).join('\n\n');
    const result = await ask(key, prompt, PLAN_SCHEMA, signal);
    if (!result.script || !result.script.trim()) throw new Friendly('대본을 받지 못했어요. 다시 시도해 주세요.');
    return result;
  }

  // 오류를 사장님이 바로 조치할 수 있는 말로 바꾼다.
  function explain(err) {
    if (err instanceof Friendly) return err.message;
    if (sdk) {
      if (err instanceof sdk.APIUserAbortError) return '';
      if (err instanceof sdk.AuthenticationError) return 'API 키가 맞지 않아요. AI 연결에서 키를 다시 넣어 주세요.';
      if (err instanceof sdk.PermissionDeniedError) return '이 API 키로는 사용할 수 없어요. 콘솔에서 키 권한을 확인해 주세요.';
      if (err instanceof sdk.RateLimitError) return '요청이 많아요. 1분쯤 뒤에 다시 시도해 주세요.';
      if (err instanceof sdk.APIConnectionError) return '인터넷 연결을 확인하고 다시 시도해 주세요.';
      if (err instanceof sdk.APIError) {
        if (err.status === 402 || /credit balance/i.test(err.message)) return 'API 크레딧이 부족해요. console.anthropic.com에서 충전해 주세요.';
        if (err.status >= 500) return 'AI 서버가 바쁜 것 같아요. 잠시 뒤에 다시 시도해 주세요.';
      }
    }
    if (err instanceof SyntaxError) return 'AI 답변을 읽지 못했어요. 다시 시도해 주세요.';
    return '문제가 생겼어요. 다시 시도해 주세요.';
  }

  root.Planner = { getIdeas, writePlan, explain };
})(window);
