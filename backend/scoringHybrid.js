// scoringHybrid.js (CommonJS)
const cosineSim = require("cosine-similarity");
const { HfInference } = require("@huggingface/inference");

// Hugging Face client
const hf = process.env.HF_ACCESS_TOKEN
  ? new HfInference(process.env.HF_ACCESS_TOKEN)
  : null;

function clamp01(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function chunkText(t) {
  return String(t || "")
    .split(/\n{2,}|(?:\.|\!|\?)\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40); // limit to 40 chunks for speed
}

async function embedBatchHF(texts) {
  if (!texts?.length || !hf) return null;
  try {
    const out = await hf.featureExtraction({
      model: process.env.HF_EMBED_MODEL || "BAAI/bge-small-en-v1.5",
      inputs: texts,
    });
    const arr = Array.isArray(out[0]) ? out : [out];
    return arr.map((v, i) => ({ text: texts[i], embedding: v }));
  } catch (e) {
    return { error: `hf_embed_error:${e?.message || e}` };
  }
}

async function embedBatch(texts) {
  const hfEmb = await embedBatchHF(texts);
  if (Array.isArray(hfEmb)) return { provider: "huggingface", rows: hfEmb };
  return { provider: "none", rows: [], error: hfEmb?.error || "no_provider" };
}

async function buildSemanticJDMatches(jd, rawText) {
  const jdTexts = (jd.items || []).map((it) => `[${it.id}] ${it.text}`);
  const resumeChunks = chunkText(rawText);

  const [jdEmb, resEmb] = await Promise.all([
    embedBatch(jdTexts),
    embedBatch(resumeChunks),
  ]);

  const provider = jdEmb.provider !== "none" ? jdEmb.provider : resEmb.provider;
  if (!Array.isArray(jdEmb.rows) || !Array.isArray(resEmb.rows)) {
    const error = jdEmb.error || resEmb.error || "embedding_failed";
    return { provider, matches: [], error };
  }

  const matches = jdEmb.rows.map((j) => {
    let best = { score: 0, snippet: resumeChunks[0] || "" };
    for (const r of resEmb.rows) {
      const s = cosineSim(j.embedding, r.embedding) || 0;
      if (s > best.score) best = { score: s, snippet: r.text };
    }
    const idMatch = j.text.match(/^\[(.*?)\]/);
    return {
      id: idMatch ? idMatch[1] : "",
      sim: round2(best.score),
      snippet: best.snippet,
    };
  });

  return { provider, matches, error: null };
}

function computeHybridOverall(matches, jdChecklist, weights) {
  const byId = Object.fromEntries((matches || []).map((m) => [m.id, m]));
  let total = 0,
    denom = 0;
  for (const row of jdChecklist || []) {
    const w = (weights && (weights[row.id] ?? row.weight)) ?? 0.05;
    const detPass = row.status === "Pass" ? 1 : 0;
    const sim = clamp01(byId[row.id]?.sim || 0); // 0..1
    const blended = 0.7 * detPass + 0.3 * sim; // ATS + semantic
    total += blended * w * 100;
    denom += w * 100;
  }
  return denom ? Math.round(total / denom) : null;
}

module.exports = { buildSemanticJDMatches, computeHybridOverall };
