// hfJudge.js
const { HfInference } = require("@huggingface/inference");

const hf = process.env.HF_ACCESS_TOKEN
  ? new HfInference(process.env.HF_ACCESS_TOKEN)
  : null;

async function hfJSONJudge(prompt) {
  if (!hf) throw new Error("HF_ACCESS_TOKEN not set");

  const model = process.env.HF_LLM_MODEL || "mistralai/Mistral-7B-Instruct-v0.2";
  const prefix = `You are a strict JSON machine. Reply with JSON ONLY. Do not include explanations or extra text.`;

  const resp = await hf.textGeneration({
    model,
    inputs: `${prefix}\n\n${prompt}\n\nJSON:`,
    parameters: {
      max_new_tokens: 900,
      temperature: 0.2,
      do_sample: false,
      return_full_text: false,
    },
  });

  return (resp.generated_text || "").replace(/```json|```/g, "").trim();
}

module.exports = { hfJSONJudge };
