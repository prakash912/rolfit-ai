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

function tagMatch(tag, tokens, rawText, role) {
  const norm = String(tag || "")
    .toLowerCase()
    .trim();
  const joinTok = (s) => s.replace(/\s+/g, ""); // for token set lookups

  // Fast path: exact token or substring
  const naiveHit = tokens.has(joinTok(norm)) || rawText.includes(norm);

  if (ATS_CONTEXT_MODE === "naive") return naiveHit;

  // --- Context guards for ambiguous HR terms ---
  if (role === "hr_recruiter") {
    if (norm === "pipeline") {
      // require hiring context near "pipeline" (±20 chars)
      const ctx =
        /\b(?:hiring|talent|recruit(?:er|ment)?|candidate)\b.{0,20}\bpipeline\b|\bpipeline\b.{0,20}\b(?:hiring|talent|recruit(?:er|ment)?|candidate)\b/i;
      const devopsNear =
        /\b(ci\/?cd|jenkins|github actions|gitlab ci|build|deploy|kubernetes|docker)\b/i;
      const hit = ctx.test(rawText);
      if (!hit) return false;
      // if clearly devops-heavy around "pipeline", discard
      return !devopsNear.test(rawText);
    }
    if (norm === "recruiter") {
      // avoid counting generic "recruiters" from LI banners; prefer resume phrases
      const rx = /\b(technical|it)?\s*recruiter(s)?\b|\brecruitment\b/i;
      return rx.test(rawText);
    }
    if (norm === "technical hiring" || norm === "tech roles") {
      const rx =
        /\b(technical|tech)\s+hiring\b|\bhiring\s+(for|of)\s+(tech|engineering|it)\b/i;
      return rx.test(rawText);
    }
  }

  // default fallback
  return naiveHit;
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
  const seen = new Set(); const out = [];
  for (const x of (arr || [])) { const k = String(x).trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}
function clampList(arr, n) { return (arr || []).slice(0, n); }

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
    "react","next","vue","node","express","nest","typescript","javascript",
    "postgres","mysql","mongodb","redis",
    "aws","ec2","s3","lambda","cloudfront","api gateway","docker","kubernetes",
    "cypress","playwright","selenium","jest","mocha","graphql","rest"
  ];
  const hits = techList.filter(k => t.includes(k)).slice(0, 6);
  return hits.map(s => s.toUpperCase() === "REST" ? "REST" : s.replace(/\b\w/g, c => c.toUpperCase()));
}

function buildDeterministicHRInsights({
  roleFit, techDepth, delivery, atsPct, formatting, impact, recency,
  jd, jdChecklist, ats, resumeText, liText, candidateData,
}) {
  const strengths = [];
  const weaknesses = [];

  const resumeOrLI = (resumeText && resumeText.length > 50) ? resumeText : liText || "";
  const topTechs = deriveTopTechs(candidateData).join(", ");

  // Strength: JD alignment
  if (roleFit >= 70) {
    const snip = findSnippet(resumeOrLI, [/project|experience|role|responsib/i]);
    strengths.push(`JD Alignment — Impact: Ready to contribute with ${roleFit}% weighted JD fit. Evidence: "${snip || "Relevant project bullets present"}". Probe: Which JD must-haves are you strongest in and why?`);
  }

  // Strength: Technical depth
  if (techDepth >= 65) {
    const snip = findSnippet(resumeOrLI, [/react|node|typescript|postgres|mongodb|aws|docker|kubernetes/i]);
    strengths.push(`Technical Depth — Impact: Solid hands-on across ${topTechs || "core stack"}. Evidence: "${snip || "Stack listed in recent roles"}". Probe: Walk me through one deep technical decision and alternatives you rejected.`);
  }

  // Strength: Delivery/DevOps
  if (delivery >= 60) {
    const snip = findSnippet(resumeOrLI, [/ci\/?cd|jenkins|github actions|gitlab ci|docker|kubernetes|deploy/i]);
    strengths.push(`Delivery & DevOps — Impact: Demonstrated CI/CD and deployment ownership. Evidence: "${snip || "CI/CD and releases noted"}". Probe: Describe your pipeline, tests, and rollback strategy on a recent release.`);
  }

  // Strength: Impact orientation
  if (impact >= 40) {
    const snip = findSnippet(resumeOrLI, [/\b\d+%|\b\d+x|\b\d+ms|\b(\$|₹)[\d,]+/i]);
    strengths.push(`Outcome Focus — Impact: Uses metrics to prove results. Evidence: "${snip || "Quantified results mentioned"}". Probe: Pick one metric you moved—how did you isolate your contribution?`);
  }

  // Strength: Recency
  if (recency >= 80) {
    const snip = findSnippet(resumeOrLI, [/2024|2025|2023/i]);
    strengths.push(`Recent Hands-on — Impact: Up-to-date skills (recency ${recency}%). Evidence: "${snip || "Recent years visible"}". Probe: What’s the newest tool or pattern you adopted and why?`);
  }

  // Transferable/communication (if tokens show)
  if (/\b(stakeholder|client|presentation|mentored|lead|led|owned)\b/i.test(candidateData)) {
    const snip = findSnippet(resumeOrLI, [/stakeholder|client|presentation|mentored|led|owned/i]);
    strengths.push(`Collaboration/Ownership — Impact: Communicates and drives work across teams. Evidence: "${snip || "Collaboration verbs present"}". Probe: Describe a conflict you resolved between engineering and product.`);
  }

  // Weakness: Missing MUST items
  const mustSet = new Set((jd.items || []).filter(i => i.must).map(i => i.id));
  const mustFails = (jdChecklist || []).filter(r => r.status !== "Pass" && mustSet.has(r.id));
  if (mustFails.length) {
    const areas = mustFails.map(r => r.id).join(", ");
    weaknesses.push(`Must-Haves Gap — Risk: High. Evidence: "Fails: ${areas}". Mitigation: Complete a small project covering the missing MUST areas and add quantified results. Probe: Which MUST are you addressing first and how?`);
  }

  // Weakness: ATS gaps
  const missingTags = (ats?.missing || []).slice(0, 6);
  if (missingTags.length) {
    weaknesses.push(`Keyword Coverage — Risk: Medium. Evidence: "Missing: ${missingTags.join(", ")}". Mitigation: Blend missing tags into truthful bullets (tools, versions, scope). Probe: Where have you used or can you demo these quickly?`);
  }

  // Weakness: Delivery low
  if (delivery < 60) {
    weaknesses.push(`Delivery/DevOps Depth — Risk: Medium. Evidence: "CI/CD or release details limited". Mitigation: Document pipeline, test strategy, monitoring; ship a demo with pipeline yaml. Probe: How do you gate releases and monitor post-deploy?`);
  }

  // Weakness: Impact evidence low
  if (impact < 40) {
    weaknesses.push(`Quantified Impact — Risk: Medium. Evidence: "Few metrics on outcomes". Mitigation: Add 2–3 bullets with %/time/cost deltas per project. Probe: What baseline did you improve and by how much?`);
  }

  // Weakness: Formatting
  if (formatting < 60) {
    weaknesses.push(`Resume Clarity — Risk: Low. Evidence: "Formatting score ${formatting}%". Mitigation: Standardize sections/bullets/dates; trim fluff. Probe: If we skim 30s, what 3 results should pop out?`);
  }

  // Weakness: Recency
  if (recency < 60) {
    weaknesses.push(`Recency — Risk: Medium. Evidence: "Last activity older (recency ${recency}%)". Mitigation: Ship a fresh repo or case study using current stack. Probe: What’s the most recent project you can walk me through end-to-end?`);
  }

  // Ensure at least 3 strengths by adding safe transferable ones
  while (strengths.length < 3) {
    strengths.push(`Transferable Strength — Impact: Clear communication and structured thinking. Evidence: "Well-organized sections / role descriptions". Probe: Explain a complex concept from your resume to a non-engineer.`);
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
      "How did you align stakeholders with conflicting priorities?"
    ],
    hr_summary: {
      elevator_pitch: `Hands-on ${roleFit}% JD fit with ${techDepth}% technical depth; ${delivery}% delivery signals; focuses on ${topTechs || "core web platform"}.`,
      must_have_coverage_pct: Math.round(100 * ((jd.items || []).filter(i => i.must).length
        ? (jdChecklist || []).filter(r => r.status === "Pass" && mustSet.has(r.id)).length / (jd.items || []).filter(i => i.must).length
        : 1)),
      top_driver: roleFit >= 70 ? "Strong JD alignment" : "Solid core stack",
      key_risk: (mustFails.length ? "Must-have gaps" : (delivery < 60 ? "Delivery depth" : (impact < 40 ? "Impact evidence" : "Moderate risks")))
    }
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
function fallbackATSFromJD(candidateText, jd, role) {
  const raw = (candidateText || "").toLowerCase();
  const tokens = new Set(
    tokenize(candidateText).map((t) => t.replace(/\s+/g, ""))
  );

  const all = new Set();
  (jd.items || []).forEach((it) =>
    (it.tags || []).forEach((tg) => all.add(toLower(String(tg).trim())))
  );

  const matched = new Set();
  const missing = new Set();

  for (const tg of all) {
    if (tagMatch(tg, tokens, raw, role)) matched.add(tg);
    else missing.add(tg);
  }
  return { matched: Array.from(matched), missing: Array.from(missing) };
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
const LVL = { Strong: 1.0, Medium: 0.75, Weak: 0.4 };

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
    const role = (req.body.role || "software_engineer").toLowerCase().trim();
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
      return res
        .status(400)
        .json({
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
    const detChecklist = deterministicJDChecklist(atsText, jd, role);
    let ats = fallbackATSFromJD(atsText, jd, role);

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

    // 10) Recompute role-fit on merged checklist
    const roleFitMerged = scoreRoleFit(
      jd_checklist,
      jd.weights || {},
      jd.items || []
    );

    // 11) Deterministic overall (primary)
    const mustPenalty =
      roleFitMerged.mustCoverage < 0.8
        ? (0.8 - roleFitMerged.mustCoverage) * 30
        : 0;
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
    const bandFromScore = (overall, roleFitScore) => {
      if (overall >= 80) return "strong_pass";
      if (overall >= 60) return "normal_pass";
      if (overall >= 50 || roleFitScore >= 60) return "low_pass"; // JD>=60 => at least low pass
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
const strengthsLLM = Array.isArray(parsed.strengths) ? parsed.strengths.map(s => String(s).trim()).filter(Boolean) : [];
const weaknessesLLM = Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(s => String(s).trim()).filter(Boolean) : [];

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
strengths = uniqKeepOrder([...(strengthsLLM || []), ...hrDet.strengths]).slice(0, 5);
weaknesses = uniqKeepOrder([...(weaknessesLLM || []), ...hrDet.weaknesses]).slice(0, 4);

// As a safety net: never ship zero strengths
if (strengths.length < 3) strengths = hrDet.strengths;
if (weaknesses.length === 0) weaknesses = hrDet.weaknesses;

// Optional: stash richer HR aids if the LLM provided them
const hr_strengths_rich = parsed.extended?.hr_strengths_rich || hrDet.hr_strengths_rich;
const hr_weaknesses_rich = parsed.extended?.hr_weaknesses_rich || hrDet.hr_weaknesses_rich;
const hr_interview_probes = parsed.extended?.hr_interview_probes || hrDet.hr_interview_probes;
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
