import React, { useEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Upload,
  BarChart4,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Globe,
  FileText,
  X,
  Target,
  Award,
} from "lucide-react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
} from "recharts";
import { CircularProgressbar, buildStyles } from "react-circular-progressbar";
import "react-circular-progressbar/dist/styles.css";
import autoTable from "jspdf-autotable";
import jsPDF from "jspdf";

/* ====================== Types (match updated backend) ===================== */
export type JDItem = {
  skill: string;
  status: "Pass" | "Fail";
  level?: "Strong" | "Medium" | "Basic" | "Weak";
  evidence?: string;
  id?: string;
};

type HireScores = {
  role_fit: number; // 0-100
  tech_depth: number; // 0-100
  delivery: number; // 0-100
  risk: number; // 0-100 (higher = more risk)
};

type ScoreBreakdown = {
  mandatory?: number;
  nice_to_have?: number;
  soft_skills?: number;
  recency?: number;
  formatting?: number;
  keywords?: number;
  impact?: number;
};

type Extended = {
  candidate_name?: string | null;
  contact?: { emails: string[]; phones: string[]; location?: string | null };
  ats_keywords?: { matched: string[]; missing: string[]; inferred?: string[] };
  score_breakdown?: ScoreBreakdown;
  jd_weights?: Record<string, number>;
  jd_raw?: any[];
  summary_bullets?: string[];
  interview_recommendation?:
    | "Reject"
    | "Phone Screen"
    | "Technical Round"
    | "Onsite"
    | null;
  confidence?: number | null; // 0-1
  recommended_next_steps?: string[];
  tool_matrix?: { tech: string; years: number | null }[];
  hire_signals?: any; // optional detailed evidence
  llm_raw?: string;
};

export type LegacyResult = {
  score?: number;
  decision?: "Pass" | "Fail";
  recommendation?: string;
  jd_checklist?: JDItem[];
  strengths?: string[];
  weaknesses?: string[];
  red_flags?: string[];
  training_needs?: string[];
  growth_potential?: "Strong" | "Average" | "Limited";
  role_alignment?: "High" | "Medium" | "Low";
  hire_scores?: HireScores;
  extended?: Extended;
  _sources?: {
    resume_used?: boolean;
    resume_chars?: number;
    linkedin_used?: boolean;
    linkedin_chars?: number;
    linkedin_method?: string | null;
    linkedin_reason?: string | null;
    linkedin_url?: string | null;
    model?: string;
    latency_ms?: number;
  };
  [k: string]: any;
};

type Analysis = {
  overallScore: number; // 0-100
  categoryScores: {
    formatting: number;
    content: number;
    keywords: number;
    impact: number;
  };
  suggestions: string[];
  strengths: string[];
  analysisTimestamp: number;
};

const API_ANALYZE = "http://localhost:3000/api/analyze";

/* ======================================================================== */
export default function AnalyzeResume3Step() {
  // --- EXEC SUMMARY HELPERS ---

  // helper (put near other helpers)
  const stripProbe = (s?: string) => {
    if (!s) return "";
    // remove everything from "Probe:" (or "probe -/—") to the end
    const cleaned = s.replace(/\bprobe\b\s*[:\-–—]\s*.*$/i, "");
    // tidy leftover punctuation / whitespace / leading bullets or numbers
    return cleaned
      .replace(/[“”"]/g, "") // optional: drop quotes
      .replace(/\s+[.,;:!?]*\s*$/, "") // trailing punctuation
      .replace(/^\s*[-•\d.)\s]+/, "") // leading list tokens
      .trim();
  };

  function highlightNumbers(s: string) {
    // Wrap % and numbers in <mark> (subtle)
    const parts = s.split(/(\d+%|\d+\b)/g);
    return parts.map((p, i) =>
      /\d/.test(p) ? (
        <mark key={i} className="bg-amber-100/60 rounded px-1">
          {p}
        </mark>
      ) : (
        <span key={i}>{p}</span>
      )
    );
  }

  type SummaryStats = {
    overall?: number | null;
    jdFit?: number | null;
    mustCoverage?: number | null;
    techDepth?: number | null;
    delivery?: number | null;
    atsCoverage?: number | null;
    atsMatched?: number | null;
    atsMissing?: number | null;
    formatting?: number | null;
    impact?: number | null;
    recency?: number | null;
    risk?: number | null;
    flags?: string | null;
  };

  function parseSummaryBullets(bullets: string[]): SummaryStats {
    const stats: SummaryStats = {};
    for (const b of bullets) {
      let m: RegExpMatchArray | null;

      m = b.match(/Overall\s+(\d+)%/i);
      if (m) stats.overall = +m[1];

      m = b.match(/JD fit\s+(\d+)%/i);
      if (m) stats.jdFit = +m[1];

      m = b.match(/(\d+)%\s+must-have coverage/i);
      if (m) stats.mustCoverage = +m[1];

      m = b.match(/Tech depth\s+(\d+)%/i);
      if (m) stats.techDepth = +m[1];

      m = b.match(/delivery readiness\s+(\d+)%/i);
      if (m) stats.delivery = +m[1];

      m = b.match(
        /ATS coverage\s+(\d+)%\s*\((\d+)\s*matched\s*\/\s*(\d+)\s*missing\)/i
      );
      if (m) {
        stats.atsCoverage = +m[1];
        stats.atsMatched = +m[2];
        stats.atsMissing = +m[3];
      }

      m = b.match(/Formatting\s+(\d+)%/i);
      if (m) stats.formatting = +m[1];

      m = b.match(/impact (?:signals\s*)?(\d+)%/i);
      if (m) stats.impact = +m[1];

      m = b.match(/recency\s+(\d+)%/i);
      if (m) stats.recency = +m[1];

      m = b.match(/Risk\s+(\d+)(?:.*flags:\s*([a-zA-Z_\-]+))?/i);
      if (m) {
        stats.risk = +m[1];
        if (m[2]) stats.flags = m[2];
      }
    }
    return stats;
  }

  // ===== Your functional state =====
  const [role, setRole] = useState<"software_engineer" | "qa_engineer">(
    "software_engineer"
  );
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LegacyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

const [jdMode, setJdMode] = useState<"default" | "upload" | "text">("default");
const [jdFile, setJdFile] = useState<File | null>(null);
const [jdText, setJdText] = useState("");

function getJDExample(r: string) {
  if (r === "qa_engineer") {
    return `Required: 3+ years manual testing for web/mobile and API.\nAutomation with Selenium or Cypress (nice to have Playwright).\nAPI testing with Postman/Swagger.\nBug tracking in Jira/Zephyr; write and maintain test cases.\nFamiliar with CI/CD and Git.\nGood communication for client updates.`;
  }
  // default software engineer example
  return `Required: 3+ years with React and Node.js.\nTypeScript, REST and/or GraphQL APIs.\nSQL (Postgres/MySQL) and a NoSQL (MongoDB) nice to have.\nAuthN/Z (JWT/OAuth2) and security basics.\nAWS exposure (S3, EC2, Lambda) and CI/CD (GitHub Actions/Jenkins).\nClear communication and code reviews.`;
}

  // ===== Visual refs (GSAP) =====
  const scanOverlayRef = useRef<HTMLDivElement>(null);
  const scanBarsRef = useRef<HTMLDivElement>(null);
  const heroGradientRef = useRef<HTMLDivElement>(null);

  const summaryBullets: string[] =
    (result?.extended?.summary_bullets as string[]) ||
    (result?.summary_bullets as string[]) ||
    [];

  const summaryStats = useMemo(
    () => parseSummaryBullets(summaryBullets),
    [summaryBullets]
  );

  // ===== GSAP animations =====
  useEffect(() => {
    if (!heroGradientRef.current) return;
    const tl = gsap.timeline({ repeat: -1, yoyo: true });
    tl.to(heroGradientRef.current, {
      backgroundPosition: "200% 0",
      duration: 14,
      ease: "power1.inOut",
    });
    return () => tl.kill();
  }, []);
  useEffect(() => {
    if (!scanOverlayRef.current || !scanBarsRef.current) return;
    if (loading) {
      gsap.set(scanOverlayRef.current, { autoAlpha: 1 });
      const tl = gsap.timeline({ repeat: -1 });
      tl.to(scanBarsRef.current, {
        xPercent: 100,
        duration: 1.4,
        ease: "none",
      }).set(scanBarsRef.current, { xPercent: -100 });
      return () => tl.kill();
    } else {
      gsap.to(scanOverlayRef.current, {
        autoAlpha: 0,
        duration: 0.3,
        ease: "power2.out",
      });
    }
  }, [loading]);

  // ===== Derived =====
  const hasJD =
    Array.isArray(result?.jd_checklist) && result!.jd_checklist!.length > 0;
  const strengths = (
    Array.isArray(result?.strengths) ? result!.strengths! : []
  ) as string[];
  const weaknesses = (
    Array.isArray(result?.weaknesses) ? result!.weaknesses! : []
  ) as string[];
  const cleanStrengths = useMemo(
    () => (strengths || []).map(stripProbe).filter(Boolean),
    [strengths]
  );

  const cleanSuggestions = useMemo(
    () => (weaknesses || []).map(stripProbe).filter(Boolean),
    [weaknesses]
  );
  const redFlags = (
    Array.isArray(result?.red_flags) ? result!.red_flags! : []
  ) as string[];

  const sb: ScoreBreakdown = (result?.extended?.score_breakdown ||
    {}) as ScoreBreakdown;
  const candidateName = result?.extended?.candidate_name || "Candidate";
  const contact = result?.extended?.contact || {
    emails: [],
    phones: [],
    location: null,
  };
  // const ats = result?.extended?.ats_keywords || { matched: [], missing: [] };
  const ats = (result?.extended?.ats_keywords as any) || {
    matched: [],
    missing: [],
    inferred: [],
  };

  const norm = (s: string) =>
    (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[_\-]+/g, " ") // treat -/_ the same
      .trim();

  const inferredSet = useMemo(
    () => new Set<string>((ats.inferred || []).map(norm)),
    [ats.inferred]
  );

  const matchedInferred = useMemo(
    () => (ats.matched || []).filter((t: string) => inferredSet.has(norm(t))),
    [ats.matched, inferredSet]
  );
  const matchedDirect = useMemo(
    () => (ats.matched || []).filter((t: string) => !inferredSet.has(t)),
    [ats.matched, inferredSet]
  );

  const hire = result?.hire_scores || {
    role_fit: 0,
    tech_depth: 0,
    delivery: 0,
    risk: 0,
  };

  const analysis: Analysis | null = useMemo(() => {
    if (!result) return null;

    // Compose Content Quality from JD-related subscores
    const contentComposite = Math.round(
      (sb.mandatory ?? 0) * 0.6 +
        (sb.nice_to_have ?? 0) * 0.25 +
        (sb.soft_skills ?? 0) * 0.15
    );

    const cat = {
      formatting: Math.round(sb.formatting ?? 0),
      content: Math.max(0, Math.min(100, contentComposite || 0)),
      keywords: Math.round(
        sb.keywords ??
          (Array.isArray(ats.matched) &&
          ats.matched.length + (ats.missing?.length || 0) > 0
            ? Math.round(
                (ats.matched.length /
                  (ats.matched.length + (ats.missing?.length || 0))) *
                  100
              )
            : 0)
      ),
      impact: Math.round(sb.impact ?? 0),
    } as Analysis["categoryScores"];

    return {
      overallScore:
        typeof result.score === "number"
          ? result.score
          : typeof (result as any)?.extended?.overall === "number"
          ? (result as any).extended.overall
          : 0,
      categoryScores: cat,
      suggestions: weaknesses || [],
      strengths: strengths || [],
      analysisTimestamp: Date.now(),
    };
  }, [
    result,
    strengths,
    weaknesses,
    ats.matched?.length,
    ats.missing?.length,
    sb,
  ]);

  const radarData = useMemo(() => {
    if (hasJD) {
      const items: JDItem[] = result!.jd_checklist!;
      return items.map((it) => ({
        subject: it.skill.length > 26 ? it.skill.slice(0, 23) + "…" : it.skill,
        A:
          it.status === "Pass"
            ? it.level === "Strong"
              ? 100
              : it.level === "Medium"
              ? 70
              : 40
            : 0,
        fullMark: 100,
      }));
    }
    if (!result) return [] as any[];
    return [
      {
        subject: "Strengths",
        A: Math.min(100, (strengths.length || 0) * 25),
        fullMark: 100,
      },
      {
        subject: "Weaknesses",
        A: Math.max(0, 100 - (weaknesses.length || 0) * 20),
        fullMark: 100,
      },
      {
        subject: "Red Flags",
        A: Math.max(0, 100 - (redFlags.length || 0) * 30),
        fullMark: 100,
      },
    ];
  }, [hasJD, result, strengths.length, weaknesses.length, redFlags.length]);

  const scoreValue = typeof result?.score === "number" ? result.score : 0;
  const decision = result?.decision || (scoreValue >= 70 ? "Pass" : "Fail");
  const recommendation = result?.recommendation || "";
  const interviewRec = result?.extended?.interview_recommendation || null;
  const confidence = result?.extended?.confidence ?? null;

  // ===== Helpers =====
  const getScoreColor = (score: number) => {
    if (score < 50) return "text-red-500";
    if (score < 70) return "text-amber-500";
    if (score < 90) return "text-emerald-500";
    return "text-indigo-600";
  };
  const formatBytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

  const validLinkedIn = useMemo(() => {
    if (!linkedinUrl) return false;
    try {
      const u = new URL(linkedinUrl);
      return u.host.includes("linkedin.com");
    } catch {
      return false;
    }
  }, [linkedinUrl]);

  const step = result ? 3 : resumeFile ? 2 : 1;

  function ChipList({
    title,
    items,
    color,
    markInferred,
  }: {
    title: string;
    items: string[];
    color: "emerald" | "amber";
    markInferred?: (tag: string) => boolean;
  }) {
    // base palettes
    const base =
      color === "emerald"
        ? {
            bg: "bg-green-50",
            text: "text-green-700",
            border: "border-green-200",
          }
        : {
            bg: "bg-amber-50",
            text: "text-amber-700",
            border: "border-amber-200",
          };

    // palette for INFERRED chips (different color)
    const inferred = {
      bg: "bg-indigo-50",
      text: "text-indigo-700",
      border: "border-indigo-200",
    };

    return (
      <div>
        <div className="text-sm font-medium mb-2">{title}</div>
        <div className="flex flex-wrap gap-2">
          {(items || []).length ? (
            items.map((k, i) => {
              const isInf = markInferred ? !!markInferred(k) : false;
              const tone = isInf ? inferred : base;
              return (
                <span
                  key={`${k}-${i}`}
                  title={isInf ? "Inferred via ontology" : undefined}
                  className={[
                    "px-2 py-1 rounded-full text-xs",
                    tone.bg,
                    tone.text,
                    isInf ? "border-2 border-dashed" : "border",
                    tone.border,
                  ].join(" ")}
                >
                  {k}
                </span>
              );
            })
          ) : (
            <span className="text-xs text-gray-500">None</span>
          )}
        </div>
      </div>
    );
  }

  // ===== Handlers =====
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setResult(null);
    setError(null);
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      if (
        f.type === "application/pdf" ||
        f.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        setResumeFile(f);
      } else {
        setResumeFile(null);
        setError("Please upload a PDF or DOCX file");
      }
    }
  }
  function clearFile() {
    setResumeFile(null);
    setResult(null);
    const input = document.getElementById(
      "resume-input"
    ) as HTMLInputElement | null;
    if (input) input.value = "";
  }

  function formatValue(s?: string | null) {
    if (!s) return "";
    return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function handleAnalyze(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError(null);
    setResult(null);
    if (!resumeFile) {
      setError("Please select a resume file first");
      return;
    }

    const fd = new FormData();
    fd.append("role", role);
    fd.append("resume", resumeFile);
    if (linkedinUrl) fd.append("linkedinUrl", linkedinUrl.trim());
     fd.append("jd_mode", jdMode);
if (jdMode === "upload" && jdFile) fd.append("jd", jdFile);
 if (jdMode === "text" && jdText.trim()) fd.append("jd_text", jdText.trim());

    setLoading(true);
    try {
      const res = await fetch(API_ANALYZE, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data: LegacyResult = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ===== PDF Report =====
  // async function handleDownloadPdf() {
  //   try {
  //     const { jsPDF } = await import("jspdf"); // dynamic import, keeps bundle slim
  //     const doc = new jsPDF({ unit: "pt" });

  //     const add = (y: number, text: string, size = 12, bold = false) => {
  //       doc.setFont("helvetica", bold ? "bold" : "normal");
  //       doc.setFontSize(size);
  //       doc.text(text, 48, y);
  //       return y + (size + 12);
  //     };

  //     let y = 64;
  //     y = add(y, `${candidateName} — Resume Report`, 18, true);
  //     y = add(y, `Role: ${role.replace("_", " ")}   |   Decision: ${decision}   |   Overall: ${analysis?.overallScore ?? 0}%`, 12);
  //     if (interviewRec) y = add(y, `Interview Recommendation: ${interviewRec}   (Confidence: ${confidence ?? "N/A"})`, 12);

  //     if (contact?.location || (contact?.emails?.length || 0) > 0) {
  //       const email = contact.emails?.[0] || "—";
  //       const loc = contact.location || "—";
  //       y = add(y, `Contact: ${email}   |   Location: ${loc}`, 11);
  //     }

  //     y += 10; doc.setLineWidth(0.6); doc.line(48, y, 560, y); y += 20;

  //     // Hire scores
  //     y = add(y, "Hireability Overview", 14, true);
  //     y = add(y, `Role Fit: ${hire.role_fit}%    |    Technical Depth: ${hire.tech_depth}%`, 11);
  //     y = add(y, `Delivery Readiness: ${hire.delivery}%    |    Risk: ${hire.risk}% (lower is better)`, 11);

  //     y += 8;
  //     y = add(y, "Category Breakdown", 13, true);
  //     y = add(y, `Formatting: ${analysis?.categoryScores.formatting ?? 0}%   |   Content: ${analysis?.categoryScores.content ?? 0}%`, 11);
  //     y = add(y, `Keywords: ${analysis?.categoryScores.keywords ?? 0}%   |   Impact: ${analysis?.categoryScores.impact ?? 0}%`, 11);

  //     // Strengths/Weaknesses
  //     y += 8; y = add(y, "Strengths", 13, true);
  //     (strengths.slice(0, 6).length ? strengths.slice(0, 6) : ["—"]).forEach((s) => (y = add(y, `• ${s}`, 11)));
  //     y += 6; y = add(y, "Areas to Improve", 13, true);
  //     ((weaknesses || []).slice(0, 6).length ? weaknesses.slice(0, 6) : ["—"]).forEach((w) => (y = add(y, `• ${w}`, 11)));

  //     // JD highlights
  //     if (hasJD) {
  //       y += 6; y = add(y, "JD Highlights", 13, true);
  //       (result?.jd_checklist || []).slice(0, 8).forEach((it) => {
  //         const tag = it.status === "Pass" ? "✓" : "✕";
  //         y = add(y, `${tag} ${it.skill}${it.level ? ` (${it.level})` : ""}${it.evidence ? ` — ${it.evidence}` : ""}`, 11);
  //       });
  //     }

  //     // Next steps
  //     const steps = result?.extended?.recommended_next_steps || [];
  //     y += 6; y = add(y, "Recommended Next Steps", 13, true);
  //     (steps.length ? steps : ["—"]).forEach((s) => (y = add(y, `• ${s}`, 11)));

  //     // Footer
  //     y += 14; doc.setFontSize(9);
  //     doc.text(`Generated ${new Date().toLocaleString()}`, 48, 780);
  //     doc.save(`${candidateName?.replace(/\s+/g, "_") || "Candidate"}_Report.pdf`);
  //   } catch (e) {
  //     console.error("PDF error:", e);
  //     alert("Could not generate PDF report. Please ensure 'jspdf' is installed.");
  //   }
  // }

  function slugify(s: string) {
    return (s || "")
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function truncate(s: string, n = 180) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function levelToText(l?: string) {
    if (!l) return "—";
    // normalize "Weak"/"Basic"
    if (l.toLowerCase() === "basic") return "Basic";
    if (l.toLowerCase() === "weak") return "Weak";
    return l;
  }

  /**
   * Build PDF **from evaluated data**:
   * - primary source: result.jd_checklist (Pass/Fail, Level, Evidence)
   * - fallback: result.extended.jd_raw (same structure from backend)
   */
  function generateReportPDF(result: LegacyResult) {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const mm = 72 / 25.4; // points per mm

    const name =
      (result as any)?.extended?.candidate_name ||
      (result as any)?.candidate_name ||
      "Candidate";

    const role =
      (result as any)?.role ||
      (result as any)?.extended?.role ||
      "Software Engineer";

    const overall =
      typeof result.score === "number"
        ? Math.max(0, Math.min(100, result.score))
        : 0;

    const sb =
      (result as any)?.hire_scores || (result as any)?.hire_scores || {};
    const cat = {
      role_fit: Math.round(sb.tech_depth ?? 0),
      tech_depth: Math.round(sb.tech_depth ?? 0),
      delivery: Math.round(sb.delivery ?? 0),
      risk: Math.round(sb.risk ?? 0),
    };

    // === Header ===
    const left = 24 * mm;
    let y = 24 * mm;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(`Resume Evaluation — ${name}`, left, y);
    y += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(
      `Role: ${role}     Overall: ${overall}%     Decision: ${
        result.decision || (overall >= 70 ? "Pass" : "Fail")
      }`,
      left,
      (y += 16)
    );
    doc.text(`Generated: ${new Date().toLocaleString()}`, left, (y += 16));

    // === Category Breakdown ===
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Category Breakdown", left, (y += 20));

    autoTable(doc, {
      startY: y + 10,
      styles: { font: "helvetica", fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [33, 150, 243] }, // blue header
      head: [["Category", "Score"]],
      body: [
        ["Role Fit", `${cat.role_fit}%`],
        ["Tech Depth Knowedge", `${cat.tech_depth}%`],
        ["Delivery", `${cat.delivery}%`],
        ["Risk to hire(Must be less than 60%)", `${cat.risk}%`],
      ],
      theme: "striped",
      margin: { left, right: left },
    });

    // Advance y to below the table
    y = (doc as any).lastAutoTable?.finalY || y + 40;

    // === JD Checklist (from evaluated results) ===
    const checklist: Array<{
      skill: string;
      status: "Pass" | "Fail";
      level?: string;
      evidence?: string;
    }> =
      Array.isArray(result.jd_checklist) && result.jd_checklist.length
        ? result.jd_checklist
        : Array.isArray((result as any)?.extended?.jd_raw)
        ? (result as any).extended.jd_raw.map((r: any) => ({
            skill: r.skill || r.id || "",
            status: r.status === "Pass" ? "Pass" : "Fail",
            level: r.level,
            evidence:
              Array.isArray(r.evidence_spans) && r.evidence_spans.length
                ? r.evidence_spans[0].text
                : "",
          }))
        : [];

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("JD Checklist", left, (y += 28));

    if (!checklist.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No JD evidence found.", left, (y += 16));
    } else {
      autoTable(doc, {
        startY: y + 10,
        styles: {
          font: "helvetica",
          fontSize: 9,
          cellPadding: 6,
          overflow: "linebreak",
        },
        headStyles: { fillColor: [76, 175, 80] }, // green header
        head: [["Requirement", "Status", "Level", "Evidence"]],
        body: checklist.map((it) => [
          it.skill || "—",
          it.status === "Pass" ? "✓ Pass" : "✕ Fail",
          levelToText(it.level),
          truncate(it.evidence || "", 300),
        ]),
        columnStyles: {
          0: { cellWidth: 180 }, // Requirement
          1: { cellWidth: 70 }, // Status
          2: { cellWidth: 70 }, // Level
          3: { cellWidth: "auto" }, // Evidence
        },
        theme: "grid",
        margin: { left, right: left },
        didParseCell: (data) => {
          // colorize status column
          if (data.section === "body" && data.column.index === 1) {
            const v = String(data.cell.raw || "");
            if (v.startsWith("✓")) data.cell.styles.textColor = [21, 128, 61]; // green
            if (v.startsWith("✕")) data.cell.styles.textColor = [185, 28, 28]; // red
          }
        },
      });
      y = (doc as any).lastAutoTable?.finalY || y + 40;
    }

    // === Strengths / Improvements ===
    const strengths: string[] = Array.isArray(result.strengths)
      ? result.strengths
      : [];
    const weaknesses: string[] = Array.isArray(result.weaknesses)
      ? result.weaknesses
      : [];

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Strengths", left, (y += 28));
    autoTable(doc, {
      startY: y + 10,
      styles: { fontSize: 10, cellPadding: 6 },
      head: [["Strength"]],
      body: strengths.length ? strengths.map((s) => [s]) : [["—"]],
      theme: "plain",
      margin: { left, right: left },
    });
    y = (doc as any).lastAutoTable?.finalY || y + 28;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Areas for Improvement", left, (y += 28));
    autoTable(doc, {
      startY: y + 10,
      styles: { fontSize: 10, cellPadding: 6 },
      head: [["Suggestion"]],
      body: weaknesses.length ? weaknesses.map((w) => [w]) : [["—"]],
      theme: "plain",
      margin: { left, right: left },
    });

    // === Save ===
    const file = `${slugify(name)}-report.pdf`;
    doc.save(file);
  }

  // ===== Drag & drop =====
  const [isDragActive, setIsDragActive] = useState(false);
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(true);
  };
  const onDragLeave = () => setIsDragActive(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (
      f.type === "application/pdf" ||
      f.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      setResumeFile(f);
      setResult(null);
      setError(null);
    } else {
      setError("Please upload a PDF or DOCX file");
    }
  };

  function StatChip({
    label,
    value,
    suffix = "%",
    tone = "indigo",
  }: {
    label: string;
    value?: number | null;
    suffix?: string;
    tone?: "indigo" | "emerald" | "amber" | "sky" | "violet";
  }) {
    const v = typeof value === "number" ? value : null;
    const clr =
      tone === "emerald"
        ? ["bg-emerald-50", "text-emerald-700", "border-emerald-200"]
        : tone === "amber"
        ? ["bg-amber-50", "text-amber-700", "border-amber-200"]
        : tone === "sky"
        ? ["bg-sky-50", "text-sky-700", "border-sky-200"]
        : tone === "violet"
        ? ["bg-violet-50", "text-violet-700", "border-violet-200"]
        : ["bg-indigo-50", "text-indigo-700", "border-indigo-200"];

    return (
      <div
        className={`px-3 py-2 rounded-lg border ${clr[0]} ${clr[1]} ${clr[2]} text-sm`}
      >
        <div className="text-xs opacity-80">{label}</div>
        <div className="font-semibold">
          {v === null ? "—" : `${v}${suffix}`}
        </div>
      </div>
    );
  }

  function ExecutiveSummary({
    bullets,
    stats,
    overallForRing,
  }: {
    bullets: string[];
    stats: SummaryStats;
    overallForRing: number;
  }) {
    return (
      <Card className="shadow-sm">
        <CardHeader className="border-b">
          <CardTitle>Executive Summary</CardTitle>
          <CardDescription>
            One-glance snapshot for HR & hiring managers
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: bullets */}
            <div className="lg:col-span-2">
              <ul className="space-y-3">
                {bullets.length ? (
                  bullets.map((b, i) => {
                    const isRisk = /risk/i.test(b);
                    return (
                      <li
                        key={i}
                        className="flex items-start gap-3 p-3 rounded-md border border-gray-200"
                      >
                        <span
                          className={`mt-0.5 inline-flex items-center justify-center h-6 w-6 rounded-full text-sm ${
                            isRisk
                              ? "bg-amber-100 text-amber-700"
                              : "bg-green-100 text-green-700"
                          }`}
                        >
                          {isRisk ? "!" : "✓"}
                        </span>
                        <div className="text-gray-800">
                          {highlightNumbers(b)}
                        </div>
                      </li>
                    );
                  })
                ) : (
                  <li className="text-gray-500">No summary provided.</li>
                )}
              </ul>
            </div>

            {/* Right: ring + chips */}
            <div className="flex flex-col items-center gap-4">
              {/* Overall ring mirrors your style */}
              <div className="grid grid-cols-2 gap-2 w-full">
                <StatChip
                  label="Must Coverage"
                  value={stats.mustCoverage ?? null}
                  tone="sky"
                />
                <StatChip
                  label="ATS Coverage"
                  value={stats.atsCoverage ?? null}
                  tone="amber"
                />
              </div>
              {(typeof stats.atsMatched === "number" ||
                typeof stats.atsMissing === "number") && (
                <div className="text-xs text-gray-600">
                  ATS terms:{" "}
                  <span className="font-medium text-emerald-700">
                    {stats.atsMatched ?? "—"} matched
                  </span>{" "}
                  /{" "}
                  <span className="font-medium text-amber-700">
                    {stats.atsMissing ?? "—"} missing
                  </span>
                </div>
              )}
              {typeof stats.risk === "number" && (
                <div className="text-xs text-gray-600">
                  Risk:{" "}
                  <span
                    className={
                      stats.risk > 40
                        ? "text-amber-700 font-medium"
                        : "text-gray-700 font-medium"
                    }
                  >
                    {stats.risk}%
                  </span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  /* ================================ UI =================================== */
  return (
    <div className="bg-gradient-to-b from-slate-50 to-white min-h-screen relative">
      {/* Scanning overlay */}
      <div
        ref={scanOverlayRef}
        className="pointer-events-none fixed inset-0 z-50 bg-black/20 opacity-0"
      >
        <div className="absolute inset-0 overflow-hidden">
          <div ref={scanBarsRef} className="h-full w-1/3 bg-white/10" />
        </div>
      </div>

      {/* Hero gradient */}
      <div
        ref={heroGradientRef}
        className="absolute inset-x-0 top-0 h-64 bg-[linear-gradient(90deg,#e0f2fe,#eef2ff,#e0f2fe)] bg-[length:200%_100%]"
      />

      <div className="container mx-auto px-4 sm:px-6 py-14 relative">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <h1 className="text-4xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
              AI Resume Analysis
            </h1>
            <p className="text-gray-600">
              Same smooth 3-step UI. Your API & scores.
            </p>
          </div>

          {/* Stepper */}
          <Stepper step={step} />

          {/* Errors */}
          {error && (
            <div className="max-w-2xl mx-auto mb-6">
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            </div>
          )}

          {/* Step 1 */}
          {step === 1 && (
            <Card className="mb-8 shadow-sm">

              <Card className="mb-8 shadow-sm">
              <CardHeader className="border-b bg-slate-50/80">
                <CardTitle className="flex items-center gap-2 text-xl">

              <div><Upload className="h-5 w-5 text-blue-500" /> Step 1: Add
                  Details & Resume
                <CardDescription>
                  Choose role, paste LinkedIn, and add your resume (PDF/DOCX)
                </CardDescription></div>
                </CardTitle>
                </CardHeader>
                </Card>

  <CardHeader>
    <CardTitle className="text-base">Job Description</CardTitle>
    <CardDescription>Select how you want to provide the JD.</CardDescription>
  </CardHeader>
  <CardContent className="space-y-3">
    <div className="flex gap-2">
      <Button variant={jdMode === "default" ? "default" : "outline"} size="sm" onClick={() => setJdMode("default")}>
        Use default SYMB JD
      </Button>
      <Button variant={jdMode === "upload" ? "default" : "outline"} size="sm" onClick={() => setJdMode("upload")}>
        Upload JD
      </Button>
      <Button variant={jdMode === "text" ? "default" : "outline"} size="sm" onClick={() => setJdMode("text")}>
        Write JD
      </Button>
    </div>

    {jdMode === "upload" && (
      <div className="flex items-center gap-3">
        <Input
          type="file"
          accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setJdFile(e.target.files?.[0] || null)}
        />
        {jdFile && (
          <div className="text-xs text-gray-500">
            {jdFile.name} • {(jdFile.size / 1024).toFixed(1)} KB
            <Button variant="ghost" size="icon" onClick={() => setJdFile(null)} className="ml-1">
              <X className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    )}

    {jdMode === "text" && (
      <div className="space-y-2">
        <textarea
          className="w-full rounded border p-3 text-sm min-h-[140px]"
          placeholder={`Paste or type the JD here. One requirement per line.\n\nTip: mark must-haves with words like "Required", "Must", or "3+ years".`}
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setJdText(getJDExample(role))}
          >
            Use example JD
          </Button>
          <span className="text-xs text-gray-500">We’ll detect must-haves and tags automatically.</span>
        </div>
      </div>
    )}

    {jdMode === "default" && (
      <div className="text-xs text-gray-600">
        Using the built-in SYMB JD for <b>{formatValue(role)}</b>. You can switch to “Upload JD” or “Write JD” anytime.
      </div>
    )}
  </CardContent>

{result?.extended?.jd_origin && (
  <div className="text-xs text-gray-500 mt-2">
    JD mode: <b>{result.extended.jd_origin.mode}</b>
    {result.extended.jd_origin.items ? ` • ${result.extended.jd_origin.items} items` : null}
    {result.extended.jd_origin.note ? ` — ${result.extended.jd_origin.note}` : null}
  </div>
)}

      
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Role
                    </label>
                    <div className="relative">
                      <select
                        value={role}
                        onChange={(e) => setRole(e.target.value as any)}
                        className="w-full h-10 rounded-md border border-gray-300 bg-white px-3 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="software_engineer">
                          Software Engineer / Full Stack Developer
                        </option>
                        <option value="qa_engineer">QA Engineer</option>
                        <option value="drupal_developer">
                          Drupal Developer
                        </option>
                        <option value="tech_lead">Tech Lead</option>
                        <option value="business_analyst">
                          Business Analyst
                        </option>
                        <option value="project_manager">Project Manager</option>
                        <option value="hr_recruiter">HR Recruiter</option>
                        <option value="frontend_engineer_react">
                          Frontend Engineer React
                        </option>
                        <option value="frontend_engineer_vue_nuxt">
                          Frontend Engineer Vue/Nuxt
                        </option>
                        <option value="backend_engineer_node">
                          Backend Engineer NodeJS
                        </option>
                        <option value="backend_engineer_python">
                          Backend Engineer Python
                        </option>
                        <option value="aws_devops_engineer">
                          Aws Devops Engineer
                        </option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-gray-400">
                        ▾
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                      <Globe className="h-4 w-4 text-blue-500" /> LinkedIn
                      Profile URL
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="url"
                        value={linkedinUrl}
                        onChange={(e) => setLinkedinUrl(e.target.value)}
                        placeholder="https://www.linkedin.com/in/username"
                        className={`${
                          linkedinUrl && !validLinkedIn ? "border-red-300" : ""
                        }`}
                      />
                    </div>
                    {linkedinUrl && !validLinkedIn && (
                      <p className="text-xs text-red-600 mt-1">
                        Please enter a valid LinkedIn URL.
                      </p>
                    )}
                  </div>
                </div>

                {/* File input area */}
                <div
                  className={`flex flex-col items-center px-4 py-12 border-2 ${
                    isDragActive
                      ? "border-blue-400 bg-blue-50"
                      : "border-dashed border-gray-300 bg-gray-50"
                  } rounded-lg transition-all`}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                >
                  <div
                    className={`w-16 h-16 rounded-full ${
                      resumeFile ? "bg-blue-100" : "bg-blue-50"
                    } flex items-center justify-center mb-4`}
                  >
                    <Upload
                      size={30}
                      className={`${
                        resumeFile ? "text-blue-600" : "text-blue-400"
                      }`}
                    />
                  </div>
                  <p className="text-lg font-medium mb-2">
                    {isDragActive
                      ? "Drop your file here"
                      : "Drag and drop your resume"}
                  </p>
                  <p className="text-gray-500 mb-6">or</p>
                    <Input
                    id="resume-input"
                    type="file"
                    accept=".pdf,.docx"
                    onChange={onFileChange}
                    className="hidden"
                  />
                  <label
                    htmlFor="resume-input"
                    className="mt-4 mx-3 inline-flex items-center justify-center rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 h-10 px-6 py-2 cursor-pointer shadow-sm hover:shadow"
                  >
                    Browse Files
                  </label>
                  {resumeFile && (
                    <div className="mt-6 text-sm flex items-center gap-2 bg-white p-3 rounded-md border border-blue-100 shadow-sm max-w-sm w-full">
                      <div className="p-2 bg-blue-50 rounded-full">
                        <FileText className="h-5 w-5 text-blue-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className="truncate font-medium"
                          title={resumeFile.name}
                        >
                          {resumeFile.name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {formatBytes(resumeFile.size)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-gray-500 hover:bg-red-50 hover:text-red-500"
                        onClick={clearFile}
                        title="Clear selection"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2 */}
          {step === 2 && (
            <Card className="mb-8 shadow-sm border-blue-100">
              <CardHeader className="border-b bg-blue-50/70">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <BarChart4 className="h-5 w-5 text-blue-500" /> Step 2:
                  Analyze Resume
                </CardTitle>
                <CardDescription>
                  We’ll send your role, LinkedIn (optional), and resume to your
                  analyzer
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg mb-6">
                  <div className="flex-shrink-0">
                    <CheckCircle2 className="h-8 w-8 text-green-500" />
                  </div>
                  <div>
                    <p className="font-medium">Ready to analyze</p>
                    <p className="text-sm text-gray-600">{resumeFile?.name}</p>
                  </div>
                </div>
                <div className="flex justify-center">
                  <Button
                    onClick={handleAnalyze}
                    disabled={loading}
                    className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white px-8 py-2 h-11"
                  >
                    {loading ? (
                      <>
                        <AlertTriangle className="mr-2 h-4 w-4 animate-pulse" />{" "}
                        Analyzing…
                      </>
                    ) : (
                      <>
                        Analyze Now <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3 */}
          {step === 3 && analysis && (
            <div className="space-y-10">
              {/* Candidate header */}
              <Card className="shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-indigo-600" />
                    {candidateName}
                    {contact?.location && (
                      <span className="text-sm font-normal text-gray-500">
                        — {contact.location}
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    Decision:{" "}
                    <span
                      className={`font-medium ${
                        decision === "Pass"
                          ? "text-emerald-600"
                          : "text-rose-600"
                      }`}
                    >
                      {decision}
                    </span>
                    {/* {recommendation ? ` • ${formatValue(recommendation)}` : ""} */}
                    {interviewRec
                      ? ` • Interview: ${formatValue(interviewRec)}`
                      : ""}
                    {confidence !== null
                      ? ` • Confidence: ${(confidence * 100).toFixed(0)}%`
                      : ""}
                  </CardDescription>
                </CardHeader>
              </Card>

              {/* Overall Score */}
              <OverallScoreCard
                value={analysis.overallScore}
                timestamp={analysis.analysisTimestamp}
              />

              {/* Hireability Overview (NEW 4 cards) */}
              <section>
                <h2 className="text-2xl font-semibold mb-5 border-l-4 border-indigo-500 pl-3">
                  Hireability Overview
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                  <HireCard
                    title="Role Fit"
                    value={hire.role_fit}
                    hint="JD match weighted by must-haves"
                  />
                  <HireCard
                    title="Technical Depth"
                    value={hire.tech_depth}
                    hint="Breadth & depth across stack"
                  />
                  <HireCard
                    title="Delivery Readiness"
                    value={hire.delivery}
                    hint="CI/CD, cloud, agile, ownership"
                  />
                  <HireCard
                    title="Risk (higher is better)"
                    value={100 -(hire.risk || 0)}
                    invert
                    hint="Penalty for must-fail & flags"
                  />
                </div>
              </section>

              {/* Category Breakdown */}
              <section>
                <h2 className="text-2xl font-semibold mb-5 border-l-4 border-blue-500 pl-3">
                  Category Breakdown
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                  <MiniScore
                    title="Formatting"
                    value={analysis.categoryScores.formatting}
                    tone="#3B82F6"
                  />
                  <MiniScore
                    title="Content Quality"
                    value={analysis.categoryScores.content}
                    tone="#10B981"
                  />
                  <MiniScore
                    title="Keywords"
                    value={analysis.categoryScores.keywords}
                    tone="#F97316"
                  />
                  <MiniScore
                    title="Impact"
                    value={analysis.categoryScores.impact}
                    tone="#8B5CF6"
                  />
                </div>
              </section>

              {/* JD Checklist */}
              {hasJD && (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle>JD Checklist</CardTitle>
                    <CardDescription>
                      Evidence for each requirement
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-3">
                      {result!.jd_checklist!.map((it, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-3 p-3 rounded-md border border-gray-200"
                        >
                          <span
                            className={`mt-0.5 inline-flex items-center justify-center h-6 w-6 rounded-full text-sm ${
                              it.status === "Pass"
                                ? "bg-green-100 text-green-700"
                                : "bg-red-100 text-red-700"
                            }`}
                          >
                            {it.status === "Pass" ? "✓" : "✕"}
                          </span>
                          <div className="flex-1">
                            <div className="font-medium text-gray-800">
                              {it.skill}
                              {it.level && (
                                <span
                                  className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${
                                    it.level === "Strong"
                                      ? "bg-green-50 text-green-700 border-green-200"
                                      : it.level === "Medium"
                                      ? "bg-amber-50 text-amber-700 border-amber-200"
                                      : "bg-gray-50 text-gray-700 border-gray-200"
                                  }`}
                                >
                                  {it.level}
                                </span>
                              )}
                            </div>
                            {it.evidence && (
                              <div className="text-sm text-gray-600 mt-1">
                                {it.evidence}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* ATS Keywords */}
              <Card className="shadow-sm">
                <CardHeader className="border-b">
                  <CardTitle>ATS Keywords</CardTitle>
                  <CardDescription>
                    Matched {ats.matched?.length || 0}
                    {matchedInferred.length
                      ? ` (${matchedInferred.length} inferred)`
                      : ""}{" "}
                    / {(ats.matched?.length || 0) + (ats.missing?.length || 0)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Matched: dashed border if inferred */}
                    <ChipList
                      title="Matched"
                      items={(ats.matched || []).slice(0, 30)}
                      color="emerald"
                      markInferred={(tag) => inferredSet.has(tag)} // or inferredSet.has(norm(tag))
                    />

                    <ChipList
                      title="Missing"
                      items={(ats.missing || []).slice(0, 30)}
                      color="amber"
                    />
                  </div>

                  {/* small legend */}
                  {matchedInferred.length > 0 && (
                    <div className="mt-2 text-xs text-gray-500">
                      Note:{" "}
                      <span className="border-b border-dashed">dashed</span> =
                      inferred via ontology
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Skill Radar */}
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Skill Radar</CardTitle>
                  <CardDescription>
                    Snapshot of JD match and signals
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div style={{ width: "100%", height: 340 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <RadarChart data={radarData}>
                        <PolarGrid stroke="#e5e7eb" />
                        <PolarAngleAxis
                          dataKey="subject"
                          tick={{ fill: "#6b7280", fontSize: 12 }}
                        />
                        <Radar
                          name="Candidate"
                          dataKey="A"
                          stroke="#60a5fa"
                          fill="#60a5fa"
                          fillOpacity={0.5}
                        />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Executive Summary (from summary_bullets) */}
              {summaryBullets.length > 0 && (
                <ExecutiveSummary
                  bullets={summaryBullets}
                  stats={summaryStats}
                  overallForRing={
                    typeof analysis.overallScore === "number"
                      ? analysis.overallScore
                      : summaryStats.overall ?? 0
                  }
                />
              )}

              {/* Suggestions & Strengths */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ListCard
                  title="Areas for Improvement"
                  icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
                  color="amber"
                  items={cleanSuggestions}
                  empty="No suggestions available."
                />
                <ListCard
                  title="Resume Strengths"
                  icon={<CheckCircle2 className="h-5 w-5 text-green-500" />}
                  color="green"
                  items={cleanStrengths}
                  empty="No strengths highlighted."
                />
              </div>

              {/* Recommended Next Steps */}
              {(result?.extended?.recommended_next_steps?.length ?? 0) > 0 && (
                <Card className="shadow-sm">
                  <CardHeader className="border-b">
                    <CardTitle>Candidate Resume Fix</CardTitle>
                    <CardDescription>
                      Quick wins to raise candidate score
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <ul className="list-disc pl-6 space-y-2 text-gray-700">
                      {result!.extended!.recommended_next_steps!.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* Sources used */}
              {result?._sources && (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle>Sources Used</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
                      <li>
                        Resume:{" "}
                        {result._sources.resume_used
                          ? `✅ ${result._sources.resume_chars} chars`
                          : "❌ not provided"}
                      </li>
                      <li>
                        LinkedIn:{" "}
                        {result._sources.linkedin_used
                          ? `✅ ${result._sources.linkedin_chars} chars (via ${result._sources.linkedin_method})`
                          : "❌ not used"}
                        {result._sources.linkedin_reason
                          ? ` — ${result._sources.linkedin_reason}`
                          : ""}
                        {result._sources.linkedin_url
                          ? ` — ${result._sources.linkedin_url}`
                          : ""}
                      </li>
                      {typeof result._sources.latency_ms === "number" && (
                        <li>
                          LLM: {result._sources.model} —{" "}
                          {result._sources.latency_ms} ms
                        </li>
                      )}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* Actions */}
              <div className="bg-gray-50 rounded-lg p-6 border border-gray-200 shadow-sm">
                <h3 className="text-xl font-bold mb-4 text-center">
                  Next Steps
                </h3>
                <div className="flex flex-wrap gap-4 justify-center">
                  <Button
                    onClick={() => {
                      setResumeFile(null);
                      setResult(null);
                      setLinkedinUrl("");
                    }}
                    variant="outline"
                    className="min-w-36 h-12 border-gray-300 hover:bg-gray-100 hover:text-gray-900"
                  >
                    <Upload className="mr-2 h-4 w-4" /> Analyze Another
                  </Button>
                  <Button
                    onClick={() => result && generateReportPDF(result)}
                    className="min-w-36 h-12 bg-blue-600 hover:bg-blue-700 text-white transition-all"
                  >
                    <FileText className="mr-2 h-4 w-4" /> Download Report (PDF)
                  </Button>
                </div>
              </div>

              {/* Debug */}
              <details className="text-sm text-gray-600">
                <summary className="cursor-pointer">Debug JSON</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words bg-slate-50 border p-3 rounded">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================= Small presentational pieces ====================== */

function Stepper({ step }: { step: number }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-center max-w-2xl mx-auto select-none">
        <div
          className={`flex flex-col items-center ${
            step > 1 ? "opacity-50" : "opacity-100"
          }`}
        >
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              step >= 1 ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-500"
            }`}
          >
            <Upload size={18} />
          </div>
          <span className="mt-2 text-sm font-medium">Upload</span>
        </div>
        <div
          className={`w-16 h-0.5 ${
            step >= 2 ? "bg-blue-500" : "bg-gray-200"
          } mx-2`}
        />
        <div
          className={`flex flex-col items-center ${
            step > 2 ? "opacity-50" : "opacity-100"
          }`}
        >
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              step >= 2 ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-500"
            }`}
          >
            <BarChart4 size={18} />
          </div>
          <span className="mt-2 text-sm font-medium">Analyze</span>
        </div>
        <div
          className={`w-16 h-0.5 ${
            step === 3 ? "bg-blue-500" : "bg-gray-200"
          } mx-2`}
        />
        <div className="flex flex-col items-center">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              step === 3
                ? "bg-blue-500 text-white"
                : "bg-blue-100 text-blue-500"
            }`}
          >
            <CheckCircle2 size={18} />
          </div>
          <span className="mt-2 text-sm font-medium">Results</span>
        </div>
      </div>
    </div>
  );
}

function OverallScoreCard({
  value,
  timestamp,
}: {
  value: number;
  timestamp: number;
}) {
  const getScoreColor = (score: number) => {
    if (score < 50) return "text-red-500";
    if (score < 70) return "text-amber-500";
    if (score < 90) return "text-emerald-500";
    return "text-indigo-600";
  };
  return (
    <Card className="overflow-hidden shadow-sm border-blue-100">
      <CardHeader className="pb-2 border-b bg-gradient-to-r from-blue-50 to-indigo-50">
        <CardTitle className="flex items-center gap-2">
          <BarChart4 className="h-5 w-5 text-blue-500" /> Overall Resume Score
        </CardTitle>
        <CardDescription>Based on our analyzer’s evaluation</CardDescription>
      </CardHeader>
      <CardContent className="pt-8 pb-10">
        <div className="flex flex-col md:flex-row items-center justify-center gap-8">
          <div className="relative">
            <div className="w-52 h-52 relative">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  stroke="#E5E7EB"
                  strokeWidth="10"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  stroke={
                    value > 80 ? "#4F46E5" : value > 60 ? "#10B981" : "#F97316"
                  }
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 54}
                  strokeDashoffset={2 * Math.PI * 54 * (1 - value / 100)}
                  className="transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-5xl font-bold ${getScoreColor(value)}`}>
                  {value}%
                </span>
                <span className="text-sm text-gray-500 mt-1">
                  Overall Score
                </span>
              </div>
            </div>
          </div>
          <div className="max-w-md">
            <h3 className="text-xl font-bold mb-3">Score Summary</h3>
            <div
              className={`p-4 rounded-lg mb-4 ${
                value >= 80
                  ? "bg-green-50 border border-green-100"
                  : value >= 60
                  ? "bg-blue-50 border border-blue-100"
                  : "bg-amber-50 border border-amber-100"
              }`}
            >
              <div className="flex items-start gap-3">
                {value >= 60 ? (
                  <CheckCircle2
                    className={`h-6 w-6 ${
                      value >= 80 ? "text-green-500" : "text-blue-500"
                    } mt-0.5`}
                  />
                ) : (
                  <AlertTriangle className="h-6 w-6 text-amber-500 mt-0.5" />
                )}
                <div>
                  <p className="font-medium mb-1">
                    {value >= 80
                      ? "Candidate is quite strong!"
                      : value >= 60
                      ? "Candidate is on the right track"
                      : "Candidate needs improvement"}
                  </p>
                  <p className="text-sm text-gray-700">
                    {value >= 80
                      ? "Strong content and keyword match. Hire with confidence."
                      : value >= 60
                      ? "Solid elements but can improve to stand out more."
                      : "Not good enough. Needs more work."}
                  </p>
                </div>
              </div>
            </div>
            <div className="text-sm text-gray-600">
              Analysis performed {new Date(timestamp).toLocaleString()}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HireCard({
  title,
  value,
  invert = false,
  hint,
}: {
  title: string;
  value: number;
  invert?: boolean;
  hint?: string;
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const effective = invert ? v : v;
  const label =
    effective >= 85
      ? "Excellent"
      : effective >= 70
      ? "Good"
      : effective >= 40
      ? "Fair"
      : "Needs work";
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-gray-700">{title}</CardTitle>
        {hint && <CardDescription className="text-xs">{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-4">
          <div className="w-16">
            <CircularProgressbar
              value={v}
              text={`${v}%`}
              styles={buildStyles({
                textColor: "#111827",
                pathColor: invert ? "#F97316" : "#4F46E5",
                trailColor: "#E5E7EB",
              })}
            />
          </div>
          <div className="text-sm text-gray-600">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniScore({
  title,
  value,
  tone,
}: {
  title: string;
  value: number;
  tone: string;
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const label =
    v === 0
      ? "N/A"
      : v >= 85
      ? "Excellent"
      : v >= 70
      ? "Good"
      : v >= 40
      ? "Fair"
      : "Needs work";
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-gray-700">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-4">
          <div className="w-16">
            <CircularProgressbar
              value={v}
              text={`${v}%`}
              styles={buildStyles({
                textColor: "#111827",
                pathColor: tone,
                trailColor: "#E5E7EB",
              })}
            />
          </div>
          <div className="text-sm text-gray-600">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChipList({
  title,
  items,
  color,
}: {
  title: string;
  items: string[];
  color: "emerald" | "amber";
}) {
  const tone = color === "emerald" ? "green" : "amber";
  return (
    <div>
      <div className="text-sm font-medium mb-2">{title}</div>
      <div className="flex flex-wrap gap-2">
        {(items || []).length ? (
          items.map((k, i) => (
            <span
              key={`${k}-${i}`}
              className={`px-2 py-1 rounded-full text-xs bg-${tone}-50 text-${tone}-700 border border-${tone}-200`}
            >
              {k}
            </span>
          ))
        ) : (
          <span className="text-xs text-gray-500">None</span>
        )}
      </div>
    </div>
  );
}

function ListCard({
  title,
  icon,
  color,
  items,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  color: "amber" | "green";
  items: string[];
  empty: string;
}) {
  const grad =
    color === "amber"
      ? "from-amber-50 to-orange-50"
      : "from-green-50 to-emerald-50";
  return (
    <Card
      className={`shadow-sm border-${
        color === "amber" ? "amber" : "green"
      }-100 h-full`}
    >
      <CardHeader className={`border-b bg-gradient-to-r ${grad}`}>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6">
        <ul className="space-y-3">
          {items?.length ? (
            items.map((s, i) => (
              <li
                key={i}
                className="flex items-start p-3 rounded-lg transition-all duration-200 hover:bg-gray-50"
              >
                <span
                  className={`inline-flex items-center justify-center h-6 w-6 rounded-full ${
                    color === "amber"
                      ? "bg-amber-100 text-amber-600"
                      : "bg-green-100 text-green-600"
                  } text-sm font-medium mr-3 mt-0.5 flex-shrink-0`}
                >
                  {i + 1}
                </span>
                <span className="text-gray-700">{s}</span>
              </li>
            ))
          ) : (
            <li className="p-3 text-gray-500">{empty}</li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
