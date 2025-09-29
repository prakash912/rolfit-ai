/* ---------------------------------- Setup --------------------------------- */
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth"); // DOCX -> text
const fetch = require("node-fetch"); // v2
const cheerio = require("cheerio");
const { z } = require("zod");
const Groq = require("groq-sdk");
require("dotenv").config();
const ATS_DETERMINISTIC_ONLY = process.env.ATS_DETERMINISTIC_ONLY !== "false";
// Default: ATS & JD checklist use RESUME ONLY (LinkedIn is bonus for other scores)
const ATS_USE_LINKEDIN = process.env.ATS_USE_LINKEDIN === "true"; // default false
// Context guards on ambiguous tags (recommended "guarded"; set "naive" to disable)
const ATS_CONTEXT_MODE = process.env.ATS_CONTEXT_MODE || "guarded"; // "guarded" | "naive"

function atsBaseText(resumeText, liText) {
  return stripWhitespace(
    (resumeText || "") + (ATS_USE_LINKEDIN ? "\n" + (liText || "") : "")
  );
}

// function tagMatch(tag, tokens, rawText, role) {
//   const norm = String(tag || "")
//     .toLowerCase()
//     .trim();
//   const joinTok = (s) => s.replace(/\s+/g, ""); // for token set lookups

//   // Fast path: exact token or substring
//   const naiveHit = tokens.has(joinTok(norm)) || rawText.includes(norm);

//   if (ATS_CONTEXT_MODE === "naive") return naiveHit;

//   // --- Context guards for ambiguous HR terms ---
//   if (role === "hr_recruiter") {
//     if (norm === "pipeline") {
//       // require hiring context near "pipeline" (±20 chars)
//       const ctx =
//         /\b(?:hiring|talent|recruit(?:er|ment)?|candidate)\b.{0,20}\bpipeline\b|\bpipeline\b.{0,20}\b(?:hiring|talent|recruit(?:er|ment)?|candidate)\b/i;
//       const devopsNear =
//         /\b(ci\/?cd|jenkins|github actions|gitlab ci|build|deploy|kubernetes|docker)\b/i;
//       const hit = ctx.test(rawText);
//       if (!hit) return false;
//       // if clearly devops-heavy around "pipeline", discard
//       return !devopsNear.test(rawText);
//     }
//     if (norm === "recruiter") {
//       // avoid counting generic "recruiters" from LI banners; prefer resume phrases
//       const rx = /\b(technical|it)?\s*recruiter(s)?\b|\brecruitment\b/i;
//       return rx.test(rawText);
//     }
//     if (norm === "technical hiring" || norm === "tech roles") {
//       const rx =
//         /\b(technical|tech)\s+hiring\b|\bhiring\s+(for|of)\s+(tech|engineering|it)\b/i;
//       return rx.test(rawText);
//     }
//   }

//   // default fallback
//   return naiveHit;
// }
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// whole-phrase match with boundaries (no lookbehind needed)
function hasWhole(raw, needle) {
  const safe = escapeRe(needle.trim());
  // boundaries = non-alnum on both sides (or string edges)
  const re = new RegExp(`(^|[^A-Za-z0-9])${safe}([^A-Za-z0-9]|$)`, "i");
  return re.test(raw);
}

// check if A appears within N chars of any of the context words (B)
function near(raw, a, ctxWords, N = 32) {
  const safeA = escapeRe(a.trim());
  const reA = new RegExp(safeA, "ig");
  let m;
  while ((m = reA.exec(raw))) {
    const start = Math.max(0, m.index - N);
    const end = Math.min(raw.length, m.index + m[0].length + N);
    const window = raw.slice(start, end);
    for (const w of ctxWords) {
      const reW = new RegExp(`\\b${escapeRe(w)}\\b`, "i");
      if (reW.test(window)) return true;
    }
  }
  return false;
}

function tagMatch(tag, tokens, rawText, role) {
  const norm = String(tag || "")
    .toLowerCase()
    .trim();
  const joinTok = (s) => s.replace(/\s+/g, "");

  // strict word/phrase hit (no substring cheating)
  const tokenHit = tokens.has(joinTok(norm)) || tokens.has(norm);
  const phraseHit = hasWhole(rawText, norm);
  let hit = tokenHit || phraseHit;

  if (ATS_CONTEXT_MODE === "naive") return hit;

  // ---------- Global guard: brand/tool names must be whole words ----------
  // Fixes: "lever" vs "leveraged", "git" vs "digital"
  if (["lever", "greenhouse", "zoho", "git"].includes(norm)) {
    return hasWhole(rawText, norm); // no tokens / no substring
  }

  // ---------- HR-only guards (reduce false positives from dev resumes) ----------
  if (role === "hr_recruiter") {
    // already guarded in your code: pipeline. Keep but rewrite to near().
    if (norm === "pipeline") {
      const hrNear = [
        "hiring",
        "talent",
        "recruiter",
        "recruitment",
        "candidate",
      ];
      const devopsNear = [
        "ci/cd",
        "jenkins",
        "github actions",
        "gitlab ci",
        "build",
        "deploy",
        "kubernetes",
        "docker",
      ];
      const hrCtx = near(rawText, "pipeline", hrNear, 24);
      const devopsCtx = devopsNear.some((t) =>
        near(rawText, "pipeline", [t], 28)
      );
      return hit && hrCtx && !devopsCtx;
    }

    // super ambiguous: appears a lot in dev resumes ("end-to-end testing")
    if (norm === "end-to-end") {
      const hrCtx = [
        "recruitment",
        "hiring",
        "candidate",
        "screening",
        "offer",
        "negotiation",
        "shortlist",
      ];
      const devCtx = ["testing", "qa", "e2e", "service", "feature", "system"];
      return (
        hit &&
        near(rawText, "end-to-end", hrCtx, 28) &&
        !near(rawText, "end-to-end", devCtx, 28)
      );
    }

    if (norm === "screening") {
      const mustNear = [
        "candidate",
        "resume",
        "cv",
        "profile",
        "phone",
        "interview",
        "sourcing",
      ];
      return hit && near(rawText, "screening", mustNear, 28);
    }

    if (norm === "offer" || norm === "negotiation") {
      const mustNear = [
        "candidate",
        "salary",
        "comp",
        "compensation",
        "ctc",
        "accept",
        "close",
        "rollout",
      ];
      return (
        hit && (hasWhole(rawText, norm) || near(rawText, norm, mustNear, 28))
      );
    }

    if (norm === "recruiter") {
      // prefer explicit recruiter phrasing
      return /\b(technical|it)?\s*recruiter(s)?\b|\brecruitment\b/i.test(
        rawText
      );
    }

    if (norm === "technical hiring" || norm === "tech roles") {
      return /\b(technical|tech)\s+hiring\b|\bhiring\s+(for|of)\s+(tech|engineering|it)\b/i.test(
        rawText
      );
    }
  }

  // default: return the strict hit
  return hit;
}

// function sanitizeChecklist(jd_checklist, detChecklist, candidateText, role) {
//   const raw = String(candidateText || "").toLowerCase();
//   const detMap = new Map(detChecklist.map(r => [r.id, r]));
//   const LVL_ORDER = { Weak: 0, Medium: 1, Strong: 2 };
//   const LVL_BY_IDX = ["Weak","Medium","Strong"];

//   return (jd_checklist || []).map(row => {
//     const det = detMap.get(row.id);
//     // Start from LLM row, but clamp to deterministic
//     let status = det ? det.status : row.status;
//     let level  = det ? det.level  : row.level;

//     // If deterministic Fail, force Fail+Weak
//     if (det && det.status === "Fail") {
//       status = "Fail";
//       level  = "Weak";
//     } else if (det && det.status === "Pass") {
//       // If deterministic Pass, allow only same-or-lower level than deterministic
//       const detIdx = LVL_ORDER[det.level] ?? 0;
//       const llmIdx = LVL_ORDER[row.level] ?? detIdx;
//       level = LVL_BY_IDX[Math.min(detIdx, llmIdx)];
//     }

//     // Evidence must be literal substring of candidate text
//     const evidence_spans = (row.evidence_spans || []).filter(
//       s => s && s.text && raw.includes(String(s.text).toLowerCase())
//     ).slice(0, 3);

//     // Extra guard for HR items to prevent dev “end-to-end/pipeline” collisions
//     if (role === "hr_recruiter" && status === "Pass" &&
//         (row.id === "full_cycle" || row.id === "it_recruitment_experience")) {
//       const hrSignal = /\b(recruit(ment|er)|candidate|screen(ing)?|shortlist|offer|negotiat(e|ion)|sourcing)\b/i.test(raw);
//       if (!hrSignal) { status = "Fail"; level = "Weak"; }
//     }

//     return { ...row, status, level, evidence_spans };
//   });
// }

// function sanitizeChecklist(jd_checklist, detChecklist, candidateText, role) {
//   const raw = String(candidateText || "").toLowerCase();
//   const detMap = new Map(detChecklist.map(r => [r.id, r]));
//   const LVL_ORDER = { Weak: 0, Medium: 1, Strong: 2 };
//   const LVL_BY_IDX = ["Weak","Medium","Strong"];

//   // “Looks like role” anchors (lightweight)
//   const ROLE_ANCHORS = {
//     hr_recruiter: /\b(recruit(?:ment|er)|candidate|sourc(?:ing|e)|screen(?:ing)?|shortlist|offer|negotiat(?:e|ion)|boolean search|linkedin recruiter|naukri|indeed|greenhouse|lever|zoho)\b/i,
//     software_engineer: /\b(react|vue|angular|next|node|express|typescript|javascript|java|python|api|graphql|sql|mongodb|postgres|aws|docker|kubernetes)\b/i,
//     qa_engineer: /\b(qa|test(?:ing)?|automation|selenium|cypress|playwright|defect|bug|testrail|postman|regression)\b/i,
//     project_manager: /\b(plan|scope|gantt|milestone|roadmap|stakeholder|status report|risk|raid|budget)\b/i,
//     business_analyst: /\b(requirements|user stories|brd|frd|acceptance criteria|figma|wireframe|stakeholder)\b/i,
//     tech_lead: /\b(architecture|architected|design|code review|mentoring|roadmap|scalable|microservices)\b/i,
//     drupal_developer: /\b(drupal|twig|drush|module|hook_|paragraphs)\b/i,
//   };
//   const looksLikeRole = ROLE_ANCHORS[role] ? ROLE_ANCHORS[role].test(raw) : true;

//   // HR false-positive collision from DevOps “pipeline”
//   const DEVOPS_NEAR = /\b(ci\/?cd|jenkins|github actions?|gitlab ci|build|deploy|docker|kubernetes)\b/i;

//   return (jd_checklist || []).map(row => {
//     const det = detMap.get(row.id);

//     // Start from deterministic baseline
//     let status = det ? det.status : row.status;
//     let level  = det ? det.level  : row.level;

//     if (det && det.status === "Fail") {
//       // keep Fail (LLM can't upgrade)
//       status = "Fail";
//       level  = "Weak";
//     } else if (det && det.status === "Pass") {
//       // NEVER worse than deterministic: lock to deterministic level
//       status = "Pass";
//       level  = det.level;
//     } else {
//       // no deterministic row; clamp LLM level to valid range
//       const llmIdx = LVL_ORDER[row.level] ?? 0;
//       level = LVL_BY_IDX[Math.max(0, Math.min(2, llmIdx))];
//     }

//     // keep only literal evidence from candidate text
//     const evidence_spans = (row.evidence_spans || [])
//       .filter(s => s && s.text && raw.includes(String(s.text).toLowerCase()))
//       .slice(0, 3);
//     const hasEvidence = evidence_spans.length > 0;

//     // Cross-role guard: apply **only when deterministic was Fail or missing**
//     if ((!det || det.status === "Fail") && status === "Pass" && !looksLikeRole && !hasEvidence) {
//       status = "Fail";
//       level  = "Weak";
//     }

//     // Extra HR guard (only when deterministic was Fail or missing)
//     if (role === "hr_recruiter" && (!det || det.status === "Fail") && status === "Pass" &&
//        (row.id === "full_cycle" || row.id === "it_recruitment_experience" ||
//         row.id === "sourcing_platforms" || row.id === "ats_tools")) {

//       const hasHR = ROLE_ANCHORS.hr_recruiter.test(raw);
//       const devopsCollision =
//         /\b(pipeline|end-?to-?end|ownership)\b/i.test(raw) && DEVOPS_NEAR.test(raw);

//       if (!hasHR || devopsCollision) {
//         status = "Fail";
//         level  = "Weak";
//       }
//     }

//     return { ...row, status, level, evidence_spans };
//   });
// }

function sanitizeChecklist(jd_checklist, detChecklist, candidateText, role) {
  const raw = String(candidateText || "").toLowerCase();
  const rawNorm = raw.replace(/\s+/g, " ").trim();

  const detMap = new Map(detChecklist.map((r) => [r.id, r]));
  const LVL_ORDER = { Weak: 0, Medium: 1, Strong: 2 };
  const LVL_BY_IDX = ["Weak", "Medium", "Strong"];

  // Light role anchors (soft gating)
  // const ROLE_ANCHORS = {
  //   hr_recruiter: /\b(recruit(?:ment|er)|candidate|sourc(?:ing|e)|screen(?:ing)?|shortlist|offer|negotiat(?:e|ion)|boolean search|linkedin recruiter|naukri|indeed|greenhouse|lever|zoho)\b/i,
  //   software_engineer: /\b(react|vue|angular|next|node|express|typescript|javascript|java|python|api|graphql|sql|mongodb|postgres|aws|docker|kubernetes)\b/i,
  //   qa_engineer: /\b(qa|test(?:ing)?|automation|selenium|cypress|playwright|defect|bug|testrail|postman|regression)\b/i,
  //   project_manager: /\b(plan|scope|gantt|milestone|roadmap|stakeholder|status report|risk|raid|budget)\b/i,
  //   business_analyst: /\b(requirements|user stories|brd|frd|acceptance criteria|figma|wireframe|stakeholder)\b/i,
  //   tech_lead: /\b(architecture|architected|design|code review|mentoring|roadmap|scalable|microservices)\b/i,
  //   drupal_developer: /\b(drupal|twig|drush|module|hook_|paragraphs)\b/i,
  // };

  const ROLE_ANCHORS = {
    hr_recruiter:
      /\b(recruit(?:ment|er)|candidate|sourc(?:ing|e)|screen(?:ing)?|shortlist|offer|negotiat(?:e|ion)|boolean search|linkedin recruiter|naukri|indeed|greenhouse|lever|zoho)\b/i,
    software_engineer:
      /\b(react|vue|angular|next|node|express|typescript|javascript|java|python|api|graphql|sql|mongodb|postgres|aws|docker|kubernetes)\b/i,
    qa_engineer:
      /\b(qa|test(?:ing)?|automation|selenium|cypress|playwright|defect|bug|testrail|postman|regression)\b/i,
    project_manager:
      /\b(plan|scope|gantt|milestone|roadmap|stakeholder|status report|risk|raid|budget)\b/i,
    business_analyst:
      /\b(requirements|user stories|brd|frd|acceptance criteria|figma|wireframe|stakeholder)\b/i,
    tech_lead:
      /\b(architecture|architected|design|code review|mentoring|roadmap|scalable|microservices)\b/i,
    drupal_developer: /\b(drupal|twig|drush|module|hook_|paragraphs)\b/i,

    // NEW:
    frontend_engineer_react:
      /\b(react|hooks|redux|zustand|next(?:js)?|vite|webpack|typescript|jest|testing library|cypress|playwright|mui|tailwind)\b/i,
    frontend_engineer_vue_nuxt:
      /\b(vue(?:3)?|composition api|pinia|vuex|nuxt(?:3)?|vite|typescript|jest|vitest|cypress|playwright|vuetify|quasar|tailwind)\b/i,
    backend_engineer_node:
      /\b(node(?:js)?|express|nest|api|rest|graphql|postgres|mysql|mongodb|prisma|jwt|oauth|redis|kafka)\b/i,
    backend_engineer_python:
      /\b(python|django|fastapi|flask|pydantic|api|postgres|mysql|mongodb|sqlalchemy|jwt|oauth|celery|asyncio)\b/i,
    aws_devops_engineer:
      /\b(aws|ec2|s3|iam|vpc|rds|lambda|cloudfront|api gateway|terraform|cloudformation|cdk|docker|kubernetes|eks|ecr|jenkins|github actions|gitlab ci|cloudwatch|grafana|prometheus)\b/i,
  };

  const looksLikeRole = ROLE_ANCHORS[role]
    ? ROLE_ANCHORS[role].test(raw)
    : true;

  // HR false-positive collision from DevOps “pipeline”
  const DEVOPS_NEAR =
    /\b(ci\/?cd|jenkins|github actions?|gitlab ci|build|deploy|docker|kubernetes)\b/i;

  const stripSemanticPrefix = (s) =>
    String(s || "").replace(/^\s*\[semantic[^\]]*\]\s*/i, "");
  const norm = (s) =>
    stripSemanticPrefix(s).toLowerCase().replace(/\s+/g, " ").trim();

  return (jd_checklist || []).map((row) => {
    const det = detMap.get(row.id);

    // Start from deterministic baseline
    let status = det ? det.status : row.status;
    let level = det ? det.level : row.level;

    if (det && det.status === "Fail") {
      // Default: keep Fail baseline…
      status = "Fail";
      level = "Weak";
    } else if (det && det.status === "Pass") {
      // Never worse than deterministic
      status = "Pass";
      level = det.level;
    } else {
      // No deterministic row; make LLM level sane
      const llmIdx = LVL_ORDER[row.level] ?? 0;
      level = LVL_BY_IDX[Math.max(0, Math.min(2, llmIdx))];
    }

    // Keep evidence only if it literally appears (after stripping [semantic …])
    const evidence_spans = (row.evidence_spans || [])
      .filter((s) => {
        const t = norm(s.text);
        return t && rawNorm.includes(t);
      })
      .slice(0, 3);

    const hasEvidence = evidence_spans.length > 0;

    // If deterministic said Fail but LLM said Pass, be lenient:
    // upgrade to Pass/Weak if we have either evidence OR the resume roughly matches the role.
    if (det && det.status === "Fail" && row.status === "Pass") {
      status = hasEvidence || looksLikeRole ? "Pass" : "Fail";
      level = status === "Pass" ? "Weak" : "Weak"; // Weak either way; only Pass changes scoring
    }

    // Cross-role guard: ONLY soften to Weak, never force Fail
    if (
      (!det || det.status === "Fail") &&
      status === "Pass" &&
      !looksLikeRole &&
      !hasEvidence
    ) {
      status = "Pass";
      level = "Weak";
    }

    // Extra HR guard (hard block only on devops collision)
    if (
      role === "hr_recruiter" &&
      (!det || det.status === "Fail") &&
      status === "Pass" &&
      (row.id === "full_cycle" ||
        row.id === "it_recruitment_experience" ||
        row.id === "sourcing_platforms" ||
        row.id === "ats_tools")
    ) {
      const hasHR = ROLE_ANCHORS.hr_recruiter.test(raw);
      const devopsCollision =
        /\b(pipeline|end-?to-?end|ownership)\b/i.test(raw) &&
        DEVOPS_NEAR.test(raw);

      if (!hasHR && devopsCollision) {
        // Only in this very specific false-positive case, flip to Fail.
        status = "Fail";
        level = "Weak";
      } else if (!hasEvidence) {
        // Otherwise, keep it but cap to Weak.
        status = "Pass";
        level = "Weak";
      }
    }

    return { ...row, status, level, evidence_spans };
  });
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
}); // 8 MB
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = "2025-09-27-adv-backend-v6";

/* ---------------------------- Helpers: general ---------------------------- */
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const pct2 = (n) => round2(clamp01(n) * 100);
const stripWhitespace = (s) => (s || "").replace(/\s+/g, " ").trim();
const toLower = (s) => (s || "").toLowerCase();
const yearNow = new Date().getFullYear();

// ---------- HR insights helpers ----------
function uniqKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = String(x).trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
function clampList(arr, n) {
  return (arr || []).slice(0, n);
}

function findSnippet(text, patterns) {
  const t = String(text || "");
  for (const p of patterns) {
    const r = p instanceof RegExp ? p : new RegExp(p, "i");
    const m = r.exec(t);
    if (m) {
      const start = Math.max(0, m.index - 80);
      const end = Math.min(t.length, m.index + m[0].length + 80);
      return t.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 220);
    }
  }
  return null;
}

function deriveTopTechs(candidateData) {
  const t = (candidateData || "").toLowerCase();
  const techList = [
    "react",
    "next",
    "vue",
    "node",
    "express",
    "nest",
    "typescript",
    "javascript",
    "postgres",
    "mysql",
    "mongodb",
    "redis",
    "aws",
    "ec2",
    "s3",
    "lambda",
    "cloudfront",
    "api gateway",
    "docker",
    "kubernetes",
    "cypress",
    "playwright",
    "selenium",
    "jest",
    "mocha",
    "graphql",
    "rest",
  ];
  const hits = techList.filter((k) => t.includes(k)).slice(0, 6);
  return hits.map((s) =>
    s.toUpperCase() === "REST"
      ? "REST"
      : s.replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function buildDeterministicHRInsights({
  roleFit,
  techDepth,
  delivery,
  atsPct,
  formatting,
  impact,
  recency,
  jd,
  jdChecklist,
  ats,
  resumeText,
  liText,
  candidateData,
}) {
  const strengths = [];
  const weaknesses = [];

  const resumeOrLI =
    resumeText && resumeText.length > 50 ? resumeText : liText || "";
  const topTechs = deriveTopTechs(candidateData).join(", ");

  // Strength: JD alignment
  if (roleFit >= 70) {
    const snip = findSnippet(resumeOrLI, [
      /project|experience|role|responsib/i,
    ]);
    strengths.push(
      `JD Alignment — Impact: Ready to contribute with ${roleFit}% weighted JD fit. Evidence: "${
        snip || "Relevant project bullets present"
      }". Probe: Which JD must-haves are you strongest in and why?`
    );
  }

  // Strength: Technical depth
  if (techDepth >= 65) {
    const snip = findSnippet(resumeOrLI, [
      /react|node|typescript|postgres|mongodb|aws|docker|kubernetes/i,
    ]);
    strengths.push(
      `Technical Depth — Impact: Solid hands-on across ${
        topTechs || "core stack"
      }. Evidence: "${
        snip || "Stack listed in recent roles"
      }". Probe: Walk me through one deep technical decision and alternatives you rejected.`
    );
  }

  // Strength: Delivery/DevOps
  if (delivery >= 60) {
    const snip = findSnippet(resumeOrLI, [
      /ci\/?cd|jenkins|github actions|gitlab ci|docker|kubernetes|deploy/i,
    ]);
    strengths.push(
      `Delivery & DevOps — Impact: Demonstrated CI/CD and deployment ownership. Evidence: "${
        snip || "CI/CD and releases noted"
      }". Probe: Describe your pipeline, tests, and rollback strategy on a recent release.`
    );
  }

  // Strength: Impact orientation
  if (impact >= 40) {
    const snip = findSnippet(resumeOrLI, [
      /\b\d+%|\b\d+x|\b\d+ms|\b(\$|₹)[\d,]+/i,
    ]);
    strengths.push(
      `Outcome Focus — Impact: Uses metrics to prove results. Evidence: "${
        snip || "Quantified results mentioned"
      }". Probe: Pick one metric you moved—how did you isolate your contribution?`
    );
  }

  // Strength: Recency
  if (recency >= 80) {
    const snip = findSnippet(resumeOrLI, [/2024|2025|2023/i]);
    strengths.push(
      `Recent Hands-on — Impact: Up-to-date skills (recency ${recency}%). Evidence: "${
        snip || "Recent years visible"
      }". Probe: What’s the newest tool or pattern you adopted and why?`
    );
  }

  // Transferable/communication (if tokens show)
  if (
    /\b(stakeholder|client|presentation|mentored|lead|led|owned)\b/i.test(
      candidateData
    )
  ) {
    const snip = findSnippet(resumeOrLI, [
      /stakeholder|client|presentation|mentored|led|owned/i,
    ]);
    strengths.push(
      `Collaboration/Ownership — Impact: Communicates and drives work across teams. Evidence: "${
        snip || "Collaboration verbs present"
      }". Probe: Describe a conflict you resolved between engineering and product.`
    );
  }

  // Weakness: Missing MUST items
  const mustSet = new Set(
    (jd.items || []).filter((i) => i.must).map((i) => i.id)
  );
  const mustFails = (jdChecklist || []).filter(
    (r) => r.status !== "Pass" && mustSet.has(r.id)
  );
  if (mustFails.length) {
    const areas = mustFails.map((r) => r.id).join(", ");
    weaknesses.push(
      `Must-Haves Gap — Risk: High. Evidence: "Fails: ${areas}". Mitigation: Complete a small project covering the missing MUST areas and add quantified results. Probe: Which MUST are you addressing first and how?`
    );
  }

  // Weakness: ATS gaps
  const missingTags = (ats?.missing || []).slice(0, 6);
  if (missingTags.length) {
    weaknesses.push(
      `Keyword Coverage — Risk: Medium. Evidence: "Missing: ${missingTags.join(
        ", "
      )}". Mitigation: Blend missing tags into truthful bullets (tools, versions, scope). Probe: Where have you used or can you demo these quickly?`
    );
  }

  // Weakness: Delivery low
  if (delivery < 60) {
    weaknesses.push(
      `Delivery/DevOps Depth — Risk: Medium. Evidence: "CI/CD or release details limited". Mitigation: Document pipeline, test strategy, monitoring; ship a demo with pipeline yaml. Probe: How do you gate releases and monitor post-deploy?`
    );
  }

  // Weakness: Impact evidence low
  if (impact < 40) {
    weaknesses.push(
      `Quantified Impact — Risk: Medium. Evidence: "Few metrics on outcomes". Mitigation: Add 2–3 bullets with %/time/cost deltas per project. Probe: What baseline did you improve and by how much?`
    );
  }

  // Weakness: Formatting
  if (formatting < 60) {
    weaknesses.push(
      `Resume Clarity — Risk: Low. Evidence: "Formatting score ${formatting}%". Mitigation: Standardize sections/bullets/dates; trim fluff. Probe: If we skim 30s, what 3 results should pop out?`
    );
  }

  // Weakness: Recency
  if (recency < 60) {
    weaknesses.push(
      `Recency — Risk: Medium. Evidence: "Last activity older (recency ${recency}%)". Mitigation: Ship a fresh repo or case study using current stack. Probe: What’s the most recent project you can walk me through end-to-end?`
    );
  }

  // Ensure at least 3 strengths by adding safe transferable ones
  while (strengths.length < 3) {
    strengths.push(
      `Transferable Strength — Impact: Clear communication and structured thinking. Evidence: "Well-organized sections / role descriptions". Probe: Explain a complex concept from your resume to a non-engineer.`
    );
  }

  return {
    strengths: clampList(uniqKeepOrder(strengths), 5),
    weaknesses: clampList(uniqKeepOrder(weaknesses), 4),
    hr_strengths_rich: [], // optional—kept simple; you can fill from LLM if present
    hr_weaknesses_rich: [],
    hr_interview_probes: [
      "Walk me through a difficult trade-off you made and why.",
      "How do you design a CI/CD pipeline for safety and speed?",
      "Show me a metric you moved—method, baseline, counter-metrics.",
      "Describe a failure in production and your remediation steps.",
      "How did you align stakeholders with conflicting priorities?",
    ],
    hr_summary: {
      elevator_pitch: `Hands-on ${roleFit}% JD fit with ${techDepth}% technical depth; ${delivery}% delivery signals; focuses on ${
        topTechs || "core web platform"
      }.`,
      must_have_coverage_pct: Math.round(
        100 *
          ((jd.items || []).filter((i) => i.must).length
            ? (jdChecklist || []).filter(
                (r) => r.status === "Pass" && mustSet.has(r.id)
              ).length / (jd.items || []).filter((i) => i.must).length
            : 1)
      ),
      top_driver: roleFit >= 70 ? "Strong JD alignment" : "Solid core stack",
      key_risk: mustFails.length
        ? "Must-have gaps"
        : delivery < 60
        ? "Delivery depth"
        : impact < 40
        ? "Impact evidence"
        : "Moderate risks",
    },
  };
}

/* ----------------------------- Security & JSON ---------------------------- */
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));

/* ---------------------------------- CORS ---------------------------------- */
const ALLOW_ORIGINS = (process.env.CORS_ALLOW || "http://localhost:8080")
  .split(",")
  .map((s) => s.trim());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
  })
);

/* ------------------------------- Rate limit ------------------------------- */
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

/* --------------------------------- JD Bank -------------------------------- */
/**
 * Company-specific JD library with weights per category.
 * You can PATCH/UPSERT via /api/jd/upsert at runtime.
 */
// ---- Role aliases / normalizer ----
const ROLE_ALIASES = {
  hr: "hr_recruiter",
  "hr recruiter": "hr_recruiter",

  "frontend engineer (react)": "frontend_engineer_react",
  "react frontend": "frontend_engineer_react",
  "react developer": "frontend_engineer_react",

  "frontend engineer (vue,nuxt)": "frontend_engineer_vue_nuxt",
  "frontend engineer (vue, nuxt)": "frontend_engineer_vue_nuxt",
  "vue nuxt": "frontend_engineer_vue_nuxt",
  "vue developer": "frontend_engineer_vue_nuxt",

  "backend engineer (nodejs)": "backend_engineer_node",
  "backend engineer (node)": "backend_engineer_node",
  "node backend": "backend_engineer_node",
  "nodejs developer": "backend_engineer_node",

  "backend engineer (python)": "backend_engineer_python",
  "python backend": "backend_engineer_python",
  "python developer": "backend_engineer_python",

  "aws developer": "aws_devops_engineer",
  "devops engineer": "aws_devops_engineer",
  "aws devops": "aws_devops_engineer",
};

function resolveRoleKey(input) {
  const s = String(input || "")
    .toLowerCase()
    .trim();
  if (JD_BANK[s]) return s; // exact key given
  if (ROLE_ALIASES[s]) return ROLE_ALIASES[s]; // exact alias
  // fuzzy contains
  for (const [k, v] of Object.entries(ROLE_ALIASES)) {
    if (s.includes(k)) return v;
  }
  return s; // fallback to raw (may match existing keys like "software_engineer")
}

const JD_BANK = {
  /* ======================= Software Engineer (existing) ======================= */
  software_engineer: {
    weights: {
      foundation: 0.15,
      frontend: 0.15,
      backend: 0.15,
      databases: 0.15,
      cloud_devops: 0.15,
      security_auth: 0.1,
      tdd_quality: 0.05,
      collab_agile: 0.05,
      perf_optim: 0.05,
    },
    items: [
      {
        id: "foundation",
        text: "Strong foundation in software design and data structures",
        must: true,
        tags: ["dsa", "design patterns", "data structures", "algorithms"],
      },
      {
        id: "frontend",
        text: "Proficiency in React.js and/or Vue.js",
        must: true,
        tags: ["react", "vue", "nextjs", "nuxt", "redux", "zustand"],
      },
      {
        id: "backend",
        text: "Proficiency in Node.js (API design, Express/Nest)",
        must: true,
        tags: ["node", "express", "nest", "api", "rest", "graphql"],
      },
      {
        id: "databases",
        text: "Hands-on with relational and NoSQL databases including schema design, indexing, query optimization",
        must: true,
        tags: [
          "postgres",
          "mysql",
          "mongodb",
          "index",
          "query plan",
          "sql",
          "nosql",
        ],
      },
      {
        id: "security_auth",
        text: "Authentication & Security: JWT, OAuth2, session management",
        must: true,
        tags: ["jwt", "oauth", "oauth2", "session", "owasp"],
      },
      {
        id: "cloud_devops",
        text: "AWS services: EC2, S3, RDS, Lambda, API Gateway; CI/CD with GitHub Actions/Jenkins/GitLab CI; Docker",
        must: true,
        tags: [
          "aws",
          "ec2",
          "s3",
          "rds",
          "lambda",
          "api gateway",
          "github actions",
          "jenkins",
          "gitlab",
          "docker",
          "ci/cd",
          "kubernetes",
        ],
      },
      {
        id: "collab_agile",
        text: "Agile collaboration (Scrum, Jira) and Git workflows (branching, PR reviews)",
        must: false,
        tags: [
          "jira",
          "scrum",
          "pull request",
          "pr review",
          "branching",
          "git",
        ],
      },
      {
        id: "perf_optim",
        text: "Performance optimization: FE (bundle, lazy load, caching) + BE (query optimization, API scaling)",
        must: false,
        tags: [
          "bundle",
          "lazy",
          "cache",
          "caching",
          "scaling",
          "profiling",
          "performance",
        ],
      },
      {
        id: "tdd_quality",
        text: "Familiarity with TDD and modern testing workflows",
        must: false,
        tags: [
          "tdd",
          "jest",
          "mocha",
          "cypress",
          "playwright",
          "unit test",
          "integration test",
        ],
      },
      {
        id: "soft_skills",
        text: "Strong problem-solving, debugging, communication",
        must: false,
        tags: [
          "communication",
          "debugging",
          "problem-solving",
          "collaboration",
        ],
      },
    ],
  },

  /* =========================== QA Engineer (existing) ======================== */
  qa_engineer: {
    weights: {
      manual_core: 0.25,
      automation: 0.2,
      api_testing: 0.15,
      stlc_process: 0.15,
      agile_tools: 0.1,
      ci_cd_git: 0.1,
      client_comm: 0.05,
    },
    items: [
      {
        id: "manual_core",
        text: "Comprehensive manual testing of web, mobile, and API apps; strong SDLC/STLC",
        must: true,
        tags: [
          "manual",
          "functional",
          "regression",
          "integration",
          "exploratory",
          "stlc",
          "sdlc",
        ],
      },
      {
        id: "automation",
        text: "Automation with Selenium/Cypress/Playwright; basic scripting (Java/Python/JS)",
        must: true,
        tags: [
          "selenium",
          "cypress",
          "playwright",
          "javascript",
          "python",
          "java",
          "webdriver",
        ],
      },
      {
        id: "api_testing",
        text: "API testing with Postman or REST Assured",
        must: true,
        tags: ["postman", "rest assured", "api", "swagger", "soapui"],
      },
      {
        id: "stlc_process",
        text: "Write/maintain test cases & plans; bugs in Jira/TestRail; Agile ceremonies",
        must: true,
        tags: [
          "testrail",
          "zephyr",
          "jira",
          "standup",
          "sprint",
          "test case",
          "defect",
        ],
      },
      {
        id: "agile_tools",
        text: "Familiarity with Agile methodologies and collaboration",
        must: false,
        tags: ["agile", "scrum", "kanban"],
      },
      {
        id: "ci_cd_git",
        text: "Familiarity with CI/CD pipelines and Git version control",
        must: false,
        tags: [
          "git",
          "ci/cd",
          "pipeline",
          "github actions",
          "jenkins",
          "gitlab ci",
        ],
      },
      {
        id: "client_comm",
        text: "Strong communication, client-facing interactions",
        must: false,
        tags: ["client", "communication", "stakeholder"],
      },
    ],
  },

  /* =============================== Drupal Dev ================================= */
  drupal_developer: {
    weights: {
      drupal_core: 0.12,
      theming_twig: 0.12,
      modules_custom: 0.14,
      drupal_api: 0.12,
      php_js: 0.1,
      sql_db: 0.1,
      version_control: 0.06,
      responsive_accessibility: 0.08,
      migration: 0.08,
      infra_acquia_docker: 0.08,
    },
    items: [
      {
        id: "drupal_core",
        text: "Strong knowledge of Drupal 8/9/10 core (front-end and back-end)",
        must: true,
        tags: [
          "drupal8",
          "drupal 8",
          "drupal9",
          "drupal 9",
          "drupal10",
          "drupal 10",
          "drush",
        ],
      },
      {
        id: "theming_twig",
        text: "Drupal theming with Twig; customise look & feel",
        must: true,
        tags: ["twig", "theme", "theming", "templates", "paragraphs"],
      },
      {
        id: "modules_custom",
        text: "Custom module development for Drupal",
        must: true,
        tags: [
          "custom module",
          "module development",
          "hook_form_alter",
          "hook_menu",
          "hook_entity",
          "entity",
          "form api",
        ],
      },
      {
        id: "drupal_api",
        text: "Strong understanding of Drupal APIs and best practices",
        must: true,
        tags: ["entity api", "form api", "render api", "services", "hook"],
      },
      {
        id: "php_js",
        text: "Expertise in PHP, HTML, CSS, JavaScript/jQuery",
        must: true,
        tags: ["php", "html", "css", "javascript", "jquery"],
      },
      {
        id: "sql_db",
        text: "SQL databases (MySQL/MariaDB) and Drupal's database API",
        must: true,
        tags: ["mysql", "mariadb", "sql", "database api", "query"],
      },
      {
        id: "version_control",
        text: "Version control with Git",
        must: false,
        tags: ["git", "github", "gitlab", "bitbucket"],
      },
      {
        id: "responsive_accessibility",
        text: "Responsive design, cross-browser compatibility, accessibility",
        must: false,
        tags: [
          "responsive",
          "mobile",
          "cross-browser",
          "a11y",
          "accessibility",
        ],
      },
      {
        id: "migration",
        text: "Drupal 8/9/10 migrations & upgrades",
        must: false,
        tags: ["migration", "upgrade", "migrate"],
      },
      {
        id: "infra_acquia_docker",
        text: "Acquia Cloud hosting and/or Docker/containerization",
        must: false,
        tags: ["acquia", "acquia cloud", "docker", "container"],
      },
    ],
  },

  /* ================================ Tech Lead ================================= */
  tech_lead: {
    weights: {
      js_stack: 0.18,
      frontend_arch: 0.12,
      backend_arch: 0.12,
      leadership_mentoring: 0.12,
      quality_testing_ci: 0.1,
      apis_graphql_rest: 0.08,
      data_dbs: 0.08,
      cloud: 0.08,
      agile_delivery: 0.06,
      communication: 0.06,
    },
    items: [
      {
        id: "js_stack",
        text: "Deep hands-on with JavaScript/TypeScript, React, Node.js, Express",
        must: true,
        tags: ["javascript", "typescript", "react", "node", "express", "es6"],
      },
      {
        id: "frontend_arch",
        text: "Frontend architecture (state mgmt, tooling: Webpack/Babel, Redux/Zustand)",
        must: true,
        tags: [
          "webpack",
          "babel",
          "redux",
          "zustand",
          "architecture",
          "design",
        ],
      },
      {
        id: "backend_arch",
        text: "Backend architecture & scalability in Node.js",
        must: true,
        tags: [
          "scalable",
          "microservices",
          "node",
          "api",
          "design",
          "event-driven",
        ],
      },
      {
        id: "leadership_mentoring",
        text: "Technical leadership: mentoring, code reviews, interviews",
        must: true,
        tags: [
          "mentoring",
          "code review",
          "interview",
          "roadmap",
          "technical direction",
        ],
      },
      {
        id: "quality_testing_ci",
        text: "Quality: unit tests (Jest/Mocha) and CI/CD",
        must: false,
        tags: ["jest", "mocha", "ci/cd", "pipeline", "coverage"],
      },
      {
        id: "apis_graphql_rest",
        text: "APIs: REST and GraphQL; integrations",
        must: false,
        tags: ["graphql", "rest", "integration", "3rd party"],
      },
      {
        id: "data_dbs",
        text: "Databases: MongoDB, PostgreSQL, MySQL",
        must: false,
        tags: ["mongodb", "postgres", "mysql", "database"],
      },
      {
        id: "cloud",
        text: "Cloud exposure: AWS/GCP/Azure",
        must: false,
        tags: ["aws", "gcp", "azure", "cloud"],
      },
      {
        id: "agile_delivery",
        text: "Agile/Lean delivery (Scrum/Kanban), estimation & planning",
        must: false,
        tags: ["scrum", "kanban", "estimation", "planning", "sprint"],
      },
      {
        id: "communication",
        text: "Strong communication & cross-functional collaboration",
        must: false,
        tags: ["communication", "collaboration", "stakeholder"],
      },
    ],
  },

  /* ============================== Business Analyst ============================ */
  business_analyst: {
    weights: {
      communication_client: 0.15,
      requirements_docs: 0.18,
      wireframes_figma: 0.12,
      sdlc_basics: 0.1,
      agile_scrum: 0.1,
      tools_pm: 0.1,
      uat_testing: 0.1,
      reporting: 0.08,
      fresher_potential: 0.07,
    },
    items: [
      {
        id: "communication_client",
        text: "Strong written & verbal communication; client interaction",
        must: true,
        tags: ["communication", "client", "stakeholder", "presentation"],
      },
      {
        id: "requirements_docs",
        text: "Gathering & documenting requirements (User Stories/BRD/FRD/AC)",
        must: true,
        tags: [
          "requirements",
          "user stories",
          "brd",
          "frd",
          "acceptance criteria",
        ],
      },
      {
        id: "wireframes_figma",
        text: "Wireframes, process flows, functional specs (Figma preferred)",
        must: false,
        tags: ["figma", "wireframe", "flow", "prototype"],
      },
      {
        id: "sdlc_basics",
        text: "Basic understanding of SDLC",
        must: false,
        tags: ["sdlc", "software lifecycle"],
      },
      {
        id: "agile_scrum",
        text: "Familiarity with Agile/Scrum ceremonies",
        must: false,
        tags: ["agile", "scrum", "standup", "retro", "planning"],
      },
      {
        id: "tools_pm",
        text: "Tools: JIRA, Trello, Asana, Mentis",
        must: false,
        tags: ["jira", "trello", "asana", "mentis"],
      },
      {
        id: "uat_testing",
        text: "Support test cases and UAT",
        must: false,
        tags: ["uat", "test case", "acceptance"],
      },
      {
        id: "reporting",
        text: "Create reports/dashboards; share updates",
        must: false,
        tags: ["report", "dashboard", "status"],
      },
      {
        id: "fresher_potential",
        text: "0-2 years; willing to learn tools & BA practices",
        must: false,
        tags: ["internship", "fresher", "graduate"],
      },
    ],
  },

  /* ============================= Project Manager ============================= */
  project_manager: {
    weights: {
      planning_execution: 0.16,
      team_management: 0.14,
      stakeholder_comm: 0.14,
      risk_issue: 0.12,
      quality_delivery: 0.12,
      agile_scrum: 0.1,
      tools_pm: 0.08,
      technical_knowledge: 0.07,
      certifications: 0.07,
    },
    items: [
      {
        id: "planning_execution",
        text: "Plan & execute projects (scope, timelines, milestones, Gantt)",
        must: true,
        tags: ["plan", "gantt", "milestone", "roadmap"],
      },
      {
        id: "team_management",
        text: "Lead cross-functional teams; sprint ceremonies",
        must: true,
        tags: ["standup", "sprint", "review", "retro", "facilitate"],
      },
      {
        id: "stakeholder_comm",
        text: "Primary contact for stakeholders; status reports & presentations",
        must: true,
        tags: ["stakeholder", "status report", "presentation", "communication"],
      },
      {
        id: "risk_issue",
        text: "Risk management & issue resolution (RAID)",
        must: false,
        tags: ["risk", "dependency", "blocker", "raid"],
      },
      {
        id: "quality_delivery",
        text: "Quality & delivery oversight, deployments, post-launch",
        must: false,
        tags: ["qa", "deployment", "release", "post-launch"],
      },
      {
        id: "agile_scrum",
        text: "Agile/Scrum, Waterfall, Hybrid methods",
        must: false,
        tags: ["agile", "scrum", "kanban", "waterfall", "hybrid"],
      },
      {
        id: "tools_pm",
        text: "Tools: JIRA, Confluence, Trello",
        must: false,
        tags: ["jira", "confluence", "trello"],
      },
      {
        id: "technical_knowledge",
        text: "Basic knowledge of FE/BE tech (JS/Node/Vue/React)",
        must: false,
        tags: ["javascript", "node", "react", "vue"],
      },
      {
        id: "certifications",
        text: "SCRUM certification (mandatory); PMP/CSM/SAFe nice-to-have",
        must: true,
        tags: ["scrum master", "pmp", "csm", "safe"],
      },
    ],
  },

  /* ================================ HR Recruiter ============================= */
  hr_recruiter: {
    weights: {
      it_recruitment_experience: 0.2,
      full_cycle: 0.18,
      sourcing_platforms: 0.12,
      ats_tools: 0.12,
      stakeholder_hiring_mgr: 0.1,
      metrics_reporting: 0.08,
      employer_branding: 0.08,
      communication: 0.07,
      time_management: 0.05,
    },
    items: [
      {
        id: "it_recruitment_experience",
        text: "5+ years of IT recruitment; strong experience in technical hiring",
        must: true,
        tags: ["it recruitment", "technical hiring", "tech roles", "recruiter"],
      },
      {
        id: "full_cycle",
        text: "Full-cycle recruitment ownership",
        must: true,
        tags: ["end-to-end", "offer", "negotiation", "pipeline", "screening"],
      },
      {
        id: "sourcing_platforms",
        text: "Sourcing via LinkedIn/Naukri/Indeed/social",
        must: true,
        tags: [
          "linkedin recruiter",
          "naukri",
          "indeed",
          "boolean search",
          "sourcing",
        ],
      },
      {
        id: "ats_tools",
        text: "ATS tools (Zoho, Lever, Greenhouse)",
        must: true,
        tags: ["ats", "zoho", "lever", "greenhouse"],
      },
      {
        id: "stakeholder_hiring_mgr",
        text: "Partner with hiring managers; requirement definition",
        must: false,
        tags: ["hiring manager", "intake", "requirement"],
      },
      {
        id: "metrics_reporting",
        text: "Track metrics & reporting",
        must: false,
        tags: ["metrics", "report", "time-to-hire", "pipeline health"],
      },
      {
        id: "employer_branding",
        text: "Support employer branding & events",
        must: false,
        tags: ["branding", "events", "evangelism"],
      },
      {
        id: "communication",
        text: "Excellent communication and candidate experience",
        must: false,
        tags: ["communication", "follow-up", "candidate experience"],
      },
      {
        id: "time_management",
        text: "Strong time management; multitask in fast-paced env",
        must: false,
        tags: ["multitask", "prioritize", "fast-paced"],
      },
    ],
  },
  /* ===================== Frontend Engineer (React) ===================== */
  frontend_engineer_react: {
    weights: {
      react_core: 0.2,
      state_tooling: 0.14,
      typescript_testing: 0.12,
      next_ssr_perf: 0.12,
      ui_css: 0.1,
      api_integration: 0.12,
      ci_cd: 0.1,
      accessibility: 0.1,
    },
    items: [
      {
        id: "react_core",
        must: true,
        text: "Strong React fundamentals (hooks, components, effects, context)",
        tags: ["react", "hooks", "context", "jsx", "vite", "webpack", "babel"],
      },
      {
        id: "state_tooling",
        must: true,
        text: "State mgmt & FE tooling (Redux/Zustand + bundlers)",
        tags: ["redux", "zustand", "redux toolkit", "state", "webpack", "vite"],
      },
      {
        id: "typescript_testing",
        must: true,
        text: "TypeScript and FE testing",
        tags: [
          "typescript",
          "ts",
          "jest",
          "vitest",
          "testing library",
          "cypress",
          "playwright",
        ],
      },
      {
        id: "next_ssr_perf",
        must: false,
        text: "Next.js, SSR/SSG, routing, code-splitting, performance",
        tags: [
          "nextjs",
          "next",
          "ssr",
          "ssg",
          "lazy load",
          "bundle",
          "performance",
        ],
      },
      {
        id: "ui_css",
        must: false,
        text: "UI systems & CSS (Tailwind/SCSS/Design System/Storybook)",
        tags: [
          "tailwind",
          "scss",
          "css",
          "material ui",
          "mui",
          "chakra",
          "ant design",
          "storybook",
          "design system",
        ],
      },
      {
        id: "api_integration",
        must: true,
        text: "API integration and data fetching",
        tags: [
          "rest",
          "graphql",
          "api",
          "swr",
          "react query",
          "axios",
          "fetch",
        ],
      },
      {
        id: "ci_cd",
        must: false,
        text: "CI/CD & quality gates",
        tags: ["ci/cd", "github actions", "gitlab ci", "lint", "prettier"],
      },
      {
        id: "accessibility",
        must: false,
        text: "Accessibility & i18n",
        tags: ["a11y", "accessibility", "aria", "lighthouse", "i18n"],
      },
    ],
  },

  /* ================== Frontend Engineer (Vue / Nuxt) =================== */
  frontend_engineer_vue_nuxt: {
    weights: {
      vue_core: 0.2,
      state_tooling: 0.14,
      typescript_testing: 0.12,
      nuxt_ssr_perf: 0.12,
      ui_css: 0.1,
      api_integration: 0.12,
      ci_cd: 0.1,
      accessibility: 0.1,
    },
    items: [
      {
        id: "vue_core",
        must: true,
        text: "Strong Vue fundamentals (Composition API/Options API, components)",
        tags: ["vue", "vue3", "composition api", "options api", "vite"],
      },
      {
        id: "state_tooling",
        must: true,
        text: "State mgmt & FE tooling (Pinia/Vuex + bundlers)",
        tags: ["pinia", "vuex", "state", "webpack", "vite"],
      },
      {
        id: "typescript_testing",
        must: true,
        text: "TypeScript and FE testing",
        tags: ["typescript", "ts", "jest", "vitest", "cypress", "playwright"],
      },
      {
        id: "nuxt_ssr_perf",
        must: false,
        text: "Nuxt, SSR/SSG, routing, code-splitting, performance",
        tags: ["nuxt", "nuxt3", "ssr", "ssg", "lazy load", "performance"],
      },
      {
        id: "ui_css",
        must: false,
        text: "UI systems & CSS (Tailwind/SCSS/Design System/Storybook)",
        tags: [
          "tailwind",
          "scss",
          "css",
          "vuetify",
          "quasar",
          "element plus",
          "storybook",
          "design system",
        ],
      },
      {
        id: "api_integration",
        must: true,
        text: "API integration and data fetching",
        tags: ["rest", "graphql", "api", "axios", "fetch"],
      },
      {
        id: "ci_cd",
        must: false,
        text: "CI/CD & quality gates",
        tags: ["ci/cd", "github actions", "gitlab ci", "lint", "prettier"],
      },
      {
        id: "accessibility",
        must: false,
        text: "Accessibility & i18n",
        tags: ["a11y", "accessibility", "aria", "lighthouse", "i18n"],
      },
    ],
  },

  /* ===================== Backend Engineer (Node.js) ===================== */
  backend_engineer_node: {
    weights: {
      node_core: 0.2,
      api_design: 0.12,
      databases: 0.16,
      auth_security: 0.14,
      testing_obs: 0.12,
      cloud_devops: 0.14,
      architecture: 0.12,
    },
    items: [
      {
        id: "node_core",
        must: true,
        text: "Node.js runtime, Express/Nest, async patterns",
        tags: ["node", "nodejs", "express", "nest", "async", "middleware"],
      },
      {
        id: "api_design",
        must: true,
        text: "API design (REST/GraphQL), versioning, validation",
        tags: ["api", "rest", "graphql", "openapi", "swagger", "zod", "joi"],
      },
      {
        id: "databases",
        must: true,
        text: "Relational/NoSQL, schema/indexing, ORMs",
        tags: [
          "postgres",
          "mysql",
          "mongodb",
          "mongoose",
          "prisma",
          "knex",
          "index",
          "query plan",
          "sql",
          "nosql",
        ],
      },
      {
        id: "auth_security",
        must: true,
        text: "AuthN/Z & security best practices",
        tags: ["jwt", "oauth", "oauth2", "session", "csrf", "owasp", "rbac"],
      },
      {
        id: "testing_obs",
        must: false,
        text: "Testing & observability",
        tags: [
          "jest",
          "mocha",
          "supertest",
          "cypress",
          "playwright",
          "sentry",
          "datadog",
          "winston",
          "pino",
        ],
      },
      {
        id: "cloud_devops",
        must: false,
        text: "Cloud + container basics and CI/CD",
        tags: [
          "aws",
          "gcp",
          "azure",
          "docker",
          "kubernetes",
          "ci/cd",
          "github actions",
          "jenkins",
          "gitlab ci",
        ],
      },
      {
        id: "architecture",
        must: false,
        text: "Scalability & architecture patterns",
        tags: [
          "microservices",
          "event-driven",
          "queue",
          "kafka",
          "rabbitmq",
          "caching",
          "redis",
        ],
      },
    ],
  },

  /* ===================== Backend Engineer (Python) ===================== */
  backend_engineer_python: {
    weights: {
      py_web: 0.2,
      api_design: 0.12,
      databases: 0.16,
      auth_security: 0.14,
      testing_obs: 0.12,
      cloud_devops: 0.14,
      async_tasks: 0.12,
    },
    items: [
      {
        id: "py_web",
        must: true,
        text: "Python web frameworks",
        tags: [
          "python",
          "django",
          "fastapi",
          "flask",
          "asgiref",
          "uvicorn",
          "gunicorn",
        ],
      },
      {
        id: "api_design",
        must: true,
        text: "API design (REST/GraphQL), pydantic/validation",
        tags: ["api", "rest", "graphql", "openapi", "swagger", "pydantic"],
      },
      {
        id: "databases",
        must: true,
        text: "Relational/NoSQL, ORM, migrations",
        tags: [
          "postgres",
          "mysql",
          "mongodb",
          "sqlalchemy",
          "django orm",
          "alembic",
          "index",
          "query plan",
          "sql",
        ],
      },
      {
        id: "auth_security",
        must: true,
        text: "AuthN/Z & security best practices",
        tags: ["jwt", "oauth", "oauth2", "session", "csrf", "owasp", "rbac"],
      },
      {
        id: "testing_obs",
        must: false,
        text: "Testing & observability",
        tags: [
          "pytest",
          "unittest",
          "coverage",
          "sentry",
          "datadog",
          "prometheus",
          "logging",
        ],
      },
      {
        id: "cloud_devops",
        must: false,
        text: "Cloud + container basics and CI/CD",
        tags: [
          "aws",
          "gcp",
          "azure",
          "docker",
          "kubernetes",
          "ci/cd",
          "github actions",
          "jenkins",
          "gitlab ci",
        ],
      },
      {
        id: "async_tasks",
        must: false,
        text: "Async & background jobs",
        tags: ["asyncio", "celery", "rq", "dramatiq", "redis", "rabbitmq"],
      },
    ],
  },

  /* =================== AWS Developer / DevOps Engineer =================== */
  aws_devops_engineer: {
    weights: {
      aws_core: 0.18,
      iac: 0.14,
      ci_cd: 0.14,
      containers: 0.14,
      observability: 0.12,
      networking_security: 0.1,
      scripting_automation: 0.1,
      cost_ha: 0.08,
    },
    items: [
      {
        id: "aws_core",
        must: true,
        text: "AWS core services & day-2 ops",
        tags: [
          "aws",
          "ec2",
          "s3",
          "iam",
          "vpc",
          "rds",
          "elb",
          "alb",
          "route53",
          "cloudfront",
          "lambda",
          "api gateway",
        ],
      },
      {
        id: "iac",
        must: true,
        text: "Infrastructure as Code",
        tags: ["terraform", "terragrunt", "cloudformation", "cdk", "iac"],
      },
      {
        id: "ci_cd",
        must: true,
        text: "CI/CD pipelines",
        tags: [
          "ci/cd",
          "github actions",
          "gitlab ci",
          "jenkins",
          "codebuild",
          "codedeploy",
          "codepipeline",
        ],
      },
      {
        id: "containers",
        must: true,
        text: "Containers & orchestration",
        tags: ["docker", "ecr", "ecs", "eks", "kubernetes", "helm"],
      },
      {
        id: "observability",
        must: false,
        text: "Monitoring, logging, tracing",
        tags: [
          "cloudwatch",
          "prometheus",
          "grafana",
          "loki",
          "tempo",
          "x-ray",
          "sentry",
          "datadog",
        ],
      },
      {
        id: "networking_security",
        must: false,
        text: "Networking & security",
        tags: [
          "iam",
          "kms",
          "security group",
          "nacl",
          "subnet",
          "vpc",
          "waf",
          "shield",
        ],
      },
      {
        id: "scripting_automation",
        must: false,
        text: "Scripting & automation",
        tags: ["bash", "shell", "python", "boto3", "ansible", "packer"],
      },
      {
        id: "cost_ha",
        must: false,
        text: "Cost management & HA",
        tags: [
          "cost explorer",
          "budgets",
          "asg",
          "autoscaling",
          "multi-az",
          "backup",
          "dr",
        ],
      },
    ],
  },
};

/* ------------------------------ Utility: text ------------------------------ */
async function bufferToText(file) {
  const type = (file.mimetype || file.type || "").toLowerCase();
  if (type.includes("pdf")) {
    const data = await pdfParse(file.buffer);
    return stripWhitespace(data.text || "");
  }
  if (
    type.includes("word") ||
    type.includes("docx") ||
    (file.originalname && file.originalname.toLowerCase().endsWith(".docx"))
  ) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return stripWhitespace(value || "");
  }
  throw new Error("Unsupported file type. Please upload PDF or DOCX.");
}

/* ---------------------------- Utility: LinkedIn --------------------------- */
const looksBlocked = (text) => {
  const t = toLower(text);
  return (
    t.includes("sign in") ||
    t.includes("sign-in") ||
    t.includes("you’re signed out") ||
    t.includes("you're signed out") ||
    t.includes("captcha")
  );
};

async function fetchText(url, headers = {}) {
  const resp = await fetch(url, { headers, timeout: 15000 });
  return await resp.text();
}

async function scrapeLinkedInPublic(url) {
  const status = { ok: false, used: false, method: null, reason: "", chars: 0 };
  if (!url)
    return { text: "", status: { ...status, reason: "No URL provided" } };
  if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(url)) {
    status.reason = "Invalid or non-profile URL";
    return { text: "", status };
  }

  // 1) Direct fetch
  try {
    const html = await fetchText(url, {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    });
    const $ = cheerio.load(html);
    const parts = [];
    const metaDesc = $('meta[name="description"]').attr("content");
    if (metaDesc) parts.push(metaDesc);
    const ogDesc = $('meta[property="og:description"]').attr("content");
    if (ogDesc) parts.push(ogDesc);
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        if (json && (json["@type"] === "Person" || json.name || json.headline))
          parts.push(JSON.stringify(json));
      } catch {}
    });
    let visible = $("main").text() || $("body").text();
    visible = stripWhitespace(visible).slice(0, 8000);
    if (visible) parts.push(visible);

    const text = stripWhitespace(parts.join("\n\n"));
    if (text && !looksBlocked(text) && text.length >= 180) {
      status.ok = true;
      status.used = true;
      status.method = "direct";
      status.chars = text.length;
      return { text, status };
    }
  } catch {}

  // 2) r.jina.ai readability proxy
  try {
    const jinaURL = `https://r.jina.ai/http://${url.replace(
      /^https?:\/\//,
      ""
    )}`;
    const jinaText = await fetchText(jinaURL, {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain;q=1.0,*/*;q=0.8",
    });
    const cleaned = stripWhitespace(jinaText).slice(0, 16000);
    if (!cleaned || looksBlocked(cleaned) || cleaned.length < 180) {
      status.reason =
        "No public content extracted (profile likely private or blocked).";
      return { text: "", status };
    }
    status.ok = true;
    status.used = true;
    status.method = "jina";
    status.chars = cleaned.length;
    return { text: cleaned, status };
  } catch (err) {
    status.reason = `Fetch error (proxy): ${err.message}`;
    return { text: "", status };
  }
}

/** ================= Ontology: aliases + implications (all roles) ================= **/
const TAG_ONTOLOGY = {
  // === Core CS / Foundation
  dsa: { aliases: ["dsa", "data structures", "algorithms"], implies: [] },
  "design patterns": { aliases: ["design patterns", "patterns"], implies: [] },

  // === Frontend: React
  react: {
    aliases: ["react", "reactjs", "react.js"],
    implies: ["hooks", "jsx"],
  },
  hooks: {
    aliases: [
      "hooks",
      "useeffect",
      "use state",
      "usecontext",
      "useReducer",
      "useMemo",
    ],
    implies: [],
  },
  context: { aliases: ["context", "react context"], implies: [] },
  jsx: { aliases: ["jsx"], implies: [] },
  nextjs: {
    aliases: ["next", "nextjs", "next.js"],
    implies: ["ssr", "ssg", "routing"],
  },
  ssr: { aliases: ["ssr", "server-side rendering"], implies: [] },
  ssg: { aliases: ["ssg", "static site generation"], implies: [] },
  "react query": {
    aliases: ["react query", "@tanstack/react-query", "tanstack query"],
    implies: [],
  },
  "testing library": {
    aliases: ["testing library", "@testing-library/react"],
    implies: [],
  },

  // state/tooling
  redux: { aliases: ["redux", "redux toolkit", "rtk"], implies: ["state"] },
  zustand: { aliases: ["zustand"], implies: ["state"] },
  state: { aliases: ["state", "state management"], implies: [] },
  webpack: { aliases: ["webpack"], implies: [] },
  vite: { aliases: ["vite"], implies: [] },
  babel: { aliases: ["babel"], implies: [] },

  // styling / UI
  tailwind: { aliases: ["tailwind", "tailwindcss"], implies: [] },
  scss: { aliases: ["scss", "sass"], implies: [] },
  css: { aliases: ["css"], implies: [] },
  storybook: { aliases: ["storybook"], implies: ["design system"] },
  "design system": {
    aliases: ["design system", "component library"],
    implies: [],
  },
  "material ui": { aliases: ["material ui", "mui"], implies: ["react"] },
  chakra: { aliases: ["chakra", "chakra ui"], implies: ["react"] },
  "ant design": { aliases: ["ant design", "antd"], implies: ["react"] },

  // === Frontend: Vue/Nuxt
  vue: {
    aliases: ["vue", "vue.js", "vue2", "vue 2", "vue3", "vue 3"],
    implies: ["vue3", "composition api", "options api"],
  },
  "composition api": {
    aliases: [
      "composition api",
      "script setup",
      "setup()",
      "ref()",
      "reactive()",
    ],
    implies: [],
  },
  "options api": { aliases: ["options api"], implies: [] },
  nuxt: {
    aliases: ["nuxt", "nuxt.js", "nuxt2", "nuxt 2", "nuxt3", "nuxt 3"],
    implies: ["nuxt3", "ssr", "ssg", "routing"],
  },
  pinia: { aliases: ["pinia"], implies: ["state"] },
  vuex: { aliases: ["vuex"], implies: ["state"] },
  vuetify: { aliases: ["vuetify"], implies: ["vue"] },
  quasar: { aliases: ["quasar"], implies: ["vue"] },
  "element plus": {
    aliases: ["element plus", "element-plus"],
    implies: ["vue"],
  },

  // FE perf
  "lazy load": {
    aliases: ["lazy load", "lazy", "code splitting", "code-splitting"],
    implies: ["performance"],
  },
  bundle: {
    aliases: ["bundle", "bundling", "bundle size"],
    implies: ["performance"],
  },
  performance: {
    aliases: ["performance", "profiling", "optimize"],
    implies: [],
  },

  // === FE testing
  jest: { aliases: ["jest"], implies: [] },
  vitest: { aliases: ["vitest"], implies: ["jest"] },
  cypress: { aliases: ["cypress"], implies: [] },
  playwright: { aliases: ["playwright"], implies: [] },

  // === Backend: Node
  node: {
    aliases: ["node", "nodejs", "node.js"],
    implies: ["express", "nest"],
  },
  express: { aliases: ["express", "express.js"], implies: ["rest"] },
  nest: { aliases: ["nest", "nestjs"], implies: ["rest"] },
  middleware: { aliases: ["middleware"], implies: [] },
  async: { aliases: ["async", "async/await"], implies: [] },

  // === Backend: Python
  python: { aliases: ["python"], implies: ["django", "flask", "fastapi"] },
  django: {
    aliases: ["django", "drf", "django rest framework"],
    implies: ["rest"],
  },
  "django orm": { aliases: ["django orm"], implies: ["sql"] },
  flask: { aliases: ["flask"], implies: ["rest"] },
  fastapi: { aliases: ["fastapi"], implies: ["rest"] },
  pydantic: { aliases: ["pydantic"], implies: [] },
  asgiref: { aliases: ["asgiref"], implies: [] },
  uvicorn: { aliases: ["uvicorn"], implies: [] },
  gunicorn: { aliases: ["gunicorn"], implies: [] },

  // APIs & validation
  api: { aliases: ["api", "apis"], implies: [] },
  rest: { aliases: ["rest", "restful"], implies: ["api"] },
  graphql: { aliases: ["graphql", "gql", "apollo"], implies: ["api"] },
  openapi: { aliases: ["openapi", "swagger"], implies: [] },
  swagger: { aliases: ["swagger"], implies: ["openapi"] },
  zod: { aliases: ["zod"], implies: [] },
  joi: { aliases: ["joi"], implies: [] },

  // Databases / ORM / MQ
  postgres: { aliases: ["postgres", "postgresql"], implies: ["sql"] },
  mysql: { aliases: ["mysql"], implies: ["sql"] },
  mariadb: { aliases: ["mariadb"], implies: ["mysql", "sql"] },
  mongodb: { aliases: ["mongodb", "mongo"], implies: ["nosql"] },
  mongoose: { aliases: ["mongoose"], implies: ["mongodb"] },
  prisma: { aliases: ["prisma"], implies: ["postgres", "mysql", "sql"] },
  knex: { aliases: ["knex"], implies: ["sql"] },
  sqlalchemy: { aliases: ["sqlalchemy"], implies: ["sql"] },
  alembic: { aliases: ["alembic"], implies: ["sql"] },
  "query plan": {
    aliases: ["query plan", "explain analyze"],
    implies: ["sql"],
  },
  index: { aliases: ["index", "indexing", "indexes"], implies: ["sql"] },
  sql: { aliases: ["sql"], implies: [] },
  nosql: { aliases: ["nosql"], implies: [] },
  redis: { aliases: ["redis"], implies: ["caching"] },
  kafka: { aliases: ["kafka"], implies: [] },
  rabbitmq: { aliases: ["rabbitmq"], implies: [] },
  queue: { aliases: ["queue", "message queue"], implies: [] },

  // Auth/Sec
  jwt: { aliases: ["jwt", "json web token"], implies: ["auth"] },
  oauth: { aliases: ["oauth"], implies: ["auth"] },
  oauth2: { aliases: ["oauth2", "oauth 2.0"], implies: ["oauth", "auth"] },
  session: { aliases: ["session", "session management"], implies: ["auth"] },
  csrf: { aliases: ["csrf"], implies: ["security"] },
  owasp: { aliases: ["owasp"], implies: ["security"] },
  rbac: { aliases: ["rbac", "role based access control"], implies: ["auth"] },
  auth: {
    aliases: ["auth", "authentication", "authorization", "authn", "authz"],
    implies: ["security"],
  },
  security: { aliases: ["security"], implies: [] },

  // Cloud & DevOps
  aws: {
    aliases: ["aws", "amazon web services"],
    implies: [
      "ec2",
      "s3",
      "rds",
      "lambda",
      "api gateway",
      "cloudfront",
      "route53",
      "iam",
    ],
  },
  gcp: { aliases: ["gcp", "google cloud"], implies: [] },
  azure: { aliases: ["azure", "microsoft azure"], implies: [] },
  ec2: { aliases: ["ec2"], implies: [] },
  s3: { aliases: ["s3"], implies: [] },
  rds: { aliases: ["rds"], implies: [] },
  "api gateway": { aliases: ["api gateway"], implies: [] },
  cloudfront: { aliases: ["cloudfront"], implies: [] },
  route53: { aliases: ["route53", "route 53"], implies: [] },
  iam: { aliases: ["iam"], implies: ["security"] },
  vpc: { aliases: ["vpc"], implies: [] },
  alb: { aliases: ["alb", "application load balancer"], implies: [] },
  elb: { aliases: ["elb", "classic load balancer"], implies: [] },
  ecr: { aliases: ["ecr"], implies: [] },
  ecs: { aliases: ["ecs"], implies: [] },
  eks: { aliases: ["eks"], implies: ["kubernetes"] },
  kubernetes: { aliases: ["kubernetes", "k8s"], implies: [] },
  helm: { aliases: ["helm"], implies: ["kubernetes"] },
  terraform: { aliases: ["terraform"], implies: ["iac"] },
  terragrunt: { aliases: ["terragrunt"], implies: ["terraform", "iac"] },
  cloudformation: { aliases: ["cloudformation"], implies: ["iac"] },
  cdk: { aliases: ["cdk", "aws cdk"], implies: ["iac"] },
  iac: { aliases: ["iac", "infrastructure as code"], implies: [] },
  docker: {
    aliases: ["docker", "containers", "containerization", "container"],
    implies: [],
  },
  "ci/cd": {
    aliases: ["ci/cd", "cicd", "ci cd", "pipeline", "build pipeline"],
    implies: [
      "github actions",
      "gitlab ci",
      "jenkins",
      "circleci",
      "codebuild",
      "codedeploy",
      "codepipeline",
    ],
  },
  "github actions": { aliases: ["github actions"], implies: [] },
  "gitlab ci": { aliases: ["gitlab ci", "gitlab-ci"], implies: ["gitlab"] },
  gitlab: { aliases: ["gitlab"], implies: [] },
  jenkins: { aliases: ["jenkins"], implies: [] },
  circleci: { aliases: ["circleci"], implies: [] },
  codebuild: { aliases: ["codebuild"], implies: ["aws"] },
  codedeploy: { aliases: ["codedeploy"], implies: ["aws"] },
  codepipeline: { aliases: ["codepipeline"], implies: ["aws"] },

  // Observability
  cloudwatch: { aliases: ["cloudwatch"], implies: [] },
  prometheus: { aliases: ["prometheus"], implies: [] },
  grafana: { aliases: ["grafana"], implies: [] },
  loki: { aliases: ["loki"], implies: [] },
  tempo: { aliases: ["tempo"], implies: [] },
  "x-ray": { aliases: ["x-ray", "xray"], implies: [] },
  sentry: { aliases: ["sentry"], implies: [] },
  datadog: { aliases: ["datadog"], implies: [] },
  winston: { aliases: ["winston"], implies: [] },
  pino: { aliases: ["pino"], implies: [] },

  // Architecture & perf
  microservices: { aliases: ["microservices"], implies: [] },
  "event-driven": { aliases: ["event-driven", "event driven"], implies: [] },
  caching: { aliases: ["caching", "cache"], implies: [] },

  // Async / jobs (Python)
  asyncio: { aliases: ["asyncio"], implies: [] },
  celery: { aliases: ["celery"], implies: [] },
  rq: { aliases: ["rq"], implies: [] },
  dramatiq: { aliases: ["dramatiq"], implies: [] },

  // === Drupal
  drupal: {
    aliases: [
      "drupal",
      "drupal8",
      "drupal 8",
      "drupal9",
      "drupal 9",
      "drupal10",
      "drupal 10",
    ],
    implies: ["php"],
  },
  drush: { aliases: ["drush"], implies: ["drupal"] },
  twig: { aliases: ["twig"], implies: ["theming"] },
  theming: {
    aliases: ["theming", "theme", "templates", "paragraphs"],
    implies: ["css", "html"],
  },
  "custom module": {
    aliases: ["custom module", "module development"],
    implies: ["drupal"],
  },
  "form api": { aliases: ["form api"], implies: ["drupal api"] },
  "render api": { aliases: ["render api"], implies: ["drupal api"] },
  "entity api": { aliases: ["entity api"], implies: ["drupal api"] },
  "drupal api": {
    aliases: [
      "drupal api",
      "services",
      "hook",
      "hook_form_alter",
      "hook_menu",
      "hook_entity",
    ],
    implies: ["drupal"],
  },
  "database api": { aliases: ["database api"], implies: ["sql"] },
  acquia: { aliases: ["acquia", "acquia cloud"], implies: ["cloud"] },

  // === General web
  html: { aliases: ["html"], implies: [] },
  javascript: { aliases: ["javascript", "js"], implies: [] },
  typescript: { aliases: ["typescript", "ts"], implies: [] },

  // === Collaboration / Agile / QA process
  jira: { aliases: ["jira"], implies: ["agile"] },
  scrum: { aliases: ["scrum", "scrum master"], implies: ["agile"] },
  kanban: { aliases: ["kanban"], implies: ["agile"] },
  agile: { aliases: ["agile"], implies: [] },
  "pull request": {
    aliases: ["pull request", "pr", "pr review", "code review"],
    implies: ["git"],
  },
  git: { aliases: ["git"], implies: [] },
  "unit test": { aliases: ["unit test", "unittest"], implies: [] },
  "integration test": { aliases: ["integration test"], implies: [] },
  coverage: { aliases: ["coverage"], implies: [] },

  // === BA / PM / HR
  communication: {
    aliases: ["communication", "presentation", "follow-up"],
    implies: [],
  },
  stakeholder: {
    aliases: ["stakeholder", "hiring manager", "client"],
    implies: ["communication"],
  },
  "status report": { aliases: ["status report", "report"], implies: [] },
  dashboard: { aliases: ["dashboard"], implies: ["report"] },
  "user stories": {
    aliases: ["user stories", "story", "stories"],
    implies: [],
  },
  brd: {
    aliases: ["brd", "business requirements document"],
    implies: ["requirements"],
  },
  frd: {
    aliases: ["frd", "functional requirements document"],
    implies: ["requirements"],
  },
  "acceptance criteria": {
    aliases: ["acceptance criteria", "ac"],
    implies: ["requirements"],
  },
  requirements: { aliases: ["requirements", "requirement"], implies: [] },
  figma: { aliases: ["figma"], implies: [] },
  wireframe: { aliases: ["wireframe", "wireframes"], implies: [] },
  flow: { aliases: ["flow", "process flow"], implies: [] },
  prototype: { aliases: ["prototype", "prototyping"], implies: [] },
  sdlc: { aliases: ["sdlc", "software lifecycle"], implies: [] },
  standup: { aliases: ["standup", "daily standup"], implies: ["scrum"] },
  sprint: {
    aliases: ["sprint", "sprint planning", "review", "retro", "retrospective"],
    implies: ["scrum"],
  },
  testrail: { aliases: ["testrail"], implies: [] },
  zephyr: { aliases: ["zephyr"], implies: [] },
  "test case": { aliases: ["test case", "test cases"], implies: [] },
  defect: { aliases: ["defect", "bug"], implies: [] },
  uat: {
    aliases: ["uat", "user acceptance testing", "acceptance"],
    implies: ["test case"],
  },
  ats: { aliases: ["ats", "applicant tracking system"], implies: [] },
  zoho: { aliases: ["zoho"], implies: ["ats"] },
  lever: { aliases: ["lever"], implies: ["ats"] },
  greenhouse: { aliases: ["greenhouse"], implies: ["ats"] },
  naukri: { aliases: ["naukri"], implies: [] },
  indeed: { aliases: ["indeed"], implies: [] },
  "linkedin recruiter": {
    aliases: ["linkedin recruiter"],
    implies: ["linkedin"],
  },
  linkedin: { aliases: ["linkedin"], implies: [] },
  "boolean search": { aliases: ["boolean search"], implies: [] },
  mentoring: { aliases: ["mentoring", "mentor"], implies: [] },
  interview: { aliases: ["interview", "interviews"], implies: [] },
  roadmap: { aliases: ["roadmap"], implies: [] },
  "technical direction": { aliases: ["technical direction"], implies: [] },
  estimation: { aliases: ["estimation", "estimate"], implies: [] },
  planning: { aliases: ["planning"], implies: [] },
  raid: {
    aliases: ["raid", "risks", "assumptions", "issues", "dependencies"],
    implies: ["risk"],
  },
  risk: {
    aliases: ["risk", "risk management", "dependency", "blocker"],
    implies: [],
  },

  // Misc
  accessibility: { aliases: ["accessibility", "a11y", "aria"], implies: [] },
  i18n: { aliases: ["i18n", "internationalization"], implies: [] },
};

/** build alias → canon index */
const ALIAS_TO_CANON = new Map();
for (const [canon, obj] of Object.entries(TAG_ONTOLOGY)) {
  (obj.aliases || []).forEach((a) =>
    ALIAS_TO_CANON.set(String(a).toLowerCase(), canon)
  );
}

function canonicalize(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
function wordBoundary(alias) {
  const safe = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${safe}([^A-Za-z0-9]|$)`, "i");
}

function matchOntology(rawText) {
  const raw = canonicalize(rawText);
  const canonDirect = new Set();
  const canonInferred = new Set();

  // direct hits by alias (whole-word)
  for (const [alias, canon] of ALIAS_TO_CANON.entries()) {
    if (wordBoundary(alias).test(raw)) canonDirect.add(canon);
  }

  // closure: propagate implications
  const queue = [...canonDirect];
  const seen = new Set(queue);
  while (queue.length) {
    const c = queue.shift();
    const implies = TAG_ONTOLOGY[c]?.implies || [];
    for (const nxt of implies) {
      const canonNxt =
        ALIAS_TO_CANON.get(canonicalize(nxt)) || canonicalize(nxt);
      if (!seen.has(canonNxt)) {
        canonInferred.add(canonNxt);
        seen.add(canonNxt);
        queue.push(canonNxt);
      }
    }
  }
  return { canonDirect, canonInferred };
}

function tagHitWithOntology(tag, rawText) {
  const canon = ALIAS_TO_CANON.get(canonicalize(tag)) || canonicalize(tag);
  const { canonDirect, canonInferred } = matchOntology(rawText);
  if (canonDirect.has(canon)) return { hit: true, kind: "direct" };
  if (canonInferred.has(canon)) return { hit: true, kind: "inferred" };
  return { hit: false, kind: null };
}

/* ---------------------- Deterministic keyword signals --------------------- */
function tokenize(s) {
  return toLower(s)
    .replace(/[^a-z0-9\+\/#\.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function buildSignals(fullText, jd) {
  const tokens = new Set(tokenize(fullText));
  const has = (...arr) =>
    arr.some(
      (t) =>
        tokens.has(toLower(String(t).replace(/\s+/g, ""))) ||
        tokens.has(toLower(t))
    );
  const signals = {};
  for (const item of jd.items) signals[item.id] = has(...(item.tags || []));
  return signals;
}

/* -------------------------- Heuristic score helpers ----------------------- */
const STRONG_VERBS = [
  "designed",
  "architected",
  "led",
  "owned",
  "launched",
  "shipped",
  "scaled",
  "optimized",
  "reduced",
  "improved",
  "increased",
  "decreased",
  "boosted",
  "cut",
  "saved",
];

function scoreFormattingHeuristic(text) {
  const raw = String(text || "");
  if (!raw) return 0;
  const lines = raw.split(/\n/);
  const bullets = lines.filter((l) =>
    /^\s*(?:[-•●▪︎*]|[0-9]+\.)\s+/.test(l)
  ).length;
  const sections = (
    raw.match(
      /\b(Experience|Work|Projects|Education|Skills|Summary|Certifications)\b/gi
    ) || []
  ).length;
  const dates = (raw.match(/\b(20\d{2}|19\d{2})\b/g) || []).length;
  const bulletRatio = clamp01(bullets / Math.max(lines.length, 1));
  const secScore = clamp01(sections / 6);
  const dateScore = clamp01(dates / 12);
  const score = 0.5 * bulletRatio + 0.3 * secScore + 0.2 * dateScore;
  return Math.round(score * 100);
}

function scoreImpactHeuristic(text) {
  const t = String(text || "");
  if (!t) return 0;
  const metrics = (t.match(/\b(\d+%|\d+ms|\d+s|\d+x|x\d|\$[\d,]+)\b/gi) || [])
    .length;
  const verbs = (
    t.match(new RegExp("\\b(" + STRONG_VERBS.join("|") + ")\\b", "gi")) || []
  ).length;
  const score = clamp01(
    0.06 * Math.min(metrics, 12) + 0.04 * Math.min(verbs, 15)
  );
  return Math.round(score * 100);
}

function scoreKeywordsFromATS(ats) {
  if (!ats || !Array.isArray(ats.matched) || !Array.isArray(ats.missing))
    return null;
  const tot = ats.matched.length + ats.missing.length;
  if (!tot) return null;
  return Math.round((ats.matched.length / tot) * 100);
}

/* ------------------------------- ATS from JD ------------------------------ */
// function fallbackATSFromJD(candidateText, jd, role) {
//   const raw = (candidateText || "").toLowerCase();
//   const tokens = new Set(
//     tokenize(candidateText).map((t) => t.replace(/\s+/g, ""))
//   );

//   const all = new Set();
//   (jd.items || []).forEach((it) =>
//     (it.tags || []).forEach((tg) => all.add(toLower(String(tg).trim())))
//   );

//   const matched = new Set();
//   const missing = new Set();

//   for (const tg of all) {
//     if (tagMatch(tg, tokens, raw, role)) matched.add(tg);
//     else missing.add(tg);
//   }
//   return { matched: Array.from(matched), missing: Array.from(missing) };
// }

// === NEW: whole-word guard for brand tools
const WHOLE_WORD_GUARD = ["git", "lever", "greenhouse", "zoho"];

// === NEW: Ontology-aware ATS
function buildATSForRole(candidateText, jdForRole) {
  const raw = canonicalize(candidateText || "");
  const all = new Set();
  for (const it of jdForRole.items || [])
    (it.tags || []).forEach((t) => all.add(canonicalize(t)));

  const matched = new Set();
  const inferred = new Set();
  const missing = new Set(all);

  for (const tg of all) {
    const { hit, kind } = tagHitWithOntology(tg, raw);
    if (hit) {
      matched.add(tg);
      missing.delete(tg);
      if (kind === "inferred") inferred.add(tg);
    }
  }

  // extra safety on ambiguous short words
  for (const tricky of WHOLE_WORD_GUARD) {
    if (all.has(tricky) && !wordBoundary(tricky).test(raw)) {
      matched.delete(tricky);
      missing.add(tricky);
      inferred.delete(tricky);
    }
  }

  return {
    matched: [...matched],
    missing: [...missing],
    inferred: [...inferred],
    coveragePct:
      (matched.size / Math.max(1, matched.size + missing.size)) * 100,
  };
}

// === NEW: Ontology-aware deterministic checklist (with partial credit)
function checklistFromJD(candidateText, jdForRole) {
  const raw = canonicalize(candidateText || "");
  const rows = [];

  for (const it of jdForRole.items || []) {
    const tags = (it.tags || []).map(canonicalize);
    let points = 0;
    let directCount = 0;

    for (const tg of tags) {
      const { hit, kind } = tagHitWithOntology(tg, raw);
      if (hit) {
        if (kind === "direct") {
          points += 1;
          directCount += 1;
        } else {
          points += 0.6;
        }
      }
    }

    const denom = Math.max(1, tags.length);
    const frac = points / denom;

    const status = points > 0 ? "Pass" : "Fail";
    let level = "Weak";
    if (frac >= 0.8 || directCount >= 3) level = "Strong";
    else if (frac >= 0.5 || directCount >= 2) level = "Medium";

    rows.push({
      id: it.id,
      skill: it.text,
      status,
      level,
      must: !!it.must,
      weight: jdForRole.weights?.[it.id] ?? 0.05,
      evidence_spans: [],
    });
  }

  return rows;
}

/* --------------------------- Experience & recency -------------------------- */
function extractYears(text) {
  const m = [
    ...String(text || "").matchAll(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*years?/gi),
  ];
  return m.length ? Math.max(...m.map((x) => parseFloat(x[1]))) : null;
}
function estimateRecencyScore(text) {
  const years = (text.match(/\b(20\d{2})\b/g) || [])
    .map(Number)
    .filter((y) => y >= 2000 && y <= yearNow);
  if (!years.length) return 30; // low recency if no years
  const recent = Math.max(...years);
  const age = Math.max(0, yearNow - recent);
  // 100 if touched this year, 85 last year, decay afterwards
  const score = Math.max(10, 100 - age * 15);
  return Math.round(score);
}

/* ---------------------- Deterministic JD checklist (core) ----------------- */
function deterministicJDChecklist(candidateText, jd, role) {
  const raw = (candidateText || "").toLowerCase();
  const tokens = new Set(
    tokenize(candidateText).map((t) => t.replace(/\s+/g, ""))
  );

  const checklist = [];
  for (const it of jd.items) {
    const tags = (it.tags || []).map((tg) => tg.toLowerCase());
    const presentCount = tags.filter((tg) =>
      tagMatch(tg, tokens, raw, role)
    ).length;

    const status = presentCount > 0 ? "Pass" : "Fail";
    // Be stricter so one ambiguous word doesn't become Strong
    let level = "Weak";
    if (presentCount >= Math.max(2, Math.ceil(tags.length * 0.5)))
      level = "Medium";
    if (presentCount >= Math.max(3, Math.ceil(tags.length * 0.8)))
      level = "Strong";

    const weight = jd.weights[it.id] ?? 0.05;
    checklist.push({
      id: it.id,
      skill: it.text,
      status,
      level,
      weight,
      evidence_spans: [],
      must: !!it.must,
    });
  }
  return checklist;
}

/* ---------------------- Hireability scoring (cards) ----------------------- */
// const LVL = { Strong: 1.0, Medium: 0.75, Weak: 0.4 };
const LVL = { Strong: 1.0, Medium: 0.8, Weak: 0.6 };

function scoreRoleFit(jdChecklist = [], jdWeights = {}, jdItems = []) {
  if (!Array.isArray(jdChecklist) || jdChecklist.length === 0)
    return { score: 0, drivers: [], gaps: ["no_jd_evidence"], mustCoverage: 0 };

  const mustMap = {};
  for (const it of jdItems) mustMap[it.id] = !!it.must;

  let totalW = 0,
    got = 0,
    mustTotal = 0,
    mustPass = 0;
  const drivers = [],
    gaps = [];
  for (const row of jdChecklist) {
    const id = row.id || row.skill || "";
    const w =
      jdWeights[id] ?? (typeof row.weight === "number" ? row.weight : 0.05);
    totalW += w;
    if (mustMap[id]) mustTotal += 1;

    if (row.status === "Pass") {
      const lvl = LVL[row.level] ?? 0.6;
      got += w * lvl;
      drivers.push(`pass:${id}${row.level ? `:${row.level}` : ""}`);
      if (mustMap[id]) mustPass += 1;
    } else {
      if (mustMap[id]) gaps.push(`fail_must:${id}`);
      else gaps.push(`fail:${id}`);
    }
  }
  const ratio = totalW ? got / totalW : 0;
  const mustCoverage = mustTotal ? mustPass / mustTotal : 1;
  return {
    score: Math.round(100 * clamp01(ratio)),
    drivers,
    gaps,
    mustCoverage: round2(mustCoverage),
  };
}

function scoreTechDepth(fullText) {
  const t = (fullText || "").toLowerCase();
  const has = (...ks) => ks.some((k) => t.includes(k));

  const feats = {
    frontend: has(
      "react",
      "vue",
      "next",
      "ssr",
      "lazy load",
      "bundle",
      "redux",
      "zustand"
    ),
    backend: has("node", "express", "nest", "api", "microservice", "grpc"),
    databases: has(
      "postgres",
      "mysql",
      "mongodb",
      "dynamodb",
      "index",
      "query",
      "sql"
    ),
    cloud: has(
      "aws",
      "ec2",
      "s3",
      "lambda",
      "cloudfront",
      "api gateway",
      "docker",
      "kubernetes"
    ),
    security: has("jwt", "oauth", "oauth2", "session", "owasp"),
  };
  const verbsStrong = (
    t.match(/\b(designed|architected|led|scaled|mentored|owned)\b/gi) || []
  ).length;
  const metrics = (t.match(/\b(\d+%|x\d|\d+x|ms|reduced|improved)\b/gi) || [])
    .length;
  const years = extractYears(t) || 2;

  let area = {
    frontend: feats.frontend ? 0.7 : 0.2,
    backend: feats.backend ? 0.7 : 0.2,
    databases: feats.databases ? 0.6 : 0.2,
    cloud: feats.cloud ? 0.7 : 0.2,
    security: feats.security ? 0.5 : 0.1,
  };
  const boost = clamp01(
    0.1 * Math.min(verbsStrong, 10) +
      0.05 * Math.min(metrics, 10) +
      Math.min(years, 8) / 80
  );
  for (const k of Object.keys(area)) area[k] = clamp01(area[k] + boost);

  const weights = {
    frontend: 0.22,
    backend: 0.22,
    databases: 0.18,
    cloud: 0.22,
    security: 0.16,
  };
  const overall = Object.entries(area).reduce(
    (s, [k, v]) => s + v * weights[k],
    0
  );

  const toLevel = (v) => (v >= 0.85 ? "Strong" : v >= 0.65 ? "Medium" : "Weak");
  return {
    score: Math.round(overall * 100),
    core_stack: Object.entries(area).map(([areaKey, v]) => ({
      area: areaKey,
      level: toLevel(v),
      evidence: [],
      value: round2(v),
    })),
  };
}

function scoreDelivery(fullText) {
  const t = (fullText || "").toLowerCase();
  const has = (...ks) => ks.some((k) => t.includes(k));
  const ci = has("ci/cd", "github actions", "jenkins", "gitlab ci", "pipeline");
  const cloud = has(
    "aws",
    "gcp",
    "azure",
    "cloudfront",
    "s3",
    "lambda",
    "api gateway",
    "ec2",
    "docker",
    "kubernetes"
  );
  const agile = has(
    "scrum",
    "jira",
    "stand-up",
    "standup",
    "sprint",
    "retrospective"
  );
  const monitoring = has(
    "datadog",
    "new relic",
    "grafana",
    "prometheus",
    "sentry",
    "logging"
  );
  const ownership = (
    t.match(/\b(delivered|owned|led|shipped|launched)\b/gi) || []
  ).length;

  let score = 0;
  score += ci ? 25 : 0;
  score += cloud ? 25 : 0;
  score += agile ? 15 : 0;
  score += monitoring ? 15 : 0;
  score += Math.min(20, ownership * 5);

  return {
    score: Math.round(score),
    evidence: [
      ci && "CI/CD",
      cloud && "Cloud deploys",
      agile && "Agile/Jira",
      monitoring && "Monitoring/Observability",
      ownership > 0 && "Ownership verbs",
    ].filter(Boolean),
    ci_cd: ci,
    cloud: cloud ? ["cloud"] : [],
    agile,
    monitoring_obs: monitoring,
  };
}

function scoreRisk(parsed, jdChecklist = [], redFlags = [], jdItems = []) {
  const mustSet = new Set(jdItems.filter((it) => it.must).map((it) => it.id));
  const mustFails = jdChecklist.filter(
    (r) => r.status !== "Pass" && mustSet.has(r.id)
  ).length;
  let risk = mustFails * 25;

  const fails = jdChecklist.filter((r) => r.status !== "Pass").length;
  risk += Math.min(30, fails * 4);

  risk += Math.min(40, (redFlags || []).length * 10);

  risk = Math.max(0, Math.min(100, risk));
  return {
    score: risk,
    flags: [
      ...(mustFails
        ? [
            {
              type: "must_fail",
              severity: "high",
              note: `${mustFails} critical JD item(s) failed`,
            },
          ]
        : []),
    ],
  };
}

function computeHireSignals(candidateData, parsed, jd, signals) {
  const jdRaw =
    (parsed.extended?.jd_raw?.length
      ? parsed.extended.jd_raw
      : parsed.jd_checklist) || [];
  const roleFit = scoreRoleFit(jdRaw, jd.weights || {}, jd.items || []);
  const techDepth = scoreTechDepth(candidateData);
  const delivery = scoreDelivery(candidateData);
  const risk = scoreRisk(parsed, jdRaw, parsed.red_flags || [], jd.items || []);

  return {
    role_fit: roleFit,
    tech_depth: techDepth,
    delivery_readiness: delivery,
    risk,
  };
}

/* ------------------------------- LLM schema ------------------------------- */
const SCHEMA = {
  type: "object",
  properties: {
    candidate_name: { type: ["string", "null"] },
    contact: {
      type: "object",
      properties: {
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" } },
        location: { type: ["string", "null"] },
      },
      required: ["emails", "phones"],
    },
    overall: { type: "number" },
    score_breakdown: {
      type: "object",
      properties: {
        mandatory: { type: "number" },
        nice_to_have: { type: "number" },
        soft_skills: { type: "number" },
        recency: { type: "number" },
        formatting: { type: "number" },
        keywords: { type: "number" },
        impact: { type: "number" },
      },
      required: [
        "mandatory",
        "nice_to_have",
        "soft_skills",
        "recency",
        "keywords",
      ],
    },
    jd_checklist: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          skill: { type: "string" },
          status: { enum: ["Pass", "Fail"] },
          level: { enum: ["Strong", "Medium", "Weak"] },
          weight: { type: "number" },
          evidence_spans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { enum: ["resume", "linkedin"] },
                text: { type: "string" },
                start: { type: ["number", "null"] },
                end: { type: ["number", "null"] },
              },
              required: ["source", "text"],
            },
          },
        },
        required: ["id", "skill", "status", "level", "weight"],
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    red_flags: { type: "array", items: { type: "string" } },
    training_needs: { type: "array", items: { type: "string" } },
    growth_potential: { enum: ["Strong", "Average", "Limited"] },
    role_alignment: { enum: ["High", "Medium", "Low"] },
    ats_keywords: {
      type: "object",
      properties: {
        matched: { type: "array", items: { type: "string" } },
        missing: { type: "array", items: { type: "string" } },
      },
      required: ["matched", "missing"],
    },
    experience_years: { type: ["number", "null"] },
    timeline_note: { type: ["string", "null"] },
    summary_bullets: { type: "array", items: { type: "string" } },
    decision: { enum: ["Pass", "Fail"] },
    recommendation: { type: "string" },
  },
  required: [
    "overall",
    "score_breakdown",
    "jd_checklist",
    "strengths",
    "weaknesses",
    "red_flags",
    "training_needs",
    "growth_potential",
    "role_alignment",
    "ats_keywords",
    "decision",
    "recommendation",
  ],
};

function buildPromptLLM(role, jd, candidateEvidence, signals) {
  const weights = jd.weights || {};
  const items = jd.items || [];
  const schemaStr = JSON.stringify(SCHEMA, null, 2);
  const itemsStr = items
    .map(
      (it) =>
        `- id:${it.id} | must:${!!it.must} | weight:${
          weights[it.id] || 0.05
        } | text:${it.text}`
    )
    .join("\n");

  const signalLines = Object.entries(signals)
    .map(([k, v]) => `  ${k}: ${v ? "true" : "false"}`)
    .join("\n");

  return `You are an very good and expert recruiter and ATS evaluator(dont miss anything).
Return STRICT JSON ONLY (no markdown) that VALIDATES against JSON_SCHEMA. If uncertain, use nulls/empty arrays but keep the schema.

POLICY (IMPORTANT):
- LinkedIn is OPTIONAL. Do NOT penalize if LinkedIn is missing/private. Resume drives the decision; LinkedIn is bonus evidence only.
- Decision bands:
  * overall >= 80 -> "strong_pass"
  * 60 <= overall < 80 -> "normal_pass"
  * 50 <= overall < 60 -> "low_pass"
  * otherwise -> "fail"
- "decision" must be "Pass" for strong/normal/low pass, else "Fail".
- recommendation must be one of: "Immediate Hire", "Can Be Hire", "Hold", "Reject" (mapped from the band).
- If JD role-fit >= 60% but overall slightly below 60, treat as LOW PASS unless hard red flags exist.

SCORING:
- overall = weighted sum of JD items (by weight) with penalties for missing MUSTs; include recency/keywords/impact in score_breakdown.
- Provide 3–6 summary_bullets.
- For jd_checklist, include evidence_spans (source resume/linkedin, short text). Start/end can be null.

JSON_SCHEMA:
${schemaStr}

JD_ROLE:${role}
JD_ITEMS:
${itemsStr}

DETERMINISTIC_SIGNALS (orientation only, do not overtrust):
${signalLines}

CANDIDATE_EVIDENCE:
${candidateEvidence}`;
}

// function buildPromptLLM(role, jd, candidateEvidence, signals) {
//   const schemaStr = JSON.stringify(SCHEMA, null, 2);
//   const jdJSON = JSON.stringify(
//     {
//       role,
//       weights: jd.weights || {},
//       // send tags so the model knows what counts for ATS/checklist
//       items: (jd.items || []).map(({ id, text, must, tags }) => ({
//         id, text, must: !!must, weight: (jd.weights || {})[id] ?? 0.05, tags: tags || []
//       })),
//     },
//     null,
//     2
//   );
//   const signalsJSON = JSON.stringify(signals || {}, null, 2);

//   return (
// `You are an expert recruiter and ATS evaluator.
// Return ONE object in **valid JSON** that conforms EXACTLY to JSON_SCHEMA below.
// Do not include markdown, code fences, comments, or extra keys.

// STRICT OUTPUT RULES
// - If uncertain about any field, use null or [] but KEEP the schema shape.
// - Numbers must be finite, not NaN/Infinity. Percent-like values are integers 0..100.
// - Strings must be trimmed; no placeholder text.
// - Arrays must be de-duplicated and sorted (case-insensitive) where it makes sense.
// - Do not hallucinate company names, dates, titles, or facts not present in evidence.

// SOURCES & EVIDENCE POLICY
// - Treat RESUME text as PRIMARY. LinkedIn is OPTIONAL bonus evidence only.
// - Use ONLY information present in CANDIDATE_EVIDENCE. If a fact is not there, leave it null/empty.
// - For jd_checklist.evidence_spans:
//   • source ∈ {"resume","linkedin"}  • text ≤ 220 chars  • 0..3 spans per row
//   • text must be a literal snippet from the source (no paraphrase). If you can’t find it, omit the span.

// ATS KEYWORDS (CONSERVATIVE)
// - Build ats_keywords from the JD item tags ONLY. Do not invent synonyms.
// - A tag is “matched” only if it appears in the evidence (case-insensitive, whitespace-insensitive).
// - If not sure a tag is present, leave it in "missing".

// JD CHECKLIST (COMPLETE & ONE-TO-ONE)
// - Output EXACTLY one checklist row for every JD item in JD_ITEMS (same id).
// - status ∈ {"Pass","Fail"}.
// - Level heuristic: Weak (≥1 tag present), Medium (≥50% tags present or ≥2), Strong (≥80% tags present or ≥3).
// - weight must equal the JD weight provided for that id.

// SCORING & DECISIONS
// - Compute role-fit as the weighted sum over jd_checklist with multipliers: Strong=1.0, Medium=0.75, Weak=0.4, Fail=0.0.
// - Compute mustCoverage = (# of MUST items with status=Pass) / (total MUST items). If no MUST items, treat as 1.
// - Estimate overall in 0..100 with this guideline:
//   overall ≈ 0.70*(role-fit) + 0.10*(score_breakdown.recency) + 0.10*(score_breakdown.keywords) + 0.10*(score_breakdown.impact)
//   then subtract up to 30 points if mustCoverage < 0.8 (linear penalty).
// - Decision bands:
//   • overall ≥ 80 → "strong_pass"
//   • 60 ≤ overall < 80 → "normal_pass"
//   • 50 ≤ overall < 60 OR role-fit ≥ 60 → "low_pass"
//   • otherwise → "fail"
// - Map band → decision/recommendation:
//   • strong_pass → decision="Pass",  recommendation="immediate_hire"
//   • normal_pass → decision="Pass",  recommendation="can_be_hire"
//   • low_pass    → decision="Pass",  recommendation="hold"
//   • fail        → decision="Fail",  recommendation="reject"
// - Keep the three fields (overall, decision, recommendation) CONSISTENT with the band.

// EXTRACTION RULES
// - candidate_name: if clearly present; else null.
// - contact.emails: extract from evidence (RFC-like), lowercase; contact.phones: E.164-ish or as-is digits; location if explicitly present.
// - experience_years: best explicit number like “X years”; else null. timeline_note if obvious gaps/recency.
// - strengths/weaknesses/red_flags/training_needs: short, specific bullets grounded in evidence (no generic clichés).
// - summary_bullets: 3–6 crisp bullets that synthesize the evaluation (no repetition).

// JSON_SCHEMA:
// ${schemaStr}

// JD_ITEMS (machine-readable):
// ${jdJSON}

// DETERMINISTIC_SIGNALS (hints only; do not overtrust):
// ${signalsJSON}

// CANDIDATE_EVIDENCE (verbatim; RESUME first, then LinkedIn if any):
// ${candidateEvidence}`
//   );
// }

/* ----------------------------- JSON safe parse ---------------------------- */
function tryParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start > -1 && end > start) return JSON.parse(raw.slice(start, end + 1));
  } catch {}
  return null;
}

/* ---------------------------- Schema guard (lite) ------------------------- */
function validateLLM(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object")
    return { ok: false, errors: ["not_an_object"] };
  const req = SCHEMA.required || [];
  for (const k of req) {
    if (!(k in obj)) errors.push(`missing:${k}`);
  }
  if (typeof obj.overall !== "number") errors.push("overall_not_number");
  if (!Array.isArray(obj.jd_checklist)) errors.push("jd_checklist_not_array");
  if (!obj.ats_keywords || !Array.isArray(obj.ats_keywords.matched))
    errors.push("ats_keywords_missing");
  return { ok: errors.length === 0, errors };
}

/* ------------------------------ API: Health ------------------------------- */
app.get("/api/health", (_req, res) => {
  res.set("X-API-Version", BUILD_VERSION);
  res.json({
    ok: true,
    version: BUILD_VERSION,
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  });
});

/* ----------------------------- API: JD Upsert ----------------------------- */
const JDUpsertSchema = z.object({
  role: z.string().min(2),
  weights: z.record(z.string(), z.number().min(0).max(1)).optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().min(3),
        must: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .min(1)
    .optional(),
});

app.post("/api/jd/upsert", async (req, res) => {
  const parse = JDUpsertSchema.safeParse(req.body);
  if (!parse.success)
    return res.status(400).json({ error: parse.error.flatten() });
  const { role, weights, items } = parse.data;
  JD_BANK[role] = {
    weights: { ...(JD_BANK[role]?.weights || {}), ...(weights || {}) },
    items: items || JD_BANK[role]?.items || [],
  };
  return res.json({ ok: true, role, jd: JD_BANK[role] });
});

/* ------------------------------- API: Analyze ----------------------------- */
app.post("/api/analyze", upload.single("resume"), async (req, res) => {
  const started = Date.now();
  try {
    // const role = (req.body.role || "software_engineer").toLowerCase().trim();
    const roleInput = req.body.role || "software_engineer";
    const role = resolveRoleKey(roleInput);
    const linkedinUrl = stripWhitespace(req.body.linkedinUrl || "");
    if (!JD_BANK[role])
      return res.status(400).json({ error: `Unknown role: ${role}` });

    // 1) Resume text (REQUIRED for decision)
    let resumeText = "";
    if (req.file) {
      try {
        resumeText = await bufferToText(req.file);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    if (!resumeText && !linkedinUrl) {
      return res.status(400).json({
        error: "Please provide a resume (PDF/DOCX). LinkedIn is optional.",
      });
    }

    // 2) LinkedIn (public, optional, bonus only)
    let liText = "",
      liStatus = {
        ok: false,
        used: false,
        method: null,
        reason: "Not provided",
        chars: 0,
      };
    if (linkedinUrl) {
      const resLi = await scrapeLinkedInPublic(linkedinUrl);
      liText = resLi.text || "";
      liStatus = resLi.status || liStatus;
    }

    const atsText = atsBaseText(resumeText, liText); // resume-only by default

    // 3) Build candidate bundle
    const candidateData = stripWhitespace(
      `ROLE: ${role}\n\n=== RESUME ===\n${
        resumeText || "(none)"
      }\n\n=== LINKEDIN [${liStatus.method || "none"}] ===\n${
        liText || "(none)"
      }`
    );

    // 4) Deterministic signals & deterministic JD checklist
    const jd = JD_BANK[role];
    const signals = buildSignals(atsText, jd);
    // const detChecklist = deterministicJDChecklist(atsText, jd, role);
    const detChecklist = checklistFromJD(atsText, jd);
    // let ats = fallbackATSFromJD(atsText, jd, role);
    let ats = buildATSForRole(atsText, jd);

    const formattingDet = scoreFormattingHeuristic(resumeText || liText); // allow LI to help a bit if no resume
    const impactDet = scoreImpactHeuristic(candidateData);
    const recencyDet = estimateRecencyScore(candidateData);
    const keywordsDet = scoreKeywordsFromATS(ats) ?? 0;

    // 6) Deterministic role-fit & other signals
    const roleFitDet = scoreRoleFit(
      detChecklist,
      jd.weights || {},
      jd.items || []
    );
    const techDepthDet = scoreTechDepth(candidateData);
    const deliveryDet = scoreDelivery(candidateData);
    const riskDet = scoreRisk(
      { red_flags: [] },
      detChecklist,
      [],
      jd.items || []
    );

    // 7) LLM adjudication (optional)
    const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });
    let parsed = {};
    let raw = "";
    if (process.env.GROQ_API_KEY) {
      const prompt = buildPromptLLM(role, jd, candidateData, signals);
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a strict JSON machine. Reply with JSON ONLY and VALID per the provided schema.",
          },
          { role: "user", content: prompt },
        ],
      });
      raw = (completion.choices?.[0]?.message?.content || "")
        .replace(/```json|```/g, "")
        .trim();
      parsed = tryParseJSON(raw) || {};
      const val = validateLLM(parsed);
      if (!val.ok) {
        parsed = {}; // keep deterministic only
      }
    }

    // 8) Merge ATS from LLM if strictly better
    if (
      !ATS_DETERMINISTIC_ONLY &&
      parsed.ats_keywords &&
      Array.isArray(parsed.ats_keywords.matched) &&
      Array.isArray(parsed.ats_keywords.missing)
    ) {
      const kLLM = scoreKeywordsFromATS(parsed.ats_keywords) ?? 0;
      const kDet = scoreKeywordsFromATS(ats) ?? 0;
      if (kLLM > kDet) ats = parsed.ats_keywords; // only if you opt-in and LLM is strictly better
    }

    // 9) Build final jd_checklist (merge evidence if present)
    let jd_checklist = detChecklist.map(({ must, ...r }) => r);
    if (Array.isArray(parsed.jd_checklist) && parsed.jd_checklist.length) {
      const mapDet = new Map(detChecklist.map((d) => [d.id, d]));
      jd_checklist = parsed.jd_checklist.map((r) => {
        const base = mapDet.get(r.id) || {
          id: r.id,
          skill: r.skill,
          status: r.status,
          level: r.level,
          weight: r.weight,
        };
        return {
          id: r.id || base.id,
          skill: r.skill || base.skill,
          status: r.status || base.status,
          level: r.level || base.level,
          weight: typeof r.weight === "number" ? r.weight : base.weight,
          evidence_spans: Array.isArray(r.evidence_spans)
            ? r.evidence_spans.slice(0, 3)
            : [],
        };
      });
    }

    jd_checklist = sanitizeChecklist(
      jd_checklist,
      detChecklist,
      resumeText || liText,
      role
    );

    // 10) Recompute role-fit on merged checklist
    const roleFitMerged = scoreRoleFit(
      jd_checklist,
      jd.weights || {},
      jd.items || []
    );

    // 11) Deterministic overall (primary)
    // const mustPenalty =
    //   roleFitMerged.mustCoverage < 0.8
    //     ? (0.8 - roleFitMerged.mustCoverage) * 30
    //     : 0;
    // AFTER (quadratic, smaller max, starts only below 0.7 coverage)
    const MUST_PENALTY_MAX = Number(process.env.MUST_PENALTY_MAX || 12); // pts
    const MUST_PENALTY_THR = Number(process.env.MUST_PENALTY_THR || 0.7); // coverage
    const deficit = Math.max(0, MUST_PENALTY_THR - roleFitMerged.mustCoverage);
    const mustPenalty = Math.round(MUST_PENALTY_MAX * deficit * deficit); // gentle near threshold
    const baseOverall =
      0.58 * (roleFitMerged.score / 100) + // JD alignment slightly higher
      0.14 * (techDepthDet.score / 100) +
      0.12 * (deliveryDet.score / 100) +
      0.06 * (formattingDet / 100) +
      0.05 * (impactDet / 100) +
      0.05 * (keywordsDet / 100);

    let overallDet = clamp01(baseOverall) * 100 - mustPenalty;
    overallDet = Math.max(0, Math.min(100, Math.round(overallDet)));

    // 12) Conservative LLM blending (resume-first, LI is bonus)
    const llmOverall =
      typeof parsed.overall === "number"
        ? Math.max(0, Math.min(100, parsed.overall))
        : null;
    const resumeEvidence = Math.min(8000, (resumeText || "").length) / 8000; // 0..1
    const liEvidence = liStatus.ok ? 1 : 0; // bonus only
    const atsCov = (scoreKeywordsFromATS(ats) ?? 0) / 100;
    const evidenceScore = clamp01(
      0.45 * resumeEvidence + // RESUME is king
        0.1 * liEvidence + // LinkedIn is small bonus
        0.25 * atsCov +
        0.2 * roleFitMerged.mustCoverage
    );
    const llmWeight = llmOverall !== null ? clamp01(0.55 * evidenceScore) : 0; // max 0.55 weight
    const overallBlended = Math.round(
      (1 - llmWeight) * overallDet + llmWeight * (llmOverall ?? overallDet)
    );

    // 13) Score bands / policy mapping
    // const bandFromScore = (overall, roleFitScore) => {
    //   if (overall >= 80) return "strong_pass";
    //   if (overall >= 60) return "normal_pass";
    //   if (overall >= 50 || roleFitScore >= 60) return "low_pass"; // JD>=60 => at least low pass
    //   return "fail";
    // };
    const bandFromScore = (overall, roleFitScore) => {
      if (overall >= 78) return "strong_pass";
      if (overall >= 58) return "normal_pass";
      if (overall >= 48 || roleFitScore >= 60) return "low_pass";
      return "fail";
    };
    const band = bandFromScore(overallBlended, roleFitMerged.score);
    const actionMap = {
      strong_pass: "immediate_hire",
      normal_pass: "can_be_hire",
      low_pass: "hold",
      fail: "reject",
    };
    const action = actionMap[band];

    // 14) Confidence calc (explicit %)
    const passAnchor =
      band === "fail"
        ? 50
        : band === "low_pass"
        ? 55
        : band === "normal_pass"
        ? 65
        : 80;
    const scoreMargin = clamp01(Math.abs(overallBlended - passAnchor) / 30);
    const riskFactor = 1 - clamp01(riskDet.score / 120);
    const confidence =
      clamp01(0.4 + 0.4 * evidenceScore + 0.2 * scoreMargin) * riskFactor;

    // 15) Summary bullets (deterministic text)
    const summary_bullets = [
      `Overall ${overallBlended}% (${band.replace("_", " ")}), JD fit ${
        roleFitMerged.score
      }% with ${pct2(roleFitMerged.mustCoverage)}% must-have coverage.`,
      `Tech depth ${techDepthDet.score}%, delivery readiness ${deliveryDet.score}%.`,
      `ATS coverage ${scoreKeywordsFromATS(ats) ?? 0}% (${
        ats.matched.length
      } matched / ${ats.missing.length} missing).`,
      `Formatting ${formattingDet}%, impact signals ${impactDet}%, recency ${recencyDet}%.`,
      riskDet.score > 0
        ? `Risk ${riskDet.score} (flags: ${
            riskDet.flags.map((f) => f.type).join(", ") || "none"
          }).`
        : `Low risk profile.`,
    ];

    // 16) Strengths/Weaknesses from signals (deterministic)
    let strengths = [];
    let weaknesses = [];

    // Prefer LLM if it returned useful, non-empty lists
    const strengthsLLM = Array.isArray(parsed.strengths)
      ? parsed.strengths.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const weaknessesLLM = Array.isArray(parsed.weaknesses)
      ? parsed.weaknesses.map((s) => String(s).trim()).filter(Boolean)
      : [];

    // Build deterministic HR insights as fallback or to blend
    const hrDet = buildDeterministicHRInsights({
      roleFit: roleFitMerged.score,
      techDepth: techDepthDet.score,
      delivery: deliveryDet.score,
      atsPct: scoreKeywordsFromATS(ats) ?? 0,
      formatting: formattingDet,
      impact: impactDet,
      recency: recencyDet,
      jd,
      jd_checklist,
      ats,
      resumeText,
      liText,
      candidateData,
    });

    // Merge policy:
    // - Use LLM if present; top up with deterministic to guarantee min counts.
    // - Always dedupe and cap list sizes (5 strengths, 4 weaknesses).
    strengths = uniqKeepOrder([
      ...(strengthsLLM || []),
      ...hrDet.strengths,
    ]).slice(0, 5);
    weaknesses = uniqKeepOrder([
      ...(weaknessesLLM || []),
      ...hrDet.weaknesses,
    ]).slice(0, 4);

    // As a safety net: never ship zero strengths
    if (strengths.length < 3) strengths = hrDet.strengths;
    if (weaknesses.length === 0) weaknesses = hrDet.weaknesses;

    // Optional: stash richer HR aids if the LLM provided them
    const hr_strengths_rich =
      parsed.extended?.hr_strengths_rich || hrDet.hr_strengths_rich;
    const hr_weaknesses_rich =
      parsed.extended?.hr_weaknesses_rich || hrDet.hr_weaknesses_rich;
    const hr_interview_probes =
      parsed.extended?.hr_interview_probes || hrDet.hr_interview_probes;
    const hr_summary = parsed.extended?.hr_summary || hrDet.hr_summary;

    // 17) Score breakdown object
    const mustIds = new Set(
      (jd.items || []).filter((i) => i.must).map((i) => i.id)
    );
    const detMap = new Map(jd_checklist.map((r) => [r.id, r]));
    let mustW = 0,
      mustGot = 0,
      niceW = 0,
      niceGot = 0;
    jd.items.forEach((it) => {
      const w = jd.weights[it.id] ?? 0.05;
      const row = detMap.get(it.id);
      const lvl = row?.status === "Pass" ? LVL[row.level] ?? 0.6 : 0;
      if (mustIds.has(it.id)) {
        mustW += w;
        mustGot += w * lvl;
      } else {
        niceW += w;
        niceGot += w * lvl;
      }
    });
    const mandatoryPct = mustW ? Math.round((mustGot / mustW) * 100) : 100;
    const nicePct = niceW ? Math.round((niceGot / niceW) * 100) : 0;

    const t = toLower(candidateData);
    const softHits = [
      "communication",
      "stakeholder",
      "client",
      "leadership",
      "mentored",
      "presentation",
      "collaboration",
    ].reduce((a, k) => a + (t.includes(k) ? 1 : 0), 0);
    const softSkillsPct = Math.min(100, 25 * softHits); // up to 100

    const score_breakdown = {
      mandatory: mandatoryPct,
      nice_to_have: nicePct,
      soft_skills: softSkillsPct,
      recency: recencyDet,
      formatting: formattingDet,
      keywords: scoreKeywordsFromATS(ats) ?? 0,
      impact: impactDet,
    };

    // 18) Human-friendly score summary for HR
    const score_summary = {
      overall: overallBlended,
      band,
      action, // immediate_hire | can_be_hire | hold | reject
      components: {
        jd_fit: roleFitMerged.score,
        tech_depth: techDepthDet.score,
        delivery: deliveryDet.score,
        ats_keywords: scoreKeywordsFromATS(ats) ?? 0,
        formatting: formattingDet,
        impact: impactDet,
        recency: recencyDet,
        must_have_coverage_pct: pct2(roleFitMerged.mustCoverage),
        risk: riskDet.score,
      },
      top_drivers: (roleFitMerged.drivers || []).slice(0, 5),
      top_gaps: (roleFitMerged.gaps || []).slice(0, 5),
    };

    // 19) Decision fields (kept legacy fields but updated to your labels)
    const decision = band === "fail" ? "Fail" : "Pass";
    const recommendation = action; // immediate_hire / can_be_hire / hold / reject

    // 20) Build response object
    const response = {
      score: overallBlended, // overall %
      decision, // "Pass" | "Fail"
      recommendation, // new label set
      confidence_pct: Math.round(confidence * 100), // explicit %
      jd_checklist, // merged checklist with evidence if any
      strengths,
      weaknesses,
      red_flags: [], // deterministic layer doesn’t infer red flags textually
      training_needs: (ats.missing || []).slice(0, 6), // quick win items
      growth_potential:
        overallBlended >= 80
          ? "Strong"
          : overallBlended >= 65
          ? "Average"
          : "Limited",
      role_alignment:
        roleFitMerged.score >= 75
          ? "High"
          : roleFitMerged.score >= 55
          ? "Medium"
          : "Low",

      hire_scores: {
        role_fit: roleFitMerged.score,
        tech_depth: techDepthDet.score,
        delivery: deliveryDet.score,
        risk: riskDet.score, // lower is better
      },

      score_summary, // <-- HR clarity block

      extended: {
        candidate_name: parsed.candidate_name || null,
        contact: parsed.contact || { emails: [], phones: [], location: null },
        experience_years:
          parsed.experience_years ?? extractYears(candidateData) ?? null,
        timeline_note: parsed.timeline_note || null,
        ats_keywords: ats,
        score_breakdown,
        jd_weights: jd.weights || {},
        jd_raw: Array.isArray(parsed.jd_checklist) ? parsed.jd_checklist : [],
        summary_bullets,
        llm_raw: raw || null,
        interview_recommendation: recommendation, // mirrors new labels
        confidence: round2(confidence), // 0..1
        tool_matrix: (() => {
          const techs = [
            "react",
            "vue",
            "next.js",
            "node",
            "express",
            "nest",
            "postgres",
            "mysql",
            "mongodb",
            "dynamodb",
            "aws",
            "s3",
            "ec2",
            "lambda",
            "cloudfront",
            "docker",
            "kubernetes",
            "jenkins",
            "github actions",
            "gitlab ci",
            "jwt",
            "oauth",
            "cypress",
            "playwright",
            "selenium",
          ];
          const tkset = new Set(tokenize(candidateData));
          return techs
            .filter(
              (t) =>
                tkset.has(toLower(t.replace(/\s+/g, ""))) ||
                candidateData.toLowerCase().includes(t)
            )
            .map((t) => ({ tech: t, years: null }));
        })(),
        recommended_next_steps: (() => {
          const steps = [];
          if (roleFitMerged.mustCoverage < 0.9)
            steps.push(
              "Address missing MUST-have JD topics with concrete project bullets."
            );
          if (deliveryDet.score < 60)
            steps.push(
              "Document CI/CD, cloud deploys, monitoring stack with tools and environments."
            );
          if ((scoreKeywordsFromATS(ats) ?? 0) < 60)
            steps.push(
              "Blend missing JD keywords naturally into experience bullets."
            );
          if (impactDet < 40)
            steps.push(
              "Add 2–3 quantified outcomes (%, time, cost, throughput)."
            );
          if (formattingDet < 60)
            steps.push(
              "Use consistent bullets, sections, and dates for readability."
            );
          return steps;
        })(),
        policy_notes: {
          decision_bands: {
            ">=80": "strong_pass → immediate_hire",
            "60–79": "normal_pass → can_be_hire",
            "50–59 or JD fit ≥60": "low_pass → hold",
            "<50": "fail → reject",
          },
          linkedIn_optional: true,
          resume_primary: true,
        },
      },

      _sources: {
        resume_used: !!resumeText,
        resume_chars: (resumeText || "").length,
        linkedin_used: liStatus.used,
        linkedin_ok: liStatus.ok,
        linkedin_chars: liStatus.chars,
        linkedin_reason: liStatus.reason || null,
        linkedin_method: liStatus.method || null,
        linkedin_url: linkedinUrl || null,
        model,
        version: BUILD_VERSION,
        latency_ms: Date.now() - started,
      },
      hr_strengths_rich,
      hr_weaknesses_rich,
      hr_interview_probes,
      hr_summary,
    };

    return res.json(response);
  } catch (e) {
    console.error("/api/analyze error", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

/* --------------------------------- Startup -------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Advanced Hiring API running http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY) {
    console.warn(
      "ℹ️ GROQ_API_KEY not set. Running in deterministic (non-LLM) mode."
    );
  }
});
