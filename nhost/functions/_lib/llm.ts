// Real LLM call via Groq's OpenAI-compatible API (free tier). If no
// GROQ_API_KEY is set, falls back to a stubbed response with a disclosed
// artificial delay, per the assignment's explicit allowance for that case.

export async function callLLM(prompt: string, model = 'llama-3.1-8b-instant'): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    // disclosed stub — not a real model call
    await new Promise((r) => setTimeout(r, 800));
    return `[STUBBED LLM RESPONSE — no GROQ_API_KEY set] Echo: ${prompt.slice(0, 200)}`;
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
